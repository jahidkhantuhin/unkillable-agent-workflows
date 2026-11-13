import { randomUUID } from 'node:crypto';
import { type Db, type MongoClient, type Document } from 'mongodb';
import {
  runSchema,
  runEventSchema,
  workflowDefinitionSchema,
  canTransition,
  type Run,
  type RunStatus,
  type RunEvent,
  type EventInput,
} from '@unkillable/shared';
type Stored = Document & { _id: string };
export interface RunStore {
  create(userId: string, input: { message: string }): Promise<Run>;
  get(id: string): Promise<Run | null>;
  list(limit: number, status?: RunStatus): Promise<Run[]>;
  events(id: string, after: number, limit?: number): Promise<RunEvent[]>;
}
export class RunRepository implements RunStore {
  private readonly runs;
  private readonly log;
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {
    this.runs = db.collection<Stored>('runs');
    this.log = db.collection<Stored>('runEvents');
  }
  async create(userId: string, input: { message: string }) {
    const now = new Date();
    const run = runSchema.parse({
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      workflowId: 'durability-demo',
      workflowVersion: 1,
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
  async markDispatched(id: string) {
    await this.runs.updateOne(
      { _id: id, dispatchPending: true },
      { $set: { dispatchPending: false } },
    );
  }
  async definition(value: unknown) {
    const parsed = workflowDefinitionSchema.parse(value);
    await this.db
      .collection<Stored>('workflowDefinitions')
      .updateOne(
        { _id: parsed.id },
        { $setOnInsert: { ...parsed, _id: parsed.id } },
        { upsert: true },
      );
  }
  async append(
    id: string,
    input: EventInput,
    options: {
      key?: string;
      status?: RunStatus;
      state?: Record<string, unknown>;
      error?: string;
      dispatchPending?: boolean;
    } = {},
  ) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        if (options.key) {
          const previous = await this.log.findOne(
            { runId: id, key: options.key },
            { session },
          );
          if (previous) return runEventSchema.parse(previous);
        }
        const current = await this.runs.findOne({ _id: id }, { session });
        if (!current) throw new Error('Run not found');
        const run = runSchema.parse(current);
        if (options.status && !canTransition(run.status, options.status))
          throw new Error(
            `Invalid run transition: ${run.status} -> ${options.status}`,
          );
        if (
          !options.status &&
          ['succeeded', 'failed', 'cancelled', 'compensated'].includes(
            run.status,
          )
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
        await this.runs.updateOne({ _id: id }, { $set: next }, { session });
        await this.log.insertOne({ ...event, _id: event.id }, { session });
        return event;
      });
    } finally {
      await session.endSession();
    }
  }
}
