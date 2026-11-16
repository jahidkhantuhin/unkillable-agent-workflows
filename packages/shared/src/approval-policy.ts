import { z } from 'zod';
export const policyOutcomeSchema = z.enum([
  'auto_approve',
  'require_approval',
  'require_two_approvals',
]);
export const policyInputsSchema = z.strictObject({
  action: z.literal('support_reply'),
  riskTier: z.enum(['low', 'high']),
  amountCents: z.number().int().min(0).max(100000),
  confidence: z.number().min(0).max(1),
  customerTier: z.enum(['standard', 'vip']),
  hourUtc: z.number().int().min(0).max(23),
});
export const approvalRuleSchema = z.strictObject({
  id: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(1).max(300),
  when: z
    .strictObject({
      riskTier: z.enum(['low', 'high']).optional(),
      minAmountCents: z.number().int().min(0).max(100000).optional(),
      maxAmountCents: z.number().int().min(0).max(100000).optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      customerTier: z.enum(['standard', 'vip']).optional(),
      hoursUtc: z
        .array(z.number().int().min(0).max(23))
        .min(1)
        .max(24)
        .optional(),
    })
    .refine(
      (w) =>
        w.minAmountCents === undefined ||
        w.maxAmountCents === undefined ||
        w.minAmountCents <= w.maxAmountCents,
      'Minimum amount exceeds maximum',
    ),
  outcome: policyOutcomeSchema,
});
export const approvalPolicySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  rules: z
    .array(approvalRuleSchema)
    .max(30)
    .refine(
      (r) => new Set(r.map((x) => x.id)).size === r.length,
      'Rule IDs must be unique',
    ),
  fallback: policyOutcomeSchema,
});
export const saveApprovalPolicySchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  policy: approvalPolicySchema,
});
export const dryRunPolicySchema = z.strictObject({
  policy: approvalPolicySchema,
});
export const policyDecisionSchema = z.object({
  version: z.number().int().nonnegative(),
  policyName: z.string(),
  inputs: policyInputsSchema,
  outcome: policyOutcomeSchema,
  requiredApprovals: z.number().int().min(0).max(2),
  reason: z.string(),
  trace: z.array(
    z.object({ ruleId: z.string(), matched: z.boolean(), reason: z.string() }),
  ),
});
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type PolicyInputs = z.infer<typeof policyInputsSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export const defaultApprovalPolicy: ApprovalPolicy = {
  name: 'Human review by default',
  rules: [],
  fallback: 'require_approval',
};
export const policyVersionDTOSchema = z.object({
  version: z.number().int(),
  policy: approvalPolicySchema,
  actorId: z.string(),
  actorName: z.string().nullable().default(null),
  createdAt: z.iso.datetime().nullable(),
});
export const policiesDTOSchema = z.object({
  current: policyVersionDTOSchema,
  history: z.array(policyVersionDTOSchema),
});
export const dryRunDTOSchema = z.object({
  limit: z.number(),
  total: z.number(),
  results: z.array(
    z.object({
      runId: z.string(),
      before: policyOutcomeSchema,
      after: policyOutcomeSchema,
      changed: z.boolean(),
      decision: policyDecisionSchema,
    }),
  ),
});
export const analyticsDTOSchema = z.object({
  scope: z.string(),
  evaluated: z.number(),
  humanRequired: z.number(),
  autoApproved: z.number(),
  humanApprovalRate: z.number().nullable(),
  resolved: z.number(),
  edited: z.number(),
  rejected: z.number(),
  editRate: z.number().nullable(),
  medianTimeToApproveMs: z.number().nullable(),
  approvedSamples: z.number(),
  rejectionReasons: z.array(
    z.object({ reason: z.string(), count: z.number() }),
  ),
  daily: z.array(
    z.object({
      date: z.string(),
      evaluated: z.number(),
      autoApproved: z.number(),
      autoApprovedShare: z.number(),
    }),
  ),
  feedback: z.array(
    z.object({
      runId: z.string(),
      actorId: z.string(),
      reviewerName: z.string().nullable().default(null),
      title: z.string().nullable().default(null),
      action: z.string(),
      original: z.string(),
      edited: z.string().nullable(),
      reason: z.string().nullable(),
      at: z.iso.datetime(),
    }),
  ),
});
export function evaluateApprovalPolicy(
  raw: ApprovalPolicy,
  rawInputs: PolicyInputs,
  version: number,
): PolicyDecision {
  const policy = approvalPolicySchema.parse(raw);
  const inputs = policyInputsSchema.parse(rawInputs);
  const trace: PolicyDecision['trace'] = [];
  let outcome = policy.fallback;
  let reason = 'No rule matched; use the configured fallback.';
  for (const rule of policy.rules) {
    const w = rule.when;
    const matched =
      (w.riskTier === undefined || w.riskTier === inputs.riskTier) &&
      (w.minAmountCents === undefined ||
        inputs.amountCents >= w.minAmountCents) &&
      (w.maxAmountCents === undefined ||
        inputs.amountCents <= w.maxAmountCents) &&
      (w.minConfidence === undefined || inputs.confidence >= w.minConfidence) &&
      (w.customerTier === undefined ||
        inputs.customerTier === w.customerTier) &&
      (w.hoursUtc === undefined || w.hoursUtc.includes(inputs.hourUtc));
    trace.push({ ruleId: rule.id, matched, reason: rule.reason });
    if (matched) {
      outcome = rule.outcome;
      reason = rule.reason;
      break;
    }
  }
  // An admin's rule cannot silently remove human control over money movement.
  if (
    outcome === 'auto_approve' &&
    (inputs.amountCents > 0 || inputs.riskTier === 'high')
  ) {
    outcome = 'require_approval';
    reason =
      'Human review required: money movement or high risk cannot be auto-approved.';
    trace.push({ ruleId: 'safety-floor', matched: true, reason });
  }
  return policyDecisionSchema.parse({
    version,
    policyName: policy.name,
    inputs,
    outcome,
    requiredApprovals:
      outcome === 'auto_approve'
        ? 0
        : outcome === 'require_two_approvals'
          ? 2
          : 1,
    reason,
    trace,
  });
}
