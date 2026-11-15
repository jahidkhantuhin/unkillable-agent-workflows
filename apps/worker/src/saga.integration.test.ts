import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { RunRepository } from '@unkillable/storage';
import {
  supportExamples,
  ticketInputSchema,
  supportConfigSchema,
  sagaSchema,
  RetryableError,
} from '@unkillable/shared';
import { bootstrapIndexes } from '../../api/src/repositories/indexes';
import { createExecutor } from './executor';
import { MailpitMailer, supportDependencies } from './support-adapters';
import { faultKey, RedisFaultInjector } from './faults';

const uri = process.env.INTEGRATION_MONGODB_URI;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
const mailpit = process.env.INTEGRATION_MAILPIT_URL;
async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await read();
    if (matches(value)) return value;
    await delay(40);
  }
  throw new Error('Timed out waiting for saga recovery');
}
describe.skipIf(!uri || !redisUrl || !mailpit)(
  'saga rollback and real process crash recovery',
  () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
    const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
    const runs = new RunRepository(client, db);
    const redis = new Redis(redisUrl ?? 'redis://127.0.0.1:6379', {
      lazyConnect: true,
    });
    const name = `saga-test-${randomUUID()}`;
    const config = supportConfigSchema.parse({});
    const smtp = new MailpitMailer(config);
    const children: ChildProcess[] = [];
    const keys: string[] = [];
    let queue: Queue;
    let executor: Awaited<ReturnType<typeof createExecutor>>;
    beforeAll(async () => {
      await client.connect();
      await redis.connect();
      await bootstrapIndexes(db);
      queue = new Queue(name, { connection: { url: redisUrl! } });
      executor = await createExecutor(
        runs,
        uri!,
        db.databaseName,
        0,
        {},
        supportDependencies(runs, config, (mail) => smtp.deliver(mail)),
        new RedisFaultInjector(redis, true, undefined, undefined, name),
        (mail) => smtp.deliver(mail),
      );
    }, 30000);
    afterAll(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const done = new Promise<void>((resolve) =>
            child.once('exit', () => resolve()),
          );
          child.kill('SIGKILL');
          await done;
        }
      if (executor) await executor.close();
      smtp.close();
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      if (keys.length) await redis.del(...keys);
      redis.disconnect();
      await db.dropDatabase();
      await client.close();
    }, 30000);
    async function flag(
      id: string,
      node: string,
      phase: 'before' | 'after',
      mode: string,
    ) {
      const key = faultKey(id, node, phase);
      keys.push(key);
      await redis.set(key, JSON.stringify({ mode }), 'EX', 120);
    }
    async function prepared() {
      const example = supportExamples[0];
      const input = ticketInputSchema.parse({
        title: 'Saga duplicate-charge test',
        description: example.description,
        customerEmail: `saga-${randomUUID()}@example.test`,
        orderId: example.orderId,
        amountCents: example.amountCents,
        currency: 'USD',
      });
      const run = await runs.createSupport('saga-tester', input);
      await executor.execute(run.id);
      const approval = await runs.approvals().forRun(run.id);
      await runs
        .approvals()
        .resolve(approval!.id, 0, { action: 'approve' }, 'saga-reviewer');
      return { run, input };
    }
    async function messages(email: string) {
      const response = await fetch(
        `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      if (!response.ok) throw new Error('Mailpit unavailable');
      return (await response.json()) as { messages: unknown[] };
    }
    async function assertRolledBack(id: string, email: string, all = true) {
      const run = await runs.get(id);
      expect(run?.status).toBe('compensated');
      const saga = sagaSchema.parse(run!.state.saga);
      expect(saga.completed).toEqual(
        all
          ? ['reopen_ticket', 'send_correction_or_void', 'reverse_refund']
          : ['send_correction_or_void', 'reverse_refund'],
      );
      const effects = await runs.reliability().details(id);
      expect(effects.refunds).toHaveLength(1);
      expect(effects.refunds[0]?.status).toBe('reversed');
      expect(
        effects.emails.filter((row) => row.purpose === 'reply'),
      ).toHaveLength(1);
      expect(
        effects.emails.filter(
          (row) => row.purpose === 'correction' && row.status === 'sent',
        ),
      ).toHaveLength(1);
      expect((await messages(email)).messages).toHaveLength(2);
      expect(
        (await runs.support().ticket(String(run!.state.ticketId)))?.status,
      ).toBe('open');
      const events = await runs.events(id, 0);
      expect(
        events
          .filter(
            (event) =>
              event.type === 'CUSTOM' && event.name === 'compensation.finished',
          )
          .map((event) =>
            event.type === 'CUSTOM' ? event.value.nodeId : null,
          ),
      ).toEqual(saga.completed);
      expect(
        (await runs.reliability().deadLetters()).filter(
          (row) => row.runId === id,
        ),
      ).toHaveLength(0);
      const sequence = run!.sequence;
      await executor.execute(id);
      expect((await runs.get(id))?.sequence).toBe(sequence);
    }
    it('fails after the last effect and compensates every committed effect in reverse order', async () => {
      const { run, input } = await prepared();
      await flag(run.id, 'close_ticket', 'after', 'throw_always');
      await executor.execute(run.id, 1);
      await assertRolledBack(run.id, input.customerEmail);
    }, 30000);
    it('fails before the last effect and compensates only effects actually committed', async () => {
      const { run, input } = await prepared();
      await flag(run.id, 'close_ticket', 'before', 'throw_always');
      await executor.execute(run.id, 1);
      await assertRolledBack(run.id, input.customerEmail, false);
    }, 30000);
    it('recovers throw_once without compensating and leaves a successful refund intact', async () => {
      const { run, input } = await prepared();
      await flag(run.id, 'send_email', 'before', 'throw_once');
      await executor.execute(run.id, 1);
      expect((await runs.get(run.id))?.status).toBe('succeeded');
      const effects = await runs.reliability().details(run.id);
      expect(effects.refunds[0]?.status).toBe('active');
      expect(effects.emails).toHaveLength(1);
      expect((await messages(input.customerEmail)).messages).toHaveLength(1);
    }, 30000);
    it('deduplicates racing compensation executors and fences stale forward checkpoints', async () => {
      const { run, input } = await prepared();
      await flag(run.id, 'close_ticket', 'after', 'throw_always');
      await flag(run.id, 'send_correction_or_void', 'before', 'throw_always');
      await expect(executor.execute(run.id, 1)).rejects.toThrow(
        'Injected permanent failure',
      );
      expect((await runs.get(run.id))?.status).toBe('compensating');
      await expect(
        runs.append(
          run.id,
          { type: 'STATE_SNAPSHOT', snapshot: {} },
          { state: {}, expectedStatus: 'running' },
        ),
      ).rejects.toThrow('superseded');
      await redis.del(faultKey(run.id, 'send_correction_or_void', 'before'));
      const fresh = await createExecutor(
        runs,
        uri!,
        db.databaseName,
        0,
        {},
        supportDependencies(runs, config, (mail) => smtp.deliver(mail)),
        undefined,
        (mail) => smtp.deliver(mail),
      );
      try {
        await Promise.all([
          executor.execute(run.id, 1),
          fresh.execute(run.id, 1),
        ]);
      } finally {
        await fresh.close();
      }
      await assertRolledBack(run.id, input.customerEmail);
      expect(
        await db
          .collection('idempotencyKeys')
          .countDocuments({ key: `${run.id}:reverse_refund:undo` }),
      ).toBe(1);
    }, 30000);
    it('replays an accepted correction after a lost SMTP acknowledgement without duplicating it', async () => {
      const { run, input } = await prepared();
      await flag(run.id, 'close_ticket', 'after', 'throw_always');
      let lost = false;
      const fresh = await createExecutor(
        runs,
        uri!,
        db.databaseName,
        0,
        {},
        supportDependencies(runs, config, (mail) => smtp.deliver(mail)),
        new RedisFaultInjector(redis, true, undefined, undefined, name),
        async (mail) => {
          await smtp.deliver(mail);
          if (!lost) {
            lost = true;
            throw new RetryableError(
              'Correction accepted; acknowledgement lost',
            );
          }
        },
      );
      try {
        await expect(fresh.execute(run.id, 1)).rejects.toThrow(
          'acknowledgement lost',
        );
        expect((await runs.get(run.id))?.status).toBe('compensating');
        await fresh.execute(run.id, 1);
      } finally {
        await fresh.close();
      }
      await assertRolledBack(run.id, input.customerEmail);
    }, 30000);
    it('uses Dead Letters when failure happens before any effect exists', async () => {
      const e = supportExamples[0];
      const run = await runs.createSupport(
        'saga-tester',
        ticketInputSchema.parse({
          title: e.title,
          description: e.description,
          customerEmail: `none-${randomUUID()}@example.test`,
          orderId: e.orderId,
          amountCents: e.amountCents,
          currency: 'USD',
        }),
      );
      await flag(run.id, 'classify', 'before', 'throw_always');
      await expect(executor.execute(run.id)).rejects.toThrow(
        'Injected permanent failure',
      );
      expect((await runs.get(run.id))?.status).toBe('failed');
      expect((await runs.reliability().details(run.id)).keys).toHaveLength(0);
      expect(
        (await runs.reliability().deadLetters()).filter(
          (row) => row.runId === run.id,
        ),
      ).toHaveLength(1);
    }, 30000);
    async function startWorker() {
      const url = new URL(uri!);
      url.pathname = `/${db.databaseName}`;
      let logs = '';
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./index.ts', import.meta.url)),
        ],
        {
          env: {
            ...process.env,
            MONGODB_URI: url.toString(),
            REDIS_URL: redisUrl!,
            RUN_QUEUE_NAME: name,
            SUPPORT_LLM_PROVIDER: 'mock',
            ORGMIND_RETRIEVER_ENABLED: 'false',
            CHAOS_ENABLED: 'true',
            NODE_ENV: 'development',
            WORKER_LOCK_DURATION_MS: '2000',
            WORKER_STALLED_INTERVAL_MS: '1000',
            LOG_LEVEL: 'warn',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      child.stdout?.on('data', (chunk) => {
        logs += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        logs += String(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Worker not ready: ${logs}`)),
          15000,
        );
        child.on('message', (message) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'worker-ready'
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Worker exited before ready: ${logs}`));
        });
      });
      return child;
    }
    it('survives a real crash after reversal commits but before compensation progress is saved', async () => {
      const { run, input } = await prepared();
      await flag(run.id, 'close_ticket', 'after', 'throw_always');
      await flag(run.id, 'reverse_refund', 'after', 'crash_process');
      const child = await startWorker();
      const exited = new Promise<number | null>((resolve) =>
        child.once('exit', resolve),
      );
      await queue.add(
        'execute-run',
        { runId: run.id, execution: 1 },
        { jobId: `${run.id}-1` },
      );
      expect(await exited).toBe(137);
      expect((await runs.get(run.id))?.status).toBe('compensating');
      expect(
        await redis.get(faultKey(run.id, 'reverse_refund', 'after')),
      ).toBeNull();
      await startWorker();
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'compensated',
      );
      await assertRolledBack(run.id, input.customerEmail);
      expect(
        await db
          .collection('idempotencyKeys')
          .countDocuments({ key: `${run.id}:reverse_refund:undo` }),
      ).toBe(1);
    }, 45000);
  },
);
