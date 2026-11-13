import { z } from 'zod';
export * from './domain';
export * from './events';
export * from './auth';
export * from './runs';

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  services: z.object({ mongo: z.boolean(), redis: z.boolean() }),
});
export type Health = z.infer<typeof healthSchema>;
export const queueName = 'workflow-runs';
export const infrastructureSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  REDIS_URL: z
    .url()
    .refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol)),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});
