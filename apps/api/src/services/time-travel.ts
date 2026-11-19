import { createHistoryRuntime } from '@unkillable/workflows/history';
import { prepareForkState, ForkStateError } from '@unkillable/workflows/fork';
import {
  checkpointDetailSchema,
  checkpointSummarySchema,
  diffStates,
  runToDTO,
  type Run,
  type Identity,
} from '@unkillable/shared';
import type { RunService } from './runs';
import { HttpError } from '../errors';
type Runtime = Awaited<ReturnType<typeof createHistoryRuntime>>;
type Snapshot = Awaited<ReturnType<Runtime['graph']['getState']>>;
function summary(snapshot: Snapshot, runtime: Runtime) {
  const parsed = runtime.schema.safeParse(snapshot.values);
  return checkpointSummarySchema.parse({
    id: snapshot.config.configurable?.checkpoint_id,
    parentId: snapshot.parentConfig?.configurable?.checkpoint_id || null,
    createdAt: snapshot.createdAt ?? null,
    step: snapshot.metadata?.step ?? null,
    next: snapshot.next,
    completed: parsed.success ? parsed.data.completed : [],
    forkable: parsed.success,
  });
}
export class TimeTravelService {
  constructor(
    private readonly runs: RunService,
    private readonly uri: string,
    private readonly dbName: string,
  ) {}
  private async read<T>(
    id: string,
    operation: (runtime: Runtime, run: Run) => Promise<T>,
  ) {
    const run = await this.runs.get(id);
    if (
      ![
        'durability-demo',
        'support-ticket-router',
        'content-moderation',
      ].includes(run.workflowId)
    )
      throw new HttpError(
        400,
        'HISTORY_UNAVAILABLE',
        'History is unavailable for this workflow',
      );
    const runtime = await createHistoryRuntime(
      run.workflowId,
      this.uri,
      this.dbName,
    );
    try {
      return await operation(runtime, run);
    } finally {
      await runtime.close();
    }
  }
  private async snapshot(runtime: Runtime, id: string, checkpointId: string) {
    const config = {
      configurable: { thread_id: id, checkpoint_id: checkpointId },
    };
    if (!(await runtime.saver.getTuple(config)))
      throw new HttpError(
        404,
        'CHECKPOINT_NOT_FOUND',
        'Checkpoint does not belong to this run',
      );
    return runtime.graph.getState(config);
  }
  history(id: string, limit: number, before?: string) {
    return this.read(id, async (runtime) => {
      if (before) await this.snapshot(runtime, id, before);
      const checkpoints = [];
      for await (const snapshot of runtime.graph.getStateHistory(
        { configurable: { thread_id: id } },
        {
          limit,
          ...(before
            ? {
                before: {
                  configurable: { thread_id: id, checkpoint_id: before },
                },
              }
            : {}),
        },
      ))
        checkpoints.push(summary(snapshot, runtime));
      return {
        checkpoints,
        nextBefore:
          checkpoints.length === limit ? checkpoints.at(-1)!.id : null,
      };
    });
  }
  checkpoint(id: string, checkpointId: string) {
    return this.read(id, async (runtime) => {
      const snapshot = await this.snapshot(runtime, id, checkpointId);
      return checkpointDetailSchema.parse({
        ...summary(snapshot, runtime),
        state: snapshot.values,
      });
    });
  }
  diff(id: string, from: string, to: string) {
    return this.read(id, async (runtime) => {
      const [a, b] = await Promise.all([
        this.snapshot(runtime, id, from),
        this.snapshot(runtime, id, to),
      ]);
      return { from, to, changes: diffStates(a.values, b.values) };
    });
  }
  async relations(id: string) {
    const run = await this.runs.get(id);
    const parent = run.parentRunId
      ? await this.runs.repository.get(run.parentRunId)
      : null;
    return {
      parent: parent ? runToDTO(parent) : null,
      children: (await this.runs.repository.children(id)).map(runToDTO),
    };
  }
  fork(
    id: string,
    checkpointId: string,
    edits: Record<string, unknown>,
    actor: Identity,
  ) {
    return this.read(id, async (runtime, parent) => {
      if (parent.workflowId === 'content-moderation' && actor.role !== 'admin')
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Moderation forks require an administrator',
        );
      if (
        parent.workflowVersion !==
        (parent.workflowId === 'durability-demo' ? 3 : 1)
      )
        throw new HttpError(
          400,
          'FORK_VERSION_UNSUPPORTED',
          'Forking is supported for current workflow versions only',
        );
      const source = await this.snapshot(runtime, id, checkpointId);
      if (!runtime.schema.safeParse(source.values).success)
        throw new HttpError(
          400,
          'INCOMPLETE_CHECKPOINT',
          'Choose a checkpoint with initialized workflow state',
        );
      try {
        const prepared = prepareForkState(
          parent.workflowId,
          source.values,
          edits,
        );
        return this.runs.createFork(
          actor.user.id,
          parent,
          checkpointId,
          prepared.state,
          prepared.asNode,
        );
      } catch (error) {
        if (error instanceof ForkStateError)
          throw new HttpError(400, 'INVALID_FORK', error.message);
        throw error;
      }
    });
  }
}
