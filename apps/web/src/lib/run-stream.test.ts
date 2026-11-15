import { it, expect, vi } from 'vitest';
import { observeRun } from './run-stream';
import { runEventSchema } from '@unkillable/shared';
class Source extends EventTarget {
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  send(sequence: number) {
    this.dispatchEvent(
      new MessageEvent('run-event', {
        data: JSON.stringify(
          runEventSchema.parse({
            id: `e${sequence}`,
            runId: 'run',
            threadId: 'run',
            sequence,
            timestamp: sequence,
            type: 'RUN_STARTED',
          }),
        ),
      }),
    );
  }
}
it('reconnects from the last accepted cursor and replays a gap without duplicates', () => {
  const sources: Source[] = [],
    urls: string[] = [],
    timers: (() => void)[] = [];
  const event = vi.fn();
  const stop = observeRun(
    'run',
    { event, status: vi.fn(), snapshot: vi.fn() },
    {
      open: (url) => {
        urls.push(url);
        const source = new Source();
        sources.push(source);
        return source as unknown as EventSource;
      },
      fetch: vi.fn(),
      schedule: (fn) => {
        timers.push(fn);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    },
  );
  sources[0].send(1);
  sources[0].send(1);
  sources[0].onerror?.(new Event('error'));
  timers.shift()!();
  expect(urls[1]).toContain('after=1');
  sources[1].send(3);
  timers.shift()!();
  expect(urls[2]).toContain('after=1');
  sources[2].send(2);
  sources[2].send(3);
  expect(event.mock.calls.map((args) => args[0].sequence)).toEqual([1, 2, 3]);
  stop();
  expect(sources[2].close).toHaveBeenCalled();
});
