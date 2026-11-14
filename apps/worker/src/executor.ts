import { createDemoRuntime, Command } from '@unkillable/workflows/runtime';
import { RunRepository } from '@unkillable/storage';
import { retryOperation } from '@unkillable/workflows/retry';
import {
  demoStateSchema,
  terminalStatuses,
  type DemoState,
  type DemoNode,
  type RetryPolicy,
  defaultRetryPolicy,
  effectResultSchema,
  RetryableError,
  PermanentError,
  NodeFailure,
} from '@unkillable/shared';
export async function createExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  delayMs: number,
  policies: Partial<Record<DemoNode, RetryPolicy>> = {},
) {
  const reliability = repository.reliability();
  const approvals = repository.approvals();
  const active = new Map<string, number>();
  async function recordCheckpoint(
    runId: string,
    state: DemoState,
    checkpointId: string,
  ) {
    for (const stepName of state.completed)
      await repository.append(
        runId,
        { type: 'STEP_FINISHED', stepName },
        {
          key: `step:${stepName}:finished`,
          expectedExecution: active.get(runId),
        },
      );
    await repository.append(
      runId,
      { type: 'STATE_SNAPSHOT', snapshot: state },
      {
        key: `checkpoint:${checkpointId}`,
        state,
        expectedExecution: active.get(runId),
      },
    );
  }
  const runtime = await createDemoRuntime(
    uri,
    dbName,
    {
      stepStarted: async (runId, stepName) => {
        await repository.append(
          runId,
          { type: 'STEP_STARTED', stepName },
          { expectedExecution: active.get(runId) },
        );
      },
      checkpoint: recordCheckpoint,
      runNode: async (runId, node, operation) => {
        const execution = active.get(runId) ?? 0;
        const run = await repository.get(runId);
        if (!run) throw new Error('Run not found');
        return retryOperation(
          node,
          async (attempt) => {
            if (node === 'complete' && run.workflowVersion >= 2) {
              const mode = demoStateSchema.parse(run.state).deliveryMode;
              if (mode === 'permanent')
                throw new PermanentError(
                  'Local notice payload rejected',
                  'DEMO_INVALID_PAYLOAD',
                );
              if (
                (mode === 'retry-once' && attempt === 1) ||
                (mode === 'exhaust' && execution === 0)
              )
                throw new RetryableError(
                  'Local notice provider temporarily unavailable',
                  'DEMO_UNAVAILABLE',
                );
              await reliability.executeOnce(
                runId + ':complete:notice',
                async (transaction) => {
                  const receipt = await transaction.enqueue('notification', {
                    message: run.state.noticeMessage || run.state.message,
                  });
                  return { receipt };
                },
                effectResultSchema,
              );
            }
            return operation();
          },
          reliability.attemptStore(runId, node, execution),
          policies[node] ?? defaultRetryPolicy,
        );
      },
    },
    delayMs,
  );
  return {
    close: runtime.close,
    async execute(runId: string, expectedExecution?: number) {
      const run = await repository.get(runId);
      if (!run) throw new Error('Run not found');
      if (
        terminalStatuses.includes(run.status) ||
        (expectedExecution !== undefined && run.execution !== expectedExecution)
      )
        return;
      active.set(run.id, run.execution);
      try {
        const approval = await approvals.forRun(runId);
        if (run.status === 'waiting_approval') return;
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
          {
            key: `run:started:${run.execution}`,
            status: 'running',
            dispatchPending: false,
            expectedExecution: run.execution,
          },
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
        const before = saved ? await runtime.graph.getState(config) : null;
        const interrupted = before?.tasks.some(
          (task) => task.interrupts?.length,
        );
        const input =
          interrupted && approval?.decision
            ? new Command<unknown, Partial<DemoState>, DemoNode | '__start__'>({
                resume: approval.decision,
              })
            : saved
              ? null
              : demoStateSchema.parse(run.state);
        const output = await runtime.graph.invoke(input, config);
        const snapshot = await runtime.graph.getState(config);
        if (snapshot.tasks.some((task) => task.interrupts?.length)) {
          const paused = demoStateSchema.parse(snapshot.values);
          await approvals.request(
            run.id,
            run.execution,
            String(snapshot.config.configurable?.checkpoint_id),
            paused.message,
          );
          return;
        }
        const result = demoStateSchema.parse(output);
        const outcome =
          result.approvalAction === 'reject' ? 'cancelled' : 'succeeded';
        await repository.append(
          run.id,
          { type: 'RUN_FINISHED', outcome },
          {
            key: `run:finished:${run.execution}`,
            status: outcome,
            state: result,
            expectedExecution: run.execution,
          },
        );
      } catch (error) {
        const failure = await reliability.latestFailure(run.id, run.execution);
        if (failure?.error) {
          const saved = await runtime.saver.getTuple({
            configurable: { thread_id: run.id },
          });
          await reliability.recordFailure(run.id, run.execution, error, {
            checkpointId: saved?.checkpoint.id ?? null,
            jobId: run.execution === 0 ? run.id : `${run.id}-${run.execution}`,
            execution: run.execution,
          });
          throw new NodeFailure(failure.nodeId, failure.attempt, failure.error);
        }
        throw error;
      } finally {
        active.delete(run.id);
      }
    },
  };
}
