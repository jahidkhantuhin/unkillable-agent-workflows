import { type Db, type Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  userSchema,
  membershipSchema,
  workspaceId,
  type Role,
  type Membership,
} from '@unkillable/shared';
import { randomUUID } from 'node:crypto';

export function normalizeDocument(document: Document) {
  return { ...document, id: document.id ?? String(document._id) };
}
/** Validates both incoming documents and outgoing reads; no unvalidated DB values escape. */
export class DocumentRepository<T extends { id: string }> {
  private readonly collection;
  constructor(
    db: Db,
    name: string,
    private readonly schema: z.ZodType<T>,
  ) {
    this.collection = db.collection<Document & { _id: string }>(name);
  }
  async insert(value: T) {
    const parsed = this.schema.parse(value);
    await this.collection.insertOne({ ...parsed, _id: parsed.id });
    return parsed;
  }
  async get(id: string) {
    const value = await this.collection.findOne({ _id: id });
    return value ? this.schema.parse(normalizeDocument(value)) : null;
  }
}
export interface MembershipRepository {
  get(userId: string): Promise<Membership | null>;
  ensureViewer(userId: string): Promise<void>;
  setRole(userId: string, role: Role): Promise<void>;
}
export class MongoMembershipRepository implements MembershipRepository {
  private readonly collection;
  constructor(db: Db) {
    this.collection = db.collection<Document & { _id: string }>('memberships');
  }
  async get(userId: string) {
    const value = await this.collection.findOne({ userId, workspaceId });
    return value ? membershipSchema.parse(normalizeDocument(value)) : null;
  }
  async ensureViewer(userId: string) {
    const now = new Date();
    const document = membershipSchema.parse({
      id: randomUUID(),
      userId,
      workspaceId,
      role: 'viewer',
      createdAt: now,
      updatedAt: now,
    });
    try {
      await this.collection.updateOne(
        { userId, workspaceId },
        { $setOnInsert: { ...document, _id: document.id } },
        { upsert: true },
      );
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 11000
      ))
        throw error;
    }
  }
  async setRole(userId: string, role: Role) {
    const current = await this.get(userId);
    if (!current) throw new Error('Membership does not exist');
    const parsed = membershipSchema.parse({
      ...current,
      role,
      updatedAt: new Date(),
    });
    await this.collection.updateOne(
      { userId, workspaceId },
      { $set: { role: parsed.role, updatedAt: parsed.updatedAt } },
    );
  }
}
export class UserRepository {
  constructor(private readonly db: Db) {}
  async byEmail(email: string) {
    const value = await this.db
      .collection('users')
      .findOne({ email: email.toLowerCase() });
    return value ? userSchema.parse(normalizeDocument(value)) : null;
  }
  async byId(id: string) {
    const value = await this.db
      .collection('users')
      .findOne({ _id: new ObjectId(id) });
    return value ? userSchema.parse(normalizeDocument(value)) : null;
  }
}
