import { describe, it, expect, vi } from 'vitest';
import { createSessionLoader } from './session-client';
describe('session refresh', () => {
  it('joins concurrent checks and fetches again after completion', async () => {
    let finish: (response: Response) => void = () => {};
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const load = createSessionLoader(fetcher);
    const first = load();
    const second = load();
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish(new Response(null, { status: 401 }));
    expect(await first).toBeNull();
    const next = load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish(new Response(null, { status: 401 }));
    await next;
  });
  it('distinguishes signed out from API failure and allows retry after failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const load = createSessionLoader(fetcher);
    await expect(load()).rejects.toThrow('Session unavailable');
    await expect(load()).resolves.toBeNull();
    await expect(load()).resolves.toBeNull();
  });
  it('aborts an unresponsive session request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options!.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await expect(createSessionLoader(fetcher, 10)()).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
  });
});
