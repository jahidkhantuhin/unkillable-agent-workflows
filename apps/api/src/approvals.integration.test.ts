import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository } from '@unkillable/storage';
import { createDemoRuntime } from '@unkillable/workflows/runtime';
import { createExecutor } from '../../worker/src/executor';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
const redis = process.env.INTEGRATION_REDIS_URL;
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (match(value)) return value;
    await delay(25);
  }
  throw new Error('Timed out waiting for approval workflow');
}
describe.skipIf(!uri || !redis)('human approval gates', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
  const runs = new RunRepository(client, db);
  const approvals = runs.approvals();
  const name = `approvals-test-${randomUUID()}`;
  let queue: Queue;
  let worker: Worker | undefined;
  let executor: Awaited<ReturnType<typeof createExecutor>> | undefined;
  const failures: unknown[] = [];
  async function start() {
    executor = await createExecutor(runs, uri!, db.databaseName, 0);
    worker = new Worker(
      name,
      (job) => executor!.execute(job.data.runId, job.data.execution),
      { connection: { url: redis! }, concurrency: 1 },
    );
    worker.on('failed', (_job, error) => failures.push(error));
    await worker.waitUntilReady();
  }
  async function stop() {
    await worker?.close();
    worker = undefined;
    await executor?.close();
    executor = undefined;
  }
  beforeAll(async () => {
    await client.connect();
    await bootstrapIndexes(db);
    queue = new Queue(name, { connection: { url: redis! } });
  }, 30000);
  afterAll(async () => {
    await stop();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await db.dropDatabase();
    await client.close();
  }, 30000);
  it('releases the queue slot, survives restart, enforces RBAC and resolves once with an edited payload', async () => {
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
        secret: 'approval-integration-secret-at-least-32-chars',
        baseURL: 'http://localhost:4000',
        trustedOrigins: [origin],
        test: true,
      },
    );
    let outage = false;
    const service = new RunService(runs, {
      add: async (n, data, opts) => {
        if (outage) throw new Error('simulated queue outage');
        return queue.add(n, data, opts);
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
        name: 'Approval tester',
        email: 'approval@example.test',
        password: 'local-approval-password',
      });
    expect(signed.status).toBe(201);
    const cookie = (signed.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(
      (await request(app).get('/approvals').set('Cookie', cookie)).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/approvals/${randomUUID()}/resolve`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ version: 0, decision: { action: 'approve' } })
      ).status,
    ).toBe(403);
    await members.setRole(signed.body.user.id, 'approver');
    await start();
    const created = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({
        input: {
          title: 'Review test identity',
          message: 'Review my notice',
          requireApproval: true,
        },
      });
    expect(created.status).toBe(202);
    const id = created.body.id as string;
    await until(
      () => runs.get(id),
      (run) => run?.status === 'waiting_approval',
    );
    await until(
      () => queue.getJob(id).then((job) => job?.getState()),
      (state) => state === 'completed',
    );
    expect(await queue.getActiveCount()).toBe(0);
    // A late queue failure after the durable pause must not destroy its pending review.
    await runs
      .reliability()
      .recordFailure(
        id,
        0,
        new Error('late failed acknowledgement after pause'),
      );
    expect((await runs.get(id))?.status).toBe('waiting_approval');
    expect(
      (await runs.reliability().deadLetters()).filter(
        (item) => item.runId === id,
      ),
    ).toHaveLength(0);
    expect((await runs.reliability().details(id)).outbox).toHaveLength(0);
    const normal = await service.create(signed.body.user.id, {
      message: 'Another run while approval waits',
    });
    await until(
      () => runs.get(normal.id),
      (run) => run?.status === 'succeeded',
    );
    expect((await runs.get(id))?.status).toBe('waiting_approval');
    const list = await request(app).get('/approvals').set('Cookie', cookie);
    expect(list.status).toBe(200);
    await members.setRole(signed.body.user.id, 'admin');
    expect(
      (await request(app).get('/approvals').set('Cookie', cookie)).status,
    ).toBe(200);
    await members.setRole(signed.body.user.id, 'approver');
    const approval = list.body.find(
      (item: { runId: string }) => item.runId === id,
    );
    expect(approval.proposedAction.message).toBe('Review my notice');
    expect(approval.title).toBe('Review test identity');
    expect(
      (
        await request(app)
          .get(`/approvals/${approval.id}`)
          .set('Cookie', cookie)
      ).status,
    ).toBe(200);
    await stop();
    await start();
    const endpoint = `/approvals/${approval.id}/resolve`;
    expect(
      (
        await request(app)
          .post(endpoint)
          .set('Cookie', cookie)
          .set('Origin', 'https://untrusted.example')
          .send({ version: 0, decision: { action: 'approve' } })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(endpoint)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({
            version: 0,
            decision: { action: 'edit', payload: { message: '' } },
          })
      ).status,
    ).toBe(400);
    outage = true;
    const decisions = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post(endpoint)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({
            version: 0,
            decision: {
              action: 'edit',
              payload: { message: 'Human corrected notice' },
            },
          }),
      ),
    );
    expect(decisions.map((value) => value.status).sort()).toEqual([200, 409]);
    expect((await runs.get(id))?.dispatchPending).toBe(true);
    outage = false;
    await service.reconcile();
    await until(
      () => runs.get(id),
      (run) => run?.status === 'succeeded',
    );
    await runs.reliability().dispatchOutbox();
    const details = await runs.reliability().details(id);
    expect(details.deliveries).toHaveLength(1);
    expect(details.deliveries[0]?.payload.message).toBe(
      'Human corrected notice',
    );
    const record = await approvals.get(approval.id);
    expect((await runs.get(id))?.state).toMatchObject({
      title: 'Review test identity',
      message: 'Review my notice',
      noticeMessage: 'Human corrected notice',
    });
    expect(record?.title).toBe('Review test identity');
    expect(record?.resolvedBy).toBe(signed.body.user.id);
    expect(record?.version).toBe(1);
    const events = await runs.events(id, 0);
    expect(
      events.filter(
        (event) =>
          event.type === 'CUSTOM' && event.name === 'approval.requested',
      ),
    ).toHaveLength(1);
    const resolved = events.find(
      (event) => event.type === 'CUSTOM' && event.name === 'approval.resolved',
    );
    expect(resolved).toMatchObject({
      value: {
        actorId: signed.body.user.id,
        decision: {
          action: 'edit',
          payload: { message: 'Human corrected notice' },
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === 'STEP_STARTED' && event.stepName === 'prepare',
      ),
    ).toHaveLength(1);
    expect(failures).toEqual([]);
    await stop();
  }, 45000);
  it.each(['approve', 'reject'] as const)(
    'resumes %s through a fresh executor and suppresses effects after rejection',
    async (action) => {
      const first = await createExecutor(runs, uri!, db.databaseName, 0);
      const run = await runs.create('decision-tester', {
        message: `${action} local notice`,
        requireApproval: true,
      });
      try {
        await first.execute(run.id);
      } finally {
        await first.close();
      }
      expect((await runs.get(run.id))?.status).toBe('waiting_approval');
      const approval = await approvals.forRun(run.id);
      expect(approval).toBeTruthy();
      await approvals.resolve(
        approval!.id,
        0,
        action === 'approve'
          ? { action }
          : { action, reason: 'Do not deliver this notice' },
        'reviewer',
      );
      const next = await createExecutor(runs, uri!, db.databaseName, 0);
      try {
        await next.execute(run.id, 1);
        await next.execute(run.id, 0);
      } finally {
        await next.close();
      }
      expect((await runs.get(run.id))?.status).toBe(
        action === 'approve' ? 'succeeded' : 'cancelled',
      );
      expect((await runs.reliability().details(run.id)).outbox).toHaveLength(
        action === 'approve' ? 1 : 0,
      );
    },
    30000,
  );
  it('recovers after the resumed decision checkpoints without delivering twice', async () => {
    const run = await runs.create('resume-boundary', {
      message: 'One approved notice',
      requireApproval: true,
    });
    const first = await createExecutor(runs, uri!, db.databaseName, 0);
    await first.execute(run.id);
    const approval = await approvals.forRun(run.id);
    await approvals.resolve(approval!.id, 0, { action: 'approve' }, 'reviewer');
    const append = runs.append.bind(runs);
    const interrupted = vi
      .spyOn(runs, 'append')
      .mockImplementation(async (id, event, options) => {
        if (event.type === 'RUN_FINISHED')
          throw new Error('Stopped after resumed checkpoint');
        return append(id, event, options);
      });
    try {
      await expect(first.execute(run.id, 1)).rejects.toThrow(
        'Stopped after resumed checkpoint',
      );
    } finally {
      interrupted.mockRestore();
      await first.close();
    }
    const next = await createExecutor(runs, uri!, db.databaseName, 0);
    try {
      await next.execute(run.id, 1);
    } finally {
      await next.close();
    }
    await runs.reliability().dispatchOutbox();
    expect((await runs.get(run.id))?.status).toBe('succeeded');
    expect((await runs.reliability().details(run.id)).deliveries).toHaveLength(
      1,
    );
    expect(
      (await runs.events(run.id, 0)).filter(
        (event) =>
          event.type === 'CUSTOM' && event.name === 'approval.resolved',
      ),
    ).toHaveLength(1);
  }, 30000);
  it('resumes a version 2 checkpoint lacking approval channels without introducing a gate', async () => {
    const run = await runs.create('legacy-boundary', {
      message: 'Legacy version 2 notice',
    });
    await db
      .collection('runs')
      .updateOne({ id: run.id }, { $set: { workflowVersion: 2 } });
    const first = await createExecutor(runs, uri!, db.databaseName, 0);
    const append = runs.append.bind(runs);
    const interrupted = vi
      .spyOn(runs, 'append')
      .mockImplementation(async (id, event, options) => {
        if (event.type === 'RUN_FINISHED')
          throw new Error('Legacy checkpoint interruption');
        return append(id, event, options);
      });
    try {
      await expect(first.execute(run.id)).rejects.toThrow(
        'Legacy checkpoint interruption',
      );
    } finally {
      interrupted.mockRestore();
      await first.close();
    }
    // Use the native serializer: checkpoint payloads are not plain Mongo objects.
    const legacy = await createDemoRuntime(
      uri!,
      db.databaseName,
      { stepStarted: async () => {}, checkpoint: async () => {} },
      0,
    );
    try {
      const config = { configurable: { thread_id: run.id } };
      const tuple = await legacy.saver.getTuple(config);
      if (!tuple?.metadata)
        throw new Error('Missing legacy checkpoint fixture');
      for (const field of [
        'title',
        'requireApproval',
        'noticeMessage',
        'approvalAction',
      ])
        delete tuple.checkpoint.channel_values[field];
      await legacy.saver.put(tuple.config, tuple.checkpoint, tuple.metadata);
      expect(
        (await legacy.saver.getTuple(config))?.checkpoint.channel_values,
      ).not.toHaveProperty('requireApproval');
    } finally {
      await legacy.close();
    }
    const next = await createExecutor(runs, uri!, db.databaseName, 0);
    try {
      await next.execute(run.id);
    } finally {
      await next.close();
    }
    expect((await runs.get(run.id))?.status).toBe('succeeded');
    expect(await approvals.forRun(run.id)).toBeNull();
  }, 30000);
  it('recovers an interrupt checkpoint if the worker stops before publishing its approval', async () => {
    const run = await runs.create('boundary-tester', {
      message: 'Recover unpublished approval',
      requireApproval: true,
    });
    const original = runs.approvals.bind(runs);
    const fake = original();
    vi.spyOn(fake, 'request').mockRejectedValue(
      new Error('crash after interrupt checkpoint'),
    );
    const spy = vi.spyOn(runs, 'approvals').mockReturnValue(fake);
    const first = await createExecutor(runs, uri!, db.databaseName, 0);
    try {
      await expect(first.execute(run.id)).rejects.toThrow(
        'crash after interrupt checkpoint',
      );
    } finally {
      await first.close();
      spy.mockRestore();
    }
    expect(await approvals.forRun(run.id)).toBeNull();
    const next = await createExecutor(runs, uri!, db.databaseName, 0);
    try {
      await next.execute(run.id);
      await next.execute(run.id);
    } finally {
      await next.close();
    }
    expect((await runs.get(run.id))?.status).toBe('waiting_approval');
    expect(
      (await approvals.list()).filter((item) => item.runId === run.id),
    ).toHaveLength(1);
  }, 30000);
});
