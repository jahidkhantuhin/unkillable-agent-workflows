import { describe, expect, it } from 'vitest';
import {
  retryPolicySchema,
  retryDelay,
  classifyError,
  RetryableError,
  PermanentError,
  attemptSchema,
  type Attempt,
  type AttemptStore,
  workerConfigSchema,
} from '@unkillable/shared';
import { retryOperation } from './retry';
function fixture() {
  let now = 0;
  let saved: Attempt | null = null;
  const waits: number[] = [];
  const store: AttemptStore = {
    load: async () => saved,
    start: async (policy) => {
      saved = attemptSchema.parse({
        id: 'attempt',
        key: 'run:0:node',
        runId: 'run',
        nodeId: 'node',
        execution: 0,
        attempt:
          saved?.status === 'retrying'
            ? saved.attempt + 1
            : (saved?.attempt ?? 1),
        status: 'running',
        policy,
        createdAt: new Date(0),
        updatedAt: new Date(now),
      });
      return saved;
    },
    retry: async (error, delayMs) => {
      saved = {
        ...saved!,
        status: 'retrying',
        error,
        nextAttemptAt: new Date(now + delayMs),
      };
    },
    succeed: async () => {
      saved = { ...saved!, status: 'succeeded' };
    },
    fail: async (error) => {
      saved = { ...saved!, status: 'failed', error };
    },
  };
  return {
    store,
    waits,
    clock: {
      now: () => new Date(now),
      sleep: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
      random: () => 1,
    },
    read: () => saved,
    seed: (value: Attempt) => {
      saved = value;
    },
  };
}
describe('bounded retry policies', () => {
  it('uses exponential delays, then returns a successful result', async () => {
    const f = fixture();
    let calls = 0;
    const policy = retryPolicySchema.parse({
      initialDelayMs: 100,
      maxDelayMs: 1000,
      jitter: 0,
    });
    expect(
      await retryOperation(
        'node',
        async () => {
          if (++calls < 3) throw new RetryableError('offline');
          return 'recovered';
        },
        f.store,
        policy,
        f.clock,
      ),
    ).toBe('recovered');
    expect(f.waits).toEqual([100, 200]);
    expect(calls).toBe(3);
    expect(f.read()?.status).toBe('succeeded');
  });
  it('caps jittered delay and validates configuration', () => {
    const p = retryPolicySchema.parse({
      initialDelayMs: 100,
      maxDelayMs: 250,
      jitter: 0.2,
    });
    expect(retryDelay(p, 1, () => 0)).toBe(80);
    expect(retryDelay(p, 10, () => 1)).toBe(250);
    expect(retryPolicySchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
    expect(
      workerConfigSchema.safeParse({
        MONGODB_URI: 'mongodb://localhost/test',
        NODE_RETRY_POLICIES: '{"typo":{"maxAttempts":2}}',
      }).success,
    ).toBe(false);
  });
  it('does not retry permanent failures and preserves exhaustion across a new invocation', async () => {
    const permanent = fixture();
    let calls = 0;
    await expect(
      retryOperation(
        'node',
        async () => {
          calls++;
          throw new PermanentError('invalid');
        },
        permanent.store,
        undefined,
        permanent.clock,
      ),
    ).rejects.toMatchObject({ attempts: 1 });
    expect(calls).toBe(1);
    expect(permanent.waits).toEqual([]);
    const f = fixture();
    let transient = 0;
    const op = async () => {
      transient++;
      throw new RetryableError('offline');
    };
    await expect(
      retryOperation(
        'node',
        op,
        f.store,
        retryPolicySchema.parse({ maxAttempts: 2, initialDelayMs: 10 }),
        f.clock,
      ),
    ).rejects.toMatchObject({ attempts: 2 });
    await expect(
      retryOperation('node', op, f.store, undefined, f.clock),
    ).rejects.toMatchObject({ attempts: 2 });
    expect(transient).toBe(2);
  });
  it('honors a previously persisted retry deadline after restart', async () => {
    const f = fixture();
    f.seed(
      attemptSchema.parse({
        id: 'a',
        key: 'run:0:node',
        runId: 'run',
        nodeId: 'node',
        execution: 0,
        attempt: 1,
        status: 'retrying',
        policy: retryPolicySchema.parse({}),
        nextAttemptAt: new Date(750),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    );
    let seen = 0;
    await retryOperation(
      'node',
      async (attempt) => {
        seen = attempt;
        return true;
      },
      f.store,
      undefined,
      f.clock,
    );
    expect(f.waits).toEqual([750]);
    expect(seen).toBe(2);
  });
  it.each([
    [{ status: 429, message: 'rate limit' }, 'retryable'],
    [{ status: 503, message: 'unavailable' }, 'retryable'],
    [{ code: 'ECONNRESET', message: 'reset' }, 'retryable'],
    [{ name: 'MongoNetworkError', message: 'network' }, 'retryable'],
    [{ status: 400, message: 'bad input' }, 'permanent'],
    [new Error('programming bug'), 'permanent'],
    [new PermanentError('invalid'), 'permanent'],
  ] as const)('classifies operation errors', (error, expected) => {
    expect(classifyError(error).classification).toBe(expected);
  });
});
