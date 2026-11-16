import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MongoClient, ObjectId } from 'mongodb';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository } from '@unkillable/storage';
import {
  supportExamples,
  ticketInputSchema,
  supportConfigSchema,
  type ApprovalPolicy,
} from '@unkillable/shared';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { createApp } from './app';
import { createExecutor } from '../../worker/src/executor';
import { supportDependencies } from '../../worker/src/support-adapters';
const uri = process.env.INTEGRATION_MONGODB_URI;
function ticket(index: number, amount?: number) {
  const e = supportExamples[index];
  return ticketInputSchema.parse({
    title: e.title,
    description: e.description,
    customerEmail: e.customerEmail,
    orderId: e.orderId,
    amountCents: amount ?? e.amountCents,
    currency: e.currency,
  });
}
describe.skipIf(!uri)('versioned approval policies', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const databases: string[] = [];
  const origin = 'http://localhost:3000';
  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    for (const name of databases) await client.db(name).dropDatabase();
    await client.close();
  });
  async function setup() {
    const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
    databases.push(db.databaseName);
    await bootstrapIndexes(db);
    const runs = new RunRepository(client, db),
      members = new MongoMembershipRepository(db);
    const service = new RunService(runs, { add: async () => ({}) });
    await service.initialize();
    const auth = createAuth(
      memoryAdapter({
        users: [],
        sessions: [],
        accounts: [],
        verifications: [],
      }),
      members,
      {
        secret: 'policy-integration-test-secret-at-least-32-chars',
        baseURL: 'http://localhost:4000',
        trustedOrigins: [origin],
        test: true,
      },
    );
    const app = createApp(
      { mongo: async () => true, redis: async () => true },
      [origin],
      'silent',
      new AuthService(auth, members, 'http://localhost:4000'),
      service,
    );
    const accounts: { id: string; cookie: string }[] = [];
    for (const role of ['admin', 'approver', 'viewer'] as const) {
      const response = await request(app)
        .post('/auth/register')
        .set('Origin', origin)
        .send({
          name: role,
          email: `${role}@example.test`,
          password: 'policy-local-test-password',
        });
      expect(response.status).toBe(201);
      await members.setRole(response.body.user.id, role);
      accounts.push({
        id: response.body.user.id,
        cookie: (response.headers['set-cookie'] as unknown as string[])
          .map((v) => v.split(';')[0])
          .join('; '),
      });
    }
    const [admin, approver, viewer] = accounts;
    const post = (path: string, body: object, cookie = admin.cookie) =>
      request(app)
        .post(path)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send(body);
    return { db, runs, app, admin, approver, viewer, post };
  }
  const sample: ApprovalPolicy = {
    name: 'Test rules',
    rules: [
      {
        id: 'large',
        when: { minAmountCents: 10000 },
        outcome: 'require_two_approvals',
        reason: 'Large refund needs two people',
      },
      {
        id: 'safe',
        when: { riskTier: 'low', maxAmountCents: 0, minConfidence: 0.95 },
        outcome: 'auto_approve',
        reason: 'Safe reply',
      },
    ],
    fallback: 'require_approval',
  };
  it('enforces roles/origin, saves immutable versions, rejects stale updates and dry-runs without writes', async () => {
    const { db, runs, app, admin, approver, viewer, post } = await setup();
    expect((await request(app).get('/policies')).status).toBe(401);
    for (const actor of [approver, viewer]) {
      expect(
        (await request(app).get('/policies').set('Cookie', actor.cookie))
          .status,
      ).toBe(403);
      expect(
        (
          await post(
            '/policies',
            { expectedVersion: 0, policy: sample },
            actor.cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (await post('/policies/dry-run', { policy: sample }, actor.cookie))
          .status,
      ).toBe(403);
      expect(
        (await request(app).get('/analytics').set('Cookie', actor.cookie))
          .status,
      ).toBe(403);
    }
    expect(
      (
        await request(app)
          .post('/policies')
          .set('Cookie', admin.cookie)
          .send({ expectedVersion: 0, policy: sample })
      ).status,
    ).toBe(403);
    const run = await runs.createSupport(admin.id, ticket(2));
    const inputs = {
      action: 'support_reply' as const,
      riskTier: 'low' as const,
      amountCents: 0,
      confidence: 0.98,
      customerTier: 'standard' as const,
      hourUtc: 12,
    };
    const concurrent = await Promise.all([
      runs.policies().decide(run.id, inputs),
      runs.policies().decide(run.id, inputs),
    ]);
    expect(concurrent[0]).toEqual(concurrent[1]);
    expect(
      await db.collection('policyDecisions').countDocuments({ runId: run.id }),
    ).toBe(1);
    const before = await db.collection('runEvents').countDocuments();
    const trial = await post('/policies/dry-run', { policy: sample });
    expect(trial.status).toBe(200);
    expect(trial.body.results[0]).toMatchObject({
      before: 'require_approval',
      after: 'auto_approve',
      changed: true,
    });
    expect(await db.collection('runEvents').countDocuments()).toBe(before);
    expect((await runs.policies().current()).version).toBe(0);
    expect(
      (await post('/policies', { expectedVersion: 0, policy: sample })).status,
    ).toBe(200);
    expect(
      (await post('/policies', { expectedVersion: 0, policy: sample })).status,
    ).toBe(409);
    expect(
      (
        await post('/policies', {
          expectedVersion: 1,
          policy: { ...sample, arbitrary: true },
        })
      ).status,
    ).toBe(400);
    expect(await runs.policies().decide(run.id, inputs)).toMatchObject({
      version: 0,
      outcome: 'require_approval',
    });
    expect(await runs.policies().history()).toHaveLength(1);
  });
  it('runs safe replies automatically, pins decisions, and requires two distinct reviews of the same edited content', async () => {
    const { runs, db, admin, approver, post } = await setup();
    await runs.policies().save(0, sample, admin.id);
    const delivered: string[] = [];
    const deps = supportDependencies(
      runs,
      supportConfigSchema.parse({ SUPPORT_LLM_PROVIDER: 'mock' }),
      async (mail) => {
        delivered.push(mail.text);
      },
    );
    const executor = await createExecutor(
      runs,
      uri!,
      db.databaseName,
      0,
      {},
      deps,
    );
    try {
      const auto = await runs.createSupport(admin.id, ticket(2));
      await executor.execute(auto.id, 0);
      expect((await runs.get(auto.id))?.status).toBe('succeeded');
      expect(await runs.approvals().forRun(auto.id)).toBeNull();
      expect(delivered).toHaveLength(1);
      const run = await runs.createSupport(admin.id, ticket(0, 15000));
      await executor.execute(run.id, 0);
      const approval = (await runs.approvals().forRun(run.id))!;
      expect(approval.requiredApprovals).toBe(2);
      expect((await runs.get(run.id))?.status).toBe('waiting_approval');
      await runs.policies().save(
        1,
        {
          name: 'Changed while waiting',
          rules: [],
          fallback: 'auto_approve',
        },
        admin.id,
      );
      expect(
        (
          await post(`/approvals/${approval.id}/resolve`, {
            version: 0,
            decision: {
              action: 'edit',
              payload: { message: 'Two humans reviewed this reply' },
              reason: 'Clarified the customer reply',
            },
          })
        ).status,
      ).toBe(200);
      expect((await runs.get(run.id))?.status).toBe('waiting_approval');
      expect(delivered).toHaveLength(1);
      expect(
        (
          await post(`/approvals/${approval.id}/resolve`, {
            version: 1,
            decision: { action: 'approve' },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await post(
            `/approvals/${approval.id}/resolve`,
            {
              version: 1,
              decision: {
                action: 'edit',
                payload: { message: 'Changed behind first reviewer' },
              },
            },
            approver.cookie,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await post(
            `/approvals/${approval.id}/resolve`,
            { version: 1, decision: { action: 'approve' } },
            approver.cookie,
          )
        ).status,
      ).toBe(200);
      expect((await runs.approvals().forRun(run.id))?.decision).toMatchObject({
        action: 'edit',
        payload: { message: 'Two humans reviewed this reply' },
      });
      await executor.execute(run.id, 1);
      await executor.execute(run.id, 1);
      expect((await runs.get(run.id))?.status).toBe('succeeded');
      expect(delivered).toEqual([
        expect.any(String),
        'Two humans reviewed this reply',
      ]);
      expect(
        await db.collection('fakeRefunds').countDocuments({ runId: run.id }),
      ).toBe(1);
      expect((await runs.get(run.id))?.state.policyDecision).toMatchObject({
        version: 1,
        requiredApprovals: 2,
      });
      const analytics = await runs.policies().analytics();
      expect(analytics).toMatchObject({
        evaluated: 2,
        humanRequired: 1,
        autoApproved: 1,
        resolved: 1,
        edited: 1,
        humanApprovalRate: 0.5,
        editRate: 1,
        approvedSamples: 1,
      });
      expect(analytics.feedback[0]).toMatchObject({
        reason: 'Clarified the customer reply',
        edited: 'Two humans reviewed this reply',
      });
    } finally {
      await executor.close();
    }
  }, 60000);
  it('serializes racing reviews and permits rejection before the second approval without effects', async () => {
    const { db, runs, admin, approver, post } = await setup();
    await runs
      .policies()
      .save(
        0,
        { name: 'Dual', rules: [], fallback: 'require_two_approvals' },
        admin.id,
      );
    const executor = await createExecutor(
      runs,
      uri!,
      db.databaseName,
      0,
      {},
      supportDependencies(runs, supportConfigSchema.parse({}), async () => {}),
    );
    try {
      const run = await runs.createSupport(admin.id, ticket(0));
      await executor.execute(run.id, 0);
      const approval = (await runs.approvals().forRun(run.id))!;
      const results = await Promise.all([
        post(`/approvals/${approval.id}/resolve`, {
          version: 0,
          decision: { action: 'approve' },
        }),
        post(
          `/approvals/${approval.id}/resolve`,
          { version: 0, decision: { action: 'approve' } },
          approver.cookie,
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const reviewed = (await runs.approvals().forRun(run.id))!;
      expect(reviewed.reviews).toHaveLength(1);
      const remaining =
        reviewed.reviews[0].actorId === admin.id ? approver : admin;
      expect(
        (
          await post(
            `/approvals/${approval.id}/resolve`,
            {
              version: 1,
              decision: {
                action: 'reject',
                reason: 'Refund eligibility needs investigation',
              },
            },
            remaining.cookie,
          )
        ).status,
      ).toBe(200);
      await executor.execute(run.id, 1);
      expect((await runs.get(run.id))?.status).toBe('cancelled');
      expect(await db.collection('fakeRefunds').countDocuments()).toBe(0);
      expect(await db.collection('fakeEmails').countDocuments()).toBe(0);
      expect(await runs.policies().analytics()).toMatchObject({
        rejected: 1,
        medianTimeToApproveMs: null,
        rejectionReasons: [
          { reason: 'Refund eligibility needs investigation', count: 1 },
        ],
      });
    } finally {
      await executor.close();
    }
  }, 60000);
  it('computes exact analytics denominators, median approval time and UTC daily shares', async () => {
    const { db, runs, admin } = await setup();
    const inputs = {
      action: 'support_reply' as const,
      riskTier: 'low' as const,
      amountCents: 0,
      confidence: 0.98,
      customerTier: 'standard' as const,
      hourUtc: 12,
    };
    for (let i = 0; i < 3; i++) {
      const run = await runs.createSupport(admin.id, ticket(2));
      await runs.policies().decide(run.id, inputs);
      await runs.append(run.id, { type: 'RUN_STARTED' }, { status: 'running' });
      await runs
        .approvals()
        .request(run.id, 0, 'test-checkpoint', 'Original reply');
      const approval = (await runs.approvals().forRun(run.id))!;
      await runs.approvals().resolve(
        approval.id,
        0,
        i === 0
          ? { action: 'approve' }
          : i === 1
            ? {
                action: 'edit',
                payload: { message: 'Improved reply' },
                reason: 'Clarity',
              }
            : { action: 'reject', reason: 'Insufficient evidence' },
        admin.id,
      );
      await db.collection('approvals').updateOne(
        { id: approval.id },
        {
          $set: {
            createdAt: new Date('2026-11-01T12:00:00Z'),
            resolvedAt: new Date(
              Date.parse('2026-11-01T12:00:00Z') + (i === 0 ? 1000 : 3000),
            ),
          },
        },
      );
      await db
        .collection('policyDecisions')
        .updateOne(
          { runId: run.id },
          { $set: { createdAt: new Date('2026-11-01T12:00:00Z') } },
        );
    }
    await runs
      .policies()
      .save(
        0,
        { name: 'Safe only', rules: [], fallback: 'auto_approve' },
        admin.id,
      );
    const auto = await runs.createSupport(admin.id, ticket(2));
    await runs.policies().decide(auto.id, inputs);
    await db
      .collection('policyDecisions')
      .updateOne(
        { runId: auto.id },
        { $set: { createdAt: new Date('2026-11-02T12:00:00Z') } },
      );
    const reviewerId = new ObjectId();
    await db.collection('users').insertMany([
      { _id: reviewerId, name: 'Named reviewer', email: 'named@example.test' },
      {
        _id: new ObjectId(),
        id: admin.id,
        name: 'Local admin',
        email: 'local-admin@example.test',
      },
    ]);
    await db
      .collection('approvals')
      .updateOne(
        { status: 'edited' },
        { $set: { 'reviews.0.actorId': reviewerId.toHexString() } },
      );
    const metrics = await runs.policies().analytics();
    expect((await runs.policies().history())[0]).toMatchObject({
      actorId: admin.id,
      actorName: 'Local admin',
    });
    expect(metrics.feedback.find((f) => f.action === 'edit')).toMatchObject({
      reviewerName: 'Named reviewer',
      actorId: reviewerId.toHexString(),
      title: ticket(2).title,
    });
    expect(metrics.feedback.find((f) => f.action === 'reject')).toMatchObject({
      reviewerName: 'Local admin',
      actorId: admin.id,
    });
    await db.collection('users').deleteOne({ _id: reviewerId });
    await db.collection('users').deleteOne({ id: admin.id });
    expect((await runs.policies().history())[0]).toMatchObject({
      actorId: admin.id,
      actorName: null,
    });
    expect(
      (await runs.policies().analytics()).feedback.find(
        (f) => f.action === 'edit',
      ),
    ).toMatchObject({ reviewerName: null, actorId: reviewerId.toHexString() });
    expect(metrics).toMatchObject({
      evaluated: 4,
      humanRequired: 3,
      autoApproved: 1,
      humanApprovalRate: 0.75,
      resolved: 3,
      edited: 1,
      rejected: 1,
      editRate: 1 / 3,
      approvedSamples: 2,
      medianTimeToApproveMs: 2000,
    });
    expect(metrics.daily).toEqual([
      {
        date: '2026-11-01',
        evaluated: 3,
        autoApproved: 0,
        autoApprovedShare: 0,
      },
      {
        date: '2026-11-02',
        evaluated: 1,
        autoApproved: 1,
        autoApprovedShare: 1,
      },
    ]);
  });
});
