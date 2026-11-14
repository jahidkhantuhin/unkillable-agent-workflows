import { z } from 'zod';
import { approvalSchema } from './domain';
export const noticePayloadSchema = z.strictObject({
  message: z.string().trim().min(1).max(500),
});
export const approvalDecisionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve') }),
  z.strictObject({ action: z.literal('edit'), payload: noticePayloadSchema }),
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
});
export type ApprovalDTO = z.infer<typeof approvalDTOSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
