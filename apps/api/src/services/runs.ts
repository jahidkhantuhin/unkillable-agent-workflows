import { demoDefinition } from '@unkillable/workflows';
import type { RunRepository } from '@unkillable/storage';
import type { RunStatus } from '@unkillable/shared';
import { HttpError } from '../errors';
export interface RunQueue {
  add(
    name: string,
    data: { runId: string },
    options: { jobId: string },
  ): Promise<unknown>;
}
export class RunService {
  private recovering = false;
  constructor(
    readonly repository: RunRepository,
    private readonly queue: RunQueue,
    private readonly warn: (error: unknown) => void = () => {},
  ) {}
  async initialize() {
    await this.repository.definition(demoDefinition);
  }
  async create(userId: string, input: { message: string }) {
    const run = await this.repository.create(userId, input);
    try {
      await this.dispatch(run.id);
    } catch (error) {
      this.warn(error);
    }
    return (await this.repository.get(run.id))!;
  }
  private async dispatch(runId: string) {
    await this.queue.add('execute-run', { runId }, { jobId: runId });
    await this.repository.markDispatched(runId);
  }
  async reconcile() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      for (const run of await this.repository.pendingDispatch())
        await this.dispatch(run.id);
    } finally {
      this.recovering = false;
    }
  }
  async get(id: string) {
    const run = await this.repository.get(id);
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
    return run;
  }
  list(limit: number, status?: RunStatus) {
    return this.repository.list(limit, status);
  }
}
