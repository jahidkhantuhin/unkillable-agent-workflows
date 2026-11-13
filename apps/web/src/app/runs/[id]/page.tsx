import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { runDTOSchema, runIdParamsSchema } from '@unkillable/shared';
import { serverIdentity, apiURL } from '@/lib/server-auth';
import { RunDetail } from '@/components/run-detail';
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await serverIdentity())) redirect('/login');
  const parsed = runIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const response = await fetch(`${apiURL}/runs/${parsed.data.id}`, {
    headers: { cookie: (await cookies()).toString() },
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error('Run is unavailable');
  return <RunDetail initial={runDTOSchema.parse(await response.json())} />;
}
