import { policyDecisionSchema } from '@unkillable/shared';
export function PolicyTrace({ value }: { value: unknown }) {
  const parsed = policyDecisionSchema.safeParse(value);
  if (!parsed.success) return null;
  const decision = parsed.data;
  return (
    <section className="mt-6 rounded-2xl border border-border p-6">
      <h2 className="text-lg font-semibold">Approval policy decision</h2>
      <p className="mt-2 text-sm">
        {decision.policyName} · version {decision.version} ·{' '}
        {decision.outcome.replaceAll('_', ' ')}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{decision.reason}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Risk: {decision.inputs.riskTier}; amount: USD{' '}
        {(decision.inputs.amountCents / 100).toFixed(2)}; confidence:{' '}
        {decision.inputs.confidence}; tier: {decision.inputs.customerTier}; hour
        UTC: {decision.inputs.hourUtc}. Required reviewers:{' '}
        {decision.requiredApprovals}.
      </p>
      <ul className="mt-3 space-y-1 text-sm">
        {decision.trace.map((t) => (
          <li key={t.ruleId}>
            {t.ruleId}: {t.matched ? 'matched' : 'did not match'} — {t.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}
