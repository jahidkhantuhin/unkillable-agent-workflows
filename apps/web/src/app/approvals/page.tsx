import { redirect } from 'next/navigation';
import { hasPermission } from '@unkillable/shared';
import { serverIdentity } from '@/lib/server-auth';
import { ApprovalInbox } from '@/components/approval-inbox';
export default async function ApprovalsPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (!hasPermission(identity.role, 'approvals:read'))
    return (
      <div role="alert" className="rounded-2xl border border-border p-8">
        <h1 className="text-3xl font-semibold">Access restricted</h1>
        <p className="mt-4 text-muted-foreground">
          Approval review requires an approver or administrator.
        </p>
      </div>
    );
  return <ApprovalInbox />;
}
