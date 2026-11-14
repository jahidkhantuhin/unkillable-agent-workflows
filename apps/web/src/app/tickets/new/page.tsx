import { redirect } from 'next/navigation';
import { hasPermission } from '@unkillable/shared';
import { serverIdentity } from '@/lib/server-auth';
import { NewTicket } from '@/components/new-ticket';
export default async function NewTicketPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (!hasPermission(identity.role, 'runs:create'))
    return (
      <div role="alert">
        Starting tickets requires an approver or administrator.
      </div>
    );
  return <NewTicket />;
}
