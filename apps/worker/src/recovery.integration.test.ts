import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createExecutor } from './executor';
import { Queue } from 'bullmq';
import { MongoClient } from 'mongodb';
import { RunRepository } from '@unkillable/storage';
import { bootstrapIndexes } from '../../api/src/repositories/indexes';
const uri = process.env.INTEGRATION_MONGODB_URI;
const redis = process.env.INTEGRATION_REDIS_URL;
async function until<T>(
  read: () => Promise<T>,
  match: (value: T) => boolean,
  timeout = 30000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (match(value)) return value;
    await delay(50);
  }
  throw new Error('Timed out waiting for recovery condition');
}
describe.skipIf(!uri || !redis)(
  'worker crash recovery with real checkpoints',
  () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
    const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
    const repository = new RunRepository(client, db);
    const name = `workflow-runs-test-${randomUUID()}`;
    let queue: Queue;
    const children: ChildProcess[] = [];
    let logs = '';
    beforeAll(async () => {
      await client.connect();
      await bootstrapIndexes(db);
      queue = new Queue(name, { connection: { url: redis! } });
    }, 30000);
    afterAll(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await new Promise<void>((resolve) =>
            child.once('exit', () => resolve()),
          );
        }
      if (queue) {
        await queue.obliterate({ force: true });
        await queue.close();
      }
      await db.dropDatabase();
      await client.close();
    }, 30000);
    async function startWorker() {
      const url = new URL(uri!);
      url.pathname = `/${db.databaseName}`;
      const worker = fileURLToPath(new URL('./index.ts', import.meta.url));
      const child = spawn(process.execPath, ['--import', 'tsx', worker], {
        env: {
          ...process.env,
          MONGODB_URI: url.toString(),
          REDIS_URL: redis!,
          RUN_QUEUE_NAME: name,
          WORKER_LOCK_DURATION_MS: '2000',
          WORKER_STALLED_INTERVAL_MS: '1000',
          WORKER_MAX_STALLED_COUNT: '2',
          DEMO_NODE_DELAY_MS: '700',
          LOG_LEVEL: 'warn',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      child.stdout?.on('data', (chunk) => {
        logs += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        logs += String(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Worker startup timed out: ${logs}`)),
          15000,
        );
        child.on('message', (message) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'worker-ready'
          ) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          reject(new Error(`Worker exited: ${logs}`));
        });
      });
      return child;
    }
    it('kills a child mid-run, resumes its stalled job, and does not rerun a checkpointed node', async () => {
      const first = await startWorker();
      const run = await repository.create('recovery-tester', {
        message: 'survive a killed worker',
      });
      await queue.add('execute-run', { runId: run.id }, { jobId: run.id });
      await until(
        () => repository.events(run.id, 0),
        (events) =>
          events.some(
            (event) =>
              event.type === 'STEP_STARTED' && event.stepName === 'summarize',
          ),
      );
      const checkpoint = await db
        .collection('checkpoints')
        .findOne({ thread_id: run.id });
      expect(checkpoint).toBeTruthy();
      const exited = new Promise<void>((resolve) =>
        first.once('exit', () => resolve()),
      );
      first.kill('SIGKILL');
      await exited;
      const replacement = await startWorker();
      const result = await until(
        () => repository.get(run.id),
        (value) => value?.status === 'succeeded',
      );
      expect(result?.state.completed).toEqual([
        'prepare',
        'summarize',
        'complete',
      ]);
      const events = await repository.events(run.id, 0);
      expect(
        events.filter(
          (event) =>
            event.type === 'STEP_STARTED' && event.stepName === 'prepare',
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'STEP_FINISHED' && event.stepName === 'prepare',
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'STEP_STARTED' && event.stepName === 'summarize',
        ).length,
      ).toBe(2);
      expect(
        events.some(
          (event) => event.type === 'CUSTOM' && event.name === 'run.resumed',
        ),
      ).toBe(true);
      expect(
        events.filter((event) => event.type === 'RUN_FINISHED'),
      ).toHaveLength(1);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: events.length }, (_, i) => i + 1),
      );
      await until(
        () => queue.getJob(run.id).then((job) => job?.getState()),
        (value) => value === 'completed',
      );
      const stopped = new Promise<void>((resolve) =>
        replacement.once('exit', () => resolve()),
      );
      replacement.kill('SIGKILL');
      await stopped;
    }, 45000);
    it('replays a committed effect after a worker kill before its checkpoint without duplicate delivery', async () => {
      const first = await startWorker();
      const run = await repository.create('effect-recovery-tester', {
        message: 'one durable notice',
      });
      await queue.add('execute-run', { runId: run.id }, { jobId: run.id });
      const reliability = repository.reliability();
      await until(
        () => reliability.details(run.id),
        (value) =>
          value.keys.some(
            (key) =>
              key.key === `${run.id}:complete:notice` &&
              key.status === 'completed',
          ),
      );
      const stopped = new Promise<void>((resolve) =>
        first.once('exit', () => resolve()),
      );
      first.kill('SIGKILL');
      await stopped;
      await startWorker();
      await until(
        () => repository.get(run.id),
        (value) => value?.status === 'succeeded',
      );
      const details = await until(
        () => reliability.details(run.id),
        (value) => value.outbox.some((row) => row.status === 'sent'),
      );
      expect(details.outbox).toHaveLength(1);
      expect(details.deliveries).toHaveLength(1);
      expect(
        details.keys.filter((key) => key.key === `${run.id}:complete:notice`),
      ).toHaveLength(1);
      const events = await repository.events(run.id, 0);
      expect(
        events.filter(
          (event) =>
            event.type === 'STEP_STARTED' && event.stepName === 'complete',
        ),
      ).toHaveLength(2);
    }, 45000);
    it('finishes after a crash gap following the final checkpoint and ignores terminal redelivery', async () => {
      const run = await repository.create('boundary-tester', {
        message: 'last checkpoint survives',
      });
      const first = await createExecutor(repository, uri!, db.databaseName, 0);
      const original = repository.append.bind(repository);
      const interrupted = vi
        .spyOn(repository, 'append')
        .mockImplementation(async (id, event, options) => {
          if (event.type === 'RUN_FINISHED')
            throw new Error('Interrupted before terminal event');
          return original(id, event, options);
        });
      try {
        await expect(first.execute(run.id)).rejects.toThrow(
          'Interrupted before terminal event',
        );
      } finally {
        interrupted.mockRestore();
        await first.close();
      }
      expect((await repository.get(run.id))?.status).toBe('running');
      const second = await createExecutor(repository, uri!, db.databaseName, 0);
      try {
        await second.execute(run.id);
        expect((await repository.get(run.id))?.status).toBe('succeeded');
        const events = await repository.events(run.id, 0);
        expect(
          events.filter((event) => event.type === 'STEP_STARTED'),
        ).toHaveLength(3);
        await second.execute(run.id);
        expect(await repository.events(run.id, 0)).toEqual(events);
      } finally {
        await second.close();
      }
    }, 30000);
  },
);
