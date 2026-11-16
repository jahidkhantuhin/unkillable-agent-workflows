import { createHash } from 'node:crypto';
import { Command } from '@unkillable/workflows/runtime';
import { createModerationRuntime } from '@unkillable/workflows/moderation-runtime';
import {
  checkModeration,
  MockModerationLLM,
  type ModerationLLM,
} from '@unkillable/workflows/moderation';
import { retryOperation } from '@unkillable/workflows/retry';
import {
  LocalContentStorage,
  type ContentStorage,
  type RunRepository,
} from '@unkillable/storage';
import {
  moderationStateSchema,
  terminalStatuses,
  defaultRetryPolicy,
  NodeFailure,
  PermanentError,
  type ModerationState,
  type ModerationNode,
} from '@unkillable/shared';
import { type FaultInjector, noFaults } from './faults';
import { compensate } from './compensator';
export async function createModerationExecutor(
  repository: RunRepository,
  uri: string,
  dbName: string,
  faults: FaultInjector = noFaults,
  files: ContentStorage = new LocalContentStorage(),
  llm: ModerationLLM = new MockModerationLLM(),
) {
  const active = new Map<string, number>(),
    reliability = repository.reliability();
  async function checkpoint(
    id: string,
    state: ModerationState,
    checkpointId: string,
  ) {
    for (const stepName of state.completed)
      await repository.append(
        id,
        { type: 'STEP_FINISHED', stepName, output: state },
        {
          key: `step:${stepName}:finished`,
          expectedExecution: active.get(id),
          expectedStatus: 'running',
        },
      );
    await repository.append(
      id,
      { type: 'STATE_SNAPSHOT', snapshot: state },
      {
        key: `checkpoint:${checkpointId}`,
        state,
        expectedExecution: active.get(id),
        expectedStatus: 'running',
      },
    );
  }
  const runtime = await createModerationRuntime(
    uri,
    dbName,
    {
      checkpoint,
      started: async (id, stepName, state) => {
        await repository.append(
          id,
          { type: 'STEP_STARTED', stepName, input: state },
          { expectedExecution: active.get(id) },
        );
      },
      runNode: (id, node, operation) =>
        retryOperation(
          node,
          async () => {
            await faults.at(id, node, 'before');
            const output = await operation();
            await faults.at(id, node, 'after');
            return output;
          },
          reliability.attemptStore(id, node, active.get(id) ?? 0),
          defaultRetryPolicy,
        ),
    },
    (id) => ({
      check: async (state) => {
        const text = await files.readText(state.file.key);
        if (
          createHash('sha256').update(text).digest('hex') !== state.file.sha256
        )
          throw new PermanentError('Stored content integrity check failed');
        return checkModeration(text, llm);
      },
      decide: async (state, publish) => {
        await repository.moderation().decide(id, state, publish);
      },
      notify: async (state) => {
        await repository.moderation().notify(id, state);
      },
    }),
  );
  return {
    close: runtime.close,
    async execute(id: string, expectedExecution?: number) {
      const run = await repository.get(id);
      if (!run) throw new Error('Run not found');
      if (run.status === 'compensating')
        return compensate(repository, id, async () => {}, faults);
      if (
        terminalStatuses.includes(run.status) ||
        run.status === 'waiting_approval' ||
        (expectedExecution !== undefined && run.execution !== expectedExecution)
      )
        return;
      active.set(id, run.execution);
      const config = {
        configurable: { thread_id: id },
        durability: 'sync' as const,
      };
      try {
        const saved = await runtime.saver.getTuple(config);
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
          const parsed = moderationStateSchema.safeParse(
            saved.checkpoint.channel_values,
          );
          if (parsed.success && parsed.data.completed.length)
            await checkpoint(id, parsed.data, saved.checkpoint.id);
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
        const approval = await repository.approvals().forRun(id);
        const input =
          before?.tasks.some((t) => t.interrupts?.length) && approval?.decision
            ? new Command<
                unknown,
                Partial<ModerationState>,
                ModerationNode | '__start__'
              >({ resume: approval.decision })
            : saved
              ? null
              : moderationStateSchema.parse(run.state);
        const output = await runtime.graph.invoke(input, config),
          snapshot = await runtime.graph.getState(config);
        if (snapshot.tasks.some((t) => t.interrupts?.length)) {
          const state = moderationStateSchema.parse(snapshot.values);
          await repository
            .approvals()
            .request(
              id,
              run.execution,
              String(snapshot.config.configurable?.checkpoint_id),
              state.preview.slice(0, 500) || 'Review the uploaded content.',
              state.title,
              {
                proposal: {
                  kind: 'moderation',
                  contentId: state.contentId,
                  bytes: state.file.bytes,
                },
                reasoning: state.decisionReason,
              },
            );
          return;
        }
        const state = moderationStateSchema.parse(output);
        await repository.append(
          id,
          { type: 'RUN_FINISHED', outcome: 'succeeded' },
          {
            key: `run:finished:${run.execution}`,
            status: 'succeeded',
            state,
            expectedStatus: 'running',
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
            await compensate(repository, id, async () => {}, faults);
            return;
          }
          const saved = await runtime.saver.getTuple(config);
          await reliability.recordFailure(id, run.execution, error, {
            checkpointId: saved?.checkpoint.id ?? null,
            jobId: run.execution ? `${id}-${run.execution}` : id,
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
