import {
  StateGraph,
  StateSchema,
  START,
  END,
  interrupt,
} from '@langchain/langgraph';
import { MongoClient } from 'mongodb-checkpoint-driver';
import {
  moderationStateSchema,
  approvalDecisionSchema,
  type ModerationState,
  type ModerationNode,
} from '@unkillable/shared';
import { ObservedSaver } from './runtime';
import type { ModerationOperations } from './moderation';
export type ModerationHooks = {
  checkpoint(
    id: string,
    state: ModerationState,
    checkpointId: string,
  ): Promise<void>;
  started(
    id: string,
    node: ModerationNode,
    state: ModerationState,
  ): Promise<void>;
  runNode(
    id: string,
    node: ModerationNode,
    operation: () => Promise<Partial<ModerationState>>,
  ): Promise<Partial<ModerationState>>;
};
export async function createModerationRuntime(
  uri: string,
  dbName: string,
  hooks: ModerationHooks,
  operations: (runId: string) => ModerationOperations,
) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const saver = new ObservedSaver(client, dbName, hooks, moderationStateSchema);
  const errors = await saver.setup();
  if (errors.length) {
    await client.close();
    throw new AggregateError(errors, 'Moderation checkpoint setup failed');
  }
  const node =
    (name: ModerationNode) =>
    async (
      state: ModerationState,
      config: { configurable?: Record<string, unknown> },
    ) => {
      const id = String(config.configurable?.thread_id);
      await hooks.started(id, name, state);
      if (name === 'approval') {
        const decision = approvalDecisionSchema.parse(
          interrupt({
            contentId: state.contentId,
            reason: state.decisionReason,
          }),
        );
        if (decision.action === 'edit')
          throw new Error('Content is immutable; approve or reject only');
        return {
          decision:
            decision.action === 'reject'
              ? ('reject' as const)
              : ('allow' as const),
          approvalAction: decision.action,
          decisionReason:
            decision.action === 'reject'
              ? decision.reason
              : 'An administrator approved this content.',
          completed: [...state.completed, name],
        };
      }
      return hooks.runNode(id, name, async () => {
        const ops = operations(id);
        let output: Partial<ModerationState> = {};
        if (name === 'automated_check') output = await ops.check(state);
        if (name === 'publish' || name === 'reject')
          await ops.decide(state, name === 'publish');
        if (name === 'notify') await ops.notify(state);
        return { ...output, completed: [...state.completed, name] };
      });
    };
  const graph = new StateGraph(new StateSchema(moderationStateSchema.shape))
    .addNode('upload', node('upload'), { retryPolicy: { maxAttempts: 1 } })
    .addNode('automated_check', node('automated_check'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('auto_decide', node('auto_decide'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('approval', node('approval'))
    .addNode('publish', node('publish'), { retryPolicy: { maxAttempts: 1 } })
    .addNode('reject', node('reject'), { retryPolicy: { maxAttempts: 1 } })
    .addNode('notify', node('notify'), { retryPolicy: { maxAttempts: 1 } })
    .addEdge(START, 'upload')
    .addEdge('upload', 'automated_check')
    .addEdge('automated_check', 'auto_decide')
    .addConditionalEdges(
      'auto_decide',
      (state) =>
        state.decision === 'review'
          ? 'approval'
          : state.decision === 'allow'
            ? 'publish'
            : 'reject',
      ['approval', 'publish', 'reject'],
    )
    .addConditionalEdges(
      'approval',
      (state) => (state.decision === 'allow' ? 'publish' : 'reject'),
      ['publish', 'reject'],
    )
    .addEdge('publish', 'notify')
    .addEdge('reject', 'notify')
    .addEdge('notify', END)
    .compile({ checkpointer: saver });
  return { graph, saver, close: () => client.close() };
}
