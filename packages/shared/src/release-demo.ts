import { z } from 'zod';
import { ticketExampleSchema } from './support';
import { approvalPolicySchema } from './approval-policy';
export const releaseDemoTicket = ticketExampleSchema.parse({
  id: 'release-demo-4821',
  title: 'Charged twice for order #4821, refund one',
  description:
    'I was charged twice for order #4821. Please refund one duplicate charge of USD 42.00.',
  customerEmail: 'customer4821@example.test',
  orderId: '4821',
  amountCents: 4200,
  currency: 'USD',
  customerTier: 'standard',
});
export const releaseDemoPolicy = approvalPolicySchema.parse({
  name: 'Interview demo: safe replies under USD 50',
  rules: [
    {
      id: 'under-50',
      when: { maxAmountCents: 5000, minConfidence: 0.9 },
      outcome: 'auto_approve',
      reason:
        'Under the demo USD 50 threshold; the mandatory money/high-risk safety floor still requires a human.',
    },
  ],
  fallback: 'require_approval',
});
export const demoSeedConfigSchema = z
  .object({
    DEMO_ADMIN_EMAIL: z
      .email()
      .refine((v) => v.endsWith('.test'))
      .default('admin@unkillable.test'),
    DEMO_ADMIN_PASSWORD: z
      .string()
      .min(12)
      .max(128)
      .default('local-demo-admin-password'),
    DEMO_APPROVER_EMAIL: z
      .email()
      .refine((v) => v.endsWith('.test'))
      .default('approver@unkillable.test'),
    DEMO_APPROVER_PASSWORD: z
      .string()
      .min(12)
      .max(128)
      .default('local-demo-approver-password'),
  })
  .refine(
    (c) => c.DEMO_ADMIN_EMAIL !== c.DEMO_APPROVER_EMAIL,
    'Demo reviewers must use different emails',
  );
