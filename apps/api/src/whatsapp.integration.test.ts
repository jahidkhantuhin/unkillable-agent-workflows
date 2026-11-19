import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { MongoClient } from 'mongodb';
import {
  RunRepository,
  NotificationRepository,
  WhatsAppRepository,
} from '@unkillable/storage';
import { identitySchema, notificationConfigSchema } from '@unkillable/shared';
import { createExecutor } from '../../worker/src/executor';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { RunService } from './services/runs';
import { ApprovalService } from './services/approvals';
import { NotificationService } from './services/notifications';
import { ApprovalSigner } from './services/approval-signing';
import { WhatsAppService } from './services/whatsapp';
import type { AuthService } from './services/auth';
import { HttpError } from './errors';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('WhatsApp signed callbacks and local approvals', () => {
  const mongo = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017'),
    db = mongo.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
  const runs = new RunRepository(mongo, db),
    memberships = new MongoMembershipRepository(db),
    queue = { add: vi.fn(async () => {}) },
    runsService = new RunService(runs, queue);
  const alice = randomUUID(),
    viewer = randomUUID(),
    origin = 'http://localhost:3000',
    phone = 'whatsapp:+15550001111';
  let now = Date.now();
  const config = notificationConfigSchema.parse({
    WHATSAPP_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'b'.repeat(32),
    WHATSAPP_WEBHOOK_URL: 'https://local.example.test/api/whatsapp/webhook',
  });
  const approvals = new ApprovalService(runs.approvals(), runsService),
    notifications = new NotificationService(
      new NotificationRepository(mongo, db, () => new Date(now)),
      approvals,
      runsService,
      memberships,
      new ApprovalSigner('local-whatsapp-test-secret-at-least-32', () => now),
      config,
      { call: vi.fn(async () => {}) },
      () => now,
    );
  const store = new WhatsAppRepository(mongo, db, () => new Date(now)),
    transport = {
      send: vi.fn(async (_to: string, _text: string) => ({
        sid: `SM${randomUUID().replaceAll('-', '')}`,
        status: 'queued',
      })),
    },
    whatsapp = new WhatsAppService(
      store,
      notifications,
      config,
      transport,
      () => now,
    );
  const auth = {
    me: async (headers: Headers) => {
      const id = headers.get('x-test-user');
      if (!id) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in');
      return identitySchema.parse({
        user: { id, name: 'Local reviewer', email: 'reviewer@example.test' },
        role: (await memberships.get(id))?.role ?? 'viewer',
        workspaceId: 'local',
      });
    },
  } as unknown as AuthService;
  const app = createApp(
    { mongo: async () => true, redis: async () => true },
    [origin],
    'silent',
    auth,
    runsService,
    undefined,
    undefined,
    undefined,
    notifications,
    whatsapp,
  );
  let executor: Awaited<ReturnType<typeof createExecutor>>;
  const actor = { id: alice, role: 'admin' as const };
  const post = (path: string, id = alice) =>
    request(app)
      .post(`/notifications/whatsapp/${path}`)
      .set('Origin', origin)
      .set('x-test-user', id)
      .send({});
  function form(
    body: string,
    from = phone,
    sid = `SM${randomUUID().replaceAll('-', '')}`,
  ) {
    return {
      AccountSid: config.TWILIO_ACCOUNT_SID,
      MessageSid: sid,
      From: from,
      To: config.TWILIO_WHATSAPP_FROM,
      Body: body,
    };
  }
  function callback(
    params: Record<string, string>,
    status = false,
    valid = true,
  ) {
    const path = status ? 'status' : 'webhook',
      url = config.WHATSAPP_WEBHOOK_URL.replace(/webhook$/, path);
    const data =
      url +
      Object.keys(params)
        .sort()
        .map((key) => key + params[key])
        .join('');
    const signature = createHmac('sha1', config.TWILIO_AUTH_TOKEN)
      .update(data)
      .digest('base64');
    return request(app)
      .post(`/notifications/whatsapp/${path}`)
      .type('form')
      .set('X-Twilio-Signature', valid ? signature : 'invalid')
      .send(params);
  }
  async function link() {
    const response = await post('link');
    expect(response.status).toBe(200);
    const inbound = form(response.body.command);
    expect((await callback(inbound)).text).toContain('WhatsApp linked');
    return inbound;
  }
  async function pending() {
    const run = await runsService.create(alice, {
      title: 'Synthetic WhatsApp test',
      message: 'Review local notice',
      requireApproval: true,
    });
    await executor.execute(run.id, 0);
    return { run, approval: (await runs.approvals().forRun(run.id))! };
  }
  beforeAll(async () => {
    await mongo.connect();
    await bootstrapIndexes(db);
    await runsService.initialize();
    for (const [id, role] of [
      [alice, 'admin'],
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
  it('requires session, reviewer role, Origin, form encoding and exact signed fields', async () => {
    expect(
      (await request(app).get('/notifications/whatsapp/settings')).status,
    ).toBe(401);
    expect((await post('link', viewer)).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/notifications/whatsapp/link')
          .set('x-test-user', alice)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/notifications/whatsapp/webhook')
          .send(form('HELLO'))
      ).status,
    ).toBe(415);
    expect((await callback(form('HELLO'), false, false)).status).toBe(403);
    expect(
      (await callback({ ...form('HELLO'), AccountSid: `AC${'c'.repeat(32)}` }))
        .status,
    ).toBe(403);
    expect(
      (await callback({ ...form('HELLO'), To: 'whatsapp:+15550009999' }))
        .status,
    ).toBe(403);
  });
  it('pairs only through a signed inbound message and masks the linked phone', async () => {
    await link();
    const settings = await whatsapp.settings(actor);
    expect(settings.linked).toBe(true);
    expect(settings.phoneMasked).toBe('•••• 1111');
    expect(settings.windowOpen).toBe(true);
    const pairing = await whatsapp.pairing(actor);
    now += 600001;
    expect((await callback(form(pairing.command))).text).not.toContain(
      'WhatsApp linked',
    );
  });
  it('records one native approval, rejects other phones and stale codes, and resumes the local run', async () => {
    const { run, approval } = await pending();
    await whatsapp.deliver();
    const calls = transport.send.mock.calls;
    const text = calls[calls.length - 1][1];
    const code = /APPROVE ([A-Za-z0-9_-]{12})/.exec(text)![1];
    expect(
      (await callback(form(`APPROVE ${code}`, 'whatsapp:+15550002222'))).text,
    ).not.toContain('Review recorded');
    const inbound = form(`APPROVE ${code}`);
    const response = await callback(inbound);
    expect(response.text).toContain('Review recorded');
    expect((await callback(inbound)).text).toBe(response.text);
    expect((await callback(form(`APPROVE ${code}`))).text).not.toContain(
      'Review recorded',
    );
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(1);
    await executor.execute(run.id, (await runs.get(run.id))!.execution);
    expect((await runs.get(run.id))!.status).toBe('succeeded');
    await runs.reliability().dispatchOutbox();
    expect(
      await db.collection('localDeliveries').countDocuments({ runId: run.id }),
    ).toBe(1);
  });
  it('allows only one vote when web and WhatsApp race for the same reviewer', async () => {
    const { approval } = await pending();
    await whatsapp.deliver();
    const code = /APPROVE ([A-Za-z0-9_-]{12})/.exec(
      transport.send.mock.calls.at(-1)![1],
    )![1];
    const signed = new URL(
      (await notifications.links(actor, approval.id)).approve,
    ).hash.slice(1);
    await Promise.allSettled([
      notifications.resolve(actor, signed),
      callback(form(`APPROVE ${code}`)).then((response) => response),
    ]);
    expect((await runs.approvals().get(approval.id))!.reviews).toHaveLength(1);
  });
  it('rejects natively and checks current membership before accepting an approval', async () => {
    const { approval } = await pending();
    await whatsapp.deliver();
    const text = transport.send.mock.calls.at(-1)![1],
      code = /REJECT ([A-Za-z0-9_-]{12})/.exec(text)![1];
    await memberships.setRole(alice, 'viewer');
    expect((await callback(form(`APPROVE ${code}`))).text).not.toContain(
      'Review recorded',
    );
    await memberships.setRole(alice, 'admin');
    expect((await callback(form(`REJECT ${code}`))).text).toContain(
      'Review recorded',
    );
    expect((await runs.approvals().get(approval.id))!.status).toBe('rejected');
  });
  it('honors pause, start and unlink without changing Telegram preferences', async () => {
    await callback(form('STOP'));
    expect((await whatsapp.settings(actor)).enabled).toBe(false);
    await callback(form('START'));
    expect((await whatsapp.settings(actor)).enabled).toBe(true);
    await callback(form('UNLINK'));
    expect((await whatsapp.settings(actor)).linked).toBe(false);
    await link();
  });
  it('does not reopen the 24-hour window when an old signed inbound request is replayed', async () => {
    const inbound = form('HELLO');
    await callback(inbound);
    now += 25 * 3600000;
    await callback(inbound);
    expect((await whatsapp.settings(actor)).windowOpen).toBe(false);
    await expect(whatsapp.test(actor)).rejects.toThrow('24-hour');
    await callback(form('HELLO'));
    expect((await whatsapp.settings(actor)).windowOpen).toBe(true);
  });
  it('limits manual sends and preserves delivered status against delayed queued callbacks', async () => {
    await whatsapp.test(actor);
    await expect(whatsapp.test(actor)).rejects.toThrow('one minute');
    const row = await store.lastMessage(alice);
    const sid = String(row!._id);
    expect(
      (
        await callback(
          {
            AccountSid: config.TWILIO_ACCOUNT_SID,
            MessageSid: sid,
            MessageStatus: 'delivered',
          },
          true,
        )
      ).status,
    ).toBe(200);
    await callback(
      {
        AccountSid: config.TWILIO_ACCOUNT_SID,
        MessageSid: sid,
        MessageStatus: 'queued',
      },
      true,
    );
    expect((await whatsapp.settings(actor)).lastStatus).toBe('delivered');
  });
  it('lets an explicit resend recover exhausted notification attempts', async () => {
    const id = randomUUID();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(await store.claim(id, 1, alice)).not.toBeNull();
      now += 60001;
    }
    expect(await store.claim(id, 1, alice)).toBeNull();
    await whatsapp.resend(actor);
    expect(await store.claim(id, 1, alice)).not.toBeNull();
  });
});
