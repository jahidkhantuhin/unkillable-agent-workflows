'use client';
import { ApprovalSla } from './approval-sla';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  approvalDTOSchema,
  type ApprovalDTO,
  type ApprovalDecision,
} from '@unkillable/shared';
import { Button } from './ui/button';
import { useAuth } from './auth-provider';
import { PolicyTrace } from './policy-trace';
import { useToast } from './toast-provider';
import { DownloadContent } from './download-content';
import { ApprovalLinks } from './approval-links';
import { InstallApp } from './pwa';
function ApprovalCard({
  approval,
  onResolved,
}: {
  approval: ApprovalDTO;
  onResolved: (next: ApprovalDTO) => void;
}) {
  const toast = useToast();
  const original =
    approval.reviews.find((review) => review.action === 'edit')?.message ??
    String(approval.proposedAction.message ?? '');
  const moderation = approval.proposedAction.kind === 'moderation';
  const { identity } = useAuth();
  const alreadyReviewed = approval.reviews.some(
    (review) => review.actorId === identity?.user.id,
  );
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
      toast.success(
        decision.action === 'reject'
          ? 'Rejection recorded.'
          : decision.action === 'edit'
            ? 'Edited draft review recorded.'
            : 'Approval review recorded.',
      );
      const current = await fetch(`/api/backend/approvals/${approval.id}`, {
        cache: 'no-store',
      });
      if (!current.ok)
        throw new Error(
          'Decision recorded; refresh to see the current review state.',
        );
      onResolved(approvalDTOSchema.parse(await current.json()));
    } catch (error) {
      toast.error(error, 'Unable to resolve approval');
      setError(
        error instanceof Error ? error.message : 'Unable to resolve approval',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      id={`approval-${approval.id}`}
      className="scroll-mt-4 rounded-2xl border border-border p-4 sm:p-6"
    >
      <h2 className="break-words text-lg font-semibold">
        {approval.title || original}
      </h2>
      <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
        Pending review ·{' '}
        {approval.proposedAction.kind === 'support-ticket'
          ? 'Support ticket'
          : moderation
            ? 'Content moderation'
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
      <p className="mt-3 text-sm">
        Reviews: {approval.reviews.length}/{approval.requiredApprovals}.{' '}
        {alreadyReviewed
          ? 'Your review is recorded. A different reviewer must finish this approval.'
          : approval.requiredApprovals === 2
            ? 'Two distinct reviewers are required.'
            : ''}
      </p>
      {approval.reviews.map((review) => (
        <p key={review.actorId} className="mt-1 text-xs text-muted-foreground">
          {review.action} · {review.actorId} · {review.at}
        </p>
      ))}
      <PolicyTrace value={approval.proposedAction.policyDecision} />
      <ApprovalSla approval={approval} />
      <p className="mt-4 text-xs text-muted-foreground">
        {approval.proposedAction.kind === 'support-ticket'
          ? `Proposed action: fake refund USD ${(Number(approval.proposedAction.refundCents) / 100).toFixed(2)}; send reply to ${String(approval.proposedAction.recipient)} through local Mailpit. No real payment or customer email.`
          : moderation
            ? 'Review the immutable original text before local publication. Approve publishes it; reject records a rejection. No external platform is contacted.'
            : 'Proposed action: store one local notice. No email or payment is sent.'}
      </p>
      {approval.proposedAction.kind === 'support-ticket' && (
        <p className="mt-3 text-xs text-muted-foreground">
          Policy {String(approval.proposedAction.citedPolicyId)}:{' '}
          {String(approval.proposedAction.citedSnippet)}
        </p>
      )}
      <label className="mt-4 block text-sm font-medium">
        {moderation
          ? 'Content preview (first 500 characters)'
          : 'Draft content'}
        <textarea
          value={draft}
          disabled={
            moderation || approval.reviews.length > 0 || alreadyReviewed
          }
          onChange={(event) => setDraft(event.target.value)}
          maxLength={500}
          rows={3}
          className="mt-2 block w-full rounded-lg border border-border bg-background p-3 text-sm"
        />
      </label>
      {moderation && (
        <DownloadContent
          className="mt-3 inline-block text-sm underline"
          runId={approval.runId}
        >
          Download full original content before reviewing
        </DownloadContent>
      )}
      <label className="mt-4 block text-sm font-medium">
        Review reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={1000}
          className="mt-2 block w-full rounded-lg border border-border bg-background p-3 text-sm"
          placeholder={
            moderation
              ? 'Required when rejecting'
              : 'Required when editing or rejecting'
          }
        />
      </label>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap [&_button]:min-h-11">
        <Button
          disabled={busy || alreadyReviewed || draft !== original}
          onClick={() => resolve({ action: 'approve' })}
        >
          {moderation
            ? 'Approve publication'
            : approval.reviews.length
              ? 'Approve reviewed draft'
              : 'Approve original'}
        </Button>
        {!moderation && (
          <Button
            variant="outline"
            disabled={
              busy ||
              alreadyReviewed ||
              approval.reviews.length > 0 ||
              !reason.trim() ||
              !draft.trim() ||
              draft === original
            }
            onClick={() =>
              resolve({ action: 'edit', payload: { message: draft }, reason })
            }
          >
            Approve edited draft
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy || alreadyReviewed || !reason.trim()}
          onClick={() => resolve({ action: 'reject', reason })}
        >
          Reject
        </Button>
      </div>
      <ApprovalLinks
        key={approval.version}
        id={approval.id}
        disabled={busy || alreadyReviewed}
      />
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
      <InstallApp compact />
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
              key={`${approval.id}-${approval.version}`}
              approval={approval}
              onResolved={(next) => {
                setApprovals((previous) =>
                  previous.map((a) => (a.id === next.id ? next : a)),
                );
                if (next.status !== 'pending')
                  setResolved((previous) => [...previous, next.id]);
              }}
            />
          ))
        )}
      </div>
    </>
  );
}
