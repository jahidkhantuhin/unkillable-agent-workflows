/* Network-only PWA: no caches, background sync, or queued approval mutations. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection required · Unkillable</title><body style="font:18px system-ui;padding:2rem;background:#0b100e;color:#edf4ef"><h1>Connection required</h1><p>Connect to the internet and reopen the Approval Inbox. No approval has been submitted or queued offline.</p><a style="color:#6ee7b7" href="/approvals">Try Approval Inbox again</a></body></html>',
          {
            status: 503,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        ),
    ),
  );
});
/* global self, fetch, Response */
