'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  approvalPolicySchema,
  policiesDTOSchema,
  dryRunDTOSchema,
} from '@unkillable/shared';
import { Button } from './ui/button';

const example = {
  name: 'Safe replies and dual review',
  rules: [
    {
      id: 'large-refund',
      reason: 'Large refunds need two different reviewers.',
      when: { minAmountCents: 10000 },
      outcome: 'require_two_approvals',
    },
    {
      id: 'safe-reply',
      reason: 'Confident low-risk replies move automatically.',
      when: { riskTier: 'low', maxAmountCents: 0, minConfidence: 0.95 },
      outcome: 'auto_approve',
    },
  ],
  fallback: 'require_approval',
};
export function PoliciesPanel() {
  const [data, setData] = useState<ReturnType<
    typeof policiesDTOSchema.parse
  > | null>(null);
  const [draft, setDraft] = useState('');
  const [trial, setTrial] = useState<ReturnType<
    typeof dryRunDTOSchema.parse
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  async function load(signal?: AbortSignal) {
    const response = await fetch('/api/backend/policies', {
      cache: 'no-store',
      signal,
    });
    if (!response.ok)
      throw new Error(
        'Unable to load policies. Administrator access is required.',
      );
    const next = policiesDTOSchema.parse(await response.json());
    setData(next);
    setDraft(JSON.stringify(next.current.policy, null, 2));
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(String(e.message));
    });
    return () => controller.abort();
  }, []);
  async function submit(save: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const policy = approvalPolicySchema.parse(JSON.parse(draft));
      const response = await fetch(
        `/api/backend/policies${save ? '' : '/dry-run'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            save
              ? { expectedVersion: data?.current.version, policy }
              : { policy },
          ),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Policy request failed');
      if (save) {
        await load();
        setTrial(null);
        setMessage(
          'New version activated. Existing decisions and approval waits stay pinned to their saved policy.',
        );
      } else {
        setTrial(dryRunDTOSchema.parse(body));
        setMessage('Dry-run only. No run or policy was changed.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid policy');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1 className="text-4xl font-semibold">Approval policies</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        First matching rule wins, otherwise fallback. Refunds and high-risk
        actions always need a human. Changes apply when new runs reach Risk
        Check.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-500">
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          aria-label="Policy update"
          className="mt-4 text-sm text-emerald-500"
        >
          {message}
        </p>
      )}
      {!data ? (
        <p className="mt-6">Loading policy…</p>
      ) : (
        <>
          <p className="mt-6 text-sm">
            Active version {data.current.version} · {data.current.policy.name}
          </p>
          <label className="mt-4 block text-sm font-medium">
            Policy JSON
            <textarea
              aria-label="Policy JSON"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setTrial(null);
              }}
              rows={18}
              className="mt-2 w-full rounded-xl border border-border bg-background p-4 font-mono text-xs"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => {
                setDraft(JSON.stringify(example, null, 2));
                setTrial(null);
              }}
            >
              Load example rules
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => {
                setDraft(JSON.stringify(data.current.policy, null, 2));
                setTrial(null);
              }}
            >
              Restore active draft
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => submit(false)}
            >
              Dry-run past decisions
            </Button>
            <Button disabled={busy} onClick={() => submit(true)}>
              Activate new version
            </Button>
          </div>
          {trial && (
            <section className="mt-6 rounded-2xl border border-border p-5">
              <h2 className="font-semibold">
                Dry-run: latest {trial.results.length} of {trial.total}{' '}
                decisions (limit {trial.limit})
              </h2>
              {!trial.results.length && (
                <p className="mt-2 text-sm">
                  Create a support ticket first to collect policy inputs.
                </p>
              )}
              <div className="mt-3 space-y-2">
                {trial.results.map((row) => (
                  <p key={row.runId} className="text-sm">
                    <Link className="underline" href={`/runs/${row.runId}`}>
                      {row.runId}
                    </Link>{' '}
                    · {row.before} → {row.after}{' '}
                    {row.changed ? '(changed)' : '(same)'} ·{' '}
                    {row.decision.reason}
                  </p>
                ))}
              </div>
            </section>
          )}
          <section className="mt-8 rounded-2xl border border-border p-5">
            <h2 className="text-lg font-semibold">Version history</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Latest 100 saved versions. Version 0 is the built-in human-review
              default. Load any version into the draft to inspect or reactivate
              it as a new version.
            </p>
            <div className="mt-3 space-y-3">
              {data.history.map((row) => (
                <div
                  key={row.version}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm"
                >
                  <span>
                    v{row.version} · {row.policy.name} · {row.createdAt} · actor{' '}
                    {row.actorId}
                  </span>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setDraft(JSON.stringify(row.policy, null, 2));
                      setTrial(null);
                    }}
                  >
                    Load v{row.version}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}
