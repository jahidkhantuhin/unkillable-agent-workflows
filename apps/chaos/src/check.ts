import type { Document } from 'mongodb';
import type { Plan } from './config';
export type Evidence = {
  plan: Plan;
  run?: Document;
  refunds: Document[];
  emails: Document[];
  outbox: Document[];
  receipts: Document[];
  deliveries: Document[];
  ticket?: Document;
  captures: number;
  events: Document[];
};
export function check(item: Evidence, now: number, timeoutMs: number) {
  const errors: string[] = [];
  const run = item.run;
  if (!run) return ['missing run'];
  const compensation = ['permanent', 'compensation_crash'].includes(
    item.plan.kind,
  );
  if (!['succeeded', 'failed', 'compensated', 'cancelled'].includes(run.status))
    errors.push('nonterminal / lost run');
  if (
    run.status === 'running' &&
    now - new Date(run.updatedAt).getTime() > timeoutMs
  )
    errors.push('running past timeout');
  if (run.status !== (compensation ? 'compensated' : 'succeeded'))
    errors.push('unexpected terminal outcome');
  if (item.refunds.length > 1) errors.push('duplicate refund');
  if (
    item.refunds.length !== 1 ||
    item.refunds[0].status !== (compensation ? 'reversed' : 'active')
  )
    errors.push('refund state inconsistent');
  for (const purpose of ['reply', 'correction']) {
    const emails = item.emails.filter(
      (row) => (row.purpose ?? 'reply') === purpose,
    );
    if (emails.length > 1) errors.push(`duplicate ${purpose} email`);
    const expected = purpose === 'reply' || compensation ? 1 : 0;
    if (
      emails.length !== expected ||
      emails.some((row) => row.status !== 'sent')
    )
      errors.push(`${purpose} email state inconsistent`);
  }
  if (
    compensation &&
    !item.emails.find((row) => row.purpose === 'reply')?.voided
  )
    errors.push('original reply not voided');
  const expected = compensation ? 2 : 1;
  if (item.captures > expected) errors.push('duplicate Mailpit capture');
  if (item.captures !== expected)
    errors.push('Mailpit capture count inconsistent');
  if (
    item.outbox.length !== expected ||
    item.outbox.some((row) => row.status !== 'sent')
  )
    errors.push('outbox not fully acknowledged');
  if (item.deliveries.length !== expected)
    errors.push('delivery receipt count inconsistent');
  const keys = item.receipts.map((row) => row.key);
  if (
    new Set(keys).size !== keys.length ||
    item.receipts.some((row) => row.status !== 'completed')
  )
    errors.push('idempotency receipt inconsistent');
  if (item.ticket?.status !== (compensation ? 'open' : 'closed'))
    errors.push('ticket state inconsistent');
  if (compensation) {
    const expectedOrder = [
      'reopen_ticket',
      'send_correction_or_void',
      'reverse_refund',
    ];
    const finished = item.events
      .filter((e) => e.type === 'CUSTOM' && e.name === 'compensation.finished')
      .map((e) => e.value.nodeId);
    if (
      JSON.stringify(finished) !== JSON.stringify(expectedOrder) ||
      JSON.stringify(run.state.saga?.completed) !==
        JSON.stringify(expectedOrder)
    )
      errors.push('compensation order/progress inconsistent');
  }
  return errors;
}
