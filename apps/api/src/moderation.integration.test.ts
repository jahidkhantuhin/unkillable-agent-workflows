import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { MongoClient } from 'mongodb';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository, LocalContentStorage } from '@unkillable/storage';
import {
  PermanentError,
  RetryableError,
  moderationStateSchema,
} from '@unkillable/shared';
import { createModerationExecutor } from '../../worker/src/moderation-executor';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { ModerationService } from './services/moderation';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI,
  redis = process.env.INTEGRATION_REDIS_URL;
async function until<T>(read: () => Promise<T>, match: (v: T) => boolean) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await read();
    if (match(value)) return value;
    await delay(30);
  }
  throw new Error('Moderation workflow timeout');
}
describe.skipIf(!uri || !redis)('async content moderation', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`),
    runs = new RunRepository(client, db);
  const origin = 'http://localhost:3000',
    queueName = `moderation-test-${randomUUID()}`;
  let directory = '',
    files: LocalContentStorage,
    queue: Queue,
    worker: Worker,
    executor: Awaited<ReturnType<typeof createModerationExecutor>>,
    app: ReturnType<typeof createApp>,
    admin = '',
    approver = '',
    viewer = '',
    adminId = '';
  const failedOnce = new Set<string>();
  const failures: unknown[] = [];
  async function start() {
    executor = await createModerationExecutor(
      runs,
      uri!,
      db.databaseName,
      {
        at: async (id, node, phase) => {
          if (phase !== 'after') return;
          const run = await runs.get(id);
          if (
            node === 'publish' &&
            run?.state.title === 'Retry after publication' &&
            !failedOnce.has(id)
          ) {
            failedOnce.add(id);
            throw new RetryableError('Disconnect after local publish');
          }
          if (
            node === 'notify' &&
            run?.state.title === 'Rollback delivered notice'
          ) {
            await runs.reliability().dispatchOutbox();
            throw new PermanentError('Failure after local notice delivery');
          }
          if (node === 'notify' && run?.state.title === 'Rollback publication')
            throw new PermanentError(
              'Deliberate terminal failure after notice',
            );
        },
      },
      files,
    );
    worker = new Worker(
      queueName,
      (job) => executor.execute(job.data.runId, job.data.execution),
      { connection: { url: redis! }, concurrency: 1 },
    );
    worker.on('failed', (_job, error) => failures.push(error));
    await worker.waitUntilReady();
  }
  beforeAll(async () => {
    await client.connect();
    await bootstrapIndexes(db);
    directory = await mkdtemp(join(tmpdir(), 'unkillable-moderation-'));
    files = new LocalContentStorage(directory);
    queue = new Queue(queueName, { connection: { url: redis! } });
    const service = new RunService(runs, queue);
    await service.initialize();
    const members = new MongoMembershipRepository(db);
    const auth = createAuth(
      memoryAdapter({
        users: [],
        sessions: [],
        accounts: [],
        verifications: [],
      }),
      members,
      {
        secret: 'moderation-test-secret-at-least-32-characters',
        baseURL: 'http://localhost:4000',
        trustedOrigins: [origin],
        test: true,
      },
    );
    app = createApp(
      { mongo: async () => true, redis: async () => true },
      [origin],
      'silent',
      new AuthService(auth, members, 'http://localhost:4000'),
      service,
      undefined,
      new ModerationService(service, files),
    );
    for (const role of ['admin', 'approver', 'viewer'] as const) {
      const r = await request(app)
        .post('/auth/register')
        .set('Origin', origin)
        .send({
          name: role,
          email: `${role}@moderation.test`,
          password: 'moderation-local-test-password',
        });
      expect(r.status).toBe(201);
      await members.setRole(r.body.user.id, role);
      const cookie = (r.headers['set-cookie'] as unknown as string[])
        .map((v) => v.split(';')[0])
        .join('; ');
      if (role === 'admin') {
        admin = cookie;
        adminId = r.body.user.id;
      } else if (role === 'approver') approver = cookie;
      else viewer = cookie;
    }
    await start();
  }, 30000);
  afterAll(async () => {
    await worker?.close();
    await executor?.close();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await db.dropDatabase();
    await client.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);
  const upload = (title: string, text: string, cookie = admin) =>
    request(app)
      .post(`/moderation/uploads?title=${encodeURIComponent(title)}`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('Content-Type', 'text/plain')
      .send(text);
  async function finish(id: string, status = 'succeeded') {
    return until(
      () => runs.get(id),
      (run) => run?.status === status,
    );
  }
  it('restricts the queue, uploads and original downloads to admins', async () => {
    expect((await request(app).get('/moderation')).status).toBe(401);
    for (const cookie of [viewer, approver]) {
      expect(
        (await request(app).get('/moderation').set('Cookie', cookie)).status,
      ).toBe(403);
      expect((await upload('Forbidden', 'safe', cookie)).status).toBe(403);
    }
    expect(
      (
        await request(app)
          .post('/moderation/uploads?title=Test')
          .set('Cookie', admin)
          .set('Content-Type', 'text/plain')
          .send('safe')
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/moderation/uploads?title=Test')
          .set('Origin', origin)
          .set('Cookie', admin)
          .send({ text: 'safe' })
      ).status,
    ).toBe(415);
  });
  it('publishes safe content once across retries/redelivery and rejects blocked content without publication', async () => {
    const submitted = await upload(
      'Retry after publication',
      'Welcome to the community.',
    );
    expect(submitted.status).toBe(202);
    const id = submitted.body.id;
    await finish(id);
    await queue.add(
      'duplicate-delivery',
      { runId: id, execution: 0 },
      { jobId: `duplicate-${id}` },
    );
    await until(
      () => queue.getJob(`duplicate-${id}`).then((job) => job?.getState()),
      (state) => state === 'completed',
    );
    const state = moderationStateSchema.parse((await runs.get(id))!.state);
    const concurrent = await runs.createModeration(adminId, {
      title: 'Concurrent first publication',
      file: state.file,
    });
    await runs.append(
      concurrent.id,
      { type: 'RUN_STARTED' },
      { status: 'running' },
    );
    const allowed = moderationStateSchema.parse({
      ...concurrent.state,
      decision: 'allow',
    });
    await Promise.all([
      runs.moderation().decide(concurrent.id, allowed, true),
      new RunRepository(client, db)
        .moderation()
        .decide(concurrent.id, allowed, true),
    ]);
    expect(
      await db
        .collection('publishedContent')
        .countDocuments({ runId: concurrent.id }),
    ).toBe(1);
    await runs.append(
      concurrent.id,
      { type: 'RUN_FINISHED', outcome: 'succeeded' },
      { status: 'succeeded', state: allowed },
    );
    await Promise.all([
      runs.moderation().decide(id, state, true),
      new RunRepository(client, db).moderation().decide(id, state, true),
    ]);
    expect(
      await db.collection('publishedContent').countDocuments({ runId: id }),
    ).toBe(1);
    expect(
      (await runs.events(id)).some(
        (e) => e.type === 'CUSTOM' && e.name === 'retry.scheduled',
      ),
    ).toBe(true);
    await runs.reliability().dispatchOutbox();
    await runs.reliability().dispatchOutbox();
    expect(
      await db.collection('localDeliveries').countDocuments({ runId: id }),
    ).toBe(1);
    expect(
      (await request(app).get(`/moderation/${id}/content`).set('Cookie', admin))
        .text,
    ).toBe('Welcome to the community.');
    expect(
      (
        await request(app)
          .get(`/moderation/${id}/content`)
          .set('Cookie', viewer)
      ).status,
    ).toBe(403);
    const blocked = await upload('Blocked', 'DEMO_BLOCK synthetic marker');
    await finish(blocked.body.id);
    expect((await runs.moderation().item(blocked.body.id))?.status).toBe(
      'rejected',
    );
    expect(
      await db
        .collection('publishedContent')
        .countDocuments({ runId: blocked.body.id }),
    ).toBe(0);
  }, 30000);
  it('resumes an admin review after executor restart, rejects edits/non-admin decisions, and publishes only after approval', async () => {
    const r = await upload(
      'Review this post',
      'DEMO_REVIEW synthetic ambiguity',
    );
    await finish(r.body.id, 'waiting_approval');
    await worker.close();
    await executor.close();
    await start();
    const approval = (await runs.approvals().forRun(r.body.id))!;
    const decide = (cookie: string, decision: object) =>
      request(app)
        .post(`/approvals/${approval.id}/resolve`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send({ version: 0, decision });
    expect((await decide(approver, { action: 'approve' })).status).toBe(403);
    expect(
      (await decide(admin, { action: 'edit', payload: { message: 'Changed' } }))
        .status,
    ).toBe(409);
    expect(
      await db
        .collection('publishedContent')
        .countDocuments({ runId: r.body.id }),
    ).toBe(0);
    expect((await decide(admin, { action: 'approve' })).status).toBe(200);
    await finish(r.body.id);
    expect(
      await db
        .collection('publishedContent')
        .countDocuments({ runId: r.body.id }),
    ).toBe(1);
    expect(
      (await runs.events(r.body.id)).filter(
        (e) => e.type === 'STEP_FINISHED' && e.stepName === 'automated_check',
      ),
    ).toHaveLength(1);
    const reject = await upload(
      'Reject in review',
      'DEMO_REVIEW another synthetic post',
    );
    await finish(reject.body.id, 'waiting_approval');
    const pending = (await runs.approvals().forRun(reject.body.id))!;
    expect(
      (
        await request(app)
          .post(`/approvals/${pending.id}/resolve`)
          .set('Cookie', admin)
          .set('Origin', origin)
          .send({
            version: 0,
            decision: { action: 'reject', reason: 'Needs clearer context' },
          })
      ).status,
    ).toBe(200);
    await finish(reject.body.id);
    expect((await runs.moderation().item(reject.body.id))?.status).toBe(
      'rejected',
    );
  }, 30000);
  it('uses the shared saga to void notice and withdraw publication after a terminal failure', async () => {
    const r = await upload('Rollback publication', 'Friendly synthetic post');
    await finish(r.body.id, 'compensated');
    expect((await runs.moderation().item(r.body.id))?.status).toBe('withdrawn');
    expect(
      await db.collection('publishedContent').findOne({ runId: r.body.id }),
    ).toMatchObject({ status: 'withdrawn' });
    expect((await runs.get(r.body.id))?.state.saga).toMatchObject({
      completed: ['void_moderation_notice', 'unpublish_content'],
    });
    await runs.reliability().dispatchOutbox();
    expect(
      await db
        .collection('localDeliveries')
        .countDocuments({ runId: r.body.id }),
    ).toBe(0);
    const result = await request(app).get('/moderation').set('Cookie', admin);
    expect(result.status).toBe(200);
    expect(result.body.decisionsLast24Hours).toBeGreaterThan(0);
    expect(failures).toEqual([]);
    expect(adminId).toBeTruthy();
    const delivered = await upload(
      'Rollback delivered notice',
      'Another friendly post',
    );
    await finish(delivered.body.id, 'compensated');
    expect(
      await db
        .collection('localDeliveries')
        .findOne({ runId: delivered.body.id }),
    ).toMatchObject({ voided: true });
    expect(
      await db
        .collection('publishedContent')
        .findOne({ runId: delivered.body.id }),
    ).toMatchObject({ status: 'withdrawn' });
  }, 30000);
});
