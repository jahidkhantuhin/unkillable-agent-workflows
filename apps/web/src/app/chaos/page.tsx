import { redirect } from 'next/navigation';
import { serverIdentity } from '@/lib/server-auth';
import { ChaosPanel } from '@/components/chaos-panel';
export default async function ChaosPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (identity.role !== 'admin')
    return (
      <p role="alert">Access restricted. Only administrators can use Chaos.</p>
    );
  return (
    <>
      <h1 className="text-4xl font-semibold">Chaos</h1>
      <ChaosPanel />
    </>
  );
}
