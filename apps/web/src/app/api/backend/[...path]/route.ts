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
  if (!allowedPaths.has(pathname))
    return NextResponse.json(
      { error: { message: 'Not found' } },
      { status: 404 },
    );
  if ((request.method === 'GET') !== (pathname === 'auth/me'))
    return NextResponse.json(
      { error: { message: 'Method not allowed' } },
      { status: 405 },
    );
  try {
    const headers = new Headers();
    for (const name of ['cookie', 'origin', 'content-type', 'user-agent']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(`${apiURL}/${pathname}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : await request.text(),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
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
