import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { RunRepository, LocalContentStorage } from '@unkillable/storage';
import {
  identitySchema,
  supportConfigSchema,
  ticketInputSchema,
  supportExamples,
  supportStateSchema,
  moderationStateSchema,
  type Run,
  type Role,
} from '@unkillable/shared';
import { createExecutor } from '../../worker/src/executor';
import { createModerationExecutor } from '../../worker/src/moderation-executor';
import { supportDependencies } from '../../worker/src/support-adapters';
import { bootstrapIndexes } from './repositories/indexes';
import { RunService } from './services/runs';
import { TimeTravelService } from './services/time-travel';
import type { AuthService } from './services/auth';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('checkpoint history and isolated forks', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`),
    runs = new RunRepository(client, db);
  const add = vi.fn(async () => {}),
    service = new RunService(runs, { add }),
    history = new TimeTravelService(service, uri!, db.databaseName);
  const actorId = randomUUID(),
    origin = 'http://localhost:3000';
  let role: Role = 'admin',
    queueUnavailable = false,
    directory = '';
  let executor: Awaited<ReturnType<typeof createExecutor>>,
    moderation: Awaited<ReturnType<typeof createModerationExecutor>>,
    files: LocalContentStorage;
  const deliver = vi.fn(async () => {});
  const deps = supportDependencies(
    runs,
    supportConfigSchema.parse({}),
    deliver,
  );
  const classify = vi.spyOn(deps.llm, 'classify'),
    draft = vi.spyOn(deps.llm, 'draft');
  const auth = {
    me: async () =>
      identitySchema.parse({
        user: {
          id: actorId,
          name: 'Fork reviewer',
          email: 'fork@example.test',
        },
        role,
        workspaceId: 'local',
      }),
  } as unknown as AuthService;
  const app = createApp(
    { mongo: async () => true, redis: async () => true },
    [origin],
    'silent',
    auth,
    service,
    undefined,
    undefined,
    history,
  );
  async function execute(run: Run) {
    await executor.execute(run.id, run.execution);
    return (await runs.get(run.id))!;
  }
  async function approve(run: Run) {
    const approval = (await runs.approvals().forRun(run.id))!;
    expect(approval.status).toBe('pending');
    await runs
      .approvals()
      .resolve(approval.id, approval.version, { action: 'approve' }, actorId);
    return (await runs.get(run.id))!;
  }
  async function fork(parent: Run, checkpointId: string, edits = {}) {
    const result = await request(app)
      .post(`/runs/${parent.id}/forks`)
      .set('Origin', origin)
      .send({ checkpointId, edits });
    expect(result.status, result.text).toBe(202);
    return (await runs.get(result.body.id))!;
  }
  beforeAll(async () => {
    await client.connect();
    await bootstrapIndexes(db);
    await service.initialize();
    await runs.support().seedExamples();
    add.mockImplementation(async () => {
      if (queueUnavailable) throw new Error('Queue offline');
    });
    directory = await mkdtemp(join(tmpdir(), 'unkillable-forks-'));
    files = new LocalContentStorage(directory);
    executor = await createExecutor(
      runs,
      uri!,
      db.databaseName,
      0,
      {},
      deps,
      undefined,
      deliver,
    );
    moderation = await createModerationExecutor(
      runs,
      uri!,
      db.databaseName,
      undefined,
      files,
    );
  }, 30000);
  afterAll(async () => {
    await executor?.close();
    await moderation?.close();
    await db.dropDatabase();
    await client.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30000);
  it('pages and diffs native history, scopes checkpoints to the run and enforces fork permissions', async () => {
    const parent = await execute(
      await service.create(actorId, {
        title: 'History parent',
        message: 'Saved input',
        requireApproval: false,
        deliveryMode: 'normal',
      }),
    );
    const all = await history.history(parent.id, 100);
    expect(all.checkpoints.length).toBeGreaterThan(3);
    const page = await request(app).get(
      `/runs/${parent.id}/checkpoints?limit=2`,
    );
    expect(page.status, page.text).toBe(200);
    expect(page.body.checkpoints).toHaveLength(2);
    const older = await history.history(parent.id, 2, page.body.nextBefore);
    expect(older.checkpoints[0].id).not.toBe(page.body.checkpoints[1].id);
    const chosen = all.checkpoints.find(
      (c) => c.completed.at(-1) === 'summarize',
    )!;
    const input = all.checkpoints.find(
      (c) => c.forkable && c.completed.length === 0,
    )!;
    const differences = await history.diff(parent.id, input.id, chosen.id);
    expect(differences.changes.some((c) => c.path === '/summary')).toBe(true);
    expect(
      (await request(app).get(`/runs/${parent.id}/checkpoints/${chosen.id}`))
        .body.state.completed,
    ).toContain('summarize');
    const foreign = await execute(
      await service.create(actorId, {
        message: 'Other run',
        requireApproval: false,
        deliveryMode: 'normal',
      }),
    );
    for (const path of [
      `checkpoints/${chosen.id}`,
      `checkpoints?before=${chosen.id}`,
      `diff?from=${chosen.id}&to=${chosen.id}`,
    ])
      expect(
        (await request(app).get(`/runs/${foreign.id}/${path}`)).status,
      ).toBe(404);
    expect(
      (await request(app).get(`/runs/${parent.id}/checkpoints?limit=101`))
        .status,
    ).toBe(400);
    role = 'viewer';
    expect(
      (await request(app).get(`/runs/${parent.id}/checkpoints`)).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post(`/runs/${parent.id}/forks`)
          .set('Origin', origin)
          .send({ checkpointId: chosen.id })
      ).status,
    ).toBe(403);
    role = 'admin';
    expect(
      (
        await request(app)
          .post(`/runs/${parent.id}/forks`)
          .send({ checkpointId: chosen.id })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/runs/${parent.id}/forks`)
          .set('Origin', origin)
          .send({
            checkpointId: chosen.id,
            edits: { approvalAction: 'approve' },
          })
      ).status,
    ).toBe(400);
    const uninitialized = all.checkpoints.find((c) => !c.forkable);
    if (uninitialized)
      expect(
        (
          await request(app)
            .post(`/runs/${parent.id}/forks`)
            .set('Origin', origin)
            .send({ checkpointId: uninitialized.id })
        ).status,
      ).toBe(400);
    const child = await fork(parent, chosen.id, { title: 'History child' });
    expect(child.parentRunId).toBe(parent.id);
    expect(child.forkCheckpointId).toBe(chosen.id);
    expect((await execute(child)).status).toBe('succeeded');
    await runs.reliability().dispatchOutbox();
    for (const run of [parent, child])
      expect(
        await db
          .collection('localDeliveries')
          .countDocuments({ runId: run.id }),
      ).toBe(1);
    expect((await runs.get(parent.id))!.state).toEqual(parent.state);
    expect((await history.history(parent.id, 100)).checkpoints).toEqual(
      all.checkpoints,
    );
    expect((await history.relations(child.id)).parent?.id).toBe(parent.id);
    expect(
      (await history.relations(parent.id)).children.map((c) => c.id),
    ).toContain(child.id);
    const events = await runs.events(parent.id);
    expect(
      events.some((e) => e.type === 'CUSTOM' && e.name === 'run.forked'),
    ).toBe(true);
  }, 30000);
  it('forks a failed run without reopening the parent or reusing its effect scope', async () => {
    const created = await service.create(actorId, {
      message: 'Failed delivery',
      deliveryMode: 'permanent',
      requireApproval: false,
    });
    await expect(
      executor.execute(created.id, created.execution),
    ).rejects.toThrow();
    const parent = (await runs.get(created.id))!;
    expect(parent.status).toBe('failed');
    const chosen = (await history.history(parent.id, 100)).checkpoints.find(
      (c) => c.completed.at(-1) === 'summarize',
    )!;
    const child = await fork(parent, chosen.id, {
      title: 'Recovered branch',
      deliveryMode: 'normal',
    });
    expect((await execute(child)).status).toBe('succeeded');
    expect((await runs.get(parent.id))!.status).toBe('failed');
    expect(
      await db
        .collection('deadLetters')
        .countDocuments({ runId: parent.id, status: 'open' }),
    ).toBe(1);
    expect(
      await db.collection('deadLetters').countDocuments({ runId: child.id }),
    ).toBe(0);
  }, 30000);
  it('recomputes changed input and durably dispatches a fork after a queue outage', async () => {
    const parent = await execute(
      await service.create(actorId, {
        message: 'Old message',
        requireApproval: false,
        deliveryMode: 'normal',
      }),
    );
    const chosen = (await history.history(parent.id, 100)).checkpoints[0];
    queueUnavailable = true;
    const child = await fork(parent, chosen.id, {
      message: '  New input words  ',
    });
    expect(child.dispatchPending).toBe(true);
    expect(child.forkAsNode).toBe('__start__');
    queueUnavailable = false;
    await service.reconcile();
    expect((await runs.get(child.id))!.dispatchPending).toBe(false);
    const finished = await execute(child);
    expect(finished.status).toBe('succeeded');
    expect(finished.state.normalized).toBe('New input words');
    expect(finished.state.summary).toContain('3 words');
  }, 30000);
  it('forks a support draft into a fresh approval and exactly one separate refund/email, including restart', async () => {
    const parent = await execute(
      await service.createTicket(
        actorId,
        ticketInputSchema.parse(
          Object.fromEntries(
            Object.entries(supportExamples[0]).filter(([key]) => key !== 'id'),
          ),
        ),
      ),
    );
    expect(parent.status).toBe('waiting_approval');
    const chosen = (await history.history(parent.id, 100)).checkpoints.find(
      (c) => c.completed.at(-1) === 'draft_reply',
    )!;
    const source = await history.checkpoint(parent.id, chosen.id);
    const classifyCalls = classify.mock.calls.length,
      draftCalls = draft.mock.calls.length;
    role = 'approver';
    const child = await fork(parent, chosen.id, {
      title: 'Kinder follow-up',
      draftMessage:
        'We are sorry. Your duplicate charge refund is ready for review.',
    });
    role = 'admin';
    expect(child.state.ticketId).not.toBe(parent.state.ticketId);
    expect((await execute(child)).status).toBe('waiting_approval');
    expect(classify).toHaveBeenCalledTimes(classifyCalls);
    expect(draft).toHaveBeenCalledTimes(draftCalls);
    expect((await runs.approvals().forRun(child.id))!.id).not.toBe(
      (await runs.approvals().forRun(parent.id))!.id,
    );
    expect(
      await db.collection('fakeRefunds').countDocuments({ runId: child.id }),
    ).toBe(0);
    await executor.close();
    executor = await createExecutor(
      runs,
      uri!,
      db.databaseName,
      0,
      {},
      deps,
      undefined,
      deliver,
    );
    for (const pending of [parent, (await runs.get(child.id))!]) {
      const queued = await approve(pending);
      await Promise.all([
        executor.execute(queued.id, queued.execution),
        executor.execute(queued.id, queued.execution),
      ]);
      expect((await runs.get(queued.id))!.status).toBe('succeeded');
      for (const collection of ['fakeRefunds', 'fakeEmails', 'localDeliveries'])
        expect(
          await db.collection(collection).countDocuments({ runId: queued.id }),
        ).toBe(1);
      const keys = await db
        .collection('idempotencyKeys')
        .find({ runId: queued.id })
        .toArray();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.key.startsWith(`${queued.id}:`))).toBe(true);
    }
    const finalChild = supportStateSchema.parse(
        (await runs.get(child.id))!.state,
      ),
      finalParent = supportStateSchema.parse(
        (await runs.get(parent.id))!.state,
      );
    expect(finalChild.refund.id).not.toBe(finalParent.refund.id);
    expect(finalChild.email.messageId).not.toBe(finalParent.email.messageId);
    expect(finalChild.approvedMessage).toContain('We are sorry');
    expect((await history.checkpoint(parent.id, chosen.id)).state).toEqual(
      source.state,
    );
  }, 30000);
  it('forces human review of forked low-risk replies even under auto-approve policy', async () => {
    const active = await runs.policies().current();
    await runs.policies().save(
      active.version,
      {
        name: 'Auto safe replies',
        rules: [
          { id: 'auto', reason: 'Safe', when: {}, outcome: 'auto_approve' },
        ],
        fallback: 'require_approval',
      },
      actorId,
    );
    const parent = await execute(
      await service.createTicket(
        actorId,
        ticketInputSchema.parse(
          Object.fromEntries(
            Object.entries(supportExamples[2]).filter(([key]) => key !== 'id'),
          ),
        ),
      ),
    );
    const chosen = (await history.history(parent.id, 100)).checkpoints.find(
      (c) => c.completed.at(-1) === 'draft_reply',
    )!;
    const child = await execute(
      await fork(parent, chosen.id, {
        draftMessage: 'Edited low-risk proposal',
      }),
    );
    expect(child.status).toBe('waiting_approval');
    expect(
      supportStateSchema.parse(child.state).policyDecision?.inputs.riskTier,
    ).toBe('high');
  }, 30000);
  it('forks moderation with a fresh item, rescreens input and never reuses human approval', async () => {
    const file = await files.put(
      Readable.from(['DEMO_REVIEW Synthetic post requiring review.']),
    );
    const parent = await service.createModeration(actorId, {
      title: 'Original post',
      file,
    });
    await moderation.execute(parent.id, 0);
    const approved = await approve((await runs.get(parent.id))!);
    await moderation.execute(parent.id, approved.execution);
    expect((await runs.get(parent.id))!.status).toBe('succeeded');
    const chosen = (await history.history(parent.id, 100)).checkpoints[0];
    role = 'approver';
    expect(
      (
        await request(app)
          .post(`/runs/${parent.id}/forks`)
          .set('Origin', origin)
          .send({ checkpointId: chosen.id })
      ).status,
    ).toBe(403);
    role = 'admin';
    const child = await fork(parent, chosen.id, { title: 'Rescreened post' });
    await moderation.execute(child.id, 0);
    const pending = (await runs.get(child.id))!;
    expect(pending.status).toBe('waiting_approval');
    const state = moderationStateSchema.parse(pending.state);
    expect(state.file).toEqual(file);
    expect(state.contentId).not.toBe(parent.state.contentId);
    expect(
      await db
        .collection('publishedContent')
        .countDocuments({ runId: child.id }),
    ).toBe(0);
    const queued = await approve(pending);
    await moderation.execute(child.id, queued.execution);
    await moderation.execute(child.id, queued.execution);
    for (const id of [parent.id, child.id])
      expect(
        await db.collection('publishedContent').countDocuments({ runId: id }),
      ).toBe(1);
    expect(await files.readText(file.key)).toContain('DEMO_REVIEW');
  }, 30000);
});
