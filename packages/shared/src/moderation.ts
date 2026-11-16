import { z } from 'zod';
import { runStatusSchema } from './domain';
export const moderationCompensationNodes = [
  'void_moderation_notice',
  'unpublish_content',
  'restore_moderation',
] as const;
export const moderationWorkflowId = 'content-moderation';
export const maxContentBytes = 10 * 1024 * 1024;
export const modelPreviewChars = 16000;
export const moderationNodeSchema = z.enum([
  'upload',
  'automated_check',
  'auto_decide',
  'approval',
  'publish',
  'reject',
  'notify',
]);
export type ModerationNode = z.infer<typeof moderationNodeSchema>;
export const contentFileSchema = z.object({
  key: z.string().regex(/^[0-9a-f-]{36}\.txt$/),
  bytes: z.number().int().min(1).max(maxContentBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const moderationUploadSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
});
export const moderationCheckSchema = z.strictObject({
  verdict: z.enum(['allow', 'review', 'reject']),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(1000),
});
export const moderationStateSchema = z.object({
  kind: z.literal('moderation').default('moderation'),
  title: z.string(),
  message: z.string().default('Local content moderation'),
  contentId: z.uuid(),
  file: contentFileSchema,
  check: moderationCheckSchema.nullable().default(null),
  preview: z.string().max(2000).default(''),
  decision: z.enum(['pending', 'allow', 'review', 'reject']).default('pending'),
  decisionReason: z.string().default(''),
  approvalAction: z.enum(['pending', 'approve', 'reject']).default('pending'),
  completed: z.array(moderationNodeSchema).default([]),
});
export type ModerationState = z.infer<typeof moderationStateSchema>;
export const moderationItemSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  title: z.string(),
  file: contentFileSchema,
  status: z.enum(['queued', 'published', 'rejected', 'withdrawn']),
  createdAt: z.date(),
  updatedAt: z.date(),
  decidedAt: z.date().optional(),
});
export const moderationQueueSchema = z.object({
  backlog: z.number(),
  waitingReview: z.number(),
  decisionsLast24Hours: z.number(),
  items: z.array(
    moderationItemSchema.extend({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      decidedAt: z.iso.datetime().optional(),
      runStatus: runStatusSchema,
      decisionReason: z.string(),
    }),
  ),
});
