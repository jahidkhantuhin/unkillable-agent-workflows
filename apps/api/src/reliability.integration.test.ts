import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository, ReliabilityRepository } from '@unkillable/storage';
import {
  effectResultSchema,
  PermanentError,
  retryPolicySchema,
} from '@unkillable/shared';
import { createExecutor } from '../../worker/src/executor';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('reliability with MongoDB transactions', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
  const runs = new RunRepository(client, db);
  const reliability = new ReliabilityRepository(client, db);
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    await client.connect();
    await bootstrapIndexes(db);
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
    await db.dropDatabase();
    await client.close();
  }, 30000);
  async function child(key: string, crash = false) {
    const path = fileURLToPath(
      new URL(
        '../../../packages/storage/src/testing/effect-child.ts',
        import.meta.url,
      ),
    );
    const worker = spawn(process.execPath, ['--import', 'tsx', path], {
      env: {
        ...process.env,
        EFFECT_URI: uri!,
        EFFECT_DATABASE: db.databaseName,
        EFFECT_KEY: key,
        EFFECT_CRASH_AFTER_COMMIT: crash ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(worker);
    let logs = '';
    worker.stderr?.on('data', (data) => (logs += String(data)));
    let resolveResult: (value: { receipt: string }) => void = () => {};
    let rejectResult: (error: Error) => void = () => {};
    const result = new Promise<{ receipt: string }>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Child startup timed out: ${logs}`)),
        15000,
      );
      worker.on('message', (message) => {
        if (message && typeof message === 'object' && 'type' in message) {
          if (message.type === 'ready') {
            clearTimeout(timer);
            resolve();
          }
          if (message.type === 'result' && 'result' in message)
            resolveResult(effectResultSchema.parse(message.result));
        }
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        if (!crash && code !== 0)
          rejectResult(new Error(`Effect child failed: ${logs}`));
      });
    });
    await ready;
    return { worker, result };
  }
  it('two child workers race on a key, replay the original result, and produce one local delivery', async () => {
    const run = await runs.create('race-tester', { message: 'race' });
    const key = `${run.id}:complete:race`;
    const [a, b] = await Promise.all([child(key), child(key)]);
    a.worker.send({ go: true });
    b.worker.send({ go: true });
    const [first, second] = await Promise.all([a.result, b.result]);
    expect(second).toEqual(first);
    await Promise.all([
      reliability.dispatchOutbox(),
      new ReliabilityRepository(client, db).dispatchOutbox(),
    ]);
    const details = await reliability.details(run.id);
    expect(details.outbox).toHaveLength(1);
    expect(details.deliveries).toHaveLength(1);
    expect(details.outbox[0].status).toBe('sent');
    const replay = await reliability.executeOnce(
      key,
      async () => {
        throw new Error('Completed callback must not run');
      },
      effectResultSchema,
    );
    expect(replay).toEqual(first);
  }, 30000);
  it('rolls back an effect and receipt together, then survives a process exit after commit', async () => {
    const run = await runs.create('rollback-tester', { message: 'rollback' });
    const key = `${run.id}:complete:rollback`;
    await expect(
      reliability.executeOnce(
        key,
        async (transaction) => {
          await transaction.enqueue('notification', {
            message: 'must roll back',
          });
          throw new PermanentError('abort transaction');
        },
        effectResultSchema,
      ),
    ).rejects.toThrow('abort transaction');
    expect((await reliability.details(run.id)).keys).toHaveLength(0);
    expect((await reliability.details(run.id)).outbox).toHaveLength(0);
    const crashed = await child(key, true);
    const exited = new Promise<number | null>((resolve) =>
      crashed.worker.once('exit', resolve),
    );
    crashed.worker.send({ go: true });
    expect(await exited).toBe(137);
    const committed = (await reliability.details(run.id)).keys[0].result;
    const restarted = await child(key);
    restarted.worker.send({ go: true });
    expect(await restarted.result).toEqual(committed);
    expect((await reliability.details(run.id)).outbox).toHaveLength(1);
  }, 30000);
  it('exhausts retries into a DLQ, rejects unauthorized/double resolution, then resumes successfully', async () => {
    const members = new MongoMembershipRepository(db);
    const origin = 'http://localhost:3000';
    const auth = createAuth(
      memoryAdapter({
        users: [],
        sessions: [],
        accounts: [],
        verifications: [],
      }),
      members,
      {
        secret: 'reliability-integration-secret-at-least-32-chars',
        baseURL: 'http://localhost:4000',
        trustedOrigins: [origin],
        test: true,
      },
    );
    const jobs: string[] = [];
    const service = new RunService(runs, {
      add: async (_name, _data, options) => {
        jobs.push(options.jobId);
      },
    });
    const app = createApp(
      { mongo: async () => true, redis: async () => true },
      [origin],
      'silent',
      new AuthService(auth, members, 'http://localhost:4000'),
      service,
    );
    const signed = await request(app)
      .post('/auth/register')
      .set('Origin', origin)
      .send({
        name: 'Reliability tester',
        email: 'reliability@example.test',
        password: 'local-reliability-password',
      });
    expect(signed.status).toBe(201);
    const cookie = (signed.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(
      (await request(app).get('/dead-letters').set('Cookie', cookie)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/dead-letters/${randomUUID()}/retry`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ version: 0 })
      ).status,
    ).toBe(403);
    await members.setRole(signed.body.user.id, 'admin');
    const response = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ input: { message: 'outage', deliveryMode: 'exhaust' } });
    expect(response.status).toBe(202);
    const id = response.body.id as string;
    const executor = await createExecutor(runs, uri!, db.databaseName, 0, {
      complete: retryPolicySchema.parse({
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: 0,
      }),
    });
    try {
      await expect(executor.execute(id)).rejects.toMatchObject({ attempts: 3 });
      expect((await runs.get(id))?.status).toBe('failed');
      const list = await request(app)
        .get('/dead-letters')
        .set('Cookie', cookie);
      expect(list.status).toBe(200);
      const letter = list.body.find(
        (value: { runId: string }) => value.runId === id,
      );
      expect(letter.attempts).toBe(3);
      expect(letter.context.checkpointId).toBeTruthy();
      expect(letter.error.classification).toBe('retryable');
      expect(
        (await runs.events(id, 0)).filter(
          (event) =>
            event.type === 'CUSTOM' && event.name === 'retry.scheduled',
        ),
      ).toHaveLength(2);
      const [a, b] = await Promise.all([
        request(app)
          .post(`/dead-letters/${letter.id}/retry`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ version: 0 }),
        request(app)
          .post(`/dead-letters/${letter.id}/retry`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ version: 0 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(jobs).toContain(`${id}-1`);
      // An old queue dispatch must not acknowledge a newly queued execution.
      await runs.markDispatched(id, 0);
      // Simulate a fresh pending dispatch marker, then an old completion.
      await db
        .collection('runs')
        .updateOne({ id }, { $set: { dispatchPending: true } });
      await runs.markDispatched(id, 0);
      expect((await runs.get(id))?.dispatchPending).toBe(true);
      await runs.markDispatched(id, 1);
      expect((await runs.get(id))?.dispatchPending).toBe(false);
      await executor.execute(id);
      expect((await runs.get(id))?.status).toBe('succeeded');
      await reliability.dispatchOutbox();
      const permanent = await runs.create('discard-tester', {
        message: 'invalid',
        deliveryMode: 'permanent',
      });
      await expect(executor.execute(permanent.id)).rejects.toMatchObject({
        attempts: 1,
      });
      const bad = (await reliability.deadLetters()).find(
        (value) => value.runId === permanent.id,
      )!;
      expect(
        (
          await request(app)
            .post(`/dead-letters/${bad.id}/discard`)
            .set('Cookie', cookie)
            .set('Origin', origin)
            .send({ version: bad.version })
        ).status,
      ).toBe(200);
      expect((await reliability.deadLetter(bad.id))?.status).toBe('discarded');
      expect((await runs.get(permanent.id))?.status).toBe('failed');
    } finally {
      await executor.close();
    }
  }, 30000);
});
