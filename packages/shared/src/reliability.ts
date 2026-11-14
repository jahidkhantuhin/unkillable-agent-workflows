import { z } from 'zod';
import { deadLetterSchema, idempotencyKeySchema, outboxSchema } from './domain';
export const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    initialDelayMs: z.number().int().min(0).max(60000).default(1000),
    maxDelayMs: z.number().int().min(0).max(300000).default(10000),
    multiplier: z.number().min(1).max(5).default(2),
    jitter: z.number().min(0).max(1).default(0.2),
  })
  .refine((policy) => policy.maxDelayMs >= policy.initialDelayMs, {
    message: 'maxDelayMs must be at least initialDelayMs',
  });
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export const defaultRetryPolicy = retryPolicySchema.parse({});
export const errorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  classification: z.enum(['retryable', 'permanent']),
  stack: z.string().optional(),
});
export type ErrorInfo = z.infer<typeof errorInfoSchema>;
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly code = 'TRANSIENT_FAILURE',
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly code = 'PERMANENT_FAILURE',
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}
export class StaleExecutionError extends Error {
  constructor() {
    super('Run execution has been superseded');
    this.name = 'StaleExecutionError';
  }
}
export class NodeFailure extends Error {
  constructor(
    readonly nodeId: string,
    readonly attempts: number,
    readonly info: ErrorInfo,
  ) {
    super(info.message);
    this.name = 'NodeFailure';
  }
}
export function classifyError(error: unknown): ErrorInfo {
  const value =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          status?: unknown;
          statusCode?: unknown;
          message?: unknown;
          stack?: unknown;
          name?: unknown;
        })
      : {};
  const status = Number(value.status ?? value.statusCode);
  const transient =
    error instanceof RetryableError ||
    [
      'MongoNetworkError',
      'MongoNetworkTimeoutError',
      'MongoServerSelectionError',
      'MongoPoolClearedError',
    ].includes(String(value.name)) ||
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENETUNREACH',
    ].includes(String(value.code)) ||
    status === 429 ||
    (status >= 500 && status <= 599);
  return errorInfoSchema.parse({
    code:
      typeof value.code === 'string'
        ? value.code
        : transient
          ? 'TRANSIENT_FAILURE'
          : 'PERMANENT_FAILURE',
    message:
      typeof value.message === 'string'
        ? value.message
        : 'Unknown operation failure',
    classification:
      error instanceof PermanentError || value.name === 'ZodError'
        ? 'permanent'
        : transient
          ? 'retryable'
          : 'permanent',
    ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
  });
}
export function retryDelay(
  policy: RetryPolicy,
  failedAttempt: number,
  random: () => number = Math.random,
) {
  const capped = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * policy.multiplier ** Math.max(0, failedAttempt - 1),
  );
  return Math.floor(
    capped *
      (1 - policy.jitter + policy.jitter * Math.max(0, Math.min(1, random()))),
  );
}
export const attemptSchema = z.object({
  id: z.string(),
  key: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  execution: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  status: z.enum(['running', 'retrying', 'succeeded', 'failed']),
  policy: retryPolicySchema,
  nextAttemptAt: z.date().optional(),
  error: errorInfoSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Attempt = z.infer<typeof attemptSchema>;
export type AttemptStore = {
  load(): Promise<Attempt | null>;
  start(policy: RetryPolicy): Promise<Attempt>;
  retry(error: ErrorInfo, delayMs: number): Promise<void>;
  succeed(): Promise<void>;
  fail(error: ErrorInfo): Promise<void>;
};
export const deadLetterDTOSchema = deadLetterSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DeadLetterDTO = z.infer<typeof deadLetterDTOSchema>;
export const deadLetterActionSchema = z.strictObject({
  version: z.number().int().nonnegative(),
});
export const localDeliverySchema = z.object({
  id: z.string(),
  key: z.string(),
  runId: z.string(),
  outboxId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
});
export const effectResultSchema = z.object({ receipt: z.string() });
export const reliabilityDetailsSchema = z.object({
  keys: z.array(
    idempotencyKeySchema.extend({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  outbox: z.array(
    outboxSchema.extend({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      availableAt: z.iso.datetime(),
      sentAt: z.iso.datetime().optional(),
    }),
  ),
  deliveries: z.array(
    localDeliverySchema.extend({ createdAt: z.iso.datetime() }),
  ),
});
export type ReliabilityDetails = z.infer<typeof reliabilityDetailsSchema>;
export const nodePolicyOverridesSchema = z
  .string()
  .default('{}')
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'NODE_RETRY_POLICIES must be valid JSON',
      });
      return z.NEVER;
    }
  })
  .pipe(z.record(z.string(), retryPolicySchema));
