import { z } from 'zod';
export const compensationNodeSchema = z.enum([
  'reopen_ticket',
  'send_correction_or_void',
  'reverse_refund',
  'unpublish_content',
  'restore_moderation',
  'void_moderation_notice',
]);
export type CompensationNode = z.infer<typeof compensationNodeSchema>;
export const sagaSchema = z.object({
  plan: z.array(compensationNodeSchema),
  completed: z.array(compensationNodeSchema),
  failure: z.string(),
});
export type Saga = z.infer<typeof sagaSchema>;
