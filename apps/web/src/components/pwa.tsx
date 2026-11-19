'use client';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
export function PwaRegistration() {
  useEffect(() => {
    if (
      'serviceWorker' in navigator &&
      window.isSecureContext &&
      process.env.NODE_ENV === 'production'
    )
      void navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {});
  }, []);
  return null;
}
export function InstallApp({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null),
    [installed, setInstalled] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)');
    const refresh = () =>
      setInstalled(
        standalone.matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone ===
            true,
      );
    const ready = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };
    refresh();
    window.addEventListener('beforeinstallprompt', ready);
    window.addEventListener('appinstalled', done);
    standalone.addEventListener('change', refresh);
    return () => {
      window.removeEventListener('beforeinstallprompt', ready);
      window.removeEventListener('appinstalled', done);
      standalone.removeEventListener('change', refresh);
    };
  }, []);
  async function install() {
    if (!prompt) return;
    setBusy(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted')
        toast.success('App installation requested.');
      setPrompt(null);
    } catch (error) {
      toast.error(error, 'Installation unavailable. Use your browser menu.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Install approval app"
      className={
        compact
          ? 'mt-4 text-sm'
          : 'mt-6 max-w-2xl rounded-2xl border border-border p-5'
      }
    >
      <h2 className="font-semibold">
        {installed
          ? 'Approval app installed'
          : 'Keep approvals on your home screen'}
      </h2>
      {!installed && (
        <>
          {prompt ? (
            <Button className="mt-3 min-h-11" disabled={busy} onClick={install}>
              Install approval app
            </Button>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Use your browser’s Install app option, or on iPhone/iPad use Share
              → Add to Home Screen. HTTPS (or localhost) is required.
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Approvals require a live connection. Private pages and approval
            requests are not cached or queued offline.
          </p>
        </>
      )}
    </section>
  );
}
