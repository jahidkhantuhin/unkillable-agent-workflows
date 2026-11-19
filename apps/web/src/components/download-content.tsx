'use client';
import { useState } from 'react';
import { useToast } from './toast-provider';
export function DownloadContent({
  runId,
  children,
  className,
}: {
  runId: string;
  children: React.ReactNode;
  className?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const response = await fetch(`/api/backend/moderation/${runId}/content`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message ?? 'Unable to download content');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'moderation-content.txt';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Original content download started.');
    } catch (error) {
      toast.error(error, 'Unable to download content');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      disabled={busy}
      className={`cursor-pointer text-left disabled:cursor-wait disabled:opacity-50 ${className ?? ''}`}
      onClick={download}
    >
      {busy ? 'Preparing download…' : children}
    </button>
  );
}
