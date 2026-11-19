import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./server-auth', () => ({ apiURL: 'http://127.0.0.1:4000' }));
import { forwardWhatsApp } from './whatsapp-webhook';
afterEach(() => vi.unstubAllGlobals());
it('forwards the original signed form without browser cookies', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response('<Response/>', { headers: { 'content-type': 'text/xml' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const body = 'Body=HELLO+there&From=whatsapp%3A%2B15550001111';
  const response = await forwardWhatsApp(
    new Request('https://example.test/api/whatsapp/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'signed',
        cookie: 'private=secret',
      },
      body,
    }),
    'webhook',
  );
  expect(response.status).toBe(200);
  expect(fetcher.mock.calls[0]).toEqual([
    'http://127.0.0.1:4000/notifications/whatsapp/webhook',
    expect.objectContaining({
      body,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'signed',
      },
      cache: 'no-store',
    }),
  ]);
});
it('rejects oversized or non-form callbacks before contacting the API', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  expect(
    (
      await forwardWhatsApp(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'x'.repeat(65537),
        }),
        'status',
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await forwardWhatsApp(
        new Request('https://example.test', { method: 'POST', body: '{}' }),
        'webhook',
      )
    ).status,
  ).toBe(415);
  expect(fetcher).not.toHaveBeenCalled();
});
