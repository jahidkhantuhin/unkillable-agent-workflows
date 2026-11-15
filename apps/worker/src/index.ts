import { Worker, Queue, UnrecoverableError, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import {
  infrastructureSchema,
  workerConfigSchema,
  runIdParamsSchema,
  terminalStatuses,
  NodeFailure,
  supportConfigSchema,
} from '@unkillable/shared';
import {
  RunRepository,
  bootstrapReliabilityIndexes,
  approvalIndexes,
  supportIndexes,
  startChaosRuntime,
} from '@unkillable/storage';
import { createExecutor } from './executor';
import { MailpitMailer, supportDependencies } from './support-adapters';
import { RedisFaultInjector } from './faults';
import { chaosEnabled } from '@unkillable/shared';
const config = {
  ...infrastructureSchema.parse(process.env),
  ...workerConfigSchema.parse(process.env),
  ...supportConfigSchema.parse(process.env),
};
const logger = pino({ level: config.LOG_LEVEL });
const mongo = new MongoClient(config.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});
await mongo.connect();
await bootstrapReliabilityIndexes(mongo.db());
for (const [name, indexes] of Object.entries(approvalIndexes))
  await mongo.db().collection(name).createIndexes(indexes);
for (const [name, indexes] of Object.entries(supportIndexes))
  await mongo.db().collection(name).createIndexes(indexes);
const repository = new RunRepository(mongo);
const reliability = repository.reliability();
const smtp = new MailpitMailer(config);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const executor = await createExecutor(
  repository,
  config.MONGODB_URI,
  mongo.db().databaseName,
  config.DEMO_NODE_DELAY_MS,
  config.NODE_RETRY_POLICIES,
  supportDependencies(repository, config, (mail) => smtp.deliver(mail)),
  new RedisFaultInjector(
    connection,
    chaosEnabled(process.env),
    undefined,
    undefined,
    config.RUN_QUEUE_NAME,
    Math.random,
    async (value) => {
      await repository.append(value.runId, {
        type: 'CUSTOM',
        name: 'chaos.triggered',
        value,
      });
    },
  ),
  (mail) => smtp.deliver(mail),
);
connection.on('error', (err) =>
  logger.error({ err }, 'Worker Redis unavailable'),
);
const worker = new Worker(
  config.RUN_QUEUE_NAME,
  async (job) => {
    const { id } = runIdParamsSchema.parse({ id: job.data.runId });
    logger.info({ runId: id }, 'Executing durable run');
    try {
      await executor.execute(id, Number(job.data.execution ?? 0));
    } catch (error) {
      if (error instanceof NodeFailure)
        throw new UnrecoverableError(error.message);
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: config.WORKER_LOCK_DURATION_MS,
    lockRenewTime: Math.floor(config.WORKER_LOCK_DURATION_MS / 2),
    stalledInterval: config.WORKER_STALLED_INTERVAL_MS,
    maxStalledCount: config.WORKER_MAX_STALLED_COUNT,
  },
);
let stopChaos = async () => {};
worker.on('ready', () => {
  stopChaos = startChaosRuntime(
    connection,
    config.RUN_QUEUE_NAME,
    'worker',
    chaosEnabled(process.env),
  );
  logger.info('Worker ready');
  process.send?.({ type: 'worker-ready' });
});
worker.on('error', (err) => logger.error({ err }, 'Worker error'));
worker.on('stalled', (jobId) =>
  logger.warn({ jobId }, 'Stalled job recovered; resuming its checkpoint'),
);
async function recordFailedJob(job: Job | undefined, error: unknown) {
  const id = job?.data?.runId;
  if (typeof id !== 'string') return;
  const run = await repository.get(id);
  if (
    run?.workflowId === 'support-ticket-router' &&
    run.execution === Number(job?.data.execution ?? 0)
  ) {
    if (
      run.status === 'compensating' ||
      (await repository
        .saga()
        .begin(
          id,
          run.execution,
          error instanceof Error ? error.message : 'Queue execution failed',
        ))
    ) {
      await executor.execute(id, run.execution);
      return;
    }
  }
  await reliability.recordFailure(id, Number(job?.data.execution ?? 0), error, {
    jobId: job?.id ?? null,
    attempts: job?.attemptsMade ?? 1,
    queuePolicy: job?.opts ?? {},
    stacktrace: job?.stacktrace ?? [],
  });
}
worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Job failed');
  if (
    job &&
    !(err instanceof UnrecoverableError) &&
    job.attemptsMade < (job.opts.attempts ?? 1) &&
    !job.failedReason.includes('stalled')
  )
    return;
  void recordFailedJob(job, err).catch((error) =>
    logger.error({ err: error }, 'Unable to record run failure'),
  );
});
const queue = new Queue(config.RUN_QUEUE_NAME, { connection });
queue.on('error', (err) => logger.error({ err }, 'Worker queue error'));
let maintaining = false;
let failedOffset = 0;
const maintenance = setInterval(() => {
  if (maintaining) return;
  maintaining = true;
  void (async () => {
    for (const id of await repository.saga().pending())
      await executor
        .execute(id)
        .catch((err) =>
          logger.error(
            { runId: id, err },
            'Compensation pending; maintenance will retry',
          ),
        );
    await reliability.dispatchOutbox(25, (mail) => smtp.deliver(mail));
    const failedJobs = await queue.getFailed(failedOffset, failedOffset + 99);
    failedOffset = failedJobs.length === 100 ? failedOffset + 100 : 0;
    for (const job of failedJobs) {
      const run = await repository.get(String(job.data.runId));
      if (
        run &&
        !terminalStatuses.includes(run.status) &&
        run.status !== 'waiting_approval' &&
        run.execution === Number(job.data.execution ?? 0)
      )
        await recordFailedJob(job, new Error(job.failedReason));
    }
  })()
    .catch((err) => logger.error({ err }, 'Reliability maintenance will retry'))
    .finally(() => {
      maintaining = false;
    });
}, 5000).unref();
const heartbeat = setInterval(
  () =>
    logger.info(
      { running: worker.isRunning(), redis: connection.status },
      'Worker health',
    ),
  30000,
).unref();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  await stopChaos();
  clearInterval(maintenance);
  const timeout = setTimeout(() => process.exit(1), 20000).unref();
  await worker.close();
  await queue.close();
  connection.disconnect();
  await executor.close();
  smtp.close();
  await mongo.close();
  clearTimeout(timeout);
  logger.info('Worker stopped');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
