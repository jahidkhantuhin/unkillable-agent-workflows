'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { analyticsDTOSchema } from '@unkillable/shared';

import { Button } from './ui/button';
function percent(value: number | null) {
  return value === null ? 'Not measured' : `${(value * 100).toFixed(1)}%`;
}
export function ApprovalAnalytics() {
  const [data, setData] = useState<ReturnType<
      typeof analyticsDTOSchema.parse
    > | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh(signal?: AbortSignal) {
    setBusy(true);
    try {
      const response = await fetch('/api/backend/analytics', {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Unable to load approval analytics');
      setData(analyticsDTOSchema.parse(await response.json()));
      setError('');
    } catch (e) {
      if (!signal?.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load analytics');
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-4xl font-semibold">Approval analytics</h1>
        <Button disabled={busy} variant="outline" onClick={() => refresh()}>
          Refresh metrics
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-red-500">
          {error}
        </p>
      )}
      {!data ? (
        <p className="mt-6">Loading metrics…</p>
      ) : (
        <>
          <p className="mt-3 text-sm text-muted-foreground">
            {data.scope}. Decisions are not successful deliveries. No automatic
            training occurs.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                'Human approval rate',
                percent(data.humanApprovalRate),
                `${data.humanRequired}/${data.evaluated} decisions require a human, including pending reviews.`,
              ],
              [
                'Median time to approve',
                data.medianTimeToApproveMs === null
                  ? 'Not measured'
                  : `${(data.medianTimeToApproveMs / 1000).toFixed(1)} seconds`,
                `${data.approvedSamples} approved/edited approvals; request to final review, excluding rejections.`,
              ],
              [
                'Edit rate',
                percent(data.editRate),
                `${data.edited}/${data.resolved} resolved approvals ended with an edited draft.`,
              ],
              [
                'Auto-approved',
                String(data.autoApproved),
                'Policy decisions; includes runs that may later fail.',
              ],
            ].map(([title, value, note]) => (
              <section
                key={title}
                className="rounded-2xl border border-border p-5"
              >
                <h2 className="text-sm font-medium">{title}</h2>
                <p className="mt-3 text-2xl font-semibold">{value}</p>
                <p className="mt-2 text-xs text-muted-foreground">{note}</p>
              </section>
            ))}
          </div>
          <section className="mt-6 rounded-2xl border border-border p-5">
            <h2 className="text-lg font-semibold">
              Auto-approved share over time (UTC)
            </h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Evaluated</th>
                    <th>Auto-approved</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((d) => (
                    <tr key={d.date}>
                      <td className="py-2">{d.date}</td>
                      <td>{d.evaluated}</td>
                      <td>{d.autoApproved}</td>
                      <td>{percent(d.autoApprovedShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.daily.length && (
              <p className="mt-3 text-sm">No support policy decisions yet.</p>
            )}
          </section>
          <section className="mt-6 rounded-2xl border border-border p-5">
            <h2 className="text-lg font-semibold">
              Rejection reasons ({data.rejected})
            </h2>
            {data.rejectionReasons.map((r) => (
              <p key={r.reason} className="mt-2 break-words text-sm">
                {r.reason} · {r.count}
              </p>
            ))}
            {!data.rejected && (
              <p className="mt-2 text-sm">No rejections recorded.</p>
            )}
          </section>
          <section className="mt-6 rounded-2xl border border-border p-5">
            <h2 className="text-lg font-semibold">
              Reviewer feedback (latest 50 edits/rejections)
            </h2>
            {data.feedback.map((f, i) => (
              <article
                key={`${f.runId}-${i}`}
                className="mt-4 rounded-lg bg-muted p-4 text-sm"
              >
                <Link className="underline" href={`/runs/${f.runId}`}>
                  {f.runId}
                </Link>
                <p className="mt-2">
                  {f.action} · reviewer {f.actorId}
                </p>
                <p className="mt-2">Original: {f.original}</p>
                {f.edited && <p className="mt-2">Edited: {f.edited}</p>}
                <p className="mt-2">Reason: {f.reason ?? 'Not recorded'}</p>
              </article>
            ))}
            {!data.feedback.length && (
              <p className="mt-3 text-sm">No reviewer feedback yet.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
