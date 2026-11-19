import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import { RunRepository, NotificationRepository } from '@unkillable/storage';
import {
  identitySchema,
  notificationConfigSchema,
  type Role,
} from '@unkillable/shared';
import { createExecutor } from '../../worker/src/executor';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { RunService } from './services/runs';
import { ApprovalService } from './services/approvals';
import { NotificationService } from './services/notifications';
import { ApprovalSigner } from './services/approval-signing';
import type { AuthService } from './services/auth';
import { HttpError } from './errors';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('approval notifications and signed decisions', () => {
  const mongo = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017'),
    db = mongo.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
  const runs = new RunRepository(mongo, db),
    memberships = new MongoMembershipRepository(db),
    queue = { add: vi.fn(async () => {}) },
    service = new RunService(runs, queue),
    approvals = new ApprovalService(runs.approvals(), service);
  const alice = randomUUID(),
    bob = randomUUID(),
    viewer = randomUUID(),
    origin = 'http://localhost:3000';
  const secret = 'local-notifications-test-secret-at-least-32';
  const config = notificationConfigSchema.parse({
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123:fake_local_token',
    TELEGRAM_BOT_USERNAME: 'unkillable_test_bot',
    TELEGRAM_WEBHOOK_SECRET: secret,
  });
  let now = Date.now();
  const store = new NotificationRepository(mongo, db, () => new Date(now)),
    signer = new ApprovalSigner(secret, () => now),
    transport = {
      call: vi.fn(
        async (_method: string, _body: Record<string, unknown>) => {},
      ),
    };
  const notifications = new NotificationService(
    store,
    approvals,
    service,
    memberships,
    signer,
    config,
    transport,
    () => now,
  );
  const disabled = new NotificationService(
    store,
    approvals,
    service,
    memberships,
    signer,
    notificationConfigSchema.parse({}),
    transport,
    () => now,
  );
  const auth = {
    me: async (headers: Headers) => {
      const id = headers.get('x-test-user');
      if (!id) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in');
      const member = await memberships.get(id);
      return identitySchema.parse({
        user: { id, name: 'Local reviewer', email: 'reviewer@example.test' },
        role: member?.role ?? 'viewer',
        workspaceId: 'local',
      });
    },
  } as unknown as AuthService;
  const app = createApp(
    { mongo: async () => true, redis: async () => true },
    [origin],
    'silent',
    auth,
    service,
    undefined,
    undefined,
    undefined,
    notifications,
  );
  const disabledApp = createApp(
    { mongo: async () => true, redis: async () => true },
    [origin],
    'silent',
    auth,
    service,
    undefined,
    undefined,
    undefined,
    disabled,
  );
  let executor: Awaited<ReturnType<typeof createExecutor>>;
  const actor = (id = alice, role: Role = 'admin') => ({ id, role });
  const token = (url: string) => new URL(url).hash.slice(1);
  const post = (path: string, body: object, id = alice) =>
    request(app)
      .post(`/notifications/${path}`)
      .set('Origin', origin)
      .set('x-test-user', id)
      .send(body);
  async function pending() {
    const run = await service.create(alice, {
      title: 'Local approval',
      message: 'Review this synthetic notice',
      requireApproval: true,
    });
    await executor.execute(run.id, 0);
    return {
      run: (await runs.get(run.id))!,
      approval: (await runs.approvals().forRun(run.id))!,
    };
  }
  async function fixture(name: string, from: string, to: string) {
    return JSON.parse(
      (
        await readFile(
          new URL(`./fixtures/${name}.json`, import.meta.url),
          'utf8',
        )
      ).replace(from, to),
    );
  }
  beforeAll(async () => {
    await mongo.connect();
    await bootstrapIndexes(db);
    await service.initialize();
    for (const [id, role] of [
      [alice, 'admin'],
      [bob, 'approver'],
      [viewer, 'viewer'],
    ] as const) {
      await memberships.ensureViewer(id);
      await memberships.setRole(id, role);
    }
    executor = await createExecutor(runs, uri!, db.databaseName, 0);
  }, 30000);
  afterAll(async () => {
    await executor?.close();
    await db.dropDatabase();
    await mongo.close();
  }, 30000);
  it('requires sessions, roles and Origin; web links work while Telegram is disabled', async () => {
    const { approval } = await pending();
    expect((await request(app).get('/notifications/settings')).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .get('/notifications/settings')
          .set('x-test-user', viewer)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/notifications/links/${approval.id}`)
          .set('x-test-user', alice)
          .send({})
      ).status,
    ).toBe(403);
    const settings = await request(disabledApp)
      .get('/notifications/settings')
      .set('x-test-user', alice);
    expect(settings.body.web).toBe(true);
    expect(settings.body.telegramAvailable).toBe(false);
    expect(
      (
        await request(disabledApp)
          .post('/notifications/telegram/link')
          .set('x-test-user', alice)
          .set('Origin', origin)
          .send({})
      ).status,
    ).toBe(404);
    const links = await disabled.links(actor(), approval.id);
    expect(new URL(links.approve).pathname).toBe('/approve');
    expect(new URL(links.approve).search).toBe('');
    expect(
      (await disabled.inspect(actor(), token(links.approve))).approval.status,
    ).toBe('pending');
  });
  it('previews without consuming, then atomically consumes one raced decision and resumes once', async () => {
    const { run, approval } = await pending();
    const links = await post(`links/${approval.id}`, {});
    expect(links.status).toBe(200);
    const signed = token(links.body.approve);
    for (let i = 0; i < 2; i++)
      expect((await post('links/inspect', { token: signed })).status).toBe(200);
    expect((await runs.get(run.id))!.status).toBe('waiting_approval');
    const responses = await Promise.all([
      post('links/resolve', { token: signed }),
      post('links/resolve', { token: signed }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(1);
    expect((await post('links/resolve', { token: signed })).status).toBe(409);
    const queued = (await runs.get(run.id))!;
    await executor.execute(run.id, queued.execution);
    await runs.reliability().dispatchOutbox();
    expect((await runs.get(run.id))!.status).toBe('succeeded');
    expect(
      await db.collection('localDeliveries').countDocuments({ runId: run.id }),
    ).toBe(1);
  }, 30000);
  it('rejects tampering, expiry, another reviewer and revoked membership without consuming a valid link', async () => {
    const { approval } = await pending();
    const signed = token(
      (await notifications.links(actor(), approval.id)).approve,
    );
    const [encoded, signature] = signed.split('.');
    const changed = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(encoded, 'base64url').toString()),
        action: 'reject',
      }),
    ).toString('base64url');
    expect(
      (await post('links/resolve', { token: `${changed}.${signature}` }))
        .status,
    ).toBe(400);
    expect((await post('links/resolve', { token: signed }, bob)).status).toBe(
      403,
    );
    await memberships.setRole(alice, 'viewer');
    expect((await post('links/resolve', { token: signed })).status).toBe(403);
    await memberships.setRole(alice, 'admin');
    const savedNow = now;
    now += (config.APPROVAL_LINK_TTL_SECONDS + 1) * 1000;
    expect((await post('links/resolve', { token: signed })).status).toBe(400);
    now = savedNow;
    expect((await post('links/inspect', { token: signed })).status).toBe(200);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(0);
  });
  it('serializes an inbox decision against a signed decision and rolls back losing token consumption', async () => {
    const { approval } = await pending();
    const signed = token(
      (await notifications.links(actor(), approval.id)).approve,
    );
    const results = await Promise.all([
      post('links/resolve', { token: signed }),
      request(app)
        .post(`/approvals/${approval.id}/resolve`)
        .set('Origin', origin)
        .set('x-test-user', bob)
        .send({ version: 0, decision: { action: 'approve' } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(1);
    const stored = await db.collection('approvalLinks').findOne({
      'payload.approvalId': approval.id,
      'payload.action': 'approve',
    });
    expect(stored?.used).toBe(results[0].status === 200);
  });
  it('retains two distinct reviewer rules and invalidates old-version links', async () => {
    const { run, approval } = await pending();
    await db
      .collection('approvals')
      .updateOne({ id: approval.id }, { $set: { requiredApprovals: 2 } });
    const first = token(
        (await notifications.links(actor(), approval.id)).approve,
      ),
      second = token(
        (await notifications.links(actor(bob, 'approver'), approval.id))
          .approve,
      );
    const edited = await request(app)
      .post(`/approvals/${approval.id}/resolve`)
      .set('Origin', origin)
      .set('x-test-user', alice)
      .send({
        version: 0,
        decision: {
          action: 'edit',
          payload: { message: 'Human corrected frozen notice' },
          reason: 'Use this exact wording',
        },
      });
    expect(edited.status).toBe(200);
    expect((await post('links/resolve', { token: first })).status).toBe(409);
    expect((await runs.get(run.id))!.status).toBe('waiting_approval');
    expect((await post('links/resolve', { token: second }, bob)).status).toBe(
      409,
    );
    const fresh = token(
      (await notifications.links(actor(bob, 'approver'), approval.id)).approve,
    );
    expect(
      (await notifications.inspect(actor(bob, 'approver'), fresh)).approval
        .proposedAction.message,
    ).toBe('Human corrected frozen notice');
    await notifications.resolve(actor(bob, 'approver'), fresh);
    expect((await runs.get(run.id))!.status).toBe('queued');
    expect(
      (await runs.approvals().get(approval.id))!.reviews.map((r) => r.actorId),
    ).toEqual([alice, bob]);
    const queued = (await runs.get(run.id))!;
    await executor.execute(run.id, queued.execution);
    expect((await runs.get(run.id))!.state.noticeMessage).toBe(
      'Human corrected frozen notice',
    );
  });
  it('authenticates webhook fixtures, pairs a private chat once and handles bound callback replay', async () => {
    const { run, approval } = await pending();
    const pairing = await notifications.pairing(actor());
    const code = new URL(pairing.url).searchParams.get('start')!;
    const start = await fixture('telegram-start', 'PAIR_CODE', code);
    expect(
      (await request(app).post('/notifications/telegram/webhook').send(start))
        .status,
    ).toBe(403);
    expect(
      (
        await request(disabledApp)
          .post('/notifications/telegram/webhook')
          .set('x-telegram-bot-api-secret-token', secret)
          .send(start)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/notifications/telegram/webhook')
          .set('x-telegram-bot-api-secret-token', secret)
          .send(start)
      ).status,
    ).toBe(200);
    expect((await notifications.settings(actor())).linked).toBe(true);
    await store.unlink(bob);
    const stolen = structuredClone(start);
    stolen.message.from.id = 222;
    stolen.message.chat.id = 222;
    await notifications.webhook(stolen);
    expect((await notifications.settings(actor())).linked).toBe(true);
    expect((await notifications.settings(actor(bob, 'approver'))).linked).toBe(
      false,
    );
    // Limit this delivery trial to its newly-created approval, avoiding prior test rows.
    await db
      .collection('approvals')
      .updateMany(
        { id: { $ne: approval.id }, status: 'pending' },
        { $set: { status: 'rejected' } },
      );
    transport.call.mockClear();
    await notifications.deliver();
    await notifications.deliver();
    const sends = transport.call.mock.calls.filter(
      ([method]) => method === 'sendMessage',
    );
    expect(sends).toHaveLength(1);
    const markup = sends[0][1].reply_markup as {
      inline_keyboard: { callback_data?: string; url?: string }[][];
    };
    expect(markup.inline_keyboard[1][0].url).toContain(
      `/approvals#approval-${approval.id}`,
    );
    const callback = await fixture(
      'telegram-callback',
      'LINK_ID',
      markup.inline_keyboard[0][0].callback_data!.slice(9),
    );
    const forged = structuredClone(callback);
    forged.callback_query.from.id = 222;
    forged.callback_query.message.chat.id = 222;
    await notifications.webhook(forged);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(0);
    await memberships.setRole(alice, 'viewer');
    await notifications.webhook(callback);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(0);
    await memberships.setRole(alice, 'admin');
    const accepted = await request(app)
      .post('/notifications/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', secret)
      .send(callback);
    expect(accepted.status).toBe(200);
    await notifications.webhook(callback);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(1);
    const queued = (await runs.get(run.id))!;
    await executor.execute(run.id, queued.execution);
    expect((await runs.get(run.id))!.status).toBe('succeeded');
  }, 30000);
  it('enforces unlinking, pair expiry and admin-only moderation through every channel', async () => {
    await notifications.unlink(actor());
    expect((await notifications.settings(actor())).linked).toBe(false);
    const pairing = await notifications.pairing(actor()),
      saved = now;
    now += 600001;
    await notifications.webhook(
      await fixture(
        'telegram-start',
        'PAIR_CODE',
        new URL(pairing.url).searchParams.get('start')!,
      ),
    );
    now = saved;
    expect((await notifications.settings(actor())).linked).toBe(false);
    const { approval } = await pending();
    await db
      .collection('approvals')
      .updateOne(
        { id: approval.id },
        { $set: { 'proposedAction.kind': 'moderation' } },
      );
    expect((await post(`links/${approval.id}`, {}, bob)).status).toBe(403);
    const signed = token(
      (await notifications.links(actor(), approval.id)).approve,
    );
    await memberships.setRole(alice, 'approver');
    expect((await post('links/resolve', { token: signed })).status).toBe(403);
    await memberships.setRole(alice, 'admin');
  });
  it('keeps notification delivery recoverable without duplicating normal sends', async () => {
    const { approval } = await pending();
    await db
      .collection('approvals')
      .updateMany(
        { id: { $ne: approval.id }, status: 'pending' },
        { $set: { status: 'rejected' } },
      );
    const pairing = await notifications.pairing(actor());
    await notifications.webhook(
      await fixture(
        'telegram-start',
        'PAIR_CODE',
        new URL(pairing.url).searchParams.get('start')!,
      ),
    );
    transport.call.mockClear();
    transport.call.mockRejectedValueOnce(
      new Error('Local fake transport outage'),
    );
    await expect(notifications.deliver()).rejects.toThrow(
      'Local fake transport outage',
    );
    const saved = now;
    now += 60001;
    await notifications.deliver();
    now = saved;
    await notifications.deliver();
    expect(
      transport.call.mock.calls.filter(([method]) => method === 'sendMessage'),
    ).toHaveLength(2);
    expect(
      (
        await db
          .collection('approvalNotifications')
          .findOne({ approvalId: approval.id })
      )?.status,
    ).toBe('sent');
  });
});
