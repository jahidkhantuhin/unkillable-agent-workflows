import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import { memoryAdapter } from '@better-auth/memory-adapter';
import { RunRepository } from '@unkillable/storage';
import {
  supportConfigSchema,
  ticketInputSchema,
  supportExamples,
  supportNodeSchema,
  RetryableError,
  PermanentError,
} from '@unkillable/shared';
import { createExecutor } from '../../worker/src/executor';
import {
  MailpitMailer,
  supportDependencies,
} from '../../worker/src/support-adapters';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createAuth } from './auth';
import { AuthService } from './services/auth';
import { RunService } from './services/runs';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
const redis = process.env.INTEGRATION_REDIS_URL;
const mailpit = process.env.INTEGRATION_MAILPIT_URL;
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await read();
    if (match(value)) return value;
    await delay(30);
  }
  throw new Error('Timed out waiting for ticket workflow');
}
describe.skipIf(!uri || !redis || !mailpit)(
  'support workflow with fake ledger and Mailpit SMTP',
  () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
    const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
    const runs = new RunRepository(client, db);
    const name = `support-test-${randomUUID()}`;
    const config = supportConfigSchema.parse({});
    const smtp = new MailpitMailer(config);
    let queue: Queue;
    let worker: Worker;
    let executor: Awaited<ReturnType<typeof createExecutor>>;
    let app: ReturnType<typeof createApp>;
    let cookie = '';
    let userId = '';
    let failAfterAccept = false;
    let rejectSmtp = false;
    let smtpCalls = 0;
    const deps = supportDependencies(runs, config, async (mail) => {
      smtpCalls++;
      if (rejectSmtp)
        throw new PermanentError('Simulated permanent SMTP rejection');
      await smtp.deliver(mail);
      if (failAfterAccept) {
        failAfterAccept = false;
        throw new RetryableError(
          'Simulated disconnect after SMTP acceptance before Mongo acknowledgement',
        );
      }
    });
    const members = new MongoMembershipRepository(db);
    const origin = 'http://localhost:3000';
    const failures: unknown[] = [];
    function input(index = 0) {
      const e = supportExamples[index]!;
      return ticketInputSchema.parse({
        title: e.title,
        description: e.description,
        customerEmail: `test-${randomUUID()}@example.test`,
        orderId: e.orderId,
        amountCents: e.amountCents,
        currency: 'USD',
      });
    }
    async function captured(email: string) {
      const response = await fetch(
        `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      if (!response.ok) throw new Error('Mailpit search unavailable');
      return (await response.json()) as { messages: { ID: string }[] };
    }
    async function create(index = 0) {
      const body = input(index);
      const response = await request(app)
        .post('/tickets')
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send(body);
      expect(response.status).toBe(202);
      await until(
        () => runs.get(response.body.id),
        (run) => run?.status === 'waiting_approval',
      );
      return { id: response.body.id as string, input: body };
    }
    async function decide(id: string, decision: unknown) {
      const approval = await runs.approvals().forRun(id);
      expect(approval).toBeTruthy();
      return request(app)
        .post(`/approvals/${approval!.id}/resolve`)
        .set('Cookie', cookie)
        .set('Origin', origin)
        .send({ version: approval!.version, decision });
    }
    beforeAll(async () => {
      await client.connect();
      await bootstrapIndexes(db);
      await runs.support().seedExamples();
      await runs.support().seedExamples();
      queue = new Queue(name, { connection: { url: redis! } });
      const service = new RunService(runs, queue);
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
          secret: 'support-integration-secret-at-least-32-chars',
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
      );
      const signed = await request(app)
        .post('/auth/register')
        .set('Origin', origin)
        .send({
          name: 'Ticket tester',
          email: 'support-tester@example.test',
          password: 'local-support-test-password',
        });
      expect(signed.status).toBe(201);
      userId = signed.body.user.id;
      cookie = (signed.headers['set-cookie'] as unknown as string[])
        .map((value) => value.split(';')[0])
        .join('; ');
      executor = await createExecutor(
        runs,
        uri!,
        db.databaseName,
        0,
        {},
        deps,
        undefined,
        (mail) => {
          if (rejectSmtp)
            throw new PermanentError('Simulated permanent SMTP rejection');
          return smtp.deliver(mail);
        },
      );
      worker = new Worker(
        name,
        (job) => executor.execute(job.data.runId, job.data.execution),
        { connection: { url: redis! }, concurrency: 1 },
      );
      worker.on('failed', (_job, error) => failures.push(error));
      await worker.waitUntilReady();
    }, 30000);
    afterAll(async () => {
      if (worker) await worker.close();
      if (executor) await executor.close();
      smtp.close();
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      await db.dropDatabase();
      await client.close();
    }, 30000);
    it('enforces ticket permissions, input validation, and idempotent example seeding', async () => {
      expect(
        (
          await request(app)
            .post('/tickets')
            .set('Cookie', cookie)
            .set('Origin', origin)
            .send(input())
        ).status,
      ).toBe(403);
      expect(
        (await request(app).get('/tickets/examples').set('Cookie', cookie))
          .body,
      ).toHaveLength(3);
      expect(await db.collection('ticketExamples').countDocuments()).toBe(3);
      await members.setRole(userId, 'approver');
      expect(
        (
          await request(app)
            .post('/tickets')
            .set('Cookie', cookie)
            .set('Origin', origin)
            .send({ ...input(), customerEmail: 'customer@gmail.com' })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(app)
            .post('/tickets')
            .set('Cookie', cookie)
            .set('Origin', 'https://untrusted.example')
            .send(input())
        ).status,
      ).toBe(403);
    });
    it('approves an edited duplicate-charge reply and produces one refund and one captured email despite an SMTP acknowledgement gap', async () => {
      const run = await create();
      const pending = await runs.reliability().details(run.id);
      expect(pending.refunds).toHaveLength(0);
      expect(pending.emails).toHaveLength(0);
      const approval = await runs.approvals().forRun(run.id);
      expect(approval?.proposedAction).toMatchObject({
        kind: 'support-ticket',
        refundCents: 4900,
        citedPolicyId: 'duplicate-charge',
      });
      failAfterAccept = true;
      const beforeCalls = smtpCalls;
      expect(
        (
          await decide(run.id, {
            action: 'edit',
            payload: {
              message:
                'Human approved the synthetic USD 49.00 refund and this reply.',
            },
          })
        ).status,
      ).toBe(200);
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'succeeded',
      );
      const records = await runs.reliability().details(run.id);
      expect(records.refunds).toHaveLength(1);
      expect(records.emails).toHaveLength(1);
      expect(records.emails[0]?.status).toBe('sent');
      expect(smtpCalls - beforeCalls).toBe(2);
      expect((await runs.get(run.id))?.state.completed).toEqual(
        supportNodeSchema.options,
      );
      const message = await until(
        () => captured(run.input.customerEmail),
        (value) => value.messages.length === 1,
      );
      expect(message.messages).toHaveLength(1);
      const email = await fetch(
        `${mailpit}/api/v1/message/${message.messages[0]!.ID}`,
      ).then((response) => response.json());
      expect(z.object({ Text: z.string() }).parse(email).Text).toContain(
        'Human approved',
      );
      await Promise.all([
        runs
          .support()
          .refund(
            run.id,
            String((await runs.get(run.id))!.state.ticketId),
            4900,
          ),
        runs
          .support()
          .refund(
            run.id,
            String((await runs.get(run.id))!.state.ticketId),
            4900,
          ),
      ]);
      await smtp.deliver(records.emails[0]!.payload);
      await smtp.deliver(records.emails[0]!.payload);
      expect((await captured(run.input.customerEmail)).messages).toHaveLength(
        1,
      );
      const events = await runs.events(run.id, 0);
      await executor.execute(run.id);
      expect(await runs.events(run.id, 0)).toEqual(events);
      expect((await runs.reliability().details(run.id)).refunds).toHaveLength(
        1,
      );
      expect(
        (
          await runs
            .support()
            .ticket(String((await runs.get(run.id))!.state.ticketId))
        )?.status,
      ).toBe('closed');
      expect(failures).toEqual([]);
    }, 30000);
    it('rejects a ticket without any refund or email', async () => {
      const run = await create();
      expect(
        (
          await decide(run.id, {
            action: 'reject',
            reason: 'The duplicate charge has not been verified',
          })
        ).status,
      ).toBe(200);
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'cancelled',
      );
      const details = await runs.reliability().details(run.id);
      expect(details.refunds).toHaveLength(0);
      expect(details.emails).toHaveLength(0);
      expect((await captured(run.input.customerEmail)).messages).toHaveLength(
        0,
      );
    }, 30000);
    it('answers a how-to ticket without creating a refund', async () => {
      const run = await create(2);
      expect((await decide(run.id, { action: 'approve' })).status).toBe(200);
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'succeeded',
      );
      const details = await runs.reliability().details(run.id);
      expect(details.refunds).toHaveLength(0);
      expect(details.emails).toHaveLength(1);
      expect((await captured(run.input.customerEmail)).messages).toHaveLength(
        1,
      );
    }, 30000);
    it('deduplicates two concurrent SMTP dispatchers for a fresh message', async () => {
      const body = input();
      const run = await runs.createSupport(userId, body);
      const ticketId = String(run.state.ticketId);
      await runs.append(run.id, { type: 'RUN_STARTED' }, { status: 'running' });
      await runs.support().queueEmail(run.id, ticketId, {
        to: body.customerEmail,
        subject: 'Concurrent local reply',
        text: 'One local capture despite concurrent dispatch',
      });
      await Promise.all([
        runs
          .reliability()
          .deliverEmail(`${run.id}:send_email:reply`, (mail) =>
            smtp.deliver(mail),
          ),
        runs
          .reliability()
          .deliverEmail(`${run.id}:send_email:reply`, (mail) =>
            smtp.deliver(mail),
          ),
      ]);
      expect((await captured(body.customerEmail)).messages).toHaveLength(1);
      const records = await runs.reliability().details(run.id);
      expect(records.emails).toHaveLength(1);
      expect(records.deliveries).toHaveLength(1);
    }, 30000);
    it('keeps failed compensation resumable and reverses a refund after permanent email failure', async () => {
      await members.setRole(userId, 'admin');
      const run = await create();
      rejectSmtp = true;
      expect((await decide(run.id, { action: 'approve' })).status).toBe(200);
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'compensating',
      );
      const failed = await runs.reliability().details(run.id);
      expect(failed.refunds).toHaveLength(1);
      expect(failed.outbox[0]?.status).toBe('failed');
      rejectSmtp = false;
      const before = smtpCalls;
      await runs.reliability().dispatchOutbox(25, (mail) => smtp.deliver(mail));
      expect(smtpCalls).toBe(before);
      expect((await captured(run.input.customerEmail)).messages).toHaveLength(
        0,
      );
      await executor.execute(run.id);
      await until(
        () => runs.get(run.id),
        (value) => value?.status === 'compensated',
      );
      const recovered = await runs.reliability().details(run.id);
      expect(recovered.refunds).toHaveLength(1);
      expect(recovered.refunds[0]?.status).toBe('reversed');
      expect(
        recovered.emails.filter((row) => row.purpose === 'correction'),
      ).toHaveLength(1);
      expect((await captured(run.input.customerEmail)).messages).toHaveLength(
        1,
      );
    }, 30000);
    it('restarts from the final checkpoint without repeating refund or email effects', async () => {
      const body = input();
      const run = await runs.createSupport(userId, body);
      await executor.execute(run.id);
      const approval = await runs.approvals().forRun(run.id);
      await runs
        .approvals()
        .resolve(approval!.id, 0, { action: 'approve' }, userId);
      const original = runs.append.bind(runs);
      const interrupt = vi
        .spyOn(runs, 'append')
        .mockImplementation(async (id, event, options) => {
          if (id === run.id && event.type === 'RUN_FINISHED')
            throw new Error('Stopped after final checkpoint');
          return original(id, event, options);
        });
      try {
        await expect(executor.execute(run.id, 1)).rejects.toThrow(
          'Stopped after final checkpoint',
        );
      } finally {
        interrupt.mockRestore();
      }
      const fresh = await createExecutor(
        runs,
        uri!,
        db.databaseName,
        0,
        {},
        deps,
      );
      try {
        await fresh.execute(run.id, 1);
      } finally {
        await fresh.close();
      }
      const details = await runs.reliability().details(run.id);
      expect(details.refunds).toHaveLength(1);
      expect(details.emails).toHaveLength(1);
      expect((await captured(body.customerEmail)).messages).toHaveLength(1);
      expect((await runs.get(run.id))?.status).toBe('succeeded');
    }, 30000);
  },
);
