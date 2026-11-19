import { z } from 'zod';
import { runDTOSchema } from './runs';
// LangGraph encodes the step in the UUID variant (including ffff for input).
export const checkpointIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
export const forkRelationsSchema = z.object({
  parent: runDTOSchema.nullable(),
  children: z.array(runDTOSchema),
});
export const checkpointParamsSchema = z.strictObject({
  id: z.uuid(),
  checkpointId: checkpointIdSchema,
});
export const checkpointQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: checkpointIdSchema.optional(),
});
export const checkpointDiffQuerySchema = z.strictObject({
  from: checkpointIdSchema,
  to: checkpointIdSchema,
});
export const forkRunSchema = z.strictObject({
  checkpointId: checkpointIdSchema,
  edits: z.record(z.string(), z.unknown()).default({}),
});
export const demoForkEditsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(500).optional(),
  deliveryMode: z
    .enum(['normal', 'retry-once', 'exhaust', 'permanent'])
    .optional(),
  requireApproval: z.boolean().optional(),
});
export const supportForkEditsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  draftMessage: z.string().trim().min(1).max(500).optional(),
});
export const moderationForkEditsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
});
export const checkpointSummarySchema = z.object({
  id: checkpointIdSchema,
  parentId: checkpointIdSchema.nullable(),
  createdAt: z.string().nullable(),
  step: z.number().nullable(),
  next: z.array(z.string()),
  completed: z.array(z.string()),
  forkable: z.boolean(),
});
export const checkpointPageSchema = z.object({
  checkpoints: z.array(checkpointSummarySchema),
  nextBefore: checkpointIdSchema.nullable(),
});
export const checkpointDetailSchema = checkpointSummarySchema.extend({
  state: z.record(z.string(), z.unknown()),
});
export const stateChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['added', 'removed', 'changed']),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type StateChange = z.infer<typeof stateChangeSchema>;
export const checkpointDiffSchema = z.object({
  changes: z.array(stateChangeSchema),
});
export type CheckpointDetail = z.infer<typeof checkpointDetailSchema>;
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;
export type ForkRelations = z.infer<typeof forkRelationsSchema>;
export function diffStates(before: unknown, after: unknown): StateChange[] {
  const changes: StateChange[] = [];
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const equal = (a: unknown, b: unknown): boolean =>
    Object.is(a, b) ||
    (Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => equal(v, b[i]))
      : object(a) && object(b)
        ? Object.keys(a).length === Object.keys(b).length &&
          Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
        : false);
  const visit = (a: unknown, b: unknown, path: string) => {
    if (equal(a, b)) return;
    if (object(a) && object(b)) {
      for (const key of [
        ...new Set([...Object.keys(a), ...Object.keys(b)]),
      ].sort()) {
        const child = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (!Object.hasOwn(a, key))
          changes.push({ path: child, kind: 'added', after: b[key] });
        else if (!Object.hasOwn(b, key))
          changes.push({ path: child, kind: 'removed', before: a[key] });
        else visit(a[key], b[key], child);
      }
    } else changes.push({ path, kind: 'changed', before: a, after: b });
  };
  visit(before, after, '');
  return changes;
}
