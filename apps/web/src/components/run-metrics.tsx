'use client';
import { useEffect, useState } from 'react';
import { runMetricsSchema, workflowCostsSchema } from '@unkillable/shared';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
export function RunMetrics({
  runId,
  revision,
}: {
  runId: string;
  revision: number;
}) {
  const [data, setData] = useState<ReturnType<
      typeof runMetricsSchema.parse
    > | null>(null),
    [error, setError] = useState('');
  const toast = useToast();
  async function load(signal?: AbortSignal) {
    try {
      const response = await fetch(`/api/backend/runs/${runId}/metrics`, {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Unable to load run cost and latency');
      setData(runMetricsSchema.parse(await response.json()));
      setError('');
      if (!signal) toast.success('Run metrics refreshed.');
    } catch (error) {
      if (!signal?.aborted) {
        setError((error as Error).message);
        if (!signal) toast.error(error);
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [runId, revision]);
  return (
    <section className="mt-6 rounded-2xl border border-border p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Run cost and latency</h2>
        <Button variant="outline" onClick={() => load()}>
          Refresh run metrics
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="mt-3 text-sm">
            Elapsed {(data.elapsedMs / 1000).toFixed(1)}s · Approval wait{' '}
            {(data.approvalWaitMs / 1000).toFixed(1)}s
          </p>
          <p className="mt-2 text-sm">
            Recorded model calls: {data.calls} · Input tokens:{' '}
            {data.inputTokens} · Output tokens: {data.outputTokens}
          </p>
          <p className="mt-2 text-sm">
            Known estimated cost: USD {data.knownCostUsd.toFixed(6)}
            {data.unpricedCalls
              ? ` · ${data.unpricedCalls} calls have unknown cost`
              : ''}
            {data.missingUsageCalls
              ? ` · ${data.missingUsageCalls} calls have missing token usage`
              : ''}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Estimates use configured rates, not a provider invoice. Mock calls
            cost zero. Killed or failed provider calls may have unreported
            usage. Refresh after completion for final persisted spans.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm [&_td]:pr-4 [&_th]:pb-2 [&_th]:pr-4">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Execution / attempt</th>
                  <th>Duration</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.spans.map((span) => (
                  <tr key={span.id}>
                    <td className="py-2">
                      {span.nodeId}
                      <span className="block break-all text-xs text-muted-foreground">
                        Trace {span.traceId}
                      </span>
                    </td>
                    <td>
                      {span.execution} / {span.attempt}
                    </td>
                    <td>{span.durationMs} ms</td>
                    <td>{span.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.spans.length && <p>No completed spans recorded yet.</p>}
          </div>
        </>
      )}
    </section>
  );
}
export function WorkflowCosts() {
  const [data, setData] = useState<ReturnType<
      typeof workflowCostsSchema.parse
    > | null>(null),
    [error, setError] = useState('');
  const toast = useToast();
  async function load(signal?: AbortSignal) {
    try {
      const response = await fetch('/api/backend/analytics/costs', {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Unable to load workflow costs');
      setData(workflowCostsSchema.parse(await response.json()));
      setError('');
      if (!signal) toast.success('Workflow costs refreshed.');
    } catch (error) {
      if (!signal?.aborted) {
        setError((error as Error).message);
        if (!signal) toast.error(error);
      }
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  return (
    <section className="mt-8 rounded-2xl border border-border p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Cost per workflow</h2>
        <Button variant="outline" onClick={() => load()}>
          Refresh workflow costs
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="mt-3 text-sm text-muted-foreground">
            {data.scope}. Failed calls without provider usage may be absent.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm [&_td]:pr-4 [&_th]:pb-2 [&_th]:pr-4">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Runs / calls</th>
                  <th>Tokens in / out</th>
                  <th>Known USD</th>
                  <th>Unpriced calls</th>
                </tr>
              </thead>
              <tbody>
                {data.workflows.map((w) => (
                  <tr key={w.workflowId}>
                    <td className="py-3">{w.workflowId}</td>
                    <td>
                      {w.runs} / {w.calls}
                    </td>
                    <td>
                      {w.inputTokens} / {w.outputTokens}
                    </td>
                    <td>{w.knownCostUsd.toFixed(6)}</td>
                    <td>{w.unpricedCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
