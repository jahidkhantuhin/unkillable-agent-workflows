import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository } from '@unkillable/storage';
import { chaosPrefix } from '@unkillable/shared';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { ChaosService } from './services/chaos';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
async function until<T>(read: () => Promise<T>, match: (v: T) => boolean) {
  const end = Date.now() + 35000;
  while (Date.now() < end) {
    const v = await read();
    if (match(v)) return v;
    await delay(80);
  }
  throw new Error('Chaos recovery timeout');
}
describe.skipIf(!uri || !redisUrl)(
  'protected chaos API and supervised recovery',
  () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
    const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`),
      runs = new RunRepository(client, db);
    const redis = new Redis(redisUrl ?? 'redis://127.0.0.1:6379', {
      lazyConnect: true,
    });
    const name = `chaos-test-${randomUUID()}`,
      origin = 'http://localhost:3000';
    const children: ChildProcess[] = [],
      flags: string[] = [];
    const members = new MongoMembershipRepository(db);
    let queue: Queue,
      service: RunService,
      chaos: ChaosService,
      app: ReturnType<typeof createApp>,
      auth: AuthService,
      cookie = '',
      userId = '';
    beforeAll(async () => {
      await client.connect();
      await redis.connect();
      await bootstrapIndexes(db);
      queue = new Queue(name, {
        connection: { url: redisUrl! },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'fixed', delay: 100 },
        },
      });
      service = new RunService(runs, queue);
      await service.initialize();
      auth = new AuthService(
        createAuth(
          memoryAdapter({
            users: [],
            sessions: [],
            accounts: [],
            verifications: [],
          }),
          members,
          {
            secret: 'chaos-test-secret-at-least-32-characters',
            baseURL: 'http://localhost:4000',
            trustedOrigins: [origin],
            test: true,
          },
        ),
        members,
        'http://localhost:4000',
      );
      chaos = new ChaosService(redis, runs, name, {
        CHAOS_ENABLED: 'true',
        NODE_ENV: 'development',
      });
      app = createApp(
        { mongo: async () => true, redis: async () => true },
        [origin],
        'silent',
        auth,
        service,
        chaos,
      );
      const signed = await request(app)
        .post('/auth/register')
        .set('Origin', origin)
        .send({
          name: 'Chaos tester',
          email: 'chaos@example.test',
          password: 'chaos-local-test-password',
        });
      expect(signed.status).toBe(201);
      userId = signed.body.user.id;
      cookie = (signed.headers['set-cookie'] as unknown as string[])
        .map((v) => v.split(';')[0])
        .join('; ');
    }, 30000);
    afterAll(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const done = new Promise<void>((resolve) =>
            child.once('exit', () => resolve()),
          );
          if (process.platform === 'win32')
            spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          else child.kill('SIGTERM');
          await done;
        }
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      const keys = await redis.keys(`${chaosPrefix(name)}:*`);
      if (keys.length) await redis.del(...keys);
      if (flags.length) await redis.del(...flags);
      redis.disconnect();
      await db.dropDatabase();
      await client.close();
    }, 30000);
    function post(path: string, body: object, originHeader = true) {
      const req = request(app).post(`/chaos/${path}`).set('Cookie', cookie);
      if (originHeader) req.set('Origin', origin);
      return req.send(body);
    }
    async function supervisor(target: 'worker' | 'api') {
      const mongoURL = new URL(uri!);
      mongoURL.pathname = `/${db.databaseName}`;
      const port = await new Promise<number>((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port =
            address && typeof address === 'object' ? address.port : 0;
          server.close(() => resolve(port));
        });
      });
      const child = spawn(
        process.execPath,
        [resolve('scripts/supervise.mjs'), target],
        {
          env: {
            ...process.env,
            MONGODB_URI: mongoURL.toString(),
            REDIS_URL: redisUrl!,
            RUN_QUEUE_NAME: name,
            NODE_ENV: 'development',
            CHAOS_ENABLED: 'true',
            CHAOS_RESTART_DELAY_MS: '300',
            API_PORT: String(port),
            BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
            BETTER_AUTH_SECRET: 'chaos-child-secret-at-least-32-characters',
            CORS_ORIGINS: origin,
            SUPPORT_LLM_PROVIDER: 'mock',
            ORGMIND_RETRIEVER_ENABLED: 'false',
            WORKER_LOCK_DURATION_MS: '2000',
            WORKER_STALLED_INTERVAL_MS: '1000',
            DEMO_NODE_DELAY_MS: '1600',
            LOG_LEVEL: 'warn',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      children.push(child);
      let logs = '';
      child.stdout?.on('data', (chunk) => {
        logs += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        logs += String(chunk);
      });
      try {
        await until(
          () => chaos.status(),
          (status) => status[target].state === 'up',
        );
      } catch (error) {
        throw new Error(`${String(error)} ${logs}`, { cause: error });
      }
      return child;
    }
    it('denies unauthorized, non-admin, disabled, production and untrusted mutations', async () => {
      expect((await request(app).get('/chaos/status')).status).toBe(401);
      expect((await post('kill', { target: 'worker' })).status).toBe(403);
      await members.setRole(userId, 'approver');
      expect((await post('kill', { target: 'worker' })).status).toBe(403);
      await members.setRole(userId, 'admin');
      expect((await post('kill', { target: 'worker' }, false)).status).toBe(
        403,
      );
      expect((await post('kill', { target: 'worker', pid: 123 })).status).toBe(
        400,
      );
      for (const env of [
        { CHAOS_ENABLED: 'false', NODE_ENV: 'development' },
        { CHAOS_ENABLED: 'true', NODE_ENV: 'production' },
      ]) {
        const disabled = createApp(
          { mongo: async () => true, redis: async () => true },
          [origin],
          'silent',
          auth,
          service,
          new ChaosService(redis, runs, name, env),
        );
        expect(
          (
            await request(disabled)
              .post('/chaos/kill')
              .set('Cookie', cookie)
              .set('Origin', origin)
              .send({ target: 'worker' })
          ).status,
        ).toBe(403);
      }
    });
    it('validates per-run faults, audits the actor, and bounds model profiles with TTL', async () => {
      const run = await runs.create(userId, {
        message: 'Chaos hook validation',
      });
      await runs.markDispatched(run.id);
      const value = {
        runId: run.id,
        node: 'complete',
        phase: 'before',
        fault: { mode: 'throw_once' },
      };
      expect(
        (await post('fault', { ...value, node: 'send_email' })).status,
      ).toBe(400);
      expect((await post('fault', value)).status).toBe(202);
      const key = `unkillable:fault:${run.id}:complete:before`;
      flags.push(key);
      expect(await redis.ttl(key)).toBeGreaterThan(0);
      expect(
        (await runs.events(run.id)).some(
          (e) =>
            e.type === 'CUSTOM' &&
            e.name === 'chaos.injected' &&
            e.value.actorId === userId,
        ),
      ).toBe(true);
      expect(
        (
          await post('clear', {
            runId: run.id,
            node: 'complete',
            phase: 'before',
          })
        ).status,
      ).toBe(200);
      expect(await redis.get(key)).toBeNull();
      expect((await post('llm', { mode: 'slow', delayMs: 30001 })).status).toBe(
        400,
      );
      expect((await post('llm', { mode: 'flaky', rate: 0.5 })).status).toBe(
        200,
      );
      expect((await chaos.status()).llm.mode).toBe('flaky');
      expect((await post('llm', { mode: 'off' })).status).toBe(200);
    });
    it('kills a worker through the API during an active node and automatically resumes its abandoned job', async () => {
      await supervisor('worker');
      const before = (await chaos.status()).worker.instance;
      const run = await service.create(userId, {
        message: 'Survive chaos API worker kill',
      });
      await until(
        () => runs.events(run.id),
        (events) =>
          events.some(
            (e) =>
              e.type === 'CUSTOM' &&
              e.name === 'node.attempt' &&
              e.value.nodeId === 'summarize',
          ),
      );
      expect((await post('kill', { target: 'worker' })).status).toBe(202);
      await until(
        () => chaos.status(),
        (status) =>
          status.worker.state === 'up' && status.worker.instance !== before,
      );
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'succeeded',
      );
      const events = await runs.events(run.id);
      expect(
        events.some((e) => e.type === 'CUSTOM' && e.name === 'run.resumed'),
      ).toBe(true);
      expect(
        events.filter(
          (e) => e.type === 'STEP_STARTED' && e.stepName === 'prepare',
        ),
      ).toHaveLength(1);
      const effects = await runs.reliability().details(run.id);
      expect(
        effects.keys.filter((key) => key.key === `${run.id}:complete:notice`),
      ).toHaveLength(1);
    }, 45000);
    it('kills the supervised API through the control endpoint and observes a new ready instance', async () => {
      await supervisor('api');
      const before = (await chaos.status()).api.instance;
      expect((await post('kill', { target: 'api' })).status).toBe(202);
      const status = await until(
        () => chaos.status(),
        (value) => value.api.state === 'up' && value.api.instance !== before,
      );
      expect(status.api.restarts).toBeGreaterThan(0);
    }, 45000);
  },
);
