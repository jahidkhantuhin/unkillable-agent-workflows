import { describe, it, expect } from 'vitest';
import {
  evaluateApprovalPolicy,
  approvalPolicySchema,
  defaultApprovalPolicy,
  type PolicyInputs,
  type ApprovalPolicy,
} from './approval-policy';
const inputs: PolicyInputs = {
  action: 'support_reply',
  riskTier: 'low',
  amountCents: 0,
  confidence: 0.98,
  customerTier: 'standard',
  hourUtc: 12,
};
const policy: ApprovalPolicy = {
  name: 'Rules',
  rules: [
    {
      id: 'large',
      when: { minAmountCents: 10000 },
      outcome: 'require_two_approvals',
      reason: 'Large amount needs two reviewers',
    },
    {
      id: 'vip-day',
      when: {
        riskTier: 'low',
        maxAmountCents: 0,
        minConfidence: 0.95,
        customerTier: 'vip',
        hoursUtc: [12, 13],
      },
      outcome: 'auto_approve',
      reason: 'Safe VIP reply in staffed hours',
    },
  ],
  fallback: 'require_approval',
};
describe('approval policy evaluation', () => {
  it.each([
    [{}, 'require_approval', 1],
    [{ customerTier: 'vip' }, 'auto_approve', 0],
    [{ customerTier: 'vip', hourUtc: 23 }, 'require_approval', 1],
    [{ customerTier: 'vip', confidence: 0.94 }, 'require_approval', 1],
    [{ amountCents: 10000, riskTier: 'high' }, 'require_two_approvals', 2],
    [{ amountCents: 9999, riskTier: 'high' }, 'require_approval', 1],
  ])('evaluates input %j as %s', (changes, outcome, count) => {
    const result = evaluateApprovalPolicy(
      policy,
      { ...inputs, ...changes } as PolicyInputs,
      3,
    );
    expect(result.outcome).toBe(outcome);
    expect(result.requiredApprovals).toBe(count);
    expect(result.version).toBe(3);
  });
  it('uses first match, records nonmatches, and enforces the money/high-risk safety floor', () => {
    const allAuto: ApprovalPolicy = {
      name: 'Unsafe fallback',
      rules: [],
      fallback: 'auto_approve',
    };
    for (const changes of [{ amountCents: 1 }, { riskTier: 'high' as const }]) {
      const result = evaluateApprovalPolicy(
        allAuto,
        { ...inputs, ...changes },
        1,
      );
      expect(result.outcome).toBe('require_approval');
      expect(result.trace.at(-1)?.ruleId).toBe('safety-floor');
    }
    expect(
      evaluateApprovalPolicy(
        policy,
        { ...inputs, customerTier: 'vip' },
        1,
      ).trace.map((t) => t.matched),
    ).toEqual([false, true]);
    expect(
      evaluateApprovalPolicy(
        {
          ...policy,
          rules: [
            {
              id: 'first',
              when: {},
              outcome: 'require_approval',
              reason: 'First wins',
            },
            ...policy.rules,
          ],
        },
        { ...inputs, customerTier: 'vip' },
        1,
      ).trace,
    ).toHaveLength(1);
  });
  it('rejects ambiguous or invalid rules and preserves conservative defaults', () => {
    expect(
      approvalPolicySchema.safeParse({
        ...policy,
        rules: [policy.rules[0], policy.rules[0]],
      }).success,
    ).toBe(false);
    expect(
      approvalPolicySchema.safeParse({
        ...policy,
        rules: [
          {
            ...policy.rules[0],
            when: { minAmountCents: 100, maxAmountCents: 1 },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      evaluateApprovalPolicy(defaultApprovalPolicy, inputs, 0).outcome,
    ).toBe('require_approval');
  });
});
