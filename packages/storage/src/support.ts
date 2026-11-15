import { createHash, randomUUID } from 'node:crypto';
import type {
  MongoClient,
  Db,
  ClientSession,
  Document,
  IndexDescription,
} from 'mongodb';
import {
  fakeRefundSchema,
  fakeEmailSchema,
  refundResultSchema,
  mailResultSchema,
  supportMailSchema,
  supportExamples,
  ticketInputSchema,
  PermanentError,
  effectResultSchema,
  type SupportMail,
} from '@unkillable/shared';
import { ReliabilityRepository } from './reliability';
import { RunRepository } from './index';
type Stored = Document & { _id: string };
export class SupportRepository {
  private readonly reliability;
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
  ) {
    this.reliability = new ReliabilityRepository(client, db);
  }
  async seedExamples() {
    for (const example of supportExamples)
      await this.db
        .collection<Stored>('ticketExamples')
        .updateOne(
          { _id: example.id },
          { $setOnInsert: { ...example, _id: example.id } },
          { upsert: true },
        );
  }
  async examples() {
    const stored = await this.db
      .collection('ticketExamples')
      .find({})
      .toArray();
    return (stored.length ? stored : supportExamples).map((value) => ({
      id: String(value.id),
      ...ticketInputSchema.parse(
        Object.fromEntries(
          Object.entries(value).filter(
            ([key]) => key !== '_id' && key !== 'id',
          ),
        ),
      ),
    }));
  }
  async refund(runId: string, ticketId: string, amountCents: number) {
    const key = `${runId}:issue_refund:refund`;
    return this.reliability.executeOnce(
      key,
      async ({ session }) => {
        const record = fakeRefundSchema.parse({
          id: randomUUID(),
          key,
          runId,
          ticketId,
          amountCents,
          currency: 'USD',
          createdAt: new Date(),
        });
        await this.db
          .collection<Stored>('fakeRefunds')
          .insertOne({ ...record, _id: record.id }, { session });
        await this.effect(runId, 'issue_refund', session);
        return {
          id: record.id,
          amountCents: record.amountCents,
          currency: record.currency,
        };
      },
      refundResultSchema,
    );
  }
  async queueEmail(
    runId: string,
    ticketId: string,
    input: Omit<SupportMail, 'messageId'>,
    node = 'send_email',
  ) {
    const key = `${runId}:${node}:reply`;
    const messageId = `<${createHash('sha256').update(key).digest('hex')}@unkillable.test>`;
    return this.reliability.executeOnce(
      key,
      async ({ session, enqueue }) => {
        const now = new Date();
        const record = fakeEmailSchema.parse({
          id: randomUUID(),
          key,
          runId,
          ticketId,
          payload: supportMailSchema.parse({ ...input, messageId }),
          status: 'queued',
          purpose: node === 'send_email' ? 'reply' : 'correction',
          createdAt: now,
          updatedAt: now,
        });
        await this.db
          .collection<Stored>('fakeEmails')
          .insertOne({ ...record, _id: record.id }, { session });
        await enqueue('email', record.payload);
        if (node === 'send_correction_or_void')
          await this.db
            .collection('fakeEmails')
            .updateOne(
              { key: `${runId}:send_email:reply` },
              { $set: { voided: true, updatedAt: now } },
              { session },
            );
        if (node === 'send_email') await this.effect(runId, node, session);
        return { id: record.id, messageId };
      },
      mailResultSchema,
    );
  }
  private async effect(runId: string, node: string, session: ClientSession) {
    const runs = new RunRepository(this.client, this.db);
    const run = await runs.getInSession(runId, session);
    if (!run || run.status !== 'running')
      throw new PermanentError('Forward effects require a running workflow');
    await runs.appendInSession(
      runId,
      { type: 'CUSTOM', name: 'effect.completed', value: { nodeId: node } },
      { key: `effect:${node}` },
      session,
    );
  }
  async close(ticketId: string, status: 'closed' | 'rejected', runId?: string) {
    if (status === 'closed' && runId) {
      await this.reliability.executeOnce(
        `${runId}:close_ticket:close`,
        async ({ session }) => {
          const result = await this.db
            .collection('tickets')
            .updateOne(
              { id: ticketId },
              { $set: { status, updatedAt: new Date() } },
              { session },
            );
          if (result.matchedCount !== 1)
            throw new PermanentError('Ticket to close was not found');
          await this.effect(runId, 'close_ticket', session);
          return { receipt: ticketId };
        },
        effectResultSchema,
      );
      return;
    }
    const result = await this.db
      .collection('tickets')
      .updateOne({ id: ticketId }, { $set: { status, updatedAt: new Date() } });
    if (result.matchedCount !== 1)
      throw new PermanentError('Ticket to close was not found');
  }
  async ticket(id: string, session?: ClientSession) {
    return this.db.collection('tickets').findOne({ id }, { session });
  }
}
export const supportIndexes: Record<string, IndexDescription[]> = {
  tickets: [
    { key: { runId: 1 }, unique: true },
    { key: { status: 1, createdAt: -1 } },
  ],
  fakeRefunds: [{ key: { key: 1 }, unique: true }, { key: { runId: 1 } }],
  fakeEmails: [{ key: { key: 1 }, unique: true }, { key: { runId: 1 } }],
  ticketExamples: [{ key: { id: 1 }, unique: true }],
};
