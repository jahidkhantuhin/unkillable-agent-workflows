'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  createRunSchema,
  runDTOSchema,
  hasPermission,
  type RunDTO,
} from '@unkillable/shared';
import { Button } from './ui/button';
import { useAuth } from './auth-provider';
import { RunScenario, runTitle } from './run-scenario';
export function RunStatus({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-3 py-1 text-xs ${status === 'succeeded' ? 'border-emerald-500/40 text-emerald-500' : status === 'failed' ? 'border-red-500/40 text-red-500' : status === 'waiting_approval' ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'border-border text-muted-foreground'}`}
    >
      {status.replaceAll('_', ' ')}
    </span>
  );
}
export function RunsList() {
  const [runs, setRuns] = useState<RunDTO[]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { identity } = useAuth();
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch('/api/backend/runs', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            'Unable to load runs. Check your session and the API.',
          );
        const data: unknown = await response.json();
        if (!Array.isArray(data)) throw new Error('Invalid run response');
        setRuns(data.map((value) => runDTOSchema.parse(value)));
        setLoaded(true);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : 'Unable to load runs',
          );
      } finally {
        fetching = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      const form = new FormData(event.currentTarget);
      const input = createRunSchema.parse({
        input: {
          title: form.get('title'),
          message: form.get('message'),
          deliveryMode: form.get('deliveryMode'),
          requireApproval: form.get('requireApproval') === 'on',
        },
      });
      const response = await fetch('/api/backend/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Could not queue run');
      router.push(`/runs/${runDTOSchema.parse(body).id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not queue run');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs tracking-widest text-emerald-500">
            DURABLE EXECUTION
          </p>
          <h1 className="mt-3 text-4xl font-semibold">Runs</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Start a demo, follow its events, and inspect its saved state.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          Updates every 3 seconds
        </span>
      </div>
      <section className="my-8 rounded-2xl border border-border bg-muted/20 p-6">
        <h2 className="text-lg font-medium">Durability demo</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Prepare → Summarize → Complete. Three deterministic steps; no models
          or external actions.
        </p>
        {identity && hasPermission(identity.role, 'runs:create') ? (
          <form
            onSubmit={start}
            className="mt-5 flex flex-wrap items-end gap-4"
          >
            <label className="w-full text-sm font-medium">
              Test title
              <input
                name="title"
                required
                maxLength={200}
                defaultValue="My workflow test"
                className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
              />
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                A name to identify this run. Approval edits do not change it.
              </span>
            </label>
            <label className="w-full text-sm font-medium">
              Notice content
              <textarea
                name="message"
                aria-label="Notice content"
                required
                maxLength={500}
                rows={3}
                defaultValue="Keep my workflow running after a worker restart"
                className="mt-2 w-full rounded-lg border border-border bg-background p-3 text-sm"
              />
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                The local notice to deliver. An approver can edit this content
                before delivery.
              </span>
            </label>
            <label className="text-xs text-muted-foreground">
              Local delivery simulation
              <select
                name="deliveryMode"
                aria-label="Local delivery simulation"
                defaultValue="normal"
                className="mt-1 block h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="normal">Healthy delivery</option>
                <option value="retry-once">
                  Transient failure, then recover
                </option>
                <option value="exhaust">
                  Exhaust retries; recover on manual retry
                </option>
                <option value="permanent">
                  Permanent failure; discard example
                </option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="requireApproval"
                className="size-4 accent-emerald-500"
              />
              Require human approval
            </label>
            <Button type="submit" disabled={pending}>
              {pending ? 'Queueing…' : 'Start demo run'}
            </Button>
          </form>
        ) : (
          <p className="mt-5 text-sm text-muted-foreground">
            Viewers can inspect runs. Sign in as an approver or admin to start
            one.
          </p>
        )}
      </section>
      {error && (
        <p role="alert" className="mb-5 text-sm text-red-500">
          {error}
        </p>
      )}
      <section className="overflow-hidden rounded-2xl border border-border">
        <div className="border-b border-border px-6 py-4 text-sm font-medium">
          Latest runs
        </div>
        {!loaded ? (
          <p className="p-6 text-muted-foreground">Loading runs…</p>
        ) : !runs.length ? (
          <p className="p-6 text-muted-foreground">
            No runs yet. Start the demo to create the first timeline.
          </p>
        ) : (
          <ul>
            {runs.map((run) => (
              <li key={run.id} className="border-b border-border last:border-0">
                <Link
                  href={`/runs/${run.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 p-6 hover:bg-muted/40"
                >
                  <div>
                    <h2 className="break-words text-lg font-semibold">
                      {runTitle(run.state)}
                    </h2>
                    <div className="mt-2">
                      <RunScenario state={run.state} />
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {run.id}
                    </p>
                  </div>
                  <RunStatus status={run.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
