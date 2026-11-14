import { describe, it, expect } from 'vitest';
import { resolveApprovalSchema } from './approvals';
describe('approval decisions', () => {
  it('requires edited content and a rejection reason, and rejects injected fields', () => {
    for (const decision of [
      { action: 'edit', payload: { message: '' } },
      { action: 'reject', reason: ' ' },
      { action: 'approve', resolvedBy: 'spoofed' },
      { action: 'edit', payload: { message: 'valid', recipient: 'external' } },
    ])
      expect(
        resolveApprovalSchema.safeParse({ version: 0, decision }).success,
      ).toBe(false);
    expect(
      resolveApprovalSchema.parse({
        version: 0,
        decision: { action: 'edit', payload: { message: ' corrected ' } },
      }).decision,
    ).toEqual({ action: 'edit', payload: { message: 'corrected' } });
  });
});
