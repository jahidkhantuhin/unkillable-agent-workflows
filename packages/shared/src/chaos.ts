import { z } from 'zod';
import { supportNodeSchema } from './support';
import { demoNodeSchema } from './runs';
import { compensationNodeSchema } from './saga';
export const chaosEnabled = (env: {
  CHAOS_ENABLED?: string;
  NODE_ENV?: string;
}) =>
  env.CHAOS_ENABLED === 'true' &&
  (env.NODE_ENV ?? 'development') === 'development';
export const chaosPrefix = (queue: string) => `unkillable:chaos:${queue}`;
export const chaosNodeSchema = z.enum([
  ...new Set([
    ...demoNodeSchema.options,
    ...supportNodeSchema.options,
    ...compensationNodeSchema.options,
  ]),
]);
export const chaosFaultSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('throw_once') }),
  z.strictObject({ mode: z.literal('throw_always') }),
  z.strictObject({ mode: z.literal('crash_process') }),
  z.strictObject({
    mode: z.literal('delay_ms'),
    delayMs: z.number().int().min(1).max(30000),
  }),
]);
export const injectFaultSchema = z.strictObject({
  runId: z.uuid(),
  node: chaosNodeSchema,
  phase: z.enum(['before', 'after']).default('before'),
  fault: chaosFaultSchema,
});
export const clearFaultSchema = injectFaultSchema.omit({ fault: true });
export const llmFaultSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off') }),
  z.strictObject({
    mode: z.literal('slow'),
    delayMs: z.number().int().min(1).max(30000),
  }),
  z.strictObject({ mode: z.literal('flaky'), rate: z.number().min(0).max(1) }),
]);
export const killProcessSchema = z.strictObject({
  target: z.enum(['worker', 'api']),
});
export const toggleChaosSchema = z.strictObject({ active: z.boolean() });
export const processStateSchema = z.object({
  state: z.enum(['up', 'down', 'starting', 'restarting']),
  instance: z.string().optional(),
  restarts: z.number().int().nonnegative().default(0),
});
export const chaosStatusSchema = z.object({
  enabled: z.boolean(),
  active: z.boolean().default(true),
  api: processStateSchema,
  worker: processStateSchema,
  llm: llmFaultSchema,
});
export type ChaosStatus = z.infer<typeof chaosStatusSchema>;
