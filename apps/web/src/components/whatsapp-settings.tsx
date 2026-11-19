'use client';
import { useEffect, useState } from 'react';
import { whatsappSettingsSchema } from '@unkillable/shared';
import { notificationRequest } from '../lib/notifications';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
export function WhatsAppSettings() {
  const toast = useToast();
  const [data, setData] = useState<ReturnType<
      typeof whatsappSettingsSchema.parse
    > | null>(null),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pairing, setPairing] = useState<{ url: string; command: string } | null>(
      null,
    );
  async function load(signal?: AbortSignal) {
    const next = whatsappSettingsSchema.parse(
      await notificationRequest('whatsapp/settings', undefined, signal),
    );
    setData(next);
    setEnabled(next.enabled);
    return next;
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, []);
  async function action(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      if (path === 'refresh') {
        await load();
        toast.success('WhatsApp connection and delivery status refreshed.');
        return;
      }
      const result = await notificationRequest(`whatsapp/${path}`, body);
      if (path === 'link') {
        if (
          typeof result.url !== 'string' ||
          !result.url.startsWith('https://wa.me/') ||
          typeof result.command !== 'string'
        )
          throw new Error('Invalid WhatsApp link response');
        setPairing({ url: result.url, command: result.command });
        toast.success(
          'Pairing created. Send the LINK command from your WhatsApp within ten minutes.',
        );
      } else if (path === 'test') {
        toast.success(
          'WhatsApp test message accepted by Twilio. Refresh status or check your phone for delivery.',
        );
        await load();
      } else if (path === 'resend')
        toast.success(
          'Current pending WhatsApp approvals scheduled for resend.',
        );
      else {
        setData(whatsappSettingsSchema.parse(result));
        setEnabled(result.enabled);
        if (path === 'unlink') setPairing(null);
        toast.success(
          path === 'unlink'
            ? 'WhatsApp unlinked. Telegram and web access are unchanged.'
            : 'WhatsApp preferences saved.',
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
    <section
      aria-label="WhatsApp approval settings"
      className="mt-6 max-w-2xl space-y-4 rounded-2xl border border-border p-5 sm:p-7"
    >
      <h2 className="text-lg font-semibold">WhatsApp approvals</h2>
      <p className="text-sm text-muted-foreground">
        Receive a request on your own phone and reply APPROVE or REJECT with its
        code. EDIT opens the full web review. Telegram remains a separate
        option.
      </p>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {!data ? (
        <p>Loading WhatsApp settings…</p>
      ) : !data.available ? (
        <p className="text-sm">
          WhatsApp is disabled on this server. Web and Telegram approvals remain
          available. Follow the WhatsApp local setup guide to enable your
          testing account.
        </p>
      ) : (
        <>
          <p className="text-sm">
            Connection:{' '}
            {data.linked ? `Linked to ${data.phoneMasked}` : 'Not linked'}
          </p>
          <p className="break-words text-sm">Test sender: {data.sender}</p>
          <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
            <li>
              Join your Twilio WhatsApp testing environment using the join code
              shown in its console.
            </li>
            <li>
              Create a private link below, then send its LINK command from that
              phone.
            </li>
            <li>
              Refresh this page, enable notifications and send a test message
              before creating a workflow.
            </li>
          </ol>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!data.linked || busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            WhatsApp approval notifications
          </label>
          {data.linked && (
            <>
              <p className="text-sm">
                {data.windowOpen
                  ? `Reply window active until ${new Date(data.windowExpiresAt!).toLocaleString()}.`
                  : 'Reply window closed. Send HELLO from WhatsApp before testing or receiving another approval.'}
              </p>
              <p className="text-sm">
                Latest message status:{' '}
                {data.lastStatus ?? 'No message sent yet'}
              </p>
              {data.lastError && (
                <p className="break-words text-sm text-red-500">
                  {data.lastError}
                </p>
              )}
            </>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap [&_button]:min-h-11">
            <Button disabled={busy} onClick={() => action('link')}>
              {data.linked ? 'Relink WhatsApp' : 'Link WhatsApp number'}
            </Button>
            <Button
              variant="outline"
              disabled={busy || !data.linked}
              onClick={() => action('settings', { enabled })}
            >
              Save WhatsApp preferences
            </Button>
            <Button
              variant="outline"
              disabled={
                busy || !data.linked || !data.enabled || !data.windowOpen
              }
              onClick={() => action('test')}
            >
              Send WhatsApp test
            </Button>
            <Button
              variant="outline"
              disabled={
                busy || !data.linked || !data.enabled || !data.windowOpen
              }
              onClick={() => action('resend')}
            >
              Resend pending WhatsApp approvals
            </Button>
            {data.linked && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => action('unlink')}
              >
                Unlink WhatsApp
              </Button>
            )}
          </div>
          {pairing && (
            <div className="rounded-xl border border-border p-4 text-sm">
              <p>
                Expires in ten minutes. Never share this private pairing
                command.
              </p>
              <code className="mt-2 block break-all">{pairing.command}</code>
              <a
                className="mt-3 inline-block underline"
                href={pairing.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open WhatsApp with LINK command
              </a>
              <Button
                variant="outline"
                className="mt-3 block"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(pairing.command);
                    toast.success('Private WhatsApp pairing command copied.');
                  } catch {
                    toast.error(
                      'Copy unavailable. Select the displayed command manually.',
                    );
                  }
                }}
              >
                Copy pairing command
              </Button>
            </div>
          )}
        </>
      )}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => action('refresh')}
      >
        Refresh WhatsApp status
      </Button>
      <p className="text-xs text-muted-foreground">
        Test environments require an inbound message within the last 24 hours.
        Send HELLO to reopen the window, PENDING for fresh approval codes, STOP
        to pause, or UNLINK to disconnect. Test/resend requests are limited to
        once per minute. Twilio trial limits and charges may apply.
      </p>
    </section>
  );
}
