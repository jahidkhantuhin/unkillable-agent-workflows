'use client';
import { useEffect, useState } from 'react';
import {
  chaosStatusSchema,
  runDTOSchema,
  supportNodeSchema,
  demoNodeSchema,
  compensationNodeSchema,
  moderationNodeSchema,
  moderationCompensationNodes,
  type ChaosStatus,
  type RunDTO,
} from '@unkillable/shared';
import { useAuth } from './auth-provider';
const button =
  'cursor-pointer rounded-xl border border-red-500/40 bg-red-500/10 px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40';
export function ChaosBanner() {
  const { identity } = useAuth();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (!identity) {
      setEnabled(false);
      return;
    }
    let disposed = false;
    const controller = new AbortController();
    const refresh = () =>
      void fetch('/api/backend/chaos/mode', {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (r) => {
          if (r.ok) {
            const data = await r.json();
            if (!disposed)
              setEnabled(data.enabled === true && data.active === true);
          }
        })
        .catch(() => {});
    refresh();
    window.addEventListener('chaos-mode-changed', refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('chaos-mode-changed', refresh);
    };
  }, [identity?.user.id]);
  return enabled ? (
    <div
      role="status"
      className="border-y border-red-500 bg-red-500/15 px-6 py-3 text-sm font-semibold text-red-700 dark:text-red-300"
    >
      CHAOS MODE ENABLED · Development fault injection can interrupt the API and
      worker. Fake payments and local Mailpit only.
    </div>
  ) : null;
}
export function RunChaosActions({ run }: { run: RunDTO }) {
  const { identity } = useAuth();
  return identity?.role === 'admin' ? <ChaosPanel run={run} /> : null;
}
export function ChaosPanel({ run }: { run?: RunDTO }) {
  const [status, setStatus] = useState<ChaosStatus | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunDTO[]>(run ? [run] : []),
    [runId, setRunId] = useState(run?.id ?? ''),
    [node, setNode] = useState(
      run?.workflowId === 'content-moderation'
        ? 'publish'
        : run?.workflowId === 'durability-demo'
          ? 'complete'
          : 'send_email',
    );
  const [phase, setPhase] = useState('before'),
    [mode, setMode] = useState('throw_once'),
    [delay, setDelay] = useState(2000);
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const r = await fetch('/api/backend/chaos/status', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!r.ok) throw new Error('Chaos status unavailable');
        setStatus(chaosStatusSchema.parse(await r.json()));
        setError('');
      } catch {
        if (!controller.signal.aborted)
          setError(
            'API unreachable. Waiting for its supervisor to restart it, or for connectivity to return.',
          );
      } finally {
        fetching = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    if (!run)
      void fetch('/api/backend/runs', {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (r) => {
          if (r.ok)
            setRuns(
              (await r.json()).map((v: unknown) => runDTOSchema.parse(v)),
            );
        })
        .catch(() => {});
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [run?.id]);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setNotice('');
    try {
      const r = await fetch(`/api/backend/chaos/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message ?? 'Action refused');
      if (path === 'toggle') {
        setStatus(chaosStatusSchema.parse(data));
        window.dispatchEvent(new Event('chaos-mode-changed'));
      }
      setNotice(
        path === 'toggle'
          ? data.active
            ? 'Fault injection is active.'
            : 'Fault injection paused. Pending faults cleared and model simulation reset. Recovery of already-triggered actions continues.'
          : path === 'kill'
            ? 'Crash requested. Watch the process status recover.'
            : 'Control saved. Temporary settings expire after five minutes.',
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }
  const chosen = run ?? runs.find((item) => item.id === runId);
  const nodes =
    chosen?.workflowId === 'content-moderation'
      ? [...moderationNodeSchema.options, ...moderationCompensationNodes]
      : chosen?.workflowId === 'durability-demo'
        ? demoNodeSchema.options
        : [
            ...supportNodeSchema.options,
            ...compensationNodeSchema.options.filter(
              (node) =>
                !(moderationCompensationNodes as readonly string[]).includes(
                  node,
                ),
            ),
          ];
  const disabled = busy || !status?.enabled || !status?.active || !!error;
  return (
    <section
      className="mt-8 rounded-2xl border border-red-500/30 p-6"
      aria-label={run ? 'Run chaos actions' : 'Chaos controls'}
    >
      <h2 className="text-xl font-semibold">
        {run ? 'Fault controls for this run' : 'Chaos control panel'}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Admin-only development controls. Crashes are abrupt; supervised
        processes restart automatically. No Docker socket is used.
      </p>
      {!run && (
        <div
          className={`mt-6 flex flex-wrap items-center justify-between gap-5 rounded-2xl border p-5 ${status?.active && status.enabled ? 'border-red-500/40 bg-red-500/10' : 'border-border bg-muted/40'}`}
        >
          <div className="max-w-xl">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-semibold">Fault injection</h3>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${status?.enabled && status.active ? 'bg-red-500/15 text-red-600 dark:text-red-300' : 'bg-muted text-muted-foreground'}`}
              >
                {!status
                  ? 'Checking'
                  : !status.enabled
                    ? 'Unavailable'
                    : status.active
                      ? 'Active'
                      : 'Paused'}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              {!status?.enabled
                ? 'The environment flag must allow development chaos before this switch can be used.'
                : status.active
                  ? 'Crash controls and fault simulations are available. Pause to clear pending faults and reset model simulation.'
                  : 'New faults are blocked. Supervision and recovery keep running. Enable when you are ready to test.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Enable fault injection"
            aria-checked={!!status?.enabled && !!status.active}
            disabled={busy || !status?.enabled || !!error}
            onClick={() => void mutate('toggle', { active: !status?.active })}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span>Enable fault injection</span>
            <span
              aria-hidden="true"
              className={`flex h-7 w-12 items-center rounded-full p-1 transition-colors ${status?.enabled && status.active ? 'bg-red-500' : 'bg-muted-foreground/40'}`}
            >
              <span
                className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${status?.enabled && status.active ? 'translate-x-5' : ''}`}
              />
            </span>
          </button>
        </div>
      )}
      {run && status?.enabled && !status.active && (
        <p className="mt-3 text-sm text-muted-foreground">
          Fault injection is paused. Enable it on the Chaos page to use these
          controls.
        </p>
      )}
      {!status?.enabled && (
        <p className="mt-3 text-sm">
          Controls disabled. Set CHAOS_ENABLED=true in the root .env and restart
          pnpm dev in development mode.
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-5 text-sm">
        <p>
          API:{' '}
          {error ? 'down / unreachable' : (status?.api.state ?? 'checking')} ·
          restarts {status?.api.restarts ?? 0}
        </p>
        <p>
          Worker: {error ? 'unknown' : (status?.worker.state ?? 'checking')} ·
          restarts {status?.worker.restarts ?? 0}
        </p>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          {error}
        </p>
      )}
      {!run && (
        <>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              className={button}
              disabled={disabled || status?.worker.state !== 'up'}
              onClick={() => void mutate('kill', { target: 'worker' })}
            >
              Crash worker now
            </button>
            <button
              className={button}
              disabled={disabled || status?.api.state !== 'up'}
              onClick={() => void mutate('kill', { target: 'api' })}
            >
              Crash API now
            </button>
          </div>
          <div className="mt-6 rounded-xl bg-muted p-4">
            <h3 className="font-medium">
              Model simulation for new support-node calls
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">
              Applies to classify/draft before provider calls. Existing approval
              waits have already passed these nodes. Flaky mode simulates random
              429/500 errors without spending model quota on those attempts.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                className={button}
                disabled={disabled}
                onClick={() =>
                  void mutate('llm', { mode: 'slow', delayMs: delay })
                }
              >
                Slow LLM
              </button>
              <button
                className={button}
                disabled={disabled}
                onClick={() => void mutate('llm', { mode: 'flaky', rate: 0.5 })}
              >
                Flaky LLM · 50%
              </button>
              <button
                className={button}
                disabled={disabled}
                onClick={() => void mutate('llm', { mode: 'off' })}
              >
                Reset LLM simulation
              </button>
            </div>
            <p className="mt-2 text-xs">
              Current profile: {status?.llm.mode ?? 'checking'}
            </p>
          </div>
        </>
      )}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {!run && (
          <label className="text-sm">
            Run
            <select
              aria-label="Target run"
              className="mt-2 w-full rounded-lg border border-border bg-background p-3"
              value={runId}
              onChange={(event) => {
                setRunId(event.target.value);
                const r = runs.find((item) => item.id === event.target.value);
                setNode(
                  r?.workflowId === 'content-moderation'
                    ? 'publish'
                    : r?.workflowId === 'durability-demo'
                      ? 'complete'
                      : 'send_email',
                );
              }}
            >
              <option value="">Choose a run</option>
              {runs.map((item) => (
                <option key={item.id} value={item.id}>
                  {String(item.state.title || item.state.message)} ·{' '}
                  {item.status}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          Node
          <select
            aria-label="Fault node"
            className="mt-2 w-full rounded-lg border border-border bg-background p-3"
            value={node}
            onChange={(e) => setNode(e.target.value)}
          >
            {nodes.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          When
          <select
            className="mt-2 w-full rounded-lg border border-border bg-background p-3"
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
          >
            <option value="before">Before node work</option>
            <option value="after">
              After work, before checkpoint/progress
            </option>
          </select>
        </label>
        <label className="text-sm">
          Fault
          <select
            className="mt-2 w-full rounded-lg border border-border bg-background p-3"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="throw_once">Fail once, then retry</option>
            <option value="throw_always">Permanent failure</option>
            <option value="delay_ms">Delay node</option>
            <option value="crash_process">Crash worker at node</option>
          </select>
        </label>
        <label className="text-sm">
          Delay (milliseconds)
          <input
            className="mt-2 w-full rounded-lg border border-border bg-background p-3"
            type="number"
            min={1}
            max={30000}
            value={delay}
            onChange={(e) => setDelay(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Set the fault before the selected node executes. While waiting for
        approval, target a later effect node. Clear a persistent fault before
        retrying.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          className={button}
          disabled={disabled || !runId}
          onClick={() =>
            void mutate('fault', {
              runId,
              node,
              phase,
              fault: mode === 'delay_ms' ? { mode, delayMs: delay } : { mode },
            })
          }
        >
          Apply run fault
        </button>
        <button
          className={button}
          disabled={disabled || !runId}
          onClick={() => void mutate('clear', { runId, node, phase })}
        >
          Clear selected fault
        </button>
      </div>
      {notice && (
        <p role="status" className="mt-4 text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
