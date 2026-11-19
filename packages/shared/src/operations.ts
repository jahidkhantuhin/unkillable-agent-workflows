import { z } from 'zod';
export const slaPolicySchema = z
  .object({
    remindMs: z.number().int().min(1000).default(1800000),
    escalateMs: z.number().int().min(1000).default(3600000),
    expireMs: z.number().int().min(1000).default(86400000),
    timeoutAction: z.enum(['reject', 'cancel']).default('reject'),
    escalateRole: z.enum(['admin', 'approver']).default('admin'),
  })
  .refine(
    (p) => p.remindMs < p.escalateMs && p.escalateMs < p.expireMs,
    'SLA must satisfy remindMs < escalateMs < expireMs',
  );
export const slaConfigSchema = z.object({
  APPROVAL_SLA_ENABLED: z.enum(['true', 'false']).default('true'),
  APPROVAL_SLA_POLICIES: z
    .string()
    .default('{}')
    .transform((value, ctx) => {
      try {
        return z
          .partialRecord(
            z.enum([
              'durability-demo',
              'support-ticket-router',
              'content-moderation',
            ]),
            slaPolicySchema,
          )
          .parse(JSON.parse(value));
      } catch {
        ctx.addIssue({
          code: 'custom',
          message:
            'APPROVAL_SLA_POLICIES must contain valid workflow SLA policies',
        });
        return z.NEVER;
      }
    }),
});
export const slaSchema = z.object({
  remindAt: z.date(),
  escalateAt: z.date(),
  expireAt: z.date(),
  timeoutAction: z.enum(['reject', 'cancel']),
  escalateRole: z.enum(['admin', 'approver']),
  remindedAt: z.date().optional(),
  escalatedAt: z.date().optional(),
  expiredAt: z.date().optional(),
});
export function approvalSla(
  workflow: string,
  createdAt: Date,
  config = slaConfigSchema.parse(process.env),
) {
  if (config.APPROVAL_SLA_ENABLED !== 'true') return undefined;
  const policy =
    config.APPROVAL_SLA_POLICIES[
      workflow as keyof typeof config.APPROVAL_SLA_POLICIES
    ] ?? slaPolicySchema.parse({});
  return slaSchema.parse({
    remindAt: new Date(+createdAt + policy.remindMs),
    escalateAt: new Date(+createdAt + policy.escalateMs),
    expireAt: new Date(+createdAt + policy.expireMs),
    timeoutAction: policy.timeoutAction,
    escalateRole:
      workflow === 'content-moderation' ? 'admin' : policy.escalateRole,
  });
}
export const slaJobSchema = z.object({
  approvalId: z.uuid(),
  stage: z.enum(['remind', 'escalate', 'expire']),
});
export const usageSchema = z.object({
  id: z.uuid(),
  runId: z.string(),
  execution: z.number().int().nonnegative(),
  nodeId: z.string(),
  attempt: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  at: z.date(),
});
export const spanRecordSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  parentId: z.string().optional(),
  runId: z.string(),
  execution: z.number().int().nonnegative(),
  nodeId: z.string(),
  attempt: z.number().int().nonnegative(),
  startedAt: z.date(),
  durationMs: z.number().nonnegative(),
  status: z.enum(['ok', 'error']),
});
export const observabilityConfigSchema = z.object({
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z
    .union([
      z.literal(''),
      z.url().refine((v) => ['http:', 'https:'].includes(new URL(v).protocol)),
    ])
    .default(''),
  LLM_PRICING_JSON: z
    .string()
    .default('{}')
    .transform((value, ctx) => {
      try {
        return z
          .record(
            z.string(),
            z.object({
              inputPerMillion: z.number().nonnegative(),
              outputPerMillion: z.number().nonnegative(),
            }),
          )
          .parse(JSON.parse(value));
      } catch {
        ctx.addIssue({
          code: 'custom',
          message:
            'LLM_PRICING_JSON must map provider:model to nonnegative USD rates',
        });
        return z.NEVER;
      }
    }),
});
export function usageCost(
  input: number | null,
  output: number | null,
  rates?: { inputPerMillion: number; outputPerMillion: number },
) {
  return input === null || output === null || !rates
    ? null
    : (input * rates.inputPerMillion + output * rates.outputPerMillion) /
        1000000;
}
export const runMetricsSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  elapsedMs: z.number().nonnegative(),
  approvalWaitMs: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  knownCostUsd: z.number().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  missingUsageCalls: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  spans: z.array(spanRecordSchema.extend({ startedAt: z.iso.datetime() })),
});
export const workflowCostsSchema = z.object({
  scope: z.string(),
  workflows: z.array(
    z.object({
      workflowId: z.string(),
      runs: z.number(),
      calls: z.number(),
      knownCostUsd: z.number(),
      unpricedCalls: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
  ),
});
