import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  chaosEnabled,
  chaosPrefix,
  chaosStatusSchema,
  processStateSchema,
  llmFaultSchema,
  injectFaultSchema,
  clearFaultSchema,
  killProcessSchema,
  toggleChaosSchema,
  supportNodeSchema,
  demoNodeSchema,
  compensationNodeSchema,
  moderationNodeSchema,
  moderationCompensationNodes,
  terminalStatuses,
  type ChaosStatus,
} from '@unkillable/shared';
import type { RunRepository } from '@unkillable/storage';
import { HttpError } from '../errors';
export class ChaosService {
  readonly enabled: boolean;
  private readonly prefix: string;
  constructor(
    private readonly redis: Redis,
    private readonly runs: RunRepository,
    queue: string,
    env: { CHAOS_ENABLED?: string; NODE_ENV?: string },
  ) {
    this.enabled = chaosEnabled(env);
    this.prefix = chaosPrefix(queue);
  }
  assertEnabled() {
    if (!this.enabled)
      throw new HttpError(
        403,
        'CHAOS_DISABLED',
        'Chaos requires development mode and CHAOS_ENABLED=true',
      );
  }
  async active() {
    return (
      this.enabled && (await this.redis.get(`${this.prefix}:paused`)) !== '1'
    );
  }
  private async writeActive(key: string, value: string, ttl: number) {
    const written = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == '1' then return 0 end redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2]); return 1",
      2,
      `${this.prefix}:paused`,
      key,
      value,
      String(ttl),
    );
    if (!written)
      throw new HttpError(
        409,
        'CHAOS_PAUSED',
        'Fault injection is paused. Enable it from the Chaos page first.',
      );
  }
  async toggle(input: unknown) {
    this.assertEnabled();
    const { active } = toggleChaosSchema.parse(input);
    const lock = `${this.prefix}:toggle-lock`,
      token = randomUUID();
    if (!(await this.redis.set(lock, token, 'EX', 120, 'NX')))
      throw new HttpError(
        409,
        'CHAOS_BUSY',
        'Another administrator is updating fault injection. Try again.',
      );
    try {
      if (!active || (await this.redis.get(`${this.prefix}:paused`)) === '1') {
        // Pause first: workers/API reject new fault claims while cleanup runs.
        await this.redis.set(`${this.prefix}:paused`, '1');
        await this.redis.del(`${this.prefix}:llm`);
        const kills = await this.redis.keys(`${this.prefix}:kill:*`);
        if (kills.length) await this.redis.del(...kills);
        const owned = new Set(await this.runs.chaosRunIds());
        let cursor = '0';
        do {
          const [next, keys] = await this.redis.scan(
            cursor,
            'MATCH',
            'unkillable:fault:*',
            'COUNT',
            200,
          );
          cursor = next;
          const pending = keys.filter((key) => owned.has(key.split(':')[2]));
          if (pending.length) await this.redis.del(...pending);
        } while (cursor !== '0');
      }
      if (active) await this.redis.del(`${this.prefix}:paused`);
      return this.status();
    } finally {
      await this.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
        1,
        lock,
        token,
      );
    }
  }
  async status(): Promise<ChaosStatus> {
    const result = {
      enabled: this.enabled,
      active: await this.active(),
      api: { state: 'down' },
      worker: { state: 'down' },
      llm: { mode: 'off' },
    };
    if (!this.enabled) return chaosStatusSchema.parse(result);
    const read = async (service: 'api' | 'worker') => {
      const raw = await this.redis.get(`${this.prefix}:supervisor:${service}`);
      if (!raw) return { state: 'down' };
      const status = processStateSchema.parse(JSON.parse(raw));
      if (
        status.state === 'up' &&
        !(await this.redis.get(
          `${this.prefix}:runtime:${service}:${status.instance}`,
        ))
      )
        return { ...status, state: 'down' };
      return status;
    };
    const [api, worker, llm] = await Promise.all([
      read('api'),
      read('worker'),
      this.redis.get(`${this.prefix}:llm`),
    ]);
    return chaosStatusSchema.parse({
      ...result,
      api,
      worker,
      llm: llm ? JSON.parse(llm) : { mode: 'off' },
    });
  }
  async kill(input: unknown, actorId: string) {
    this.assertEnabled();
    const { target } = killProcessSchema.parse(input);
    const status = (await this.status())[target];
    if (status.state !== 'up' || !status.instance)
      throw new HttpError(
        409,
        'PROCESS_UNAVAILABLE',
        'Start this process through the chaos supervisor first',
      );
    await this.writeActive(
      `${this.prefix}:kill:${target}:${status.instance}`,
      JSON.stringify({ actorId }),
      5,
    );
    return { accepted: true, target };
  }
  private async target(input: unknown, clear = false) {
    this.assertEnabled();
    const value = clear
      ? clearFaultSchema.parse(input)
      : injectFaultSchema.parse(input);
    const run = await this.runs.get(value.runId);
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
    if (!clear && terminalStatuses.includes(run.status))
      throw new HttpError(409, 'RUN_TERMINAL', 'Choose an unfinished run');
    const nodes =
      run.workflowId === 'support-ticket-router'
        ? [
            ...supportNodeSchema.options,
            ...compensationNodeSchema.options.filter(
              (node) =>
                !(moderationCompensationNodes as readonly string[]).includes(
                  node,
                ),
            ),
          ]
        : run.workflowId === 'content-moderation'
          ? [...moderationNodeSchema.options, ...moderationCompensationNodes]
          : run.workflowId === 'durability-demo'
            ? demoNodeSchema.options
            : [];
    if (!nodes.includes(value.node as never))
      throw new HttpError(
        400,
        'INVALID_NODE',
        'Node does not belong to this workflow',
      );
    return value;
  }
  async inject(input: unknown, actorId: string) {
    const value = await this.target(input);
    const parsed = injectFaultSchema.parse(value);
    await this.writeActive(
      `unkillable:fault:${value.runId}:${value.node}:${value.phase}`,
      JSON.stringify(parsed.fault),
      300,
    );
    await this.runs.append(value.runId, {
      type: 'CUSTOM',
      name: 'chaos.injected',
      value: { ...parsed, actorId },
    });
    return { accepted: true, expiresInSeconds: 300 };
  }
  async clear(input: unknown, actorId: string) {
    const value = await this.target(input, true);
    await this.redis.del(
      `unkillable:fault:${value.runId}:${value.node}:${value.phase}`,
    );
    await this.runs.append(
      value.runId,
      { type: 'CUSTOM', name: 'chaos.cleared', value: { ...value, actorId } },
      { allowTerminal: true },
    );
    return { cleared: true };
  }
  async llm(input: unknown) {
    this.assertEnabled();
    const value = llmFaultSchema.parse(input);
    if (value.mode === 'off') await this.redis.del(`${this.prefix}:llm`);
    else
      await this.writeActive(`${this.prefix}:llm`, JSON.stringify(value), 300);
    return { accepted: true, expiresInSeconds: value.mode === 'off' ? 0 : 300 };
  }
}
