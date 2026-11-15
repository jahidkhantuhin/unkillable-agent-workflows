import { z } from 'zod';
import { runSchema, runStatusSchema } from './domain';
import type { RunEvent } from './events';
import { nodePolicyOverridesSchema } from './reliability';
import { supportNodeSchema } from './support';
export const deliveryModeSchema = z.enum([
  'normal',
  'retry-once',
  'exhaust',
  'permanent',
]);
export const demoWorkflowVersion = 3;
export const demoInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(500),
  deliveryMode: deliveryModeSchema.optional(),
  requireApproval: z.boolean().optional(),
});
export type DemoInput = z.infer<typeof demoInputSchema>;
export const demoNodeSchema = z.enum([
  'prepare',
  'summarize',
  'approval',
  'complete',
]);
export const demoStateSchema = z.object({
  title: z.string().default(''),
  message: z.string(),
  normalized: z.string().default(''),
  summary: z.string().default(''),
  result: z.string().default(''),
  completed: z.array(demoNodeSchema).default([]),
  deliveryMode: deliveryModeSchema.default('normal'),
  requireApproval: z.boolean().default(false),
  noticeMessage: z.string().default(''),
  approvalAction: z
    .enum(['pending', 'approve', 'edit', 'reject'])
    .default('pending'),
});
export type DemoState = z.infer<typeof demoStateSchema>;
export type DemoNode = z.infer<typeof demoNodeSchema>;
export const runQueueConfigSchema = z.object({
  RUN_QUEUE_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('workflow-runs'),
});
export const workerConfigSchema = runQueueConfigSchema.extend({
  CHAOS_ENABLED: z.enum(['true', 'false']).default('false'),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
  WORKER_LOCK_DURATION_MS: z.coerce.number().int().min(1000).default(15000),
  WORKER_STALLED_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  WORKER_MAX_STALLED_COUNT: z.coerce.number().int().min(1).max(100).default(3),
  DEMO_NODE_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(1500),
  NODE_RETRY_POLICIES: nodePolicyOverridesSchema.refine(
    (value) =>
      Object.keys(value).every((key) =>
        [
          'prepare',
          'summarize',
          'complete',
          ...supportNodeSchema.options.filter((node) => node !== 'approval'),
        ].includes(key),
      ),
    {
      message:
        'Retry policy keys must name demo or support task nodes; approval is not retryable',
    },
  ),
});
export const createRunSchema = z.strictObject({
  workflowId: z.literal('durability-demo').default('durability-demo'),
  input: demoInputSchema,
});
export const runIdParamsSchema = z.object({ id: z.uuid() });
export const eventCursorSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const runQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: runStatusSchema.optional(),
});
export const runDTOSchema = runSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Run = z.infer<typeof runSchema>;
export type RunDTO = z.infer<typeof runDTOSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type EventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'id' | 'runId' | 'threadId' | 'sequence' | 'timestamp' | 'key'>
    : never
  : never;
export const terminalStatuses: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'compensated',
  'cancelled',
];
export const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'failed', 'cancelled'],
  running: [
    'waiting_approval',
    'succeeded',
    'failed',
    'compensating',
    'cancelled',
  ],
  waiting_approval: ['queued', 'failed', 'cancelled'],
  compensating: ['compensated', 'failed'],
  succeeded: [],
  failed: ['queued'],
  compensated: [],
  cancelled: [],
};
export function canTransition(from: RunStatus, to: RunStatus) {
  return from === to || transitions[from].includes(to);
}
export function runToDTO(run: Run): RunDTO {
  return runDTOSchema.parse({
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  });
}
