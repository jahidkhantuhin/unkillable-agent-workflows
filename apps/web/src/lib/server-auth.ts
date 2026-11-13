import 'server-only';
import { cookies } from 'next/headers';
import { identitySchema } from '@unkillable/shared';
export const apiURL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:4000';
export async function serverIdentity() {
  const cookieStore = await cookies();
  const response = await fetch(`${apiURL}/auth/me`, {
    headers: { cookie: cookieStore.toString() },
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401) return null;
  if (!response.ok)
    throw new Error(
      'Unable to verify workspace access. Check the API and membership.',
    );
  return identitySchema.parse(await response.json());
}
