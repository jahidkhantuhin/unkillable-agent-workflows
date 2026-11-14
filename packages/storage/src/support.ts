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
  type SupportMail,
} from '@unkillable/shared';
import { ReliabilityRepository } from './reliability';
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
  ) {
    const key = `${runId}:send_email:reply`;
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
          createdAt: now,
          updatedAt: now,
        });
        await this.db
          .collection<Stored>('fakeEmails')
          .insertOne({ ...record, _id: record.id }, { session });
        await enqueue('email', record.payload);
        return { id: record.id, messageId };
      },
      mailResultSchema,
    );
  }
  async close(ticketId: string, status: 'closed' | 'rejected') {
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
