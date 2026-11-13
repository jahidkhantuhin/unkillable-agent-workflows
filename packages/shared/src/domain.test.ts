import { describe, expect, it } from 'vitest';
import { membershipSchema, runSchema, idempotencyKeySchema } from './domain';
import { runEventSchema } from './events';
describe('domain contracts', () => {
  it('rejects unknown roles and run states', () => {
    const dates = {
      id: 'document',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const membership = membershipSchema.parse({
      ...dates,
      userId: 'user',
      workspaceId: 'local',
      role: 'viewer',
    });
    const run = runSchema.parse({
      ...dates,
      workflowId: 'workflow',
      workflowVersion: 1,
      createdBy: 'user',
      status: 'queued',
      state: {},
    });
    expect(
      membershipSchema.safeParse({ ...membership, role: 'owner' }).success,
    ).toBe(false);
    expect(runSchema.safeParse({ ...run, status: 'done' }).success).toBe(false);
  });
  it('validates event variants and rejects missing variant fields', () => {
    const base = {
      id: 'event',
      runId: 'run',
      threadId: 'run',
      sequence: 1,
      timestamp: 1,
    };
    expect(
      runEventSchema.parse({
        ...base,
        type: 'STEP_STARTED',
        stepName: 'classify',
      }).type,
    ).toBe('STEP_STARTED');
    expect(
      runEventSchema.safeParse({ ...base, type: 'TOOL_CALL_START' }).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse({
        ...base,
        type: 'CUSTOM',
        name: 'arbitrary',
        value: {},
      }).success,
    ).toBe(false);
  });
  it('requires a nonempty idempotency key', () => {
    expect(
      idempotencyKeySchema.safeParse({
        id: 'key',
        key: '',
        runId: 'run',
        nodeId: 'node',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).success,
    ).toBe(false);
  });
});
