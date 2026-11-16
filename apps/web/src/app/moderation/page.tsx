import { redirect } from 'next/navigation';
import { serverIdentity } from '@/lib/server-auth';
import { ModerationPanel } from '@/components/moderation-panel';
export default async function ModerationPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (identity.role !== 'admin')
    return <p role="alert">Administrator access required.</p>;
  return <ModerationPanel />;
}
