'use client';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, Clock, AlertTriangle } from 'lucide-react';
import { approvalDTOSchema, type ApprovalDTO } from '@unkillable/shared';
import { useAuth } from './auth-provider';
import { useToast } from './toast-provider';
import {
  actionableApprovals,
  approvalAlertStage,
  approvalAlertKey,
} from '../lib/approval-alerts';
type State = {
  rows: ApprovalDTO[];
  error: string;
  attention: boolean;
  signal: number;
  acknowledge: () => void;
};
const Alerts = createContext<State | null>(null);
export function ApprovalAlertsProvider({ children }: { children: ReactNode }) {
  const { identity } = useAuth(),
    toast = useToast();
  const [rows, setRows] = useState<ApprovalDTO[]>([]),
    [error, setError] = useState(''),
    [attention, setAttention] = useState(false),
    [signal, setSignal] = useState(0),
    [owner, setOwner] = useState('');
  const userId = identity?.user.id,
    role = identity?.role;
  useEffect(() => {
    setRows([]);
    setOwner(`${userId}:${role}`);
    setError('');
    setAttention(false);
    toast.clearNotices();
    if (!userId || (role !== 'admin' && role !== 'approver')) return;
    const controller = new AbortController();
    let busy = false,
      baseline = false;
    const seen = new Set<string>();
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch('/api/backend/approvals', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            'Approval notifications unavailable. Open the inbox to check your access.',
          );
        const body: unknown = await response.json();
        if (!Array.isArray(body))
          throw new Error('Invalid approval notifications');
        const next = actionableApprovals(
          body.map((a) => approvalDTOSchema.parse(a)),
          userId!,
          role!,
          Date.now(),
        );
        if (controller.signal.aborted) return;
        const fresh = next.filter((a) => !seen.has(approvalAlertKey(a, role!)));
        next.forEach((a) => seen.add(approvalAlertKey(a, role!)));
        setRows(next);
        setOwner(`${userId}:${role}`);
        setError('');
        if (fresh.length) {
          setAttention(true);
          setSignal((value) => value + 1);
          if (baseline) {
            const a =
                fresh.find(
                  (a) => approvalAlertStage(a, role!) === 'escalated',
                ) ?? fresh[0],
              stage = approvalAlertStage(a, role!);
            toast.notice(
              `${stage === 'escalated' ? 'Approval escalated to your reviewer group' : stage === 'reminder' ? 'Your approval review is needed' : 'New approval request'}: ${a.title || 'Workflow approval'}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`,
              { href: `/approvals#approval-${a.id}`, label: 'Review now' },
            );
          }
        }
        baseline = true;
        if (!next.length) setAttention(false);
      } catch (error) {
        if (!controller.signal.aborted) {
          setRows([]);
          setAttention(false);
          setError((error as Error).message);
        }
      } finally {
        busy = false;
      }
    }
    void load();
    const timer = setInterval(load, 5000);
    window.addEventListener('focus', load);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', load);
      toast.clearNotices();
    };
  }, [userId, role, toast]);
  // Expired requests stop being actionable even between network polls.
  useEffect(() => {
    const timer = setInterval(
      () =>
        setRows((current) => {
          const next = current.filter(
            (a) => !a.sla || Date.parse(a.sla.expireAt) > Date.now(),
          );
          return next.length === current.length ? current : next;
        }),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <Alerts.Provider
      value={{
        rows: owner === `${userId}:${role}` ? rows : [],
        error: owner === `${userId}:${role}` ? error : '',
        attention,
        signal,
        acknowledge: () => setAttention(false),
      }}
    >
      {children}
    </Alerts.Provider>
  );
}
export function ApprovalBell() {
  const pathname = usePathname();
  const alerts = useContext(Alerts),
    { identity } = useAuth();
  const [open, setOpen] = useState(false),
    [ring, setRing] = useState(false),
    [now, setNow] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    id = useId();
  useEffect(() => {
    setOpen(false);
  }, [identity?.user.id, identity?.role, pathname]);
  useEffect(() => {
    if (!alerts?.attention || !alerts.rows.length) {
      setRing(false);
      return;
    }
    setRing(true);
    const timer = setTimeout(() => setRing(false), 900);
    return () => clearTimeout(timer);
  }, [alerts?.signal, alerts?.attention]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    function outside(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function escape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (!alerts || !identity || !['admin', 'approver'].includes(identity.role))
    return null;
  const escalated = alerts.rows.some(
    (a) => approvalAlertStage(a, identity.role) === 'escalated',
  );
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={`Approval notifications, ${alerts.rows.length} pending${alerts.error ? ', unavailable' : ''}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          setRing(false);
          alerts.acknowledge();
        }}
        className={`relative flex size-10 cursor-pointer items-center justify-center rounded-lg border focus-visible:outline-2 focus-visible:outline-offset-2 ${alerts.rows.length ? (escalated ? 'border-orange-500/60 bg-orange-500/10 text-orange-600 dark:text-orange-400' : 'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400') : 'border-border hover:bg-muted'} ${alerts.attention && alerts.rows.length && !open ? 'approval-bell-halo' : ''}`}
      >
        <Bell
          aria-hidden="true"
          className={`size-5 ${ring && !open ? 'approval-bell-ring' : ''}`}
        />
        {alerts.rows.length > 0 && (
          <span
            aria-hidden="true"
            className={`absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ${escalated ? 'bg-orange-700' : 'bg-amber-700'}`}
          >
            {alerts.rows.length > 99 ? '99+' : alerts.rows.length}
          </span>
        )}
        {!!alerts.error && (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 size-2 rounded-full bg-red-500"
          />
        )}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role="region"
          aria-label="Pending approval notifications"
          className="fixed left-3 right-3 top-20 z-50 max-h-[70dvh] overflow-auto rounded-xl border border-border bg-background p-4 shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-96"
        >
          <h2 className="font-semibold">Approvals needing your review</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Opening this list acknowledges the alert. Decisions still require
            review.
          </p>
          {alerts.error ? (
            <p role="alert" className="mt-3 text-sm">
              {alerts.error}
            </p>
          ) : !alerts.rows.length ? (
            <p className="my-4 text-sm text-muted-foreground">
              You’re all caught up.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {alerts.rows.map((a) => {
                const stage = approvalAlertStage(a, identity.role),
                  remaining = a.sla
                    ? Math.max(
                        0,
                        Math.ceil((Date.parse(a.sla.expireAt) - now) / 1000),
                      )
                    : null;
                return (
                  <li key={a.id}>
                    <Link
                      href={`/approvals#approval-${a.id}`}
                      onClick={() => setOpen(false)}
                      className={`block rounded-lg border p-3 hover:bg-muted focus-visible:outline-2 ${stage === 'escalated' ? 'border-orange-500/50' : 'border-amber-500/30'}`}
                    >
                      <span className="flex items-center gap-2 text-xs font-medium">
                        {stage === 'escalated' ? (
                          <AlertTriangle
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <Clock
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        {stage === 'escalated'
                          ? 'Escalated to your group'
                          : stage === 'reminder'
                            ? 'Your review is needed'
                            : 'Waiting for review'}
                      </span>
                      <span className="mt-1 block break-words text-sm font-semibold">
                        {a.title || 'Workflow approval'}
                      </span>
                      {remaining !== null && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {Math.floor(remaining / 60)}m {remaining % 60}s
                          remaining
                        </span>
                      )}
                      <span className="mt-2 block text-xs underline">
                        Review now
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            href="/approvals"
            onClick={() => setOpen(false)}
            className="mt-4 inline-block text-sm underline"
          >
            Open Approval Inbox
          </Link>
        </div>
      )}
    </div>
  );
}
