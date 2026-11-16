import { redirect } from 'next/navigation';
import { serverIdentity } from '@/lib/server-auth';
import { PoliciesPanel } from '@/components/policies-panel';
export default async function PoliciesPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (identity.role !== 'admin')
    return <p role="alert">Administrator access required.</p>;
  return <PoliciesPanel />;
}
