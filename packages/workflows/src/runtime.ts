import { StateGraph, StateSchema, START, END } from '@langchain/langgraph';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { MongoClient } from 'mongodb-checkpoint-driver';
import {
  demoStateSchema,
  demoNodeSchema,
  type DemoState,
  type DemoNode,
} from '@unkillable/shared';
type Hooks = {
  runNode?: (
    runId: string,
    node: DemoNode,
    operation: () => Promise<Partial<DemoState>>,
  ) => Promise<Partial<DemoState>>;
  stepStarted: (runId: string, node: DemoNode) => Promise<void>;
  checkpoint: (
    runId: string,
    state: DemoState,
    checkpointId: string,
  ) => Promise<void>;
};
/** Notify the application only after the native checkpoint write has completed. */
class ObservedSaver extends MongoDBSaver {
  constructor(
    client: MongoClient,
    dbName: string,
    private readonly hooks: Hooks,
  ) {
    super({
      client,
      dbName,
      checkpointCollectionName: 'checkpoints',
      checkpointWritesCollectionName: 'checkpointWrites',
    });
  }
  override async put(
    config: Parameters<MongoDBSaver['put']>[0],
    checkpoint: Parameters<MongoDBSaver['put']>[1],
    metadata: Parameters<MongoDBSaver['put']>[2],
  ) {
    const saved = await super.put(config, checkpoint, metadata);
    const state = demoStateSchema.safeParse(checkpoint.channel_values);
    if (state.success && state.data.completed.length)
      await this.hooks.checkpoint(
        String(config.configurable?.thread_id),
        state.data,
        checkpoint.id,
      );
    return saved;
  }
}
export function demoNodeOutput(
  node: DemoNode,
  state: DemoState,
): Partial<DemoState> {
  if (node === 'prepare')
    return {
      normalized: state.message.trim().replace(/\s+/g, ' '),
      completed: [...state.completed, node],
    };
  if (node === 'summarize')
    return {
      summary: `${state.normalized.split(' ').length} words: ${state.normalized}`,
      completed: [...state.completed, node],
    };
  return {
    result: `Completed: ${state.summary}`,
    completed: [...state.completed, node],
  };
}
export function buildDemoGraph(
  checkpointer: MongoDBSaver,
  hooks: Hooks,
  delayMs: number,
) {
  const schema = new StateSchema(demoStateSchema.shape);
  const node =
    (name: DemoNode) =>
    async (
      state: DemoState,
      config: { configurable?: Record<string, unknown> },
    ) => {
      await hooks.stepStarted(String(config.configurable?.thread_id), name);
      const operation = async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return demoNodeOutput(name, state);
      };
      return hooks.runNode
        ? hooks.runNode(String(config.configurable?.thread_id), name, operation)
        : operation();
    };
  return new StateGraph(schema)
    .addNode('prepare', node('prepare'), { retryPolicy: { maxAttempts: 1 } })
    .addNode('summarize', node('summarize'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('complete', node('complete'), { retryPolicy: { maxAttempts: 1 } })
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'summarize')
    .addEdge('summarize', 'complete')
    .addEdge('complete', END)
    .compile({ checkpointer });
}
export async function createDemoRuntime(
  uri: string,
  dbName: string,
  hooks: Hooks,
  delayMs: number,
) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const saver = new ObservedSaver(client, dbName, hooks);
  const errors = await saver.setup();
  if (errors.length) {
    await client.close();
    throw new AggregateError(errors, 'Checkpoint index setup failed');
  }
  const graph = buildDemoGraph(saver, hooks, delayMs);
  return {
    graph,
    saver,
    close: () => client.close(),
    nodeNames: demoNodeSchema.options,
  };
}
