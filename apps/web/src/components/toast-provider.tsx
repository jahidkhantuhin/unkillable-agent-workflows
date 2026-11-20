'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CircleCheck, CircleAlert, Bell, X } from 'lucide-react';
import Link from 'next/link';
type ToastAction = { href: string; label: string };
export type Toast = {
  id: number;
  tone: 'success' | 'error' | 'notice';
  message: string;
  action?: ToastAction;
};
type ToastActions = {
  success: (message: string) => void;
  error: (error: unknown, fallback?: string) => void;
  notice: (message: string, action: ToastAction) => void;
  clearNotices: () => void;
};
const ToastContext = createContext<ToastActions | null>(null);
export function errorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof SyntaxError)
    return 'Invalid JSON. Check the syntax and try again.';
  // Zod errors expose issues without requiring another direct web dependency.
  if (
    error &&
    typeof error === 'object' &&
    'issues' in error &&
    Array.isArray(error.issues)
  ) {
    const messages = error.issues
      .slice(0, 3)
      .map(
        (issue: { path?: unknown[]; message?: string }) =>
          `${issue.path?.length ? `${issue.path.join('.')}: ` : ''}${issue.message ?? 'Invalid value'}`,
      );
    if (messages.length) return messages.join('; ');
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}
function ToastItem({
  toast,
  dismiss,
}: {
  toast: Toast;
  dismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    // Errors remain until dismissed. Success timers pause during reading/focus.
    if (toast.tone === 'error' || paused) return;
    const timer = setTimeout(() => dismiss(toast.id), 6000);
    return () => clearTimeout(timer);
  }, [toast, dismiss, paused]);
  const success = toast.tone !== 'error';
  const notice = toast.tone === 'notice';
  const Icon = notice ? Bell : success ? CircleCheck : CircleAlert;
  return (
    <li
      data-testid="toast"
      data-tone={toast.tone}
      role={success ? 'status' : 'alert'}
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false);
      }}
      className={`pointer-events-auto flex min-w-0 items-start gap-3 rounded-xl border bg-background p-4 shadow-xl ${notice ? 'border-amber-500/60' : success ? 'border-emerald-500/60' : 'border-red-500/60'}`}
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-5 shrink-0 ${notice ? 'text-amber-600 dark:text-amber-400' : success ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {toast.tone === 'notice'
            ? 'Approval needs attention'
            : success
              ? 'Success'
              : 'Action failed'}
        </p>
        <p className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm text-foreground">
          {toast.message}
        </p>
        {toast.action && (
          <Link
            href={toast.action.href}
            onClick={() => dismiss(toast.id)}
            className="mt-2 inline-block text-sm font-medium underline"
          >
            {toast.action.label}
          </Link>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
        className="cursor-pointer rounded-md p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-emerald-500"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]),
    nextId = useRef(0);
  const dismiss = useCallback(
    (id: number) => setToasts((current) => current.filter((t) => t.id !== id)),
    [],
  );
  const show = useCallback(
    (tone: Toast['tone'], message: string, action?: ToastAction) => {
      const id = ++nextId.current;
      setToasts((current) =>
        [
          ...current.filter((t) => t.message !== message || t.tone !== tone),
          { id, tone, message, action },
        ].slice(-4),
      );
    },
    [],
  );
  const actions = useMemo<ToastActions>(
    () => ({
      success: (message) => show('success', message),
      error: (error, fallback) => show('error', errorMessage(error, fallback)),
      notice: (message, action) => show('notice', message, action),
      clearNotices: () =>
        setToasts((current) => current.filter((t) => t.tone !== 'notice')),
    }),
    [show],
  );
  useEffect(() => {
    const invalid = (event: Event) => {
      const field = event.target;
      if (!(
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ))
        return;
      const firstInvalid = field.form?.querySelector(':invalid');
      if (firstInvalid && firstInvalid !== field) return;
      actions.error(field.validationMessage || 'Check the required fields.');
    };
    document.addEventListener('invalid', invalid, true);
    return () => document.removeEventListener('invalid', invalid, true);
  }, [actions]);
  return (
    <ToastContext.Provider value={actions}>
      {children}
      <section
        aria-label="Notifications"
        className="pointer-events-none fixed inset-x-3 top-3 z-[100] mx-auto max-w-sm sm:inset-x-auto sm:right-5 sm:top-5 sm:mx-0 sm:w-96"
      >
        <ol className="flex max-h-[calc(100dvh-1.5rem)] flex-col gap-3 overflow-y-auto">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}
export function useToast() {
  const actions = useContext(ToastContext);
  if (!actions) throw new Error('useToast must be used inside ToastProvider');
  return actions;
}
