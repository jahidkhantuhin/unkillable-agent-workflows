'use client';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import Link from 'next/link';
import { FileText, Upload } from 'lucide-react';
import {
  moderationQueueSchema,
  maxContentBytes,
  runDTOSchema,
} from '@unkillable/shared';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
export function ModerationPanel() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  function selectFiles(selected: FileList | File[]) {
    if (busy || !selected.length) return;
    if (selected.length !== 1) {
      setError('Choose one text file at a time.');
      toast.error('Choose one text file at a time.');
      return;
    }
    const candidate = selected[0];
    if (!/\.(txt|md)$/i.test(candidate.name)) {
      setError('Choose a .txt or .md file saved as UTF-8 text.');
      toast.error('Choose a .txt or .md file saved as UTF-8 text.');
      return;
    }
    if (!candidate.size || candidate.size > maxContentBytes) {
      setError('Provide a nonempty text file up to 10 MiB.');
      toast.error('Provide a nonempty text file up to 10 MiB.');
      return;
    }
    if (fileInput.current) fileInput.current.value = '';
    setFile(candidate);
    setError('');
    toast.success(`Selected ${candidate.name}. Ready to upload.`);
  }
  function clearFile() {
    setFile(null);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
  }
  const [data, setData] = useState<ReturnType<
      typeof moderationQueueSchema.parse
    > | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('Community welcome message'),
    [text, setText] = useState(
      'Welcome to our community. Please be kind and share helpful ideas.',
    ),
    [file, setFile] = useState<File | null>(null),
    [created, setCreated] = useState('');
  async function refresh(signal?: AbortSignal) {
    const r = await fetch('/api/backend/moderation', {
      cache: 'no-store',
      signal,
    });
    if (!r.ok) throw new Error('Unable to load moderation queue');
    setData(moderationQueueSchema.parse(await r.json()));
  }
  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Queue unavailable');
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setCreated('');
    try {
      const content = file ?? new Blob([text], { type: 'text/plain' });
      if (!content.size || content.size > maxContentBytes)
        throw new Error('Provide nonempty UTF-8 text up to 10 MiB.');
      const r = await fetch(
        `/api/backend/moderation/uploads?title=${encodeURIComponent(title)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: content,
        },
      );
      const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message ?? 'Upload failed');
      setCreated(runDTOSchema.parse(body).id);
      toast.success('Moderation submitted and queued.');
      setTitle('');
      setText('');
      clearFile();
      await refresh();
    } catch (e) {
      toast.error(e, 'Upload failed');
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1 className="text-4xl font-semibold">Content moderation</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Synthetic UTF-8 text only, up to 10 MiB. Files stay on local disk.
        Publication and notifications are local records, not external posts or
        emails.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          ['Backlog', data?.backlog],
          ['Waiting for admin', data?.waitingReview],
          ['Decisions in last 24 hours', data?.decisionsLast24Hours],
        ].map(([label, value]) => (
          <section key={label} className="rounded-2xl border border-border p-5">
            <h2 className="text-sm text-muted-foreground">{label}</h2>
            <p className="mt-2 text-3xl font-semibold">{value ?? '…'}</p>
          </section>
        ))}
      </div>
      <form
        onSubmit={submit}
        className="mt-7 space-y-4 rounded-2xl border border-border p-6 [&_button:enabled]:cursor-pointer"
      >
        <h2 className="text-lg font-semibold">Submit content</h2>
        <div className="flex flex-wrap gap-2">
          {[
            ['Safe example', 'Welcome to our community. Please be kind.'],
            [
              'Review example',
              'DEMO_REVIEW: This synthetic content needs a human judgment.',
            ],
            [
              'Blocked example',
              'DEMO_BLOCK: This is a synthetic blocked-content test.',
            ],
          ].map(([label, content]) => (
            <Button
              key={label}
              variant="outline"
              type="button"
              onClick={() => {
                clearFile();
                setTitle(label);
                setText(content);
                toast.success(`${label} loaded. Ready to submit.`);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className="block text-sm">
          Content title
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-2 w-full rounded-lg border border-border bg-background p-3"
          />
        </label>
        <label className="block text-sm">
          Text content
          <textarea
            aria-label="Text content"
            rows={4}
            value={text}
            disabled={!!file}
            onChange={(e) => setText(e.target.value)}
            className="mt-2 w-full rounded-lg border border-border bg-background p-3"
          />
        </label>
        <section
          aria-label="Text file upload"
          data-testid="moderation-drop-zone"
          data-dragging={dragging}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            dragDepth.current++;
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dragDepth.current = 0;
            setDragging(false);
            selectFiles(event.dataTransfer.files);
          }}
          className={`rounded-xl border-2 border-dashed p-5 transition-colors ${dragging ? 'border-emerald-500 bg-emerald-500/10 dark:border-emerald-400' : 'border-border bg-muted/30'}`}
        >
          <input
            type="file"
            ref={fileInput}
            aria-label="Or upload a UTF-8 text file"
            tabIndex={-1}
            disabled={busy}
            accept=".txt,.md,text/plain,text/markdown"
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              event.target.value = '';
              selectFiles(selected);
            }}
            className="sr-only"
          />
          <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:justify-between sm:text-left">
            <div className="flex flex-col items-center gap-3 sm:flex-row">
              <Upload
                aria-hidden="true"
                className="size-8 shrink-0 text-emerald-600 dark:text-emerald-400"
              />
              <div>
                <h3 className="text-sm font-semibold">
                  {dragging
                    ? 'Drop your text file here'
                    : 'Drag and drop a text file'}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  UTF-8 .txt or .md · Up to 10 MiB · One file
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="shrink-0 cursor-pointer border-emerald-500/60 bg-emerald-400 text-emerald-950 hover:bg-emerald-300 dark:border-emerald-300/60 dark:bg-emerald-400 dark:text-emerald-950 dark:hover:bg-emerald-300"
            >
              Choose file
            </Button>
          </div>
          {file && (
            <div
              aria-live="polite"
              className="mt-4 rounded-lg border border-border bg-background p-3"
            >
              <div className="flex items-start gap-2">
                <FileText
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                />
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm font-medium">{file.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {file.size >= 1048576
                      ? `${(file.size / 1048576).toFixed(2)} MiB`
                      : file.size >= 1024
                        ? `${(file.size / 1024).toFixed(1)} KiB`
                        : `${file.size} bytes`}{' '}
                    · Selected for upload
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearFile();
                    toast.success('File removed. You can edit the text again.');
                  }}
                  className="shrink-0 cursor-pointer text-xs font-medium underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Remove file
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                This file will be submitted instead of the text above.
              </p>
            </div>
          )}
        </section>
        <p className="text-xs text-muted-foreground">
          Files over 16000 characters always need review unless rejected.
          DEMO_REVIEW and DEMO_BLOCK are deterministic test markers. Automated
          checks combine the configured model with local rules.
        </p>
        <div className="flex justify-end">
          <Button disabled={busy} type="submit">
            {busy ? 'Uploading…' : 'Start moderation'}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-red-500">
          {error}
        </p>
      )}
      {created && (
        <p role="status" className="mt-4 text-emerald-500">
          Content queued.{' '}
          <Link className="underline" href={`/runs/${created}`}>
            Open moderation run
          </Link>
        </p>
      )}
      <section className="mt-7 rounded-2xl border border-border p-6">
        <div className="flex flex-wrap justify-between gap-3">
          <h2 className="text-lg font-semibold">Latest 50 submissions</h2>
          <Link className="text-sm underline" href="/approvals">
            Open Approval Inbox
          </Link>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Updates every two seconds. Backlog includes queued, running, waiting
          review and compensating runs. Throughput counts current
          published/rejected decisions, not notification delivery.
        </p>
        <div className="mt-4 space-y-3">
          {data?.items.map((item) => (
            <article key={item.id} className="rounded-xl bg-muted p-4 text-sm">
              <Link
                className="font-semibold underline"
                href={`/runs/${item.runId}`}
              >
                {item.title}
              </Link>
              <p className="mt-2">
                {item.status} · workflow {item.runStatus} · {item.file.bytes}{' '}
                bytes
              </p>
              <p className="mt-2 text-muted-foreground">
                {item.decisionReason || 'Waiting for automated check'}
              </p>
              <a
                className="mt-2 inline-block underline"
                href={`/api/backend/moderation/${item.runId}/content`}
              >
                Download original text
              </a>
            </article>
          ))}
        </div>
        {data && !data.items.length && (
          <p className="mt-3 text-sm text-muted-foreground">
            No content submissions yet.
          </p>
        )}
      </section>
    </>
  );
}
