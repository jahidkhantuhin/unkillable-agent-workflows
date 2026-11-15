import { z } from 'zod';
import type { Redis } from 'ioredis';
import {
  PermanentError,
  RetryableError,
  llmFaultSchema,
  chaosPrefix,
} from '@unkillable/shared';

export const faultSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('throw_once') }),
  z.object({ mode: z.literal('throw_always') }),
  z.object({
    mode: z.literal('delay_ms'),
    delayMs: z.number().int().min(1).max(30000),
  }),
  z.object({ mode: z.literal('crash_process') }),
]);
export type FaultPhase = 'before' | 'after';
export interface FaultInjector {
  at(runId: string, node: string, phase: FaultPhase): Promise<void>;
}
export const noFaults: FaultInjector = { async at() {} };
export function faultKey(
  runId: string,
  node: string,
  phase: FaultPhase = 'before',
) {
  return `unkillable:fault:${runId}:${node}:${phase}`;
}
/** One-shot flags are consumed atomically, including before a deliberate process exit. */
export class RedisFaultInjector implements FaultInjector {
  constructor(
    private readonly redis: Redis,
    private readonly enabled: boolean,
    private readonly crash: () => void = () => process.exit(137),
    private readonly sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private readonly queue = 'workflow-runs',
    private readonly random = Math.random,
  ) {}
  async at(runId: string, node: string, phase: FaultPhase) {
    if (!this.enabled) return;
    const key = faultKey(runId, node, phase);
    const raw = await this.redis.get(key);
    if (!raw) {
      if (phase !== 'before' || !['classify', 'draft_reply'].includes(node))
        return;
      const profile = await this.redis.get(`${chaosPrefix(this.queue)}:llm`);
      if (!profile) return;
      const value = llmFaultSchema.parse(JSON.parse(profile));
      if (value.mode === 'slow') await this.sleep(value.delayMs);
      if (value.mode === 'flaky' && this.random() < value.rate) {
        const status = this.random() < 0.5 ? 429 : 500;
        throw Object.assign(
          new RetryableError(
            `Simulated LLM HTTP ${status}`,
            `CHAOS_LLM_${status}`,
          ),
          { status },
        );
      }
      return;
    }
    const flag = faultSchema.parse(JSON.parse(raw));
    if (flag.mode === 'throw_once' || flag.mode === 'crash_process') {
      const won = await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        key,
        raw,
      );
      if (!won) return;
    }
    if (flag.mode === 'throw_once')
      throw new RetryableError('Injected one-shot failure', 'CHAOS_THROW_ONCE');
    if (flag.mode === 'throw_always')
      throw new PermanentError(
        'Injected permanent failure',
        'CHAOS_THROW_ALWAYS',
      );
    if (flag.mode === 'delay_ms') await this.sleep(flag.delayMs);
    if (flag.mode === 'crash_process') this.crash();
  }
}
