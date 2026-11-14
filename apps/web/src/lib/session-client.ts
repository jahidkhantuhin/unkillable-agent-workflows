import { identitySchema, type Identity } from '@unkillable/shared';
/** One in-flight session request per provider, never a persistent identity cache. */
export function createSessionLoader(
  fetcher: typeof fetch = fetch,
  timeoutMs = 5000,
) {
  let pending: Promise<Identity | null> | null = null;
  return () => {
    if (pending) return pending;
    const request = (async () => {
      const response = await fetcher('/api/backend/auth/me', {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error('Session unavailable');
      return identitySchema.parse(await response.json());
    })();
    pending = request;
    const clear = () => {
      if (pending === request) pending = null;
    };
    void request.then(clear, clear);
    return request;
  };
}
