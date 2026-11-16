import { randomUUID } from 'node:crypto';
import {
  type MongoClient,
  type Db,
  type ClientSession,
  type Document,
  type IndexDescription,
} from 'mongodb';
import {
  idempotencyKeySchema,
  outboxSchema,
  localDeliverySchema,
  attemptSchema,
  deadLetterSchema,
  classifyError,
  PermanentError,
  StaleExecutionError,
  effectResultSchema,
  retryDelay,
  defaultRetryPolicy,
  type AttemptStore,
  type RetryPolicy,
  fakeRefundSchema,
  fakeEmailSchema,
  supportMailSchema,
  type SupportMail,
} from '@unkillable/shared';
import { RunRepository } from './index';
type Stored = Document & { _id: string };
export class ConflictError extends Error {
  constructor() {
    super('This dead letter has changed or is already resolved');
  }
}
export type EffectTransaction = {
  session: ClientSession;
  enqueue: (
    kind: 'notification' | 'email' | 'payment',
    payload: Record<string, unknown>,
  ) => Promise<string>;
};
export class ReliabilityRepository {
  private readonly runs;
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
    private readonly now = () => new Date(),
  ) {
    this.runs = new RunRepository(client, db);
  }
  /** Callback may be re-entered after a rolled-back transaction. Only session-bound MongoDB effects belong here. */
  async executeOnce<T>(
    key: string,
    fn: (transaction: EffectTransaction) => Promise<T>,
    resultSchema: { parse(value: unknown): T },
  ): Promise<T> {
    const [runId, nodeId, ...suffix] = key.split(':');
    if (!runId || !nodeId || !suffix.join(':'))
      throw new PermanentError(
        'Idempotency keys require runId:nodeId:stable-key',
      );
    const keys = this.db.collection<Stored>('idempotencyKeys');
    const existing = await keys.findOne({ key });
    if (existing?.status === 'completed')
      return resultSchema.parse(idempotencyKeySchema.parse(existing).result);
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const previous = await keys.findOne({ key }, { session });
        if (previous?.status === 'completed')
          return resultSchema.parse(
            idempotencyKeySchema.parse(previous).result,
          );
        const now = this.now();
        const receipt = idempotencyKeySchema.parse({
          id: randomUUID(),
          key,
          runId,
          nodeId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        });
        await keys.insertOne({ ...receipt, _id: receipt.id }, { session });
        const result = resultSchema.parse(
          await fn({
            session,
            enqueue: async (kind, payload) => {
              const record = outboxSchema.parse({
                id: randomUUID(),
                runId,
                key,
                kind,
                payload,
                status: 'pending',
                attempts: 0,
                availableAt: now,
                createdAt: now,
                updatedAt: now,
              });
              await this.db
                .collection<Stored>('outbox')
                .insertOne({ ...record, _id: record.id }, { session });
              return record.id;
            },
          }),
        );
        await keys.updateOne(
          { key },
          { $set: { status: 'completed', result, updatedAt: this.now() } },
          { session },
        );
        return result;
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 11000
      ) {
        const winner = await keys.findOne({ key });
        if (winner?.status === 'completed')
          return resultSchema.parse(idempotencyKeySchema.parse(winner).result);
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
  attemptStore(runId: string, nodeId: string, execution: number): AttemptStore {
    const collection = this.db.collection<Stored>('nodeAttempts');
    const key = `${runId}:${execution}:${nodeId}`;
    const load = async (session?: ClientSession) => {
      const doc = await collection.findOne({ key }, { session });
      return doc ? attemptSchema.parse(doc) : null;
    };
    const update = async (
      change: (
        current: NonNullable<Awaited<ReturnType<typeof load>>>,
        session: ClientSession,
      ) => Promise<void>,
    ) => {
      const session = this.client.startSession();
      try {
        await session.withTransaction(async () => {
          const run = await this.runs.getInSession(runId, session);
          if (!run || run.execution !== execution)
            throw new StaleExecutionError();
          const current = await load(session);
          if (!current) throw new Error('Attempt not started');
          await change(current, session);
        });
      } finally {
        await session.endSession();
      }
    };
    return {
      load: () => load(),
      start: async (policy: RetryPolicy) => {
        const session = this.client.startSession();
        try {
          return await session.withTransaction(async () => {
            const run = await this.runs.getInSession(runId, session);
            if (!run || run.execution !== execution || run.status !== 'running')
              throw new StaleExecutionError();
            const current = await load(session);
            const now = this.now();
            const attempt = attemptSchema.parse({
              ...current,
              id: current?.id ?? randomUUID(),
              key,
              runId,
              nodeId,
              execution,
              attempt: current
                ? current.status === 'retrying'
                  ? current.attempt + 1
                  : current.attempt
                : 1,
              status: 'running',
              policy: current?.policy ?? policy,
              createdAt: current?.createdAt ?? now,
              updatedAt: now,
            });
            await collection.replaceOne(
              { key },
              { ...attempt, _id: attempt.id },
              { session, upsert: true },
            );
            await this.runs.appendInSession(
              runId,
              {
                type: 'CUSTOM',
                name: 'node.attempt',
                value: { nodeId, attempt: attempt.attempt, execution },
              },
              {
                key: `attempt:${execution}:${nodeId}:${attempt.attempt}`,
                expectedExecution: execution,
              },
              session,
            );
            return attempt;
          });
        } finally {
          await session.endSession();
        }
      },
      retry: (error, delayMs) =>
        update(async (current, session) => {
          const nextAttemptAt = new Date(this.now().getTime() + delayMs);
          await collection.updateOne(
            { key },
            {
              $set: {
                status: 'retrying',
                error,
                nextAttemptAt,
                updatedAt: this.now(),
              },
            },
            { session },
          );
          await this.runs.appendInSession(
            runId,
            {
              type: 'CUSTOM',
              name: 'retry.scheduled',
              value: {
                nodeId,
                attempt: current.attempt,
                nextAttempt: current.attempt + 1,
                delayMs,
                nextAttemptAt: nextAttemptAt.toISOString(),
                error,
                execution,
              },
            },
            {
              key: `retry:${execution}:${nodeId}:${current.attempt}`,
              expectedExecution: execution,
            },
            session,
          );
        }),
      succeed: () =>
        update(async (_current, session) => {
          await collection.updateOne(
            { key },
            {
              $set: { status: 'succeeded', updatedAt: this.now() },
              $unset: { nextAttemptAt: '', error: '' },
            },
            { session },
          );
        }),
      fail: (error) =>
        update(async (_current, session) => {
          await collection.updateOne(
            { key },
            {
              $set: { status: 'failed', error, updatedAt: this.now() },
              $unset: { nextAttemptAt: '' },
            },
            { session },
          );
        }),
    };
  }
  async latestFailure(runId: string, execution: number) {
    const doc = await this.db
      .collection('nodeAttempts')
      .findOne(
        { runId, execution, status: 'failed' },
        { sort: { updatedAt: -1 } },
      );
    return doc ? attemptSchema.parse(doc) : null;
  }
  async recordFailure(
    runId: string,
    execution: number,
    error: unknown,
    context: Record<string, unknown> = {},
  ) {
    const failure = await this.latestFailure(runId, execution);
    const info = failure?.error ?? classifyError(error);
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const run = await this.runs.getInSession(runId, session);
        if (
          !run ||
          run.execution !== execution ||
          run.status === 'waiting_approval' ||
          run.status === 'compensating' ||
          [
            'succeeded',
            'failed',
            'discarded',
            'cancelled',
            'compensated',
          ].includes(run.status)
        )
          return;
        const now = this.now();
        const letter = deadLetterSchema.parse({
          id: randomUUID(),
          runId,
          nodeId: failure?.nodeId ?? 'worker',
          execution,
          version: 0,
          attempts: failure?.attempt ?? Number(context.attempts ?? 1),
          error: info,
          context: {
            ...context,
            state: run.state,
            workflowId: run.workflowId,
            workflowVersion: run.workflowVersion,
            policy: failure?.policy ?? null,
          },
          status: 'open',
          createdAt: now,
          updatedAt: now,
        });
        await this.db
          .collection<Stored>('deadLetters')
          .insertOne({ ...letter, _id: letter.id }, { session });
        // A failed support run must not keep sending a pending reply behind its DLQ record.
        await this.db.collection('outbox').updateMany(
          { runId, kind: 'email', status: 'pending' },
          {
            $set: {
              status: 'failed',
              lastError: info.message,
              updatedAt: now,
            },
          },
          { session },
        );
        await this.runs.appendInSession(
          runId,
          { type: 'RUN_ERROR', code: info.code, message: info.message },
          {
            key: `run:failed:${execution}`,
            status: 'failed',
            error: info.message,
            expectedExecution: execution,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }
  async deadLetters() {
    return (
      await this.db
        .collection('deadLetters')
        .find()
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray()
    ).map((doc) => deadLetterSchema.parse(doc));
  }
  async deadLetter(id: string) {
    const doc = await this.db
      .collection<Stored>('deadLetters')
      .findOne({ _id: id });
    return doc ? deadLetterSchema.parse(doc) : null;
  }
  async resolveDeadLetter(
    id: string,
    version: number,
    action: 'retry' | 'discard',
    actorId: string,
  ) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const doc = await this.db
          .collection<Stored>('deadLetters')
          .findOne({ _id: id }, { session });
        if (!doc) return null;
        const letter = deadLetterSchema.parse(doc);
        const run = await this.runs.getInSession(letter.runId, session);
        if (
          letter.version !== version ||
          letter.status !== 'open' ||
          !run ||
          run.status !== 'failed' ||
          run.execution !== letter.execution
        )
          throw new ConflictError();
        await this.db.collection<Stored>('deadLetters').updateOne(
          { _id: id, version },
          {
            $set: {
              status: action === 'retry' ? 'retried' : 'discarded',
              updatedAt: this.now(),
              context: { ...letter.context, resolvedBy: actorId },
            },
            $inc: { version: 1 },
          },
          { session },
        );
        await this.runs.appendInSession(
          run.id,
          {
            type: 'CUSTOM',
            name: action === 'retry' ? 'run.retried' : 'deadletter.discarded',
            value: {
              deadLetterId: id,
              actorId,
              execution: run.execution + (action === 'retry' ? 1 : 0),
            },
          },
          {
            key: `deadletter:${id}:${action}`,
            expectedExecution: run.execution,
            allowTerminal: true,
            ...(action === 'retry'
              ? {
                  status: 'queued',
                  execution: run.execution + 1,
                  dispatchPending: true,
                  error: undefined,
                }
              : {}),
          },
          session,
        );
        return letter.runId;
      });
    } finally {
      await session.endSession();
    }
  }
  async details(runId: string) {
    const keys = (
      await this.db.collection('idempotencyKeys').find({ runId }).toArray()
    ).map((doc) => idempotencyKeySchema.parse(doc));
    const outbox = (
      await this.db.collection('outbox').find({ runId }).toArray()
    ).map((doc) => outboxSchema.parse(doc));
    const deliveries = (
      await this.db.collection('localDeliveries').find({ runId }).toArray()
    ).map((doc) => localDeliverySchema.parse(doc));
    const refunds = (
      await this.db.collection('fakeRefunds').find({ runId }).toArray()
    ).map((value) => fakeRefundSchema.parse(value));
    const emails = (
      await this.db.collection('fakeEmails').find({ runId }).toArray()
    ).map((value) => fakeEmailSchema.parse(value));
    return { keys, outbox, deliveries, refunds, emails };
  }
  /** SMTP is outside Mongo transactions. Stable Message-IDs require Mailpit receiver deduplication. */
  async deliverEmail(
    key: string,
    deliver: (mail: SupportMail) => Promise<void>,
  ) {
    const doc = await this.db.collection<Stored>('outbox').findOne({ key });
    if (!doc) throw new PermanentError('Email intent not found');
    const record = outboxSchema.parse(doc);
    if (record.status === 'sent') return;
    const run = await this.runs.get(record.runId);
    if (
      key === `${record.runId}:send_email:reply` &&
      ['compensating', 'compensated'].includes(run?.status ?? '')
    )
      throw new PermanentError('Forward email is blocked during compensation');
    if (record.kind !== 'email')
      throw new PermanentError('Not an email intent');
    if (record.status === 'failed')
      await this.db.collection<Stored>('outbox').updateOne(
        { _id: record.id, status: 'failed' },
        {
          $set: { status: 'pending', updatedAt: this.now() },
          $unset: { lastError: '' },
        },
      );
    try {
      await deliver(supportMailSchema.parse(record.payload));
      await this.executeOnce(
        `${key}:delivery`,
        async ({ session }) => {
          const row = localDeliverySchema.parse({
            id: randomUUID(),
            key,
            runId: record.runId,
            outboxId: record.id,
            payload: record.payload,
            createdAt: this.now(),
          });
          await this.db
            .collection<Stored>('localDeliveries')
            .insertOne({ ...row, _id: row.id }, { session });
          await this.db.collection<Stored>('outbox').updateOne(
            { _id: record.id },
            {
              $set: {
                status: 'sent',
                sentAt: this.now(),
                updatedAt: this.now(),
              },
              $inc: { attempts: 1 },
              $unset: { lastError: '' },
            },
            { session },
          );
          await this.db
            .collection('fakeEmails')
            .updateOne(
              { key },
              { $set: { status: 'sent', updatedAt: this.now() } },
              { session },
            );
          await this.runs.appendInSession(
            record.runId,
            {
              type: 'CUSTOM',
              name: 'outbox.delivered',
              value: { key, outboxId: record.id, kind: 'email' },
            },
            { key: `outbox:${record.id}:sent`, allowTerminal: true },
            session,
          );
          return { receipt: key };
        },
        effectResultSchema,
      );
    } catch (error) {
      await this.failOutbox(record.id, error);
      throw error;
    }
  }
  /** Local MongoDB sink only: the receipt, delivery, outbox ACK, and audit event share one transaction. */
  async dispatchOutbox(
    limit = 25,
    deliverEmail?: (mail: SupportMail) => Promise<void>,
  ) {
    const records = await this.db
      .collection('outbox')
      .find({ status: 'pending', availableAt: { $lte: this.now() } })
      .sort({ availableAt: 1 })
      .limit(limit)
      .toArray();
    for (const doc of records) {
      const record = outboxSchema.parse(doc);
      if (record.kind === 'email') {
        // Support SMTP belongs to the node/compensator, so maintenance cannot race rollback.
        if (
          record.key.includes(':send_email:') ||
          record.key.includes(':send_correction_or_void:')
        )
          continue;
        if (deliverEmail)
          await this.deliverEmail(record.key, deliverEmail).catch(() => {});
        continue;
      }
      try {
        if (record.kind !== 'notification')
          throw new PermanentError(
            'No local delivery adapter for this outbox kind',
          );
        await this.executeOnce(
          `${record.key}:delivery`,
          async ({ session }) => {
            if (record.payload.kind === 'moderation') {
              const claimed = await this.db.collection('runs').updateOne(
                {
                  id: record.runId,
                  status: { $in: ['running', 'succeeded'] },
                },
                { $inc: { effectFence: 1 } },
                { session },
              );
              if (!claimed.matchedCount)
                throw new PermanentError(
                  'Moderation delivery stopped for compensation',
                );
              const current = await this.db
                .collection('outbox')
                .findOne({ key: record.key, status: 'pending' }, { session });
              if (!current)
                throw new PermanentError('Moderation notice was withdrawn');
            }
            const delivery = localDeliverySchema.parse({
              id: randomUUID(),
              key: record.key,
              runId: record.runId,
              outboxId: record.id,
              payload: record.payload,
              createdAt: this.now(),
            });
            await this.db
              .collection<Stored>('localDeliveries')
              .insertOne({ ...delivery, _id: delivery.id }, { session });
            await this.db.collection<Stored>('outbox').updateOne(
              { _id: record.id, status: 'pending' },
              {
                $set: {
                  status: 'sent',
                  sentAt: this.now(),
                  updatedAt: this.now(),
                },
                $inc: { attempts: 1 },
              },
              { session },
            );
            await this.runs.appendInSession(
              record.runId,
              {
                type: 'CUSTOM',
                name: 'outbox.delivered',
                value: { key: record.key, outboxId: record.id },
              },
              { key: `outbox:${record.id}:sent`, allowTerminal: true },
              session,
            );
            return { receipt: record.key };
          },
          effectResultSchema,
        );
      } catch (error) {
        await this.failOutbox(record.id, error);
      }
    }
  }
  private async failOutbox(id: string, error: unknown) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const doc = await this.db
          .collection<Stored>('outbox')
          .findOne({ _id: id, status: 'pending' }, { session });
        if (!doc) return;
        const record = outboxSchema.parse(doc);
        const info = classifyError(error);
        const attempts = record.attempts + 1;
        const failed = info.classification === 'permanent' || attempts >= 3;
        await this.db.collection<Stored>('outbox').updateOne(
          { _id: id },
          {
            $set: {
              attempts,
              status: failed ? 'failed' : 'pending',
              lastError: info.message,
              updatedAt: this.now(),
              availableAt: new Date(
                this.now().getTime() + retryDelay(defaultRetryPolicy, attempts),
              ),
            },
          },
          { session },
        );
        if (failed)
          await this.runs.appendInSession(
            record.runId,
            {
              type: 'CUSTOM',
              name: 'outbox.failed',
              value: { outboxId: id, error: info },
            },
            { key: `outbox:${id}:failed`, allowTerminal: true },
            session,
          );
      });
    } finally {
      await session.endSession();
    }
  }
}
export const reliabilityIndexes: Record<string, IndexDescription[]> = {
  idempotencyKeys: [{ key: { key: 1 }, unique: true }],
  deadLetters: [
    { key: { runId: 1 } },
    { key: { status: 1, createdAt: 1 } },
    { key: { runId: 1, execution: 1 }, unique: true },
  ],
  outbox: [
    { key: { key: 1 }, unique: true },
    { key: { status: 1, availableAt: 1 } },
  ],
  nodeAttempts: [
    { key: { key: 1 }, unique: true },
    { key: { runId: 1, execution: 1, status: 1, updatedAt: -1 } },
  ],
  localDeliveries: [{ key: { key: 1 }, unique: true }, { key: { runId: 1 } }],
};
export async function bootstrapReliabilityIndexes(db: Db) {
  for (const [name, indexes] of Object.entries(reliabilityIndexes))
    await db.collection(name).createIndexes(indexes);
}
