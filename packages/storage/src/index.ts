import { randomUUID } from 'node:crypto';
import {
  type Db,
  type MongoClient,
  type ClientSession,
  type Document,
} from 'mongodb';
import {
  runSchema,
  runEventSchema,
  workflowDefinitionSchema,
  canTransition,
  StaleExecutionError,
  type DemoInput,
  demoWorkflowVersion,
  supportStateSchema,
  supportWorkflowId,
  ticketDocumentSchema,
  type TicketInput,
  type Run,
  type RunStatus,
  type RunEvent,
  type EventInput,
} from '@unkillable/shared';
import { ReliabilityRepository } from './reliability';
import { ApprovalRepository } from './approvals';
import { SupportRepository } from './support';
import { SagaRepository } from './saga';
import { PolicyRepository } from './policies';
import { ModerationRepository } from './moderation';
import {
  moderationWorkflowId,
  moderationStateSchema,
  moderationItemSchema,
} from '@unkillable/shared';
type Stored = Document & { _id: string };
export interface RunStore {
  create(userId: string, input: DemoInput): Promise<Run>;
  get(id: string): Promise<Run | null>;
  list(limit: number, status?: RunStatus): Promise<Run[]>;
  events(id: string, after: number, limit?: number): Promise<RunEvent[]>;
}
export class RunRepository implements RunStore {
  moderation() {
    return new ModerationRepository(this.client, this.db);
  }
  async createModeration(
    userId: string,
    input: {
      title: string;
      file: ReturnType<typeof moderationStateSchema.parse>['file'];
    },
  ) {
    return this.createWorkflow(
      userId,
      moderationStateSchema.parse({ ...input, contentId: randomUUID() }),
      moderationWorkflowId,
      1,
    );
  }
  async chaosRunIds() {
    return this.runs.distinct('id') as Promise<string[]>;
  }
  policies() {
    return new PolicyRepository(this.client, this.db);
  }
  saga() {
    return new SagaRepository(this.client, this.db);
  }
  support() {
    return new SupportRepository(this.client, this.db);
  }
  approvals() {
    return new ApprovalRepository(this.client, this.db);
  }
  reliability() {
    return new ReliabilityRepository(this.client, this.db);
  }
  private readonly runs;
  private readonly log;
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {
    this.runs = db.collection<Stored>('runs');
    this.log = db.collection<Stored>('runEvents');
  }
  async create(userId: string, input: DemoInput) {
    return this.createWorkflow(
      userId,
      input,
      'durability-demo',
      demoWorkflowVersion,
    );
  }
  async createSupport(userId: string, input: TicketInput) {
    const ticketId = randomUUID();
    const state = supportStateSchema.parse({
      title: input.title,
      message: input.description,
      ticketId,
      ticket: input,
    });
    return this.createWorkflow(userId, state, supportWorkflowId, 1);
  }
  private async createWorkflow(
    userId: string,
    input: Record<string, unknown>,
    workflowId: string,
    workflowVersion: number,
  ) {
    const now = new Date();
    const run = runSchema.parse({
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      workflowId,
      workflowVersion,
      status: 'queued',
      state: input,
      sequence: 1,
      dispatchPending: true,
    });
    const event = runEventSchema.parse({
      id: randomUUID(),
      runId: run.id,
      threadId: run.id,
      sequence: 1,
      timestamp: Date.now(),
      type: 'CUSTOM',
      name: 'run.queued',
      value: { status: 'queued' },
      key: 'queued',
    });
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.runs.insertOne({ ...run, _id: run.id }, { session });
        if (workflowId === moderationWorkflowId) {
          const state = moderationStateSchema.parse(input);
          const item = moderationItemSchema.parse({
            id: state.contentId,
            runId: run.id,
            title: state.title,
            file: state.file,
            status: 'queued',
            createdAt: now,
            updatedAt: now,
          });
          await this.db
            .collection<Stored>('moderationItems')
            .insertOne({ ...item, _id: item.id }, { session });
        }
        if (workflowId === supportWorkflowId) {
          const state = supportStateSchema.parse(input);
          const ticket = ticketDocumentSchema.parse({
            ...state.ticket,
            id: state.ticketId,
            runId: run.id,
            status: 'open',
            createdAt: now,
            updatedAt: now,
          });
          await this.db
            .collection<Stored>('tickets')
            .insertOne({ ...ticket, _id: ticket.id }, { session });
        }
        await this.log.insertOne({ ...event, _id: event.id }, { session });
      });
    } finally {
      await session.endSession();
    }
    return run;
  }
  async get(id: string) {
    const value = await this.runs.findOne({ _id: id });
    return value ? runSchema.parse(value) : null;
  }
  async list(limit = 50, status?: RunStatus) {
    const docs = await this.runs
      .find(status ? { status } : {})
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();
    return docs.map((value) => runSchema.parse(value));
  }
  async events(runId: string, after = 0, limit = 200) {
    return (
      await this.log
        .find({ runId, sequence: { $gt: after } })
        .sort({ sequence: 1 })
        .limit(limit)
        .toArray()
    ).map((value) => runEventSchema.parse(value));
  }
  async pendingDispatch() {
    return (
      await this.runs
        .find({ status: 'queued', dispatchPending: true })
        .limit(100)
        .toArray()
    ).map((value) => runSchema.parse(value));
  }
  async markDispatched(id: string, execution?: number) {
    await this.runs.updateOne(
      {
        _id: id,
        dispatchPending: true,
        ...(execution === undefined ? {} : { execution }),
      },
      { $set: { dispatchPending: false } },
    );
  }
  async definition(value: unknown) {
    const parsed = workflowDefinitionSchema.parse(value);
    await this.db
      .collection<Stored>('workflowDefinitions')
      .updateOne(
        { id: parsed.id, version: parsed.version },
        { $setOnInsert: { ...parsed, _id: `${parsed.id}:v${parsed.version}` } },
        { upsert: true },
      );
  }
  async getDefinition(id: string, version: number) {
    const doc = await this.db
      .collection('workflowDefinitions')
      .findOne({ id, version });
    return doc ? workflowDefinitionSchema.parse(doc) : null;
  }
  async pendingOutboxCount(runId: string) {
    return this.db
      .collection('outbox')
      .countDocuments({ runId, status: 'pending' });
  }
  async getInSession(id: string, session: ClientSession) {
    const value = await this.runs.findOne({ _id: id }, { session });
    return value ? runSchema.parse(value) : null;
  }
  async append(id: string, input: EventInput, options: RunUpdate = {}) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() =>
        this.appendInSession(id, input, options, session),
      );
    } finally {
      await session.endSession();
    }
  }
  async appendInSession(
    id: string,
    input: EventInput,
    options: RunUpdate,
    session: ClientSession,
  ) {
    const run = await this.getInSession(id, session);
    if (!run) throw new Error('Run not found');
    if (
      options.expectedStatus !== undefined &&
      run.status !== options.expectedStatus
    )
      throw new StaleExecutionError();
    if (
      options.expectedExecution !== undefined &&
      run.execution !== options.expectedExecution
    )
      throw new StaleExecutionError();
    if (options.key) {
      const previous = await this.log.findOne(
        { runId: id, key: options.key },
        { session },
      );
      if (previous) return runEventSchema.parse(previous);
    }
    if (options.status && !canTransition(run.status, options.status))
      throw new Error(
        'Invalid run transition: ' + run.status + ' -> ' + options.status,
      );
    if (
      !options.status &&
      !options.allowTerminal &&
      ['succeeded', 'failed', 'cancelled', 'compensated'].includes(run.status)
    )
      return null;
    const next = runSchema.parse({
      ...run,
      ...options,
      sequence: run.sequence + 1,
      updatedAt: new Date(),
    });
    const event = runEventSchema.parse({
      ...input,
      id: randomUUID(),
      runId: id,
      threadId: id,
      sequence: next.sequence,
      timestamp: Date.now(),
      ...(options.key ? { key: options.key } : {}),
    });
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    );
    await this.runs.replaceOne({ _id: id }, { ...clean, _id: id }, { session });
    await this.log.insertOne({ ...event, _id: event.id }, { session });
    return event;
  }
}
export type RunUpdate = {
  expectedStatus?: RunStatus;
  key?: string;
  status?: RunStatus;
  state?: Record<string, unknown>;
  error?: string;
  dispatchPending?: boolean;
  execution?: number;
  expectedExecution?: number;
  allowTerminal?: boolean;
};
export * from './reliability';
export * from './approvals';
export * from './support';
export * from './saga';
export * from './chaos-runtime';
export * from './policies';
export * from './moderation';
export * from './content-files';
