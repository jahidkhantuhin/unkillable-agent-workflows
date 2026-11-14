'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  runEventSchema,
  runDTOSchema,
  type RunDTO,
  type RunEvent,
} from '@unkillable/shared';
import { RunStatus } from './runs-list';
import { ReliabilityPanel } from './reliability-panel';
import { RunScenario, runMessage } from './run-scenario';
function label(event: RunEvent) {
  if (event.type === 'STEP_STARTED') return `${event.stepName} started`;
  if (event.type === 'STEP_FINISHED') return `${event.stepName} checkpointed`;
  if (event.type === 'CUSTOM' && event.name === 'approval.requested')
    return 'Human approval requested';
  if (event.type === 'CUSTOM' && event.name === 'approval.resolved') {
    const decision = event.value.decision;
    const action =
      decision && typeof decision === 'object' && 'action' in decision
        ? String(decision.action)
        : 'resolved';
    return `Approval: ${action} · reviewer ${String(event.value.actorId)}`;
  }
  if (event.type === 'CUSTOM')
    if (event.name === 'retry.scheduled')
      return `${String(event.value.nodeId)} retry ${String(event.value.nextAttempt)} in ${String(event.value.delayMs)} ms`;
    else if (event.name === 'node.attempt')
      return `${String(event.value.nodeId)} attempt ${String(event.value.attempt)}`;
    else
      return event.name === 'run.resumed'
        ? 'Worker resumed from checkpoint'
        : event.name.replaceAll('.', ' ');
  return event.type.toLowerCase().replaceAll('_', ' ');
}
export function RunDetail({ initial }: { initial: RunDTO }) {
  const [run, setRun] = useState(initial);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState('Connecting');
  useEffect(() => {
    setRun(initial);
    setEvents([]);
    const stream = new EventSource(`/api/backend/runs/${initial.id}/events`);
    stream.onopen = () => setConnection('Live');
    stream.onerror = () => setConnection('Reconnecting…');
    stream.addEventListener('run-event', (message: MessageEvent) => {
      const parsed = runEventSchema.safeParse(JSON.parse(message.data));
      if (!parsed.success) {
        setConnection('Invalid event received');
        return;
      }
      const event = parsed.data;
      setEvents((previous) =>
        previous.some((item) => item.sequence === event.sequence)
          ? previous
          : [...previous, event].sort((a, b) => a.sequence - b.sequence),
      );
      setRun((previous) => {
        if (event.sequence <= previous.sequence) return previous;
        return {
          ...previous,
          sequence: event.sequence,
          updatedAt: new Date(event.timestamp).toISOString(),
          ...(event.type === 'STATE_SNAPSHOT' ? { state: event.snapshot } : {}),
          ...(event.type === 'RUN_STARTED'
            ? { status: 'running' as const }
            : {}),
          ...(event.type === 'RUN_FINISHED' ? { status: event.outcome } : {}),
          ...(event.type === 'RUN_ERROR'
            ? { status: 'failed' as const, error: event.message }
            : {}),
          ...(event.type === 'CUSTOM' && event.name === 'run.retried'
            ? {
                status: 'queued' as const,
                execution: Number(event.value.execution),
                error: undefined,
              }
            : {}),
          ...(event.type === 'CUSTOM' && event.name === 'approval.requested'
            ? { status: 'waiting_approval' as const }
            : {}),
          ...(event.type === 'CUSTOM' && event.name === 'approval.resolved'
            ? {
                status: 'queued' as const,
                execution: Number(event.value.execution),
              }
            : {}),
        };
      });
    });
    stream.addEventListener('stream-end', () => {
      setConnection('Replay complete');
      stream.close();
      void fetch(`/api/backend/runs/${initial.id}`, { cache: 'no-store' })
        .then(async (response) => {
          if (response.ok) setRun(runDTOSchema.parse(await response.json()));
        })
        .catch(() => {});
    });
    return () => stream.close();
  }, [initial.id, initial.execution]);
  return (
    <>
      <Link
        href="/runs"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← All runs
      </Link>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs tracking-widest text-emerald-500">
            DURABILITY DEMO
          </p>
          <h1 className="mt-3 text-4xl font-semibold">Run timeline</h1>
          <h2 className="mt-5 max-w-3xl break-words text-xl font-semibold">
            {runMessage(run.state)}
          </h2>
          <div className="mt-2">
            <RunScenario state={run.state} />
          </div>
          <p className="mt-3 break-all font-mono text-xs text-muted-foreground">
            {run.id}
          </p>
        </div>
        <RunStatus status={run.status} />
      </div>
      <ReliabilityPanel runId={run.id} />
      {run.status === 'waiting_approval' && (
        <div
          role="status"
          className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-5 text-sm"
        >
          <p className="font-semibold">Waiting for human approval</p>
          <p className="mt-2">
            The worker is free to process other runs. An approver or
            administrator can review the draft in the{' '}
            <Link href="/approvals" className="underline">
              Approval Inbox
            </Link>
            .
          </p>
        </div>
      )}
      {run.status === 'failed' && (
        <Link
          href="/dead-letters"
          className="mt-4 inline-block text-sm underline text-muted-foreground"
        >
          Inspect failure in Dead Letters (admin)
        </Link>
      )}
      <div className="mt-8 flex flex-wrap gap-3">
        {(run.state.requireApproval
          ? ['prepare', 'summarize', 'approval', 'complete']
          : ['prepare', 'summarize', 'complete']
        ).map((step) => (
          <span
            key={step}
            className={`rounded-lg border px-4 py-3 text-sm ${events.some((event) => event.type === 'STEP_FINISHED' && event.stepName === step) ? 'border-emerald-500/40 text-emerald-500' : 'border-border text-muted-foreground'}`}
          >
            {step}
          </span>
        ))}
      </div>
      <div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <section className="rounded-2xl border border-border p-6">
          <div className="flex flex-wrap justify-between gap-3">
            <h2 className="font-medium">Event history</h2>
            <p role="status" className="text-xs text-muted-foreground">
              {connection}
            </p>
          </div>
          <ol className="mt-6 border-l border-border pl-5">
            {events.map((event) => (
              <li key={event.sequence} className="relative pb-6">
                <span className="absolute -left-[25px] top-1 size-2 rounded-full bg-emerald-500" />
                <div className="flex flex-wrap justify-between gap-2">
                  <p className="text-sm font-medium capitalize">
                    {label(event)}
                  </p>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    #{event.sequence} ·{' '}
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Inspect event</summary>
                  <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(event, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
          {!events.length && (
            <p className="mt-4 text-sm text-muted-foreground">
              Loading saved events…
            </p>
          )}
        </section>
        <section className="self-start rounded-2xl border border-border p-6">
          <h2 className="font-medium">Latest saved state</h2>
          <p className="mt-2 text-xs text-muted-foreground">
            Rebuilt from checkpoint events; retained after worker and API
            restarts.
          </p>
          {run.error && (
            <p role="alert" className="mt-4 text-sm text-red-500">
              {run.error}
            </p>
          )}
          <pre className="mt-5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-xs leading-relaxed">
            {JSON.stringify(run.state, null, 2)}
          </pre>
        </section>
      </div>
    </>
  );
}
