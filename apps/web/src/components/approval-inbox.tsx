'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  approvalDTOSchema,
  type ApprovalDTO,
  type ApprovalDecision,
} from '@unkillable/shared';
import { Button } from './ui/button';
function ApprovalCard({
  approval,
  onResolved,
}: {
  approval: ApprovalDTO;
  onResolved: (id: string) => void;
}) {
  const original = String(approval.proposedAction.message ?? '');
  const [draft, setDraft] = useState(original);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function resolve(decision: ApprovalDecision) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/backend/approvals/${approval.id}/resolve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: approval.version, decision }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Unable to resolve approval');
      onResolved(approval.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to resolve approval',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="rounded-2xl border border-border p-6">
      <h2 className="break-words text-lg font-semibold">
        {approval.title || original}
      </h2>
      <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
        Pending review ·{' '}
        {approval.proposedAction.kind === 'support-ticket'
          ? 'Support ticket'
          : 'Local notice'}
      </p>
      <Link
        href={`/runs/${approval.runId}`}
        className="mt-2 block break-all font-mono text-xs text-muted-foreground underline"
      >
        {approval.runId}
      </Link>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        {approval.reasoning}
      </p>
      <p className="mt-4 text-xs text-muted-foreground">
        {approval.proposedAction.kind === 'support-ticket'
          ? `Proposed action: fake refund USD ${(Number(approval.proposedAction.refundCents) / 100).toFixed(2)}; send reply to ${String(approval.proposedAction.recipient)} through local Mailpit. No real payment or customer email.`
          : 'Proposed action: store one local notice. No email or payment is sent.'}
      </p>
      {approval.proposedAction.kind === 'support-ticket' && (
        <p className="mt-3 text-xs text-muted-foreground">
          Policy {String(approval.proposedAction.citedPolicyId)}:{' '}
          {String(approval.proposedAction.citedSnippet)}
        </p>
      )}
      <label className="mt-4 block text-sm font-medium">
        Draft content
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={500}
          rows={3}
          className="mt-2 block w-full rounded-lg border border-border bg-background p-3 text-sm"
        />
      </label>
      <label className="mt-4 block text-sm font-medium">
        Rejection reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1000}
          className="mt-2 block w-full rounded-lg border border-border bg-background p-3 text-sm"
          placeholder="Required when rejecting"
        />
      </label>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button
          disabled={busy || draft !== original}
          onClick={() => resolve({ action: 'approve' })}
        >
          Approve original
        </Button>
        <Button
          variant="outline"
          disabled={busy || !draft.trim() || draft === original}
          onClick={() =>
            resolve({ action: 'edit', payload: { message: draft } })
          }
        >
          Approve edited draft
        </Button>
        <Button
          variant="outline"
          disabled={busy || !reason.trim()}
          onClick={() => resolve({ action: 'reject', reason })}
        >
          Reject
        </Button>
      </div>
    </article>
  );
}
export function ApprovalInbox() {
  const [approvals, setApprovals] = useState<ApprovalDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [resolved, setResolved] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch('/api/backend/approvals', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            'Unable to load approvals. Check your session and permissions.',
          );
        const body: unknown = await response.json();
        if (!Array.isArray(body)) throw new Error('Invalid approval response');
        setApprovals(body.map((value) => approvalDTOSchema.parse(value)));
        setLoaded(true);
        setError('');
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : 'Unable to load approvals',
          );
      } finally {
        fetching = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const pending = approvals.filter((item) => !resolved.includes(item.id));
  return (
    <>
      <p className="text-xs tracking-widest text-emerald-500">HUMAN CONTROL</p>
      <h1 className="mt-3 text-4xl font-semibold">Approval Inbox</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Review the proposed notice, approve it, edit it, or reject with a
        reason. Updates every 2 seconds.
      </p>
      {error && (
        <p role="alert" className="mt-5 text-sm text-red-500">
          {error}
        </p>
      )}
      {resolved.length > 0 && (
        <p
          role="status"
          className="mt-5 text-sm text-emerald-600 dark:text-emerald-400"
        >
          Decision recorded. Follow the run timeline for its outcome.
        </p>
      )}
      <div className="mt-8 space-y-5">
        {!loaded ? (
          <p>Loading approvals…</p>
        ) : !pending.length ? (
          <div className="rounded-2xl border border-dashed border-border p-8 text-muted-foreground">
            No pending approvals. Start a demo on{' '}
            <Link href="/runs" className="underline">
              Runs
            </Link>{' '}
            with Require human approval enabled.
          </div>
        ) : (
          pending.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              onResolved={(id) => setResolved((previous) => [...previous, id])}
            />
          ))
        )}
      </div>
    </>
  );
}
