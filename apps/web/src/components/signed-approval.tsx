'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { approvalDTOSchema, signedPreviewSchema } from '@unkillable/shared';
import { useAuth } from './auth-provider';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
import { notificationRequest } from '../lib/notifications';
const storageKey = 'unkillable.pending-approval-link';
export function SignedApproval() {
  const { identity, loading } = useAuth(),
    toast = useToast();
  const [token, setToken] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [runId, setRunId] = useState('');
  const [preview, setPreview] = useState<{
    action: 'approve' | 'reject';
    expiresAt: string;
    approval: ReturnType<typeof approvalDTOSchema.parse>;
  } | null>(null);
  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (fragment) {
      sessionStorage.setItem(storageKey, fragment);
      window.history.replaceState(null, '', '/approve');
    }
    setToken(fragment || sessionStorage.getItem(storageKey) || '');
  }, []);
  useEffect(() => {
    if (!token || !identity) return;
    const controller = new AbortController();
    notificationRequest('links/inspect', { token }, controller.signal)
      .then((raw) => {
        const data = signedPreviewSchema.parse(raw);
        setPreview({
          ...data,
          approval: approvalDTOSchema.parse(data.approval),
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error.message);
          toast.error(error);
        }
      });
    return () => controller.abort();
  }, [token, identity?.user.id, toast]);
  async function resolve() {
    setBusy(true);
    setError('');
    try {
      const data = await notificationRequest('links/resolve', { token });
      if (typeof data.runId !== 'string')
        throw new Error('Invalid approval response');
      setRunId(data.runId);
      sessionStorage.removeItem(storageKey);
      toast.success('Review recorded. Follow the run for its outcome.');
    } catch (error) {
      setError((error as Error).message);
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-border p-5 sm:p-8">
      <h1 className="text-3xl font-semibold">Review signed approval</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Opening this page does not submit a decision. Review the saved proposal
        before confirming. An online connection is required.
      </p>
      {loading ? (
        <p className="mt-5">Checking session…</p>
      ) : !identity ? (
        <p className="mt-5">
          <Link className="underline" href="/login?next=/approve">
            Sign in to review this link
          </Link>
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mt-5 text-red-500">
              {error}
            </p>
          )}
          {runId ? (
            <p className="mt-5">
              Review recorded.{' '}
              <Link className="underline" href={`/runs/${runId}`}>
                Open run timeline
              </Link>
            </p>
          ) : preview ? (
            <div className="mt-5 space-y-4">
              <h2 className="break-words text-xl font-semibold">
                {preview.approval.title || 'Workflow review'}
              </h2>
              <p className="whitespace-pre-wrap break-words text-sm">
                {String(preview.approval.proposedAction.message)}
              </p>
              {preview.approval.proposedAction.kind === 'support-ticket' && (
                <p className="break-words text-sm">
                  Proposed local refund: USD{' '}
                  {(
                    Number(preview.approval.proposedAction.refundCents) / 100
                  ).toFixed(2)}
                  . Reply to {String(preview.approval.proposedAction.recipient)}{' '}
                  through local Mailpit.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {preview.approval.reasoning}
              </p>
              <p className="text-sm">
                Decision: {preview.action}. Reviews recorded:{' '}
                {preview.approval.reviews.length}/
                {preview.approval.requiredApprovals}. Expires{' '}
                {new Date(preview.expiresAt).toLocaleString()}.
              </p>
              {preview.approval.proposedAction.kind === 'moderation' && (
                <p className="text-sm">
                  Read the immutable original content in the inbox before
                  deciding.
                </p>
              )}
              <Link
                className="block underline"
                href={`/approvals#approval-${preview.approval.id}`}
              >
                Open full review / edit draft
              </Link>
              <Button
                className="min-h-11 w-full sm:w-auto"
                disabled={busy || !!error}
                onClick={resolve}
              >
                {busy ? 'Recording…' : `Confirm ${preview.action}`}
              </Button>
            </div>
          ) : (
            <p className="mt-5">
              {error
                ? 'Use the Approval Inbox to review the current request.'
                : token
                  ? 'Loading current approval…'
                  : 'No approval link found. Open a current link or use the Approval Inbox.'}
            </p>
          )}
        </>
      )}
      <Link className="mt-6 block text-sm underline" href="/approvals">
        Approval Inbox
      </Link>
    </section>
  );
}
