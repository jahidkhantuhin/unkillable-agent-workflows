'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  checkpointPageSchema,
  checkpointDetailSchema,
  checkpointDiffSchema,
  forkRelationsSchema,
  runDTOSchema,
  demoForkEditsSchema,
  supportForkEditsSchema,
  moderationForkEditsSchema,
  type RunDTO,
  type CheckpointDetail,
  type CheckpointSummary,
  type StateChange,
  type ForkRelations,
} from '@unkillable/shared';
import { useAuth } from './auth-provider';
import { runTitle } from './run-scenario';
const button =
  'cursor-pointer rounded-xl border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40';
async function read(path: string, signal?: AbortSignal, body?: unknown) {
  const response = await fetch(`/api/backend/runs/${path}`, {
    cache: 'no-store',
    signal,
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? 'Time travel is unavailable');
  return data;
}
function caption(c: CheckpointSummary) {
  return `Step ${c.step ?? '?'} · ${c.completed.at(-1) ?? 'Input'} · ${c.createdAt ? new Date(c.createdAt).toLocaleString() : 'No timestamp'}`;
}
export function TimeTravelPanel({ run }: { run: RunDTO }) {
  const { identity } = useAuth(),
    router = useRouter();
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(''),
    [compare, setCompare] = useState('');
  const [detail, setDetail] = useState<CheckpointDetail | null>(null),
    [changes, setChanges] = useState<StateChange[]>([]);
  const [relations, setRelations] = useState<ForkRelations | null>(null);
  const [edits, setEdits] = useState('{}'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const canFork =
    identity?.role === 'admin' ||
    (identity?.role === 'approver' && run.workflowId !== 'content-moderation');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    Promise.all([
      read(`${run.id}/checkpoints`, controller.signal),
      read(`${run.id}/forks`, controller.signal),
    ])
      .then(([history, links]) => {
        const page = checkpointPageSchema.parse(history);
        setCheckpoints(page.checkpoints);
        setCursor(page.nextBefore);
        setRelations(forkRelationsSchema.parse(links));
        setSelected((current) =>
          page.checkpoints.some((c) => c.id === current)
            ? current
            : (page.checkpoints[0]?.id ?? ''),
        );
        setCompare((current) =>
          page.checkpoints.some((c) => c.id === current)
            ? current
            : (page.checkpoints[1]?.id ?? ''),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e.message));
      });
    return () => controller.abort();
  }, [run.id, run.status, revision]);
  useEffect(() => {
    setDetail(null);
    setChanges([]);
    setEdits('{}');
    if (!selected) return;
    const controller = new AbortController();
    read(`${run.id}/checkpoints/${selected}`, controller.signal)
      .then((data) => setDetail(checkpointDetailSchema.parse(data)))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [run.id, selected]);
  useEffect(() => {
    setChanges([]);
    if (!selected || !compare) return;
    const controller = new AbortController();
    read(`${run.id}/diff?from=${compare}&to=${selected}`, controller.signal)
      .then((data) => setChanges(checkpointDiffSchema.parse(data).changes))
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [run.id, selected, compare]);
  async function older() {
    setBusy(true);
    setError('');
    try {
      const page = checkpointPageSchema.parse(
        await read(`${run.id}/checkpoints?before=${cursor}`),
      );
      setCheckpoints((old) => [
        ...old,
        ...page.checkpoints.filter((c) => !old.some((o) => o.id === c.id)),
      ]);
      setCursor(page.nextBefore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function fork() {
    setBusy(true);
    setError('');
    try {
      const schema =
        run.workflowId === 'durability-demo'
          ? demoForkEditsSchema
          : run.workflowId === 'support-ticket-router'
            ? supportForkEditsSchema
            : moderationForkEditsSchema;
      const result = schema.safeParse(JSON.parse(edits));
      if (!result.success)
        throw new Error(
          result.error.issues
            .map(
              (issue) => `${issue.path.join('.') || 'Edits'}: ${issue.message}`,
            )
            .join('; '),
        );
      const patch = result.data;
      const child = runDTOSchema.parse(
        await read(`${run.id}/forks`, undefined, {
          checkpointId: selected,
          edits: patch,
        }),
      );
      router.push(`/runs/${child.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const ordered = [...checkpoints].reverse();
  return (
    <section
      aria-label="Time travel"
      className="mt-6 min-w-0 rounded-2xl border border-border p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Time travel</h2>
        <button
          className={button}
          onClick={() => setRevision((n) => n + 1)}
          disabled={busy}
        >
          Refresh checkpoints
        </button>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Inspect saved state without changing this run. A fork is a separate run
        with fresh local effects; it does not undo the parent.
      </p>
      {relations?.parent && (
        <p className="mt-3">
          Forked from{' '}
          <Link className="underline" href={`/runs/${relations.parent.id}`}>
            {runTitle(relations.parent.state)}
          </Link>
        </p>
      )}
      {!!relations?.children.length && (
        <details className="mt-3">
          <summary className="cursor-pointer">
            Child runs (latest {relations.children.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {relations.children.map((child) => (
              <li key={child.id}>
                <Link className="underline" href={`/runs/${child.id}`}>
                  {runTitle(child.state)}
                </Link>{' '}
                · {child.status}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          {error}
        </p>
      )}
      {!checkpoints.length ? (
        <p className="mt-4 text-sm">
          No saved checkpoints yet. Refresh after the worker starts.
        </p>
      ) : (
        <>
          <label className="mt-5 block text-sm">
            Checkpoint scrubber
            <input
              aria-label="Checkpoint scrubber"
              className="mt-2 w-full cursor-pointer"
              type="range"
              min="0"
              max={ordered.length - 1}
              value={Math.max(
                0,
                ordered.findIndex((c) => c.id === selected),
              )}
              onChange={(e) => setSelected(ordered[Number(e.target.value)].id)}
            />
          </label>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            {[
              ['Selected checkpoint', selected, setSelected],
              ['Compare from', compare, setCompare],
            ].map(([title, value, setter]) => (
              <label key={String(title)} className="text-sm">
                {String(title)}
                <select
                  aria-label={String(title)}
                  className="mt-2 w-full rounded-xl border border-border bg-background p-3"
                  value={String(value)}
                  onChange={(e) =>
                    (setter as typeof setSelected)(e.target.value)
                  }
                >
                  {title === 'Compare from' && (
                    <option value="">No comparison</option>
                  )}
                  {checkpoints.map((c) => (
                    <option key={c.id} value={c.id}>
                      {caption(c)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {cursor && (
            <button
              className={`${button} mt-3`}
              disabled={busy}
              onClick={older}
            >
              Load older checkpoints
            </button>
          )}
          {detail && (
            <>
              <p className="mt-3 text-sm text-muted-foreground">
                Next: {detail.next.join(', ') || 'Finished'} · Completed:{' '}
                {detail.completed.join(', ') || 'None'}
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer">Saved state</summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-muted p-4 text-xs">
                  {JSON.stringify(detail.state, null, 2)}
                </pre>
              </details>
            </>
          )}
          <h3 className="mt-5 font-semibold">
            State diff (comparison → selected)
          </h3>
          {!changes.length ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {compare ? 'No differences.' : 'Choose a comparison checkpoint.'}
            </p>
          ) : (
            <div className="mt-2 max-h-96 space-y-3 overflow-auto">
              {changes.map((change) => (
                <div
                  key={change.path}
                  className="rounded-xl bg-muted p-3 text-xs"
                >
                  <p className="break-all font-semibold">
                    {change.path || '(root)'} · {change.kind}
                  </p>
                  {change.kind !== 'added' && (
                    <pre className="mt-2 whitespace-pre-wrap break-words text-red-500">
                      − {JSON.stringify(change.before, null, 2)}
                    </pre>
                  )}
                  {change.kind !== 'removed' && (
                    <pre className="mt-2 whitespace-pre-wrap break-words text-emerald-600 dark:text-emerald-400">
                      + {JSON.stringify(change.after, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
          {canFork && (
            <div className="mt-5 border-t border-border pt-5">
              <h3 className="font-semibold">Edit state and fork from here</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {run.workflowId === 'durability-demo'
                  ? 'Allowed: title, message, deliveryMode, requireApproval. Changing message recomputes prepare and summarize; approvals and delivery reset.'
                  : run.workflowId === 'support-ticket-router'
                    ? 'Allowed: title, draftMessage (after draft_reply). Pure results carry over; risk checks, human approval, refund and email run again with fresh IDs.'
                    : 'Allowed: title. The original immutable file is reused; screening, decisions, review and publication run again with a fresh content ID.'}
              </p>
              <label className="mt-3 block text-sm">
                State edits (JSON)
                <textarea
                  aria-label="State edits (JSON)"
                  spellCheck={false}
                  className="mt-2 min-h-28 w-full rounded-xl border border-border bg-background p-3 font-mono text-sm"
                  value={edits}
                  onChange={(e) => setEdits(e.target.value)}
                />
              </label>
              <button
                className={`${button} mt-3 bg-primary text-primary-foreground`}
                disabled={busy || !detail?.forkable}
                onClick={fork}
              >
                {busy ? 'Working…' : 'Create fork'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
