import { redirect } from 'next/navigation';
import { hasPermission } from '@unkillable/shared';
import { serverIdentity } from '@/lib/server-auth';
import { NotificationSettings } from '@/components/notification-settings';
export default async function NotificationsPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (!hasPermission(identity.role, 'approvals:resolve'))
    return (
      <p role="alert">
        Notification settings require an approver or administrator.
      </p>
    );
  return <NotificationSettings />;
}
