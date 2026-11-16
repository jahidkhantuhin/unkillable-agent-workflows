import { redirect } from 'next/navigation';
import { serverIdentity } from '@/lib/server-auth';
import { ApprovalAnalytics } from '@/components/approval-analytics';
export default async function AnalyticsPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (identity.role !== 'admin')
    return <p role="alert">Administrator access required.</p>;
  return <ApprovalAnalytics />;
}
