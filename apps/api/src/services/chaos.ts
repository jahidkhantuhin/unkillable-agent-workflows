import type { Redis } from 'ioredis';
import {
  chaosEnabled,
  chaosPrefix,
  chaosStatusSchema,
  processStateSchema,
  llmFaultSchema,
  injectFaultSchema,
  clearFaultSchema,
  killProcessSchema,
  supportNodeSchema,
  demoNodeSchema,
  compensationNodeSchema,
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
  async status(): Promise<ChaosStatus> {
    const result = {
      enabled: this.enabled,
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
    await this.redis.set(
      `${this.prefix}:kill:${target}:${status.instance}`,
      JSON.stringify({ actorId }),
      'EX',
      5,
      'NX',
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
        ? [...supportNodeSchema.options, ...compensationNodeSchema.options]
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
    await this.redis.setex(
      `unkillable:fault:${value.runId}:${value.node}:${value.phase}`,
      300,
      JSON.stringify(parsed.fault),
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
      await this.redis.setex(`${this.prefix}:llm`, 300, JSON.stringify(value));
    return { accepted: true, expiresInSeconds: value.mode === 'off' ? 0 : 300 };
  }
}
