'use client';
import { useEffect, useState } from 'react';
import type { ApprovalDTO } from '@unkillable/shared';
export function ApprovalSla({ approval }: { approval: ApprovalDTO }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const sla = approval.sla;
  if (!sla) return null;
  const remaining =
    now === null ? null : Math.max(0, new Date(sla.expireAt).getTime() - now);
  return (
    <div
      className="mt-4 rounded-xl border border-amber-500/40 p-3 text-sm"
      aria-label="Approval deadline"
    >
      <p className="font-medium">
        {remaining === null
          ? 'Approval deadline'
          : remaining === 0
            ? 'Deadline reached; automatic resolution pending'
            : `Time remaining: ${Math.floor(remaining / 60000)}m ${Math.floor(remaining / 1000) % 60}s`}
      </p>
      <p>
        At deadline:{' '}
        {sla.timeoutAction === 'reject'
          ? 'automatically reject this proposal'
          : 'cancel this run'}
        . Due {new Date(sla.expireAt).toLocaleString()}.
      </p>
      <p>
        {sla.remindedAt || (now !== null && now >= +new Date(sla.remindAt))
          ? 'Reminder due or recorded; check the run timeline.'
          : `Reminder: ${new Date(sla.remindAt).toLocaleString()}.`}
      </p>
      <p>
        {sla.escalatedAt
          ? `Escalated to ${sla.escalateRole} reviewers.`
          : `Escalation to ${sla.escalateRole} reviewers: ${new Date(sla.escalateAt).toLocaleString()}.`}
      </p>
    </div>
  );
}
