import type { Db, IndexDescription } from 'mongodb';
import {
  reliabilityIndexes,
  approvalIndexes,
  supportIndexes,
  policyIndexes,
  moderationIndexes,
} from '@unkillable/storage';
export const collectionIndexes: Record<string, IndexDescription[]> = {
  users: [{ key: { email: 1 }, unique: true }],
  memberships: [
    { key: { workspaceId: 1, userId: 1 }, unique: true },
    { key: { role: 1 } },
  ],
  workflowDefinitions: [{ key: { name: 1, version: 1 }, unique: true }],
  runs: [
    { key: { parentRunId: 1, createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { createdBy: 1, createdAt: -1 } },
  ],
  runEvents: [
    { key: { runId: 1, sequence: 1 }, unique: true },
    {
      key: { runId: 1, key: 1 },
      unique: true,
      partialFilterExpression: { key: { $type: 'string' } },
    },
  ],
  approvals: [
    { key: { runId: 1, nodeId: 1 }, unique: true },
    { key: { status: 1, createdAt: 1 } },
  ],
  idempotencyKeys: [{ key: { key: 1 }, unique: true }],
  deadLetters: [{ key: { runId: 1 } }, { key: { status: 1, createdAt: 1 } }],
  outbox: [
    { key: { key: 1 }, unique: true },
    { key: { status: 1, availableAt: 1 } },
  ],
  sessions: [
    { key: { token: 1 }, unique: true },
    { key: { userId: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  accounts: [
    { key: { providerId: 1, accountId: 1 }, unique: true },
    { key: { userId: 1 } },
  ],
  verifications: [
    { key: { identifier: 1 } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  authRateLimits: [{ key: { key: 1 }, unique: true }],
  ...reliabilityIndexes,
  ...approvalIndexes,
  ...supportIndexes,
  ...policyIndexes,
  ...moderationIndexes,
};
/** createIndexes is idempotent and fails startup on conflicting uniqueness guarantees. */
export async function bootstrapIndexes(db: Db) {
  for (const [name, indexes] of Object.entries(collectionIndexes))
    await db.collection(name).createIndexes(indexes);
}
