import { z } from 'zod';
import { approvalSchema } from './domain';
import { slaSchema } from './operations';
export const noticePayloadSchema = z.strictObject({
  message: z.string().trim().min(1).max(500),
});
export const approvalDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve') }),
  z.strictObject({
    action: z.literal('edit'),
    payload: noticePayloadSchema,
    reason: z.string().trim().min(1).max(1000).optional(),
  }),
  z.strictObject({
    action: z.literal('reject'),
    reason: z.string().trim().min(1).max(1000),
  }),
]);
export const resolveApprovalSchema = z
  .object({
    version: z.number().int().nonnegative(),
    decision: approvalDecisionSchema,
  })
  .strict();
export const approvalDTOSchema = approvalSchema.extend({
  sla: slaSchema
    .extend({
      remindAt: z.iso.datetime(),
      escalateAt: z.iso.datetime(),
      expireAt: z.iso.datetime(),
      remindedAt: z.iso.datetime().optional(),
      escalatedAt: z.iso.datetime().optional(),
      expiredAt: z.iso.datetime().optional(),
    })
    .optional(),
  reviews: z
    .array(
      z.object({
        actorId: z.string(),
        action: z.enum(['approve', 'edit', 'reject']),
        message: z.string().optional(),
        reason: z.string().optional(),
        at: z.iso.datetime(),
      }),
    )
    .default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
});
export type ApprovalDTO = z.infer<typeof approvalDTOSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
