import {
  runEventSchema,
  runDTOSchema,
  type RunDTO,
  type RunEvent,
} from '@unkillable/shared';
/** Fresh pages replay from zero; reconnects explicitly request only events after the last accepted cursor. */
export function observeRun(
  id: string,
  callbacks: {
    event: (event: RunEvent) => void;
    status: (status: string) => void;
    snapshot: (run: RunDTO) => void;
  },
  deps = {
    open: (url: string) => new EventSource(url),
    fetch: globalThis.fetch,
    schedule: (fn: () => void) => setTimeout(fn, 2000),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
) {
  let cursor = 0,
    closed = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    stream: EventSource;
  const controller = new AbortController();
  function connect() {
    if (closed) return;
    const source = deps.open(`/api/backend/runs/${id}/events?after=${cursor}`);
    stream = source;
    let disconnected = false;
    source.onopen = () => {
      if (!closed && !disconnected)
        callbacks.status(cursor ? 'Live · reconnected' : 'Live');
    };
    source.onerror = () => {
      if (disconnected || closed) return;
      disconnected = true;
      source.close();
      if (!closed) {
        callbacks.status('Reconnecting…');
        timer = deps.schedule(connect);
      }
    };
    source.addEventListener('run-event', (message: MessageEvent) => {
      if (disconnected || closed) return;
      try {
        const event = runEventSchema.parse(JSON.parse(message.data));
        if (event.runId !== id || event.sequence <= cursor) return;
        // A sequence gap must be replayed, never hidden by advancing the cursor.
        if (event.sequence !== cursor + 1) {
          source.onerror?.(new Event('error'));
          return;
        }
        cursor = event.sequence;
        callbacks.event(event);
      } catch {
        callbacks.status('Invalid event received; reconnecting…');
        source.onerror?.(new Event('error'));
      }
    });
    source.addEventListener('stream-end', () => {
      if (disconnected || closed) return;
      disconnected = true;
      source.close();
      callbacks.status('Replay complete');
      void deps
        .fetch(`/api/backend/runs/${id}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        .then(async (response) => {
          if (response.ok) {
            const snapshot = runDTOSchema.parse(await response.json());
            if (!closed) callbacks.snapshot(snapshot);
          }
        })
        .catch(() => {
          if (!closed)
            callbacks.status('Replay complete · refresh unavailable');
        });
    });
  }
  connect();
  return () => {
    closed = true;
    controller.abort();
    stream?.close();
    if (timer) deps.cancel(timer);
  };
}
