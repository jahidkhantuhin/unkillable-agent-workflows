import type { Db, MongoClient, Document, IndexDescription } from 'mongodb';
import {
  whatsappConnectionSchema,
  whatsappDecisionRecordSchema,
} from '@unkillable/shared';
import { NotificationConflict } from './notifications';
type Stored = Document & { _id: string };
export const whatsappIndexes: Record<string, IndexDescription[]> = {
  whatsappConnections: [{ key: { phone: 1 }, unique: true }],
  whatsappPairings: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  whatsappDecisions: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  whatsappNotifications: [
    { key: { approvalId: 1, version: 1, userId: 1 }, unique: true },
  ],
  whatsappMessages: [
    { key: { userId: 1, createdAt: -1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
};
export class WhatsAppRepository {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
    private readonly now: () => Date = () => new Date(),
  ) {}
  async connection(userId: string) {
    const row = await this.db
      .collection<Stored>('whatsappConnections')
      .findOne({ _id: userId });
    return row ? whatsappConnectionSchema.parse(row) : null;
  }
  async byPhone(phone: string) {
    const row = await this.db
      .collection<Stored>('whatsappConnections')
      .findOne({ phone });
    return row ? whatsappConnectionSchema.parse(row) : null;
  }
  async connections() {
    return (
      await this.db
        .collection<Stored>('whatsappConnections')
        .find({ enabled: true })
        .limit(100)
        .toArray()
    ).map((row) => whatsappConnectionSchema.parse(row));
  }
  async pairing(userId: string, hash: string) {
    await this.db.collection<Stored>('whatsappPairings').updateOne(
      { _id: userId },
      {
        $set: {
          userId,
          hash,
          expiresAt: new Date(this.now().getTime() + 600000),
        },
      },
      { upsert: true },
    );
  }
  async pairingOwner(hash: string) {
    const row = await this.db
      .collection<Stored>('whatsappPairings')
      .findOne({ hash, expiresAt: { $gt: this.now() } });
    return row ? String(row.userId) : null;
  }
  async pair(hash: string, phone: string) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const row = await this.db
          .collection<Stored>('whatsappPairings')
          .findOneAndDelete(
            { hash, expiresAt: { $gt: this.now() } },
            { session },
          );
        if (!row) throw new NotificationConflict();
        const now = this.now();
        await this.db.collection<Stored>('whatsappConnections').replaceOne(
          { _id: row.userId },
          {
            _id: row.userId,
            ...whatsappConnectionSchema.parse({
              userId: row.userId,
              phone,
              enabled: true,
              lastInboundAt: now,
              linkedAt: now,
            }),
          },
          { upsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
  }
  async preferences(userId: string, enabled: boolean) {
    await this.db
      .collection<Stored>('whatsappConnections')
      .updateOne({ _id: userId }, { $set: { enabled } });
  }
  async touch(phone: string) {
    await this.db
      .collection<Stored>('whatsappConnections')
      .updateOne({ phone }, { $set: { lastInboundAt: this.now() } });
  }
  async unlink(userId: string) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db
          .collection<Stored>('whatsappConnections')
          .deleteOne({ _id: userId }, { session });
        await this.db
          .collection<Stored>('whatsappPairings')
          .deleteOne({ _id: userId }, { session });
      });
    } finally {
      await session.endSession();
    }
  }
  async decision(value: ReturnType<typeof whatsappDecisionRecordSchema.parse>) {
    const parsed = whatsappDecisionRecordSchema.parse(value);
    await this.db
      .collection<Stored>('whatsappDecisions')
      .insertOne({ _id: parsed.hash, ...parsed });
  }
  async findDecision(hash: string, phone: string) {
    const row = await this.db
      .collection<Stored>('whatsappDecisions')
      .findOne({ _id: hash, phone, expiresAt: { $gt: this.now() } });
    return row ? whatsappDecisionRecordSchema.parse(row) : null;
  }
  async inbound(sid: string, hash: string) {
    const rows = this.db.collection<Stored>('whatsappInbound');
    try {
      await rows.updateOne(
        { _id: sid },
        { $setOnInsert: { hash, done: false, leaseUntil: new Date(0) } },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const row = await rows.findOne({ _id: sid });
    if (!row || row.hash !== hash) throw new NotificationConflict();
    if (row.done) return { response: String(row.response), claimed: false };
    const changed = await rows.updateOne(
      { _id: sid, done: false, leaseUntil: { $lte: this.now() } },
      { $set: { leaseUntil: new Date(this.now().getTime() + 60000) } },
    );
    return { response: null, claimed: changed.modifiedCount === 1 };
  }
  async inboundDone(sid: string, response: string) {
    await this.db
      .collection<Stored>('whatsappInbound')
      .updateOne({ _id: sid }, { $set: { done: true, response } });
  }
  async manualSlot(userId: string) {
    const row = await this.db
      .collection<Stored>('whatsappConnections')
      .findOneAndUpdate(
        {
          _id: userId,
          $or: [
            { manualAfter: { $exists: false } },
            { manualAfter: { $lte: this.now() } },
          ],
        },
        { $set: { manualAfter: new Date(this.now().getTime() + 60000) } },
      );
    return !!row;
  }
  async refresh(userId: string) {
    await this.db
      .collection<Stored>('whatsappNotifications')
      .updateMany(
        { userId },
        { $set: { status: 'pending', nextAt: this.now(), attempts: 0 } },
      );
  }
  async claim(approvalId: string, version: number, userId: string) {
    const key = `${approvalId}:${version}:${userId}`,
      rows = this.db.collection<Stored>('whatsappNotifications');
    try {
      await rows.updateOne(
        { _id: key },
        {
          $setOnInsert: {
            approvalId,
            version,
            userId,
            status: 'pending',
            attempts: 0,
            nextAt: this.now(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const row = await rows.findOneAndUpdate(
      {
        _id: key,
        status: { $ne: 'sent' },
        attempts: { $lt: 5 },
        nextAt: { $lte: this.now() },
      },
      {
        $inc: { attempts: 1 },
        $set: { nextAt: new Date(this.now().getTime() + 60000) },
      },
    );
    return row ? key : null;
  }
  async sent(key: string) {
    await this.db
      .collection<Stored>('whatsappNotifications')
      .updateOne(
        { _id: key },
        { $set: { status: 'sent', sentAt: this.now() } },
      );
  }
  async track(sid: string, userId: string) {
    await this.db.collection<Stored>('whatsappMessages').updateOne(
      { _id: sid },
      {
        $setOnInsert: {
          status: 'queued',
          rank: 0,
          createdAt: this.now(),
          expiresAt: new Date(this.now().getTime() + 7 * 86400000),
        },
        $set: { userId },
      },
      { upsert: true },
    );
  }
  async status(sid: string, status: string, errorCode?: string) {
    const rank = (
      {
        accepted: 0,
        queued: 1,
        sending: 2,
        sent: 3,
        delivered: 4,
        read: 5,
        failed: 4,
        undelivered: 4,
        canceled: 4,
      } as Record<string, number>
    )[status];
    try {
      await this.db.collection<Stored>('whatsappMessages').updateOne(
        {
          _id: sid,
          $or: [{ rank: { $lte: rank } }, { rank: { $exists: false } }],
        },
        {
          $set: {
            status,
            rank,
            errorCode: errorCode || null,
            updatedAt: this.now(),
          },
          $setOnInsert: {
            createdAt: this.now(),
            expiresAt: new Date(this.now().getTime() + 7 * 86400000),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  async failure(userId: string, message: string) {
    await this.db
      .collection<Stored>('whatsappConnections')
      .updateOne({ _id: userId }, { $set: { lastError: message } });
  }
  async lastMessage(userId: string) {
    return this.db
      .collection<Stored>('whatsappMessages')
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
  }
  async lastError(userId: string) {
    const row = await this.db
      .collection<Stored>('whatsappConnections')
      .findOne({ _id: userId });
    return typeof row?.lastError === 'string' ? row.lastError : null;
  }
  async clearError(userId: string) {
    await this.db
      .collection<Stored>('whatsappConnections')
      .updateOne({ _id: userId }, { $unset: { lastError: '' } });
  }
}
