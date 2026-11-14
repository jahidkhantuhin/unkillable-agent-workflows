'use client';
import { useEffect, useState } from 'react';
import {
  reliabilityDetailsSchema,
  type ReliabilityDetails,
} from '@unkillable/shared';
export function ReliabilityPanel({ runId }: { runId: string }) {
  const [details, setDetails] = useState<ReliabilityDetails | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(`/api/backend/runs/${runId}/reliability`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load reliability records');
        setDetails(reliabilityDetailsSchema.parse(await response.json()));
        setError('');
      } catch {
        if (!controller.signal.aborted)
          setError('Unable to load reliability records');
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
  }, [runId]);
  return (
    <section className="mt-6 rounded-2xl border border-border p-6">
      <h2 className="font-medium">Effect receipts and outbox</h2>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Local MongoDB notice sink only. No email or payment is sent. Receipts
        and deliveries retain stable keys across retries.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-500">
          {error}
        </p>
      )}
      {details && (
        <>
          <div className="mt-5 flex flex-wrap gap-5 text-sm">
            <p>{details.keys.length} stored receipts</p>
            <p className="text-emerald-500">
              Local deliveries: {details.deliveries.length}
            </p>
          </div>
          <ul className="mt-4 space-y-3">
            {details.outbox.map((record) => (
              <li key={record.id} className="rounded-lg bg-muted p-4 text-xs">
                <p className="break-all font-mono">{record.key}</p>
                <p className="mt-2 capitalize">
                  Outbox: {record.status} · {record.attempts} delivery
                  attempt(s)
                </p>
                {record.lastError && <p className="mt-2">{record.lastError}</p>}
              </li>
            ))}
          </ul>
          <details className="mt-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Inspect receipts</summary>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(details.keys, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
