import {
  demoDefinition,
  supportDefinition,
  moderationDefinition,
} from '@unkillable/workflows';
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
    await this.repository.definition(moderationDefinition);
  }
  async createModeration(
    userId: string,
    input: Parameters<RunRepository['createModeration']>[1],
  ) {
    const run = await this.repository.createModeration(userId, input);
    try {
      await this.dispatch(run.id);
    } catch (error) {
      this.warn(error);
    }
    return run;
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
  async graph(id: string) {
    const run = await this.get(id);
    const stored = await this.repository.getDefinition(
      run.workflowId,
      run.workflowVersion,
    );
    const definition =
      stored ??
      (run.workflowId === 'durability-demo' && run.workflowVersion <= 3
        ? { ...demoDefinition, version: run.workflowVersion }
        : null);
    if (!definition)
      throw new HttpError(
        404,
        'DEFINITION_NOT_FOUND',
        'Workflow definition not found',
      );
    const nodes = definition.nodes.filter(
      (node) =>
        node.id !== 'approval' ||
        run.workflowId !== 'durability-demo' ||
        (run.workflowVersion >= 3 && Boolean(run.state.requireApproval)),
    );
    const ids = new Set(nodes.map((node) => node.id));
    const edges = definition.edges.filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        !(
          Boolean(run.state.requireApproval) &&
          edge.source === 'summarize' &&
          edge.target === 'complete'
        ),
    );
    return {
      id: definition.id,
      name: definition.name,
      version: run.workflowVersion,
      nodes,
      edges,
    };
  }
}
