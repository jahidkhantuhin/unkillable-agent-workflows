import type {
  Db,
  MongoClient,
  ClientSession,
  Document,
  IndexDescription,
} from 'mongodb';
import {
  signedDecisionSchema,
  notificationPreferenceRecordSchema,
  type SignedDecision,
} from '@unkillable/shared';
type Stored = Document & { _id: string };
export const notificationIndexes: Record<string, IndexDescription[]> = {
  notificationSettings: [
    {
      key: { telegramUserId: 1 },
      unique: true,
      partialFilterExpression: { telegramUserId: { $type: 'string' } },
    },
  ],
  approvalLinks: [
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    { key: { hash: 1 }, unique: true },
  ],
  telegramPairings: [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  approvalNotifications: [
    { key: { approvalId: 1, version: 1, userId: 1 }, unique: true },
  ],
};
export class NotificationConflict extends Error {
  constructor() {
    super(
      'This link has expired, was already used, or the approval has changed. Open the Approval Inbox.',
    );
  }
}
export class NotificationRepository {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db = client.db(),
    private readonly now: () => Date = () => new Date(),
  ) {}
  async settings(userId: string) {
    const row = await this.db
      .collection<Stored>('notificationSettings')
      .findOne({ _id: userId });
    return row ? notificationPreferenceRecordSchema.parse(row) : null;
  }
  async preferences(userId: string, telegram: boolean) {
    await this.db
      .collection<Stored>('notificationSettings')
      .updateOne(
        { _id: userId },
        { $set: { userId, telegram } },
        { upsert: true },
      );
  }
  async unlink(userId: string) {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        await this.db.collection<Stored>('notificationSettings').updateOne(
          { _id: userId },
          {
            $set: { telegram: false },
            $unset: { telegramUserId: '', chatId: '' },
          },
          { session },
        );
        await this.db
          .collection<Stored>('telegramPairings')
          .deleteOne({ _id: userId }, { session });
      });
    } finally {
      await session.endSession();
    }
  }
  async pairing(userId: string, hash: string) {
    await this.db.collection<Stored>('telegramPairings').updateOne(
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
      .collection<Stored>('telegramPairings')
      .findOne({ hash, expiresAt: { $gt: this.now() } });
    return row ? String(row.userId) : null;
  }
  async pair(hash: string, telegramUserId: string, chatId: string) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const pair = await this.db
          .collection<Stored>('telegramPairings')
          .findOneAndDelete(
            { hash, expiresAt: { $gt: this.now() } },
            { session },
          );
        if (!pair) throw new NotificationConflict();
        await this.db.collection<Stored>('notificationSettings').updateOne(
          { _id: pair.userId },
          {
            $set: {
              userId: pair.userId,
              telegramUserId,
              chatId,
              telegram: true,
            },
          },
          { upsert: true, session },
        );
        return String(pair.userId);
      });
    } finally {
      await session.endSession();
    }
  }
  async telegramIdentity(telegramUserId: string, chatId: string) {
    const row = await this.db
      .collection<Stored>('notificationSettings')
      .findOne({ telegramUserId, chatId, telegram: true });
    return row ? notificationPreferenceRecordSchema.parse(row) : null;
  }
  async recipients() {
    return (
      await this.db
        .collection<Stored>('notificationSettings')
        .find({
          telegram: true,
          telegramUserId: { $type: 'string' },
          chatId: { $type: 'string' },
        })
        .limit(100)
        .toArray()
    ).map((row) => notificationPreferenceRecordSchema.parse(row));
  }
  async link(hash: string, payload: SignedDecision) {
    await this.db.collection<Stored>('approvalLinks').insertOne({
      _id: payload.jti,
      hash,
      payload,
      actorId: payload.actorId,
      expiresAt: new Date(payload.exp * 1000),
      used: false,
    });
  }
  async payload(jti: string) {
    const row = await this.db
      .collection<Stored>('approvalLinks')
      .findOne({ _id: jti });
    return row ? signedDecisionSchema.parse(row.payload) : null;
  }
  async available(hash: string, actorId: string) {
    if (
      !(await this.db.collection<Stored>('approvalLinks').findOne({
        hash,
        actorId,
        used: false,
        expiresAt: { $gt: this.now() },
      }))
    )
      throw new NotificationConflict();
  }
  async consume<T>(
    hash: string,
    actorId: string,
    operation: (session: ClientSession) => Promise<T>,
  ) {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(async () => {
        const result = await this.db
          .collection<Stored>('approvalLinks')
          .updateOne(
            { hash, actorId, used: false, expiresAt: { $gt: this.now() } },
            { $set: { used: true, usedAt: this.now() } },
            { session },
          );
        if (result.modifiedCount !== 1) throw new NotificationConflict();
        return operation(session);
      });
    } finally {
      await session.endSession();
    }
  }
  async claim(approvalId: string, version: number, userId: string) {
    const key = `${approvalId}:${version}:${userId}`,
      now = this.now();
    try {
      await this.db.collection<Stored>('approvalNotifications').updateOne(
        { _id: key },
        {
          $setOnInsert: {
            approvalId,
            version,
            userId,
            status: 'pending',
            attempts: 0,
            nextAt: now,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const row = await this.db
      .collection<Stored>('approvalNotifications')
      .findOneAndUpdate(
        {
          _id: key,
          status: { $ne: 'sent' },
          attempts: { $lt: 5 },
          nextAt: { $lte: now },
        },
        {
          $set: { nextAt: new Date(now.getTime() + 60000) },
          $inc: { attempts: 1 },
        },
        { returnDocument: 'after' },
      );
    return row ? key : null;
  }
  async delivered(id: string) {
    await this.db
      .collection<Stored>('approvalNotifications')
      .updateOne({ _id: id }, { $set: { status: 'sent', sentAt: this.now() } });
  }
}
