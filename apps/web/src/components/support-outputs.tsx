import { supportStateSchema } from '@unkillable/shared';
export function SupportOutputs({ state }: { state: Record<string, unknown> }) {
  const parsed = supportStateSchema.safeParse(state);
  if (!parsed.success) return null;
  const value = parsed.data;
  const outputs = {
    Classification: value.classification,
    'Retrieved policies': value.policies,
    'Draft and citation': value.draft,
    'Risk check and proposed refund': value.risk,
    'Approved reply': value.approvedMessage,
    'Fake refund receipt': value.refund,
    'Mailpit email receipt': value.email,
    'Ticket status': value.ticketStatus,
  };
  return (
    <section className="mt-6 rounded-2xl border border-border p-6">
      <h2 className="font-medium">Support node outputs</h2>
      {Boolean(state.saga) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Forward outputs retain the saved history. Check effect receipts above
          for current refund and email status after compensation.
        </p>
      )}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {Object.entries(outputs).map(([label, output]) => (
          <div key={label} className="min-w-0 rounded-lg bg-muted p-4">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {label}
            </h3>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">
              {typeof output === 'string'
                ? output || 'Not yet available'
                : JSON.stringify(output, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
