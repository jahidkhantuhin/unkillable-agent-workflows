import { z } from 'zod';

export const idSchema = z.string().min(1).max(128);
export const roleSchema = z.enum(['admin', 'approver', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
export const workspaceId = 'local';
const documentFields = {
  id: idSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
};
const payloadSchema = z.record(z.string(), z.unknown());
export const userSchema = z.object({
  ...documentFields,
  name: z.string().min(1).max(100),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.string().nullable().optional(),
});
export const membershipSchema = z.object({
  ...documentFields,
  userId: idSchema,
  workspaceId: z.literal(workspaceId),
  role: roleSchema,
});
export type Membership = z.infer<typeof membershipSchema>;
export const workflowDefinitionSchema = z.object({
  ...documentFields,
  name: z.string().min(1),
  version: z.number().int().positive(),
  nodes: z.array(
    z.object({
      id: idSchema,
      label: z.string(),
      kind: z.enum(['task', 'approval', 'effect']),
    }),
  ),
  edges: z.array(z.object({ source: idSchema, target: idSchema })),
});
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'compensating',
  'compensated',
  'cancelled',
]);
export const runSchema = z.object({
  ...documentFields,
  workflowId: idSchema,
  workflowVersion: z.number().int().positive(),
  createdBy: idSchema,
  status: runStatusSchema,
  state: payloadSchema,
  sequence: z.number().int().nonnegative().default(0),
  dispatchPending: z.boolean().default(true),
  execution: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  parentRunId: idSchema.optional(),
  forkCheckpointId: idSchema.optional(),
  forkAsNode: z.string().min(1).max(80).optional(),
});
export const approvalSchema = z.object({
  ...documentFields,
  title: z.string().default(''),
  runId: idSchema,
  nodeId: idSchema,
  version: z.number().int().nonnegative(),
  status: z.enum(['pending', 'approved', 'edited', 'rejected']),
  proposedAction: payloadSchema,
  reasoning: z.string(),
  requiredApprovals: z.number().int().min(1).max(2).default(1),
  reviews: z
    .array(
      z.object({
        actorId: idSchema,
        action: z.enum(['approve', 'edit', 'reject']),
        message: z.string().optional(),
        reason: z.string().optional(),
        at: z.date(),
      }),
    )
    .default([]),
  resolvedBy: idSchema.optional(),
  resolvedAt: z.date().optional(),
  decision: z
    .object({
      action: z.enum(['approve', 'edit', 'reject']),
      payload: payloadSchema.optional(),
      reason: z.string().optional(),
    })
    .optional(),
});
export const idempotencyKeySchema = z.object({
  ...documentFields,
  key: z.string().min(1),
  runId: idSchema,
  nodeId: idSchema,
  status: z.enum(['pending', 'completed', 'failed']),
  result: z.unknown().optional(),
});
export const deadLetterSchema = z.object({
  ...documentFields,
  runId: idSchema,
  nodeId: idSchema,
  status: z.enum(['open', 'retried', 'discarded']),
  execution: z.number().int().nonnegative().default(0),
  version: z.number().int().nonnegative().default(0),
  attempts: z.number().int().nonnegative(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    classification: z.enum(['retryable', 'permanent']).default('permanent'),
    stack: z.string().optional(),
  }),
  context: payloadSchema,
});
export const outboxSchema = z.object({
  ...documentFields,
  runId: idSchema,
  key: z.string().min(1),
  kind: z.enum(['email', 'payment', 'notification']),
  payload: payloadSchema,
  status: z.enum(['pending', 'sent', 'failed']),
  attempts: z.number().int().nonnegative(),
  availableAt: z.date(),
  sentAt: z.date().optional(),
  lastError: z.string().optional(),
});

// Better Auth owns persistence for these documents; application-facing data is validated here.
export const sessionSchema = z.object({
  ...documentFields,
  userId: idSchema,
  token: z.string().min(1),
  expiresAt: z.date(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});
export const accountSchema = z.object({
  ...documentFields,
  userId: idSchema,
  accountId: z.string(),
  providerId: z.string(),
  password: z.string().nullable().optional(),
  accessToken: z.string().nullable().optional(),
  refreshToken: z.string().nullable().optional(),
  idToken: z.string().nullable().optional(),
  accessTokenExpiresAt: z.date().nullable().optional(),
  refreshTokenExpiresAt: z.date().nullable().optional(),
  scope: z.string().nullable().optional(),
});
export const verificationSchema = z.object({
  ...documentFields,
  identifier: z.string(),
  value: z.string(),
  expiresAt: z.date(),
});
export const authRateLimitSchema = z.object({
  id: idSchema,
  key: z.string(),
  count: z.number().int().nonnegative(),
  lastRequest: z.number(),
});

export const permissionSchema = z.enum([
  'runs:read',
  'runs:create',
  'runs:fork',
  'workflows:read',
  'approvals:read',
  'approvals:resolve',
  'chaos:manage',
  'analytics:read',
  'policies:manage',
  'moderation:manage',
  'deadletters:read',
  'deadletters:manage',
]);
export type Permission = z.infer<typeof permissionSchema>;
export const rolePermissions: Record<Role, readonly Permission[]> = {
  viewer: ['runs:read', 'workflows:read'],
  approver: [
    'runs:read',
    'runs:create',
    'runs:fork',
    'workflows:read',
    'approvals:read',
    'approvals:resolve',
  ],
  admin: permissionSchema.options,
};
export function hasPermission(role: Role, permission: Permission) {
  return rolePermissions[role].includes(permission);
}
export const sectionPermissions = {
  runs: 'runs:read',
  workflows: 'workflows:read',
  approvals: 'approvals:read',
  chaos: 'chaos:manage',
  analytics: 'analytics:read',
  policies: 'policies:manage',
  moderation: 'moderation:manage',
  'dead-letters': 'deadletters:read',
} as const satisfies Record<string, Permission>;
