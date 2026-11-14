import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const cookie = vi.hoisted(() => ({ value: '' }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => cookie.value }),
}));
// React request memoization runs inside RSC, not this standalone unit renderer.
vi.mock('react', () => ({ cache: (fn: unknown) => fn }));
import { serverIdentity } from './server-auth';
describe('server session loading', () => {
  beforeEach(() => {
    cookie.value = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('avoids the API entirely without cookies', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await serverIdentity()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards cookies without caching and treats expired sessions as signed out', async () => {
    cookie.value = 'session=example';
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await serverIdentity()).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/auth/me'),
      expect.objectContaining({
        headers: { cookie: 'session=example' },
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it('does not mistake an API outage for a verified anonymous session', async () => {
    cookie.value = 'session=example';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(serverIdentity()).rejects.toThrow('Unable to verify');
  });
});
