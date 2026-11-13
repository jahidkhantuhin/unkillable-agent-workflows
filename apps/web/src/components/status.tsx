'use client';
import { useEffect, useState } from 'react';
import { healthSchema, type Health } from '@unkillable/shared';
export function ApiStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    async function check() {
      controller?.abort();
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 4000);
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
          cache: 'no-store',
        });
        const result = healthSchema.parse(await response.json());
        if (!disposed) setHealth(result);
      } catch {
        if (!disposed) setHealth(null);
      } finally {
        clearTimeout(timeout);
        if (!disposed) setChecked(true);
      }
    }
    void check();
    const timer = setInterval(check, 10000);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
    };
  }, []);
  const healthy = health?.status === 'ok';
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-full border border-border px-3 py-2 text-xs"
    >
      <span
        className={`size-2 rounded-full ${healthy ? 'bg-emerald-500' : 'bg-amber-500'}`}
      />
      {!checked
        ? 'Checking API'
        : healthy
          ? 'API · All systems ready'
          : health
            ? `API degraded · Mongo ${health.services.mongo ? 'up' : 'down'} / Redis ${health.services.redis ? 'up' : 'down'}`
            : 'API unavailable'}
    </div>
  );
}
