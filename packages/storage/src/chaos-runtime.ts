import { randomUUID } from 'node:crypto';
import { chaosPrefix } from '@unkillable/shared';
interface RedisControl {
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}
/** Only the current process can consume its generation-specific kill request. */
export function startChaosRuntime(
  redis: RedisControl,
  queue: string,
  service: 'api' | 'worker',
  enabled: boolean,
  crash = () => process.exit(137),
) {
  if (!enabled) return async () => {};
  const instance = process.env.CHAOS_INSTANCE_ID ?? randomUUID();
  const prefix = chaosPrefix(queue),
    key = `${prefix}:runtime:${service}:${instance}`;
  let stopped = false,
    busy = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await redis.setex(key, 4, JSON.stringify({ state: 'up', instance }));
      if (await redis.getdel(`${prefix}:kill:${service}:${instance}`)) crash();
    } finally {
      busy = false;
    }
  };
  void tick().catch(() => {});
  const timer = setInterval(() => void tick().catch(() => {}), 250).unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await redis.del(key);
  };
}
