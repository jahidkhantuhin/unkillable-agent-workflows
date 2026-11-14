import { redirect } from 'next/navigation';
import { hasPermission } from '@unkillable/shared';
import { serverIdentity } from '@/lib/server-auth';
import { DeadLetters } from '@/components/dead-letters';
export default async function DeadLetterPage() {
  const identity = await serverIdentity();
  if (!identity) redirect('/login');
  if (!hasPermission(identity.role, 'deadletters:read'))
    return (
      <div role="alert" className="rounded-2xl border border-border p-8">
        <h1 className="text-3xl font-semibold">Access restricted</h1>
        <p className="mt-4 text-muted-foreground">
          Dead-letter management requires an administrator.
        </p>
      </div>
    );
  return <DeadLetters />;
}
