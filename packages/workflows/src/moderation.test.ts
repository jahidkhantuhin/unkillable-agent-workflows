import { describe, it, expect } from 'vitest';
import { checkModeration, MockModerationLLM } from './moderation';
describe('moderation checks', () => {
  it.each([
    ['A friendly welcome', 'allow'],
    ['DEMO_BLOCK test', 'reject'],
    ['DEMO_REVIEW test', 'review'],
    ['x'.repeat(16001), 'review'],
    ['https://x '.repeat(6), 'review'],
  ])('routes a synthetic example to %s', async (text, decision) => {
    expect(
      (await checkModeration(text, new MockModerationLLM())).decision,
    ).toBe(decision);
  });
  it('checks the full file beyond the model preview and validates structured output', async () => {
    expect(
      (
        await checkModeration(
          'x'.repeat(17000) + 'DEMO_BLOCK',
          new MockModerationLLM(),
        )
      ).decision,
    ).toBe('reject');
    await expect(
      checkModeration('safe', {
        check: async () => ({
          verdict: 'allow',
          confidence: 3,
          reason: 'Invalid',
        }),
      }),
    ).rejects.toThrow();
    expect(
      (
        await checkModeration('safe', {
          check: async () => ({
            verdict: 'allow',
            confidence: 0.5,
            reason: 'Uncertain',
          }),
        })
      ).decision,
    ).toBe('review');
  });
});
