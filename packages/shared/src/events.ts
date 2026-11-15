import { z } from 'zod';
import { idSchema } from './domain';
const base = z.object({
  id: idSchema,
  runId: idSchema,
  threadId: idSchema,
  sequence: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
  key: z.string().optional(),
});
const step = { stepName: z.string().min(1) };
export const runEventSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('RUN_STARTED') }),
  base.extend({
    type: z.literal('RUN_FINISHED'),
    outcome: z.enum(['succeeded', 'compensated', 'cancelled']),
  }),
  base.extend({
    type: z.literal('RUN_ERROR'),
    message: z.string(),
    code: z.string(),
  }),
  base.extend({
    type: z.literal('STEP_STARTED'),
    ...step,
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  base.extend({
    type: z.literal('STEP_FINISHED'),
    ...step,
    output: z.record(z.string(), z.unknown()).optional(),
  }),
  base.extend({
    type: z.literal('STATE_SNAPSHOT'),
    snapshot: z.record(z.string(), z.unknown()),
  }),
  base.extend({
    type: z.literal('STATE_DELTA'),
    delta: z.array(
      z.object({
        op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
        path: z.string(),
        from: z.string().optional(),
        value: z.unknown().optional(),
      }),
    ),
  }),
  base.extend({
    type: z.literal('TOOL_CALL_START'),
    toolCallId: idSchema,
    toolCallName: z.string(),
    parentMessageId: idSchema.optional(),
  }),
  base.extend({ type: z.literal('TOOL_CALL_END'), toolCallId: idSchema }),
  base.extend({
    type: z.literal('CUSTOM'),
    name: z.enum([
      'run.queued',
      'run.resumed',
      'run.retried',
      'deadletter.discarded',
      'node.attempt',
      'effect.completed',
      'outbox.delivered',
      'outbox.failed',
      'approval.requested',
      'approval.resolved',
      'retry.scheduled',
      'compensation.started',
      'compensation.finished',
      'compensation.failed',
    ]),
    value: z.record(z.string(), z.unknown()),
  }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
