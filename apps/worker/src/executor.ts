import {
  observedRun,
  observedApprovalWait,
} from '@unkillable/workflows/observability';
import { createDemoRuntime, Command } from '@unkillable/workflows/runtime';
import { RunRepository } from '@unkillable/storage';
import { retryOperation } from '@unkillable/workflows/retry';
import type { SupportDependencies } from '@unkillable/workflows/support';
import type { ModerationLLM } from '@unkillable/workflows/moderation';
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
  type SupportMail,
} from '@unkillable/shared';
import { noFaults, type FaultInjector } from './faults';
async function createDemoExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  delayMs: number,
  policies: Partial<Record<string, RetryPolicy>> = {},
  faults: FaultInjector = noFaults,
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
        { type: 'STEP_FINISHED', stepName, output: state },
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
      checkpoint: recordCheckpoint,
      runNode: async (runId, node, operation) => {
        const execution = active.get(runId) ?? 0;
        const run = await repository.get(runId);
        if (!run) throw new Error('Run not found');
        return retryOperation(
          node,
          async (attempt) => {
            await faults.at(runId, node, 'before');
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
            const result = await operation();
            await faults.at(runId, node, 'after');
            return result;
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
        let saved = await runtime.saver.getTuple(config);
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
        if (!saved && run.parentRunId && run.forkAsNode) {
          await runtime.graph.updateState(
            config,
            demoStateSchema.parse(run.state),
            run.forkAsNode,
          );
          saved = await runtime.saver.getTuple(config);
        }
        if (run.parentRunId && saved)
          await repository.append(
            run.id,
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
            paused.title || paused.message,
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
export async function createExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  delayMs: number,
  policies: Partial<Record<string, RetryPolicy>> = {},
  support?: SupportDependencies,
  faults: FaultInjector = noFaults,
  deliver?: (mail: SupportMail) => Promise<void>,
  moderationModel?: ModerationLLM,
) {
  const demo = await createDemoExecutor(
    repository,
    uri,
    dbName,
    delayMs,
    policies,
    faults,
  );
  let ticketRuntime:
    | Promise<
        Awaited<
          ReturnType<
            (typeof import('./support-executor'))['createSupportExecutor']
          >
        >
      >
    | undefined;
  let closeMailer: (() => void) | undefined;
  const inFlight = new Map<string, Promise<void>>();
  let moderationRuntime:
    | Promise<
        Awaited<
          ReturnType<
            (typeof import('./moderation-executor'))['createModerationExecutor']
          >
        >
      >
    | undefined;
  async function execute(id: string, execution?: number) {
    const run = await repository.get(id);
    const approvalWait = await repository.approvals().forRun(id);
    if (approvalWait?.resolvedAt)
      await observedApprovalWait(
        approvalWait.id,
        approvalWait.createdAt,
        approvalWait.resolvedAt,
      );
    if (run?.workflowId === 'content-moderation') {
      if (!moderationRuntime)
        moderationRuntime = import('./moderation-executor')
          .then((module) =>
            module.createModerationExecutor(
              repository,
              uri,
              dbName,
              faults,
              undefined,
              moderationModel,
            ),
          )
          .catch((error) => {
            moderationRuntime = undefined;
            throw error;
          });
      return (await moderationRuntime).execute(id, execution);
    }
    if (run?.workflowId !== 'support-ticket-router')
      return demo.execute(id, execution);
    if (!ticketRuntime)
      ticketRuntime = (async () => {
        const { createSupportExecutor } = await import('./support-executor');
        let deps = support;
        if (!deps) {
          const { supportConfigSchema } = await import('@unkillable/shared');
          const { supportDependencies, MailpitMailer } =
            await import('./support-adapters');
          const config = supportConfigSchema.parse({});
          const smtp = new MailpitMailer(config);
          closeMailer = () => smtp.close();
          deliver = (mail) => smtp.deliver(mail);
          deps = supportDependencies(repository, config, (mail) =>
            smtp.deliver(mail),
          );
        }
        return createSupportExecutor(
          repository,
          uri,
          dbName,
          deps,
          policies,
          faults,
          deliver,
        );
      })().catch((error) => {
        ticketRuntime = undefined;
        closeMailer?.();
        closeMailer = undefined;
        throw error;
      });
    return (await ticketRuntime).execute(id, execution);
  }
  return {
    async execute(id: string, execution?: number) {
      const generation = execution ?? (await repository.get(id))?.execution;
      const key = `${id}:${generation}`;
      const current = inFlight.get(key);
      if (current) return current;
      const pending = observedRun(
        id,
        generation ?? 0,
        repository.operations(),
        () => execute(id, execution),
      ).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
    async close() {
      await demo.close();
      if (moderationRuntime) await (await moderationRuntime).close();
      if (ticketRuntime) await (await ticketRuntime).close();
      closeMailer?.();
    },
  };
}
