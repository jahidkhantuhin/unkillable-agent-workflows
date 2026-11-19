import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import request from 'supertest';
import { RunRepository, OperationsRepository } from '@unkillable/storage';
import { identitySchema } from '@unkillable/shared';
import { createExecutor } from '../../worker/src/executor';
import { bootstrapIndexes } from './repositories/indexes';
import { RunService } from './services/runs';
import { createApp } from './app';
import { startApprovalTimers } from './services/approval-timers';
import type { AuthService } from './services/auth';
import { HttpError } from './errors';
const uri = process.env.INTEGRATION_MONGODB_URI,
  redisUrl = process.env.INTEGRATION_REDIS_URL;
describe.skipIf(!uri || !redisUrl)(
  'SLA timers, escalation, usage and latency',
  () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017'),
      db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`),
      runs = new RunRepository(client, db),
      service = new RunService(runs, { add: vi.fn(async () => {}) });
    let now = new Date(),
      executor: Awaited<ReturnType<typeof createExecutor>>;
    const operations = new OperationsRepository(client, db, () => now),
      actor = randomUUID();
    const auth = {
      me: async (headers: Headers) => {
        const role = headers.get('x-test-role');
        if (!role) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in');
        return identitySchema.parse({
          user: { id: actor, name: 'Local test', email: 'sla@example.test' },
          role,
          workspaceId: 'local',
        });
      },
    } as unknown as AuthService;
    const app = createApp(
      { mongo: async () => true, redis: async () => true },
      ['http://localhost:3000'],
      'silent',
      auth,
      service,
    );
    async function pending() {
      const run = await service.create(actor, {
        title: 'SLA local test',
        message: 'Synthetic notice',
        requireApproval: true,
      });
      await executor.execute(run.id, 0);
      return { run, approval: (await runs.approvals().forRun(run.id))! };
    }
    beforeAll(async () => {
      await client.connect();
      await bootstrapIndexes(db);
      await service.initialize();
      executor = await createExecutor(runs, uri!, db.databaseName, 0);
    }, 30000);
    afterAll(async () => {
      await executor?.close();
      await db.dropDatabase();
      await client.close();
    }, 30000);
    it('reminds once, escalates to the configured role group and resets only their channel claims', async () => {
      const { run, approval: a } = await pending();
      const admin = randomUUID(),
        approver = randomUUID();
      await db.collection('memberships').insertMany([
        { userId: admin, workspaceId: 'local', role: 'admin' },
        { userId: approver, workspaceId: 'local', role: 'approver' },
      ]);
      await db.collection('approvalNotifications').insertMany(
        [admin, approver].map((userId) => ({
          approvalId: a.id,
          version: 0,
          userId,
          status: 'sent',
          attempts: 1,
          nextAt: new Date(0),
        })),
      );
      now = new Date(+a.sla!.remindAt - 1);
      expect(
        await operations.timer({ approvalId: a.id, stage: 'remind' }),
      ).toBe(false);
      now = a.sla!.remindAt;
      expect(
        await operations.timer({ approvalId: a.id, stage: 'remind' }),
      ).toBe(true);
      expect(
        await operations.timer({ approvalId: a.id, stage: 'remind' }),
      ).toBe(false);
      await db
        .collection('approvalNotifications')
        .updateMany({ approvalId: a.id }, { $set: { status: 'sent' } });
      now = a.sla!.escalateAt;
      expect(
        await operations.timer({ approvalId: a.id, stage: 'escalate' }),
      ).toBe(true);
      expect(
        (await db
          .collection('approvalNotifications')
          .findOne({ approvalId: a.id, userId: admin }))!.status,
      ).toBe('pending');
      expect(
        (await db
          .collection('approvalNotifications')
          .findOne({ approvalId: a.id, userId: approver }))!.status,
      ).toBe('sent');
      expect((await runs.approvals().get(a.id))!.sla!.escalatedAt).toEqual(now);
      expect((await runs.get(run.id))!.status).toBe('waiting_approval');
    });
    it('auto-rejects at the deadline exactly once and resumes only the rejection path', async () => {
      const { run, approval: a } = await pending();
      now = a.sla!.expireAt;
      const results = await Promise.all([
        operations.timer({ approvalId: a.id, stage: 'expire' }),
        operations.timer({ approvalId: a.id, stage: 'expire' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await runs.approvals().get(a.id))!.resolvedBy).toBe('system:sla');
      const queued = (await runs.get(run.id))!;
      await executor.execute(run.id, queued.execution);
      await runs.reliability().dispatchOutbox();
      expect(
        await db
          .collection('localDeliveries')
          .countDocuments({ runId: run.id }),
      ).toBe(0);
      expect(
        await operations.timer({ approvalId: a.id, stage: 'remind' }),
      ).toBe(false);
    });
    it('cancels without queuing effects and rejects late manual votes', async () => {
      const { run, approval: a } = await pending();
      await db.collection('approvals').updateOne(
        { id: a.id },
        {
          $set: {
            'sla.timeoutAction': 'cancel',
            'sla.expireAt': new Date(Date.now() - 1),
          },
        },
      );
      await expect(
        runs.approvals().resolve(a.id, a.version, { action: 'approve' }, actor),
      ).rejects.toThrow();
      now = new Date();
      expect(
        await operations.timer({ approvalId: a.id, stage: 'expire' }),
      ).toBe(true);
      expect((await runs.get(run.id))!.status).toBe('cancelled');
      expect(
        await operations.timer({ approvalId: a.id, stage: 'expire' }),
      ).toBe(false);
    });
    it('cannot override a human decision when a timer races it', async () => {
      const { run, approval: a } = await pending();
      now = a.sla!.expireAt;
      await Promise.allSettled([
        runs.approvals().resolve(a.id, a.version, { action: 'approve' }, actor),
        operations.timer({ approvalId: a.id, stage: 'expire' }),
      ]);
      const resolved = (await runs.approvals().get(a.id))!;
      expect(['approved', 'rejected']).toContain(resolved.status);
      expect(resolved.reviews).toHaveLength(1);
      expect((await runs.get(run.id))!.execution).toBe(1);
      expect(
        await operations.timer({ approvalId: a.id, stage: 'expire' }),
      ).toBe(false);
    });
    it('serves protected metrics and aggregates persisted usage with unknown cost preserved', async () => {
      const { run, approval: a } = await pending();
      await runs
        .approvals()
        .resolve(a.id, a.version, { action: 'approve' }, actor);
      await executor.execute(run.id, (await runs.get(run.id))!.execution);
      await operations.usage({
        id: randomUUID(),
        runId: run.id,
        execution: 0,
        nodeId: 'classify',
        attempt: 1,
        provider: 'fixture',
        model: 'fixture',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.002,
        at: new Date(),
      });
      await operations.usage({
        id: randomUUID(),
        runId: run.id,
        execution: 0,
        nodeId: 'draft',
        attempt: 1,
        provider: 'fixture',
        model: 'fixture',
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        at: new Date(),
      });
      expect((await request(app).get(`/runs/${run.id}/metrics`)).status).toBe(
        401,
      );
      const response = await request(app)
        .get(`/runs/${run.id}/metrics`)
        .set('x-test-role', 'viewer');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.knownCostUsd).toBe(0.002);
      expect(response.body.unpricedCalls).toBe(1);
      expect(response.body.spans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: 'approval.wait' }),
          expect.objectContaining({ nodeId: 'prepare' }),
        ]),
      );
      expect(
        (
          await request(app)
            .get('/analytics/costs')
            .set('x-test-role', 'viewer')
        ).status,
      ).toBe(403);
      const costs = await request(app)
        .get('/analytics/costs')
        .set('x-test-role', 'admin');
      expect(costs.status).toBe(200);
      expect(costs.body.workflows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workflowId: 'durability-demo',
            knownCostUsd: 0.002,
            unpricedCalls: 1,
          }),
        ]),
      );
    });
    it('reconciles persisted deadlines into delayed BullMQ jobs after timer-process restart', async () => {
      const { approval: a } = await pending();
      const base = Date.now();
      await db.collection('approvals').updateOne(
        { id: a.id },
        {
          $set: {
            'sla.remindAt': new Date(base + 2000),
            'sla.escalateAt': new Date(base + 4000),
            'sla.expireAt': new Date(base + 6000),
          },
        },
      );
      const namespace = `sla-test-${randomUUID()}`,
        errors: unknown[] = [],
        real = new OperationsRepository(client, db);
      let timers = startApprovalTimers(
        real,
        new Redis(redisUrl!, { maxRetriesPerRequest: null }),
        namespace,
        (error) => errors.push(error),
      );
      try {
        await timers.reconcile();
        const job = await timers.queue.getJob(`${a.id}-remind`);
        expect(job).not.toBeNull();
        expect(await job!.getState()).toBe('delayed');
        await timers.close();
        timers = startApprovalTimers(
          real,
          new Redis(redisUrl!, { maxRetriesPerRequest: null }),
          namespace,
          (error) => errors.push(error),
        );
        const end = Date.now() + 15000;
        while (
          Date.now() < end &&
          !(await runs.approvals().get(a.id))!.sla!.remindedAt
        )
          await delay(50);
        expect(
          (await runs.approvals().get(a.id))!.sla!.remindedAt,
        ).toBeDefined();
        expect(errors).toEqual([]);
      } finally {
        await timers.queue.obliterate({ force: true });
        await timers.close();
      }
    }, 30000);
  },
);
