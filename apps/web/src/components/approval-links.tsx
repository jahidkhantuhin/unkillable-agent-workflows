'use client';
import { useState } from 'react';
import { approvalLinksSchema } from '@unkillable/shared';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
import { notificationRequest } from '../lib/notifications';
export function ApprovalLinks({
  id,
  disabled,
}: {
  id: string;
  disabled: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false),
    [links, setLinks] = useState<ReturnType<
      typeof approvalLinksSchema.parse
    > | null>(null);
  async function create() {
    setBusy(true);
    try {
      setLinks(
        approvalLinksSchema.parse(await notificationRequest(`links/${id}`, {})),
      );
      toast.success(
        'Personal approval links created. Each link is short-lived and single-use.',
      );
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Personal approval link copied.');
    } catch {
      toast.error(
        'Unable to copy. Open the link and copy its address instead.',
      );
    }
  }
  return (
    <div className="mt-5 border-t border-border pt-4">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy}
        onClick={create}
      >
        Create personal approval links
      </Button>
      {links && (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-muted-foreground">
            Only your signed-in account can use these links. Expires{' '}
            {new Date(links.expiresAt).toLocaleString()}. A changed review
            invalidates older links.
          </p>
          {(['approve', 'reject'] as const).map((action) => (
            <div key={action} className="flex flex-wrap items-center gap-3">
              <a className="underline" href={links[action]}>
                Open {action} link
              </a>
              <Button variant="outline" onClick={() => copy(links[action])}>
                Copy {action} link
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
