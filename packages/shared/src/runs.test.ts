import { describe, expect, it } from 'vitest';
import { canTransition, createRunSchema, eventCursorSchema } from './runs';
describe('run lifecycle contracts', () => {
  it('accepts separate titles and content while preserving legacy message-only requests', () => {
    expect(
      createRunSchema.parse({
        input: { title: ' Test identity ', message: ' Notice content ' },
      }).input,
    ).toMatchObject({ title: 'Test identity', message: 'Notice content' });
    expect(
      createRunSchema.safeParse({ input: { message: 'Legacy notice' } })
        .success,
    ).toBe(true);
    for (const title of [' ', 'x'.repeat(201)])
      expect(
        createRunSchema.safeParse({ input: { title, message: 'Notice' } })
          .success,
      ).toBe(false);
  });
  it.each([
    ['queued', 'running', true],
    ['queued', 'succeeded', false],
    ['running', 'succeeded', true],
    ['running', 'waiting_approval', true],
    ['waiting_approval', 'queued', true],
    ['running', 'failed', true],
    ['running', 'compensating', true],
    ['compensating', 'compensated', true],
    ['succeeded', 'running', false],
    ['failed', 'running', false],
  ] as const)('%s -> %s = %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
  it('rejects unsupported workflows, oversized inputs, and unsafe cursors', () => {
    expect(
      createRunSchema.safeParse({
        workflowId: 'unknown',
        input: { message: 'hello' },
      }).success,
    ).toBe(false);
    expect(
      createRunSchema.safeParse({ input: { message: 'x'.repeat(501) } })
        .success,
    ).toBe(false);
    expect(eventCursorSchema.safeParse('-1').success).toBe(false);
    expect(eventCursorSchema.safeParse('9007199254740992').success).toBe(false);
  });
});
