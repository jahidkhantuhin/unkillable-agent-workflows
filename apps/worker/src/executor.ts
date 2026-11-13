import { createDemoRuntime } from '@unkillable/workflows/runtime';
import { RunRepository } from '@unkillable/storage';
import {
  demoStateSchema,
  terminalStatuses,
  type DemoState,
} from '@unkillable/shared';
export async function createExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  delayMs: number,
) {
  async function recordCheckpoint(
    runId: string,
    state: DemoState,
    checkpointId: string,
  ) {
    for (const stepName of state.completed)
      await repository.append(
        runId,
        { type: 'STEP_FINISHED', stepName },
        { key: `step:${stepName}:finished` },
      );
    await repository.append(
      runId,
      { type: 'STATE_SNAPSHOT', snapshot: state },
      { key: `checkpoint:${checkpointId}`, state },
    );
  }
  const runtime = await createDemoRuntime(
    uri,
    dbName,
    {
      stepStarted: async (runId, stepName) => {
        await repository.append(runId, { type: 'STEP_STARTED', stepName });
      },
      checkpoint: recordCheckpoint,
    },
    delayMs,
  );
  return {
    close: runtime.close,
    async execute(runId: string) {
      const run = await repository.get(runId);
      if (!run) throw new Error('Run not found');
      if (terminalStatuses.includes(run.status)) return;
      if (run.workflowId !== 'durability-demo')
        throw new Error('Unsupported workflow');
      const config = {
        configurable: { thread_id: run.id },
        durability: 'sync' as const,
      };
      const saved = await runtime.saver.getTuple(config);
      await repository.append(
        run.id,
        { type: 'RUN_STARTED' },
        { key: 'run:started', status: 'running', dispatchPending: false },
      );
      if (saved) {
        const state = demoStateSchema.safeParse(
          saved.checkpoint.channel_values,
        );
        if (state.success && state.data.completed.length)
          await recordCheckpoint(run.id, state.data, saved.checkpoint.id);
        await repository.append(run.id, {
          type: 'CUSTOM',
          name: 'run.resumed',
          value: { checkpointId: saved.checkpoint.id },
        });
      }
      const result = demoStateSchema.parse(
        await runtime.graph.invoke(
          saved ? null : demoStateSchema.parse(run.state),
          config,
        ),
      );
      await repository.append(
        run.id,
        { type: 'RUN_FINISHED', outcome: 'succeeded' },
        { key: 'run:finished', status: 'succeeded', state: result },
      );
    },
  };
}
