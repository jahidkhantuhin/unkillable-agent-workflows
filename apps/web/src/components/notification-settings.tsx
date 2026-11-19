'use client';
import { useEffect, useState } from 'react';
import { notificationSettingsSchema } from '@unkillable/shared';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
import { notificationRequest } from '../lib/notifications';
import { InstallApp } from './pwa';
export function NotificationSettings() {
  const toast = useToast();
  const [data, setData] = useState<ReturnType<
      typeof notificationSettingsSchema.parse
    > | null>(null),
    [telegram, setTelegram] = useState(false),
    [busy, setBusy] = useState(false),
    [pairing, setPairing] = useState(''),
    [error, setError] = useState('');
  async function refresh(signal?: AbortSignal) {
    const next = notificationSettingsSchema.parse(
      await notificationRequest('settings', undefined, signal),
    );
    setData(next);
    setTelegram(next.telegram);
    return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, []);
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await notificationRequest(path, body);
      if (path === 'telegram/link') {
        if (
          typeof result.url !== 'string' ||
          !result.url.startsWith('https://t.me/')
        )
          throw new Error('Invalid pairing response');
        setPairing(result.url);
        toast.success(
          'Private-chat link created. Open Telegram and press Start within ten minutes.',
        );
      } else {
        setData(notificationSettingsSchema.parse(result));
        setTelegram(result.telegram);
        if (path === 'telegram/unlink') setPairing('');
        toast.success(
          path === 'telegram/unlink'
            ? 'Telegram unlinked.'
            : 'Notification preferences saved.',
        );
      }
    } catch (error) {
      setError((error as Error).message);
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1 className="text-3xl font-semibold sm:text-4xl">
        Notification settings
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Choose how you receive pending approval requests. The web inbox is
        always available.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-red-500">
          {error}
        </p>
      )}
      <section className="mt-6 max-w-2xl space-y-5 rounded-2xl border border-border p-5 sm:p-7">
        <h2 className="text-lg font-semibold">Approval channels</h2>
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" checked disabled />
          Web Approval Inbox (always on)
        </label>
        {!data ? (
          <p>Loading preferences…</p>
        ) : (
          <>
            <p className="text-sm">
              Telegram:{' '}
              {data.telegramAvailable
                ? data.linked
                  ? 'Private chat linked'
                  : 'Not linked'
                : 'Disabled on this server. Web approvals still work.'}
            </p>
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={telegram}
                disabled={!data.telegramAvailable || !data.linked || busy}
                onChange={(e) => setTelegram(e.target.checked)}
              />
              Telegram approval notifications
            </label>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={busy}
                onClick={() => action('settings', { telegram })}
              >
                Save preferences
              </Button>
              <Button
                variant="outline"
                disabled={busy || !data.telegramAvailable}
                onClick={() => action('telegram/link')}
              >
                {data.linked
                  ? 'Relink private Telegram chat'
                  : 'Link private Telegram chat'}
              </Button>
              {data.linked && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => action('telegram/unlink')}
                >
                  Unlink Telegram
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await refresh();
                    toast.success('Notification settings refreshed.');
                  } catch (error) {
                    toast.error(error);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Refresh settings
              </Button>
            </div>
            {pairing && (
              <p className="text-sm">
                <a
                  className="underline"
                  target="_blank"
                  rel="noreferrer noopener"
                  href={pairing}
                >
                  Open Telegram and press Start
                </a>
                . Then refresh settings. This link expires in ten minutes; do
                not share it.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Personal signed links last {Math.round(data.linkTtlSeconds / 60)}{' '}
              minutes. Create them on a pending approval in the inbox. Each
              decision checks your current permissions.
            </p>
          </>
        )}
      </section>
      <InstallApp />
    </>
  );
}
