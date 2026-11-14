'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { deadLetterDTOSchema, type DeadLetterDTO } from '@unkillable/shared';
import { Button } from './ui/button';
import { RunScenario, runTitle } from './run-scenario';
export function DeadLetters() {
  const [letters, setLetters] = useState<DeadLetterDTO[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch('/api/backend/dead-letters', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load dead letters');
        const body: unknown = await response.json();
        if (!Array.isArray(body)) throw new Error('Invalid response');
        setLetters(body.map((item) => deadLetterDTOSchema.parse(item)));
        setLoaded(true);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : 'Unable to load dead letters',
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
  async function resolve(letter: DeadLetterDTO, action: 'retry' | 'discard') {
    setError('');
    setBusy(letter.id);
    try {
      const response = await fetch(
        `/api/backend/dead-letters/${letter.id}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: letter.version }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? 'Action failed');
      if (action === 'retry') {
        router.push(`/runs/${body.runId}`);
        return;
      }
      setLetters((previous) =>
        previous.map((item) =>
          item.id === letter.id
            ? { ...item, status: 'discarded', version: item.version + 1 }
            : item,
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <p className="text-xs tracking-widest text-emerald-500">RELIABILITY</p>
      <h1 className="mt-3 text-4xl font-semibold">Dead Letters</h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Inspect failed nodes and their retry context. Retry resumes the same
        checkpoint with a fresh retry budget; existing effect keys stay
        unchanged. Discard closes this failure record and leaves its history
        intact.
      </p>
      {error && (
        <p role="alert" className="mt-5 text-sm text-red-500">
          {error}
        </p>
      )}
      <div className="mt-8 space-y-5">
        {!loaded ? (
          <p className="text-muted-foreground">Loading dead letters…</p>
        ) : !letters.length ? (
          <div className="rounded-2xl border border-dashed border-border p-10 text-muted-foreground">
            No failed runs. Use the Runs page’s exhausted or permanent local
            delivery simulation to inspect this flow.
          </div>
        ) : (
          letters.map((letter) => (
            <article
              key={letter.id}
              className="rounded-2xl border border-border p-6"
            >
              <div className="flex flex-wrap justify-between gap-4">
                <div>
                  <h2 className="break-words text-lg font-semibold">
                    {runTitle(letter.context.state) || 'Durability demo'}
                  </h2>
                  <div className="mt-2">
                    <RunScenario state={letter.context.state} />
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {letter.nodeId} · {letter.error.code}
                  </p>
                  <Link
                    href={`/runs/${letter.runId}`}
                    className="mt-2 block break-all font-mono text-xs text-muted-foreground underline"
                  >
                    {letter.runId}
                  </Link>
                </div>
                <span className="text-xs capitalize text-muted-foreground">
                  {letter.status} · execution {letter.execution + 1}
                </span>
              </div>
              <p className="mt-4 text-sm">{letter.error.message}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {letter.attempts} attempt(s) · {letter.error.classification}
              </p>
              <details className="mt-4">
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Inspect failure context
                </summary>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-4 text-xs">
                  {JSON.stringify(
                    { error: letter.error, context: letter.context },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {letter.status === 'open' && (
                <div className="mt-5 flex flex-wrap gap-3">
                  <Button
                    onClick={() => resolve(letter, 'retry')}
                    disabled={busy !== null}
                  >
                    {busy === letter.id ? 'Working…' : 'Retry from checkpoint'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => resolve(letter, 'discard')}
                    disabled={busy !== null}
                  >
                    Discard dead letter
                  </Button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </>
  );
}
