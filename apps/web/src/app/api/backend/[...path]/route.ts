import { NextResponse } from 'next/server';
import { apiURL } from '@/lib/server-auth';
const allowedPaths = new Set([
  'auth/register',
  'auth/login',
  'auth/logout',
  'auth/me',
]);
async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const pathname = path.join('/');
  const isRun =
    pathname === 'runs' ||
    /^runs\/[0-9a-f-]{36}(\/(events|reliability))?$/.test(pathname);
  const isDeadLetter =
    pathname === 'dead-letters' ||
    /^dead-letters\/[0-9a-f-]{36}(\/(retry|discard))?$/.test(pathname);
  const stream = isRun && pathname.endsWith('/events');
  const isTicket = pathname === 'tickets' || pathname === 'tickets/examples';
  const isApproval =
    pathname === 'approvals' ||
    /^approvals\/[0-9a-f-]{36}(\/resolve)?$/.test(pathname);
  if (
    !allowedPaths.has(pathname) &&
    !isRun &&
    !isDeadLetter &&
    !isApproval &&
    !isTicket
  )
    return NextResponse.json(
      { error: { message: 'Not found' } },
      { status: 404 },
    );
  if (
    isTicket
      ? request.method !== (pathname === 'tickets' ? 'POST' : 'GET')
      : isApproval
        ? request.method !== (pathname.endsWith('/resolve') ? 'POST' : 'GET')
        : isDeadLetter
          ? request.method !==
            (/\/(retry|discard)$/.test(pathname) ? 'POST' : 'GET')
          : isRun
            ? request.method !== 'GET' &&
              !(pathname === 'runs' && request.method === 'POST')
            : (request.method === 'GET') !== (pathname === 'auth/me')
  )
    return NextResponse.json(
      { error: { message: 'Method not allowed' } },
      { status: 405 },
    );
  try {
    const headers = new Headers();
    for (const name of [
      'cookie',
      'origin',
      'content-type',
      'user-agent',
      'last-event-id',
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(
      `${apiURL}/${pathname}${new URL(request.url).search}`,
      {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : await request.text(),
        cache: 'no-store',
        redirect: 'manual',
        signal: stream
          ? request.signal
          : AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      },
    );
    if (stream && response.ok)
      return new Response(response.body, {
        status: response.status,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      });
    const result = new Response(
      response.status === 204 ? null : await response.text(),
      {
        status: response.status,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      },
    );
    for (const cookie of response.headers.getSetCookie())
      result.headers.append('set-cookie', cookie);
    return result;
  } catch {
    return NextResponse.json(
      { error: { message: 'The API is unavailable. Please try again.' } },
      { status: 503 },
    );
  }
}
export const GET = forward;
export const POST = forward;
