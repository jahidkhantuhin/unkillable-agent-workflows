import { demoDefinition, supportDefinition } from '@unkillable/workflows';
import type { RunRepository } from '@unkillable/storage';
import type { RunStatus, DemoInput, TicketInput } from '@unkillable/shared';
import { HttpError } from '../errors';
export interface RunQueue {
  add(
    name: string,
    data: { runId: string; execution?: number },
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
    await this.repository.definition(supportDefinition);
  }
  async create(userId: string, input: DemoInput) {
    const run = await this.repository.create(userId, input);
    try {
      await this.dispatch(run.id);
    } catch (error) {
      this.warn(error);
    }
    return (await this.repository.get(run.id))!;
  }
  async createTicket(userId: string, input: TicketInput) {
    const run = await this.repository.createSupport(userId, input);
    try {
      await this.dispatch(run.id);
    } catch (error) {
      this.warn(error);
    }
    return (await this.repository.get(run.id))!;
  }
  ticketExamples() {
    return this.repository.support().examples();
  }
  private async dispatch(runId: string) {
    const run = await this.get(runId);
    await this.queue.add(
      'execute-run',
      { runId, execution: run.execution },
      { jobId: run.execution === 0 ? runId : `${runId}-${run.execution}` },
    );
    await this.repository.markDispatched(runId, run.execution);
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
  async details(id: string) {
    await this.get(id);
    return this.repository.reliability().details(id);
  }
}
