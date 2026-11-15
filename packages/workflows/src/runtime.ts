import {
  StateGraph,
  StateSchema,
  START,
  END,
  interrupt,
  Command,
} from '@langchain/langgraph';
export { Command };
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { MongoClient } from 'mongodb-checkpoint-driver';
import {
  demoStateSchema,
  demoNodeSchema,
  type DemoState,
  type DemoNode,
  approvalDecisionSchema,
} from '@unkillable/shared';
type Hooks = {
  approvalFinished?: (runId: string) => Promise<void>;
  runNode?: (
    runId: string,
    node: DemoNode,
    operation: () => Promise<Partial<DemoState>>,
  ) => Promise<Partial<DemoState>>;
  stepStarted: (
    runId: string,
    node: DemoNode,
    state: DemoState,
  ) => Promise<void>;
  checkpoint: (
    runId: string,
    state: DemoState,
    checkpointId: string,
  ) => Promise<void>;
};
/** Notify the application only after the native checkpoint write has completed. */
export class ObservedSaver<
  T extends { completed: readonly string[] },
> extends MongoDBSaver {
  constructor(
    client: MongoClient,
    dbName: string,
    private readonly hooks: {
      checkpoint: (
        runId: string,
        state: T,
        checkpointId: string,
      ) => Promise<void>;
    },
    private readonly schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false };
    },
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
    const state = this.schema.safeParse(checkpoint.channel_values);
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
      await hooks.stepStarted(
        String(config.configurable?.thread_id),
        name,
        state,
      );
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
    .addNode(
      'approval',
      async (
        state: DemoState,
        config: { configurable?: Record<string, unknown> },
      ) => {
        await hooks.stepStarted(
          String(config.configurable?.thread_id),
          'approval',
          state,
        );
        // Keep interrupt outside the retry wrapper: GraphInterrupt is control flow.
        const decision = approvalDecisionSchema.parse(
          interrupt({ message: state.message }),
        );
        await hooks.approvalFinished?.(String(config.configurable?.thread_id));
        return {
          approvalAction: decision.action,
          noticeMessage:
            decision.action === 'edit'
              ? decision.payload.message
              : state.message,
          completed: [...state.completed, 'approval' as const],
        };
      },
    )
    .addEdge(START, 'prepare')
    .addEdge('prepare', 'summarize')
    .addConditionalEdges(
      'summarize',
      (state) => (state.requireApproval ? 'approval' : 'complete'),
      ['approval', 'complete'],
    )
    .addConditionalEdges(
      'approval',
      (state) => (state.approvalAction === 'reject' ? END : 'complete'),
      [END, 'complete'],
    )
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
  const saver = new ObservedSaver(client, dbName, hooks, demoStateSchema);
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
