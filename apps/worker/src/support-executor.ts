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
  type SupportMail,
} from '@unkillable/shared';
import type { RunRepository } from '@unkillable/storage';
import { noFaults, type FaultInjector } from './faults';
import { compensate } from './compensator';
export async function createSupportExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  deps: SupportDependencies,
  policies: Partial<Record<string, RetryPolicy>> = {},
  faults: FaultInjector = noFaults,
  deliver: (mail: SupportMail) => Promise<void> = async () => {
    throw new Error('Compensation mail transport missing');
  },
) {
  const reliability = repository.reliability();
  const approvals = repository.approvals();
  const active = new Map<string, number>();
  async function checkpoint(runId: string, state: SupportState, id: string) {
    for (const stepName of state.completed)
      await repository.append(
        runId,
        { type: 'STEP_FINISHED', stepName, output: state },
        {
          key: `step:${stepName}:finished`,
          expectedExecution: active.get(runId),
          expectedStatus: 'running',
        },
      );
    await repository.append(
      runId,
      { type: 'STATE_SNAPSHOT', snapshot: state },
      {
        key: `checkpoint:${id}`,
        state,
        expectedExecution: active.get(runId),
        expectedStatus: 'running',
      },
    );
  }
  const runtime = await createSupportRuntime(
    uri,
    dbName,
    {
      approvalFinished: (runId) =>
        retryOperation(
          'approval_after',
          () => faults.at(runId, 'approval', 'after'),
          reliability.attemptStore(
            runId,
            'approval_after',
            active.get(runId) ?? 0,
          ),
        ),
      checkpoint,
      stepStarted: async (runId, stepName, state) => {
        await repository.append(
          runId,
          { type: 'STEP_STARTED', stepName, input: state },
          { expectedExecution: active.get(runId) },
        );
        if (stepName === 'approval')
          await retryOperation(
            'approval',
            () => faults.at(runId, 'approval', 'before'),
            reliability.attemptStore(runId, 'approval', active.get(runId) ?? 0),
          );
      },
      runNode: (runId, node, operation) =>
        retryOperation(
          node,
          async () => {
            await faults.at(runId, node, 'before');
            const result = await operation();
            await faults.at(runId, node, 'after');
            return result;
          },
          reliability.attemptStore(runId, node, active.get(runId) ?? 0),
          policies[node] ?? defaultRetryPolicy,
        ),
    },
    {
      ...deps,
      decidePolicy: (runId, state, amount) =>
        repository.policies().decideSupport(runId, state, amount),
    },
  );
  return {
    close: runtime.close,
    async execute(id: string, expectedExecution?: number) {
      const run = await repository.get(id);
      if (!run) throw new Error('Run not found');
      if (run.status === 'compensating') {
        await repository.append(
          id,
          {
            type: 'CUSTOM',
            name: 'compensation.resumed',
            value: {
              instance: process.env.CHAOS_INSTANCE_ID ?? String(process.pid),
            },
          },
          {
            key: `saga:resumed:${process.env.CHAOS_INSTANCE_ID ?? process.pid}`,
          },
        );
        return compensate(repository, id, deliver, faults);
      }
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
        let saved = await runtime.saver.getTuple(config);
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
        if (!saved && run.parentRunId && run.forkAsNode) {
          await runtime.graph.updateState(
            config,
            supportStateSchema.parse(run.state),
            run.forkAsNode,
          );
          saved = await runtime.saver.getTuple(config);
        }
        if (run.parentRunId && saved)
          await repository.append(
            id,
            {
              type: 'CUSTOM',
              name: 'fork.initialized',
              value: {
                parentRunId: run.parentRunId,
                checkpointId: run.forkCheckpointId,
                asNode: run.forkAsNode,
              },
            },
            { key: 'fork:initialized' },
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
                policyDecision: state.policyDecision,
              },
              reasoning: `${state.classification.reason} ${state.risk.reason}`,
              requiredApprovals:
                state.policyDecision?.requiredApprovals === 2 ? 2 : 1,
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
            expectedStatus: 'running',
            state: result,
            expectedExecution: run.execution,
          },
        );
      } catch (error) {
        const failure = await reliability.latestFailure(id, run.execution);
        if (failure?.error) {
          if (
            await repository
              .saga()
              .begin(id, run.execution, failure.error.message)
          ) {
            await compensate(repository, id, deliver, faults);
            return;
          }
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
