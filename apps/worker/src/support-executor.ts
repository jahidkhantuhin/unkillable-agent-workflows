import { Command } from '@unkillable/workflows/runtime';
import { createSupportRuntime } from '@unkillable/workflows/support-runtime';
import type { SupportDependencies } from '@unkillable/workflows/support';
import { retryOperation } from '@unkillable/workflows/retry';
import {
  supportStateSchema,
  terminalStatuses,
  defaultRetryPolicy,
  NodeFailure,
  type SupportNode,
  type SupportState,
  type RetryPolicy,
} from '@unkillable/shared';
import type { RunRepository } from '@unkillable/storage';
export async function createSupportExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  deps: SupportDependencies,
  policies: Partial<Record<string, RetryPolicy>> = {},
) {
  const reliability = repository.reliability();
  const approvals = repository.approvals();
  const active = new Map<string, number>();
  async function checkpoint(runId: string, state: SupportState, id: string) {
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
      { key: `checkpoint:${id}`, state, expectedExecution: active.get(runId) },
    );
  }
  const runtime = await createSupportRuntime(
    uri,
    dbName,
    {
      checkpoint,
      stepStarted: async (runId, stepName) => {
        await repository.append(
          runId,
          { type: 'STEP_STARTED', stepName },
          { expectedExecution: active.get(runId) },
        );
      },
      runNode: (runId, node, operation) =>
        retryOperation(
          node,
          () => operation(),
          reliability.attemptStore(runId, node, active.get(runId) ?? 0),
          policies[node] ?? defaultRetryPolicy,
        ),
    },
    deps,
  );
  return {
    close: runtime.close,
    async execute(id: string, expectedExecution?: number) {
      const run = await repository.get(id);
      if (!run) throw new Error('Run not found');
      if (
        terminalStatuses.includes(run.status) ||
        run.status === 'waiting_approval' ||
        (expectedExecution !== undefined && expectedExecution !== run.execution)
      )
        return;
      active.set(id, run.execution);
      const config = {
        configurable: { thread_id: id },
        durability: 'sync' as const,
      };
      try {
        const saved = await runtime.saver.getTuple(config);
        const approval = await approvals.forRun(id);
        await repository.append(
          id,
          { type: 'RUN_STARTED' },
          {
            key: `run:started:${run.execution}`,
            status: 'running',
            dispatchPending: false,
            expectedExecution: run.execution,
          },
        );
        if (saved) {
          const state = supportStateSchema.safeParse(
            saved.checkpoint.channel_values,
          );
          if (state.success && state.data.completed.length)
            await checkpoint(id, state.data, saved.checkpoint.id);
          await repository.append(
            id,
            {
              type: 'CUSTOM',
              name: 'run.resumed',
              value: { checkpointId: saved.checkpoint.id },
            },
            { expectedExecution: run.execution },
          );
        }
        const before = saved ? await runtime.graph.getState(config) : null;
        const input =
          before?.tasks.some((task) => task.interrupts?.length) &&
          approval?.decision
            ? new Command<
                unknown,
                Partial<SupportState>,
                SupportNode | '__start__'
              >({ resume: approval.decision })
            : saved
              ? null
              : supportStateSchema.parse(run.state);
        const output = await runtime.graph.invoke(input, config);
        const snapshot = await runtime.graph.getState(config);
        if (snapshot.tasks.some((task) => task.interrupts?.length)) {
          const state = supportStateSchema.parse(snapshot.values);
          await approvals.request(
            id,
            run.execution,
            String(snapshot.config.configurable?.checkpoint_id),
            state.draft.message,
            state.title,
            {
              proposal: {
                kind: 'support-ticket',
                ticketId: state.ticketId,
                recipient: state.ticket.customerEmail,
                refundCents: state.risk.refundCents,
                currency: 'USD',
                citedPolicyId: state.draft.citedPolicyId,
                citedSnippet: state.draft.citedSnippet,
              },
              reasoning: `${state.classification.reason} ${state.risk.reason}`,
            },
          );
          return;
        }
        const result = supportStateSchema.parse(output);
        const outcome =
          result.approvalAction === 'reject' ? 'cancelled' : 'succeeded';
        await repository.append(
          id,
          { type: 'RUN_FINISHED', outcome },
          {
            key: `run:finished:${run.execution}`,
            status: outcome,
            state: result,
            expectedExecution: run.execution,
          },
        );
      } catch (error) {
        const failure = await reliability.latestFailure(id, run.execution);
        if (failure?.error) {
          const saved = await runtime.saver.getTuple(config);
          await reliability.recordFailure(id, run.execution, error, {
            checkpointId: saved?.checkpoint.id ?? null,
            jobId: run.execution === 0 ? id : `${id}-${run.execution}`,
          });
          throw new NodeFailure(failure.nodeId, failure.attempt, failure.error);
        }
        throw error;
      } finally {
        active.delete(id);
      }
    },
  };
}
