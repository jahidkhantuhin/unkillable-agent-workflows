import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository } from '@unkillable/storage';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('run API and append-only event integration', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
  const repository = new RunRepository(client, db);
  beforeAll(async () => {
    await client.connect();
    await bootstrapIndexes(db);
  }, 30000);
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
  it('keeps queued runs durable across dispatch failure, enforces creation roles, and replays SSE cursors', async () => {
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
        secret: 'runs-test-secret-at-least-32-characters-123',
        baseURL: 'http://localhost:4000',
        trustedOrigins: [origin],
        test: true,
      },
    );
    let unavailable = true;
    const delivered = new Set<string>();
    const service = new RunService(repository, {
      add: async (_name, _data, options) => {
        if (unavailable) throw new Error('Redis down');
        delivered.add(options.jobId);
      },
    });
    await service.initialize();
    const app = createApp(
      { mongo: async () => true, redis: async () => true },
      [origin],
      'silent',
      new AuthService(auth, members, 'http://localhost:4000'),
      service,
    );
    expect((await request(app).get('/runs')).status).toBe(401);
    const signed = await request(app)
      .post('/auth/register')
      .set('Origin', origin)
      .send({
        name: 'Run tester',
        email: 'run@example.test',
        password: 'local-run-test-password',
      });
    expect(signed.status).toBe(201);
    const cookie = (signed.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(
      (
        await request(app)
          .post('/runs')
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ input: { message: 'hello' } })
      ).status,
    ).toBe(403);
    await members.setRole(signed.body.user.id, 'approver');
    expect(
      (
        await request(app)
          .post('/runs')
          .set('Cookie', cookie)
          .send({ input: { message: 'hello' } })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/runs')
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ input: { message: '' } })
      ).status,
    ).toBe(400);
    const created = await request(app)
      .post('/runs')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send({ input: { message: 'hello world' } });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe('queued');
    expect(created.body.dispatchPending).toBe(true);
    const id = created.body.id as string;
    expect((await request(app).get(`/runs/${id}/graph`)).status).toBe(401);
    const definition = await request(app)
      .get(`/runs/${id}/graph`)
      .set('Cookie', cookie);
    expect(definition.status).toBe(200);
    expect(
      definition.body.nodes.map((node: { id: string }) => node.id),
    ).toEqual(['prepare', 'summarize', 'complete']);
    const gated = await repository.create(signed.body.user.id, {
      message: 'Review graph',
      requireApproval: true,
    });
    await repository.markDispatched(gated.id);
    expect((await service.graph(gated.id)).edges).toContainEqual({
      source: 'summarize',
      target: 'approval',
    });
    expect((await service.graph(gated.id)).edges).not.toContainEqual({
      source: 'summarize',
      target: 'complete',
    });
    unavailable = false;
    // A new service represents an API restart between persisting and enqueueing.
    const restarted = new RunService(repository, {
      add: async (_name, _data, options) => {
        delivered.add(options.jobId);
      },
    });
    await restarted.reconcile();
    await restarted.reconcile();
    expect([...delivered]).toEqual([id]);
    expect((await repository.get(id))?.dispatchPending).toBe(false);
    await repository.append(
      id,
      { type: 'RUN_STARTED' },
      { key: 'started', status: 'running' },
    );
    await repository.append(
      id,
      { type: 'RUN_ERROR', code: 'TEST_FAILURE', message: 'Test failure' },
      { key: 'failed', status: 'failed', error: 'Test failure' },
    );
    expect(
      (await request(app).get(`/runs/${id}`).set('Cookie', cookie)).body.status,
    ).toBe('failed');
    const replay = await request(app)
      .get(`/runs/${id}/events`)
      .set('Cookie', cookie);
    expect(replay.status).toBe(200);
    expect(replay.headers['content-type']).toContain('text/event-stream');
    expect(replay.text).toContain('id: 1\n');
    expect(replay.text).toContain('event: stream-end');
    const resumed = await request(app)
      .get(`/runs/${id}/events?after=0`)
      .set('Cookie', cookie)
      .set('Last-Event-ID', '2');
    expect(resumed.text).not.toContain('id: 1\n');
    expect(resumed.text).not.toContain('id: 2\n');
    expect(resumed.text).toContain('id: 3\n');
    expect(
      (
        await request(app)
          .get(`/runs/${id}/events`)
          .set('Cookie', cookie)
          .set('Last-Event-ID', '999')
      ).status,
    ).toBe(400);
    expect(
      (await request(app).get('/runs/not-a-uuid').set('Cookie', cookie)).status,
    ).toBe(400);
    expect(
      (await request(app).get(`/runs/${randomUUID()}`).set('Cookie', cookie))
        .status,
    ).toBe(404);
  }, 30000);
  it('allocates ordered sequences under concurrent appends and deduplicates checkpoint events', async () => {
    const run = await repository.create('test-user', {
      message: 'concurrent events',
    });
    await repository.append(
      run.id,
      { type: 'RUN_STARTED' },
      { key: 'started', status: 'running' },
    );
    await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.append(run.id, {
          type: 'STEP_STARTED',
          stepName: 'prepare',
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        repository.append(
          run.id,
          { type: 'STEP_FINISHED', stepName: 'prepare' },
          { key: 'prepare:finished' },
        ),
      ),
    );
    const events = await repository.events(run.id, 0);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    expect(
      events.filter((event) => event.type === 'STEP_FINISHED'),
    ).toHaveLength(1);
    expect((await repository.get(run.id))?.sequence).toBe(events.length);
    await expect(
      repository.append(
        run.id,
        { type: 'RUN_FINISHED', outcome: 'succeeded' },
        { status: 'queued' },
      ),
    ).rejects.toThrow('Invalid run transition');
  }, 30000);
});
