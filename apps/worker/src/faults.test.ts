import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisFaultInjector, faultKey } from './faults';
function fixture(enabled = true) {
  const flags = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => flags.get(key) ?? null),
    eval: vi.fn(
      async (_script: string, _count: number, key: string, value: string) =>
        flags.get(key) === value ? Number(flags.delete(key)) : 0,
    ),
  };
  const crash = vi.fn();
  const sleep = vi.fn(async (_ms: number) => {});
  return {
    flags,
    redis,
    crash,
    sleep,
    injector: new RedisFaultInjector(
      redis as unknown as Redis,
      enabled,
      crash,
      sleep,
    ),
  };
}
describe('Redis fault controls', () => {
  it('does not even read Redis when disabled', async () => {
    const f = fixture(false);
    f.flags.set(faultKey('run', 'classify'), '{"mode":"crash_process"}');
    await f.injector.at('run', 'classify', 'before');
    expect(f.redis.get).not.toHaveBeenCalled();
    expect(f.crash).not.toHaveBeenCalled();
  });
  it('atomically consumes throw_once across racing calls and isolates phase/run/node', async () => {
    const f = fixture();
    const key = faultKey('run', 'classify');
    f.flags.set(key, '{"mode":"throw_once"}');
    const result = await Promise.allSettled([
      f.injector.at('run', 'classify', 'before'),
      f.injector.at('run', 'classify', 'before'),
    ]);
    expect(result.filter((row) => row.status === 'rejected')).toHaveLength(1);
    await f.injector.at('other', 'classify', 'before');
    await f.injector.at('run', 'classify', 'after');
    expect(f.flags.has(key)).toBe(false);
  });
  it('keeps permanent flags until cleared, bounds delays, and consumes crash before exit', async () => {
    const f = fixture();
    const key = faultKey('run', 'reverse_refund', 'after');
    f.flags.set(key, '{"mode":"throw_always"}');
    await expect(
      f.injector.at('run', 'reverse_refund', 'after'),
    ).rejects.toMatchObject({ code: 'CHAOS_THROW_ALWAYS' });
    expect(f.flags.has(key)).toBe(true);
    f.flags.set(key, '{"mode":"delay_ms","delayMs":40}');
    await f.injector.at('run', 'reverse_refund', 'after');
    expect(f.sleep).toHaveBeenCalledWith(40);
    f.flags.set(key, '{"mode":"delay_ms","delayMs":30001}');
    await expect(
      f.injector.at('run', 'reverse_refund', 'after'),
    ).rejects.toThrow();
    f.flags.set(key, '{"mode":"crash_process"}');
    await f.injector.at('run', 'reverse_refund', 'after');
    expect(f.flags.has(key)).toBe(false);
    expect(f.crash).toHaveBeenCalledTimes(1);
  });
});
