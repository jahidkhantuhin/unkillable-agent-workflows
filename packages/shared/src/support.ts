import { z } from 'zod';
export const supportWorkflowId = 'support-ticket-router';
export const supportNodeSchema = z.enum([
  'classify',
  'retrieve_policy',
  'draft_reply',
  'risk_check',
  'approval',
  'issue_refund',
  'send_email',
  'close_ticket',
]);
export type SupportNode = z.infer<typeof supportNodeSchema>;
export const sandboxEmailSchema = z
  .email()
  .max(254)
  .refine(
    (value) => value.toLowerCase().endsWith('.test'),
    'Use a synthetic .test email address',
  );
export const ticketInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  customerEmail: sandboxEmailSchema,
  orderId: z.string().trim().min(1).max(80),
  amountCents: z.number().int().min(0).max(100000),
  currency: z.literal('USD').default('USD'),
});
export type TicketInput = z.infer<typeof ticketInputSchema>;
export const ticketExampleSchema = ticketInputSchema.extend({ id: z.string() });
export const classificationSchema = z.strictObject({
  label: z.enum(['duplicate_charge', 'refund_request', 'how_to', 'other']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(1000),
});
export type Classification = z.infer<typeof classificationSchema>;
export const policySchema = z.strictObject({
  id: z.string().min(1).max(80),
  text: z.string().min(1).max(2000),
  allowRefund: z.boolean(),
  maxRefundCents: z.number().int().min(0).max(100000),
});
export type SupportPolicy = z.infer<typeof policySchema>;
export const draftReplySchema = z.strictObject({
  message: z.string().trim().min(1).max(500),
  citedPolicyId: z.string().min(1),
  citedSnippet: z.string().min(1).max(1000),
});
export type DraftReply = z.infer<typeof draftReplySchema>;
export const refundResultSchema = z.object({
  id: z.string(),
  amountCents: z.number().int().nonnegative(),
  currency: z.literal('USD'),
});
export const mailResultSchema = z.object({
  id: z.string(),
  messageId: z.string(),
});
export const supportMailSchema = z.strictObject({
  to: sandboxEmailSchema,
  subject: z
    .string()
    .min(1)
    .max(250)
    .refine((value) => !/[\r\n]/.test(value)),
  text: z.string().min(1).max(500),
  messageId: z.string().regex(/^<[a-f0-9]{64}@unkillable\.test>$/),
});
export type SupportMail = z.infer<typeof supportMailSchema>;
export const supportStateSchema = z.object({
  kind: z.literal('support-ticket').default('support-ticket'),
  title: z.string(),
  message: z.string(),
  ticketId: z.string(),
  ticket: ticketInputSchema,
  classification: classificationSchema.default({
    label: 'other',
    confidence: 0,
    reason: 'Not classified yet',
  }),
  policies: z.array(policySchema).default([]),
  draft: z
    .object({
      message: z.string(),
      citedPolicyId: z.string(),
      citedSnippet: z.string(),
    })
    .default({ message: '', citedPolicyId: '', citedSnippet: '' }),
  risk: z
    .object({
      refundCents: z.number().int().nonnegative(),
      currency: z.literal('USD'),
      reason: z.string(),
    })
    .default({ refundCents: 0, currency: 'USD', reason: '' }),
  approvalAction: z
    .enum(['pending', 'approve', 'edit', 'reject'])
    .default('pending'),
  approvedMessage: z.string().default(''),
  refund: refundResultSchema.default({
    id: '',
    amountCents: 0,
    currency: 'USD',
  }),
  email: mailResultSchema.default({ id: '', messageId: '' }),
  ticketStatus: z.enum(['open', 'closed', 'rejected']).default('open'),
  completed: z.array(supportNodeSchema).default([]),
});
export type SupportState = z.infer<typeof supportStateSchema>;
export const fakeRefundSchema = z.object({
  id: z.string(),
  key: z.string(),
  runId: z.string(),
  ticketId: z.string(),
  amountCents: z.number().int().positive().max(100000),
  currency: z.literal('USD'),
  createdAt: z.date(),
});
export const fakeEmailSchema = z.object({
  id: z.string(),
  key: z.string(),
  runId: z.string(),
  ticketId: z.string(),
  payload: supportMailSchema,
  status: z.enum(['queued', 'sent']),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const ticketDocumentSchema = ticketInputSchema.extend({
  id: z.string(),
  runId: z.string(),
  status: z.enum(['open', 'closed', 'rejected']),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const supportExamples = [
  {
    id: 'duplicate-charge',
    title: 'Duplicate charge on order DEMO-1001',
    description:
      'I was charged twice for the same order. Please refund the duplicate charge.',
    customerEmail: 'alex@example.test',
    orderId: 'DEMO-1001',
    amountCents: 4900,
    currency: 'USD',
  },
  {
    id: 'refund-request',
    title: 'Refund request for order DEMO-1002',
    description: 'I changed my mind and would like a refund for my order.',
    customerEmail: 'sam@example.test',
    orderId: 'DEMO-1002',
    amountCents: 2500,
    currency: 'USD',
  },
  {
    id: 'how-to',
    title: 'How do I download my invoice?',
    description:
      'Please explain how I can download an invoice from my account.',
    customerEmail: 'lee@example.test',
    orderId: 'DEMO-1003',
    amountCents: 0,
    currency: 'USD',
  },
] as const;
export const localPolicies: SupportPolicy[] = [
  {
    id: 'duplicate-charge',
    text: 'Verified duplicate charges may be refunded once, up to the duplicate amount and a maximum of USD 1000. A human must approve the refund and reply.',
    allowRefund: true,
    maxRefundCents: 100000,
  },
  {
    id: 'refund-review',
    text: 'General refund requests require manual eligibility review. Do not automatically refund a change-of-mind request; provide a helpful reply for human review.',
    allowRefund: false,
    maxRefundCents: 0,
  },
  {
    id: 'account-help',
    text: 'Invoices can be downloaded from Account > Billing > Invoices. Never request passwords or payment credentials. A human reviews the reply before sending.',
    allowRefund: false,
    maxRefundCents: 0,
  },
];
export const supportConfigSchema = z
  .object({
    SUPPORT_LLM_PROVIDER: z.enum(['mock', 'gemini', 'ollama']).default('mock'),
    GEMINI_MODEL: z.string().default(''),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().default(''),
    OLLAMA_MODEL: z.string().default(''),
    OLLAMA_BASE_URL: z
      .url()
      .default('http://127.0.0.1:11434/v1')
      .refine(
        (value) =>
          /^https?:$/.test(new URL(value).protocol) &&
          ['127.0.0.1', 'localhost', '[::1]', 'ollama'].includes(
            new URL(value).hostname,
          ),
        'Ollama must be local',
      ),
    ORGMIND_RETRIEVER_ENABLED: z.enum(['true', 'false']).default('false'),
    ORGMIND_RETRIEVER_URL: z
      .url()
      .default('http://127.0.0.1:8000/retrieve')
      .refine(
        (value) =>
          /^https?:$/.test(new URL(value).protocol) &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname),
        'Optional retriever must be local',
      ),
    MAILPIT_SMTP_HOST: z
      .enum(['127.0.0.1', 'localhost', '::1', 'mailpit'])
      .default('127.0.0.1'),
    MAILPIT_SMTP_PORT: z.coerce
      .number()
      .refine(
        (value) => value === 1025,
        'Only local Mailpit port 1025 is supported',
      )
      .default(1025),
  })
  .superRefine((config, ctx) => {
    if (
      config.SUPPORT_LLM_PROVIDER === 'gemini' &&
      (!config.GEMINI_MODEL || !config.GOOGLE_GENERATIVE_AI_API_KEY)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Gemini requires GEMINI_MODEL and GOOGLE_GENERATIVE_AI_API_KEY',
      });
    if (config.SUPPORT_LLM_PROVIDER === 'ollama' && !config.OLLAMA_MODEL)
      ctx.addIssue({ code: 'custom', message: 'Ollama requires OLLAMA_MODEL' });
  });
export type SupportConfig = z.infer<typeof supportConfigSchema>;
