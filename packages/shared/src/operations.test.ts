import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvalSla,
  slaConfigSchema,
  usageCost,
  observabilityConfigSchema,
} from './operations';
afterEach(() => vi.useRealTimers());
describe('approval SLA deadlines and explicit pricing', () => {
  it('anchors deadlines to the approval request, not process restart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const createdAt = new Date(),
      config = slaConfigSchema.parse({
        APPROVAL_SLA_POLICIES: JSON.stringify({
          'durability-demo': {
            remindMs: 1000,
            escalateMs: 2000,
            expireMs: 3000,
            timeoutAction: 'cancel',
          },
        }),
      });
    const before = approvalSla('durability-demo', createdAt, config)!;
    vi.advanceTimersByTime(2500);
    expect(approvalSla('durability-demo', createdAt, config)).toEqual(before);
    expect(+before.expireAt - Date.now()).toBe(500);
    expect(
      approvalSla(
        'durability-demo',
        createdAt,
        slaConfigSchema.parse({ APPROVAL_SLA_ENABLED: 'false' }),
      ),
    ).toBeUndefined();
  });
  it('rejects unordered deadlines, invalid workflow names and negative rates', () => {
    expect(
      slaConfigSchema.safeParse({
        APPROVAL_SLA_POLICIES:
          '{"durability-demo":{"remindMs":3000,"escalateMs":2000,"expireMs":1000}}',
      }).success,
    ).toBe(false);
    expect(
      slaConfigSchema.safeParse({ APPROVAL_SLA_POLICIES: '{"unknown":{}}' })
        .success,
    ).toBe(false);
    expect(
      observabilityConfigSchema.safeParse({
        LLM_PRICING_JSON:
          '{"gemini:test":{"inputPerMillion":-1,"outputPerMillion":2}}',
      }).success,
    ).toBe(false);
  });
  it('computes configured estimates without inventing missing usage or rates', () => {
    expect(
      usageCost(1000, 500, { inputPerMillion: 1, outputPerMillion: 2 }),
    ).toBe(0.002);
    expect(
      usageCost(null, 500, { inputPerMillion: 1, outputPerMillion: 2 }),
    ).toBeNull();
    expect(usageCost(1000, 500)).toBeNull();
  });
});
