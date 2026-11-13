import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import {
  infrastructureSchema,
  workerConfigSchema,
  runIdParamsSchema,
  terminalStatuses,
} from '@unkillable/shared';
import { RunRepository } from '@unkillable/storage';
import { createExecutor } from './executor';
const config = {
  ...infrastructureSchema.parse(process.env),
  ...workerConfigSchema.parse(process.env),
};
const logger = pino({ level: config.LOG_LEVEL });
const mongo = new MongoClient(config.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});
await mongo.connect();
const repository = new RunRepository(mongo);
const executor = await createExecutor(
  repository,
  config.MONGODB_URI,
  mongo.db().databaseName,
  config.DEMO_NODE_DELAY_MS,
);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) =>
  logger.error({ err }, 'Worker Redis unavailable'),
);
const worker = new Worker(
  config.RUN_QUEUE_NAME,
  async (job) => {
    const { id } = runIdParamsSchema.parse({ id: job.data.runId });
    logger.info({ runId: id }, 'Executing durable run');
    await executor.execute(id);
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
worker.on('ready', () => {
  logger.info('Worker ready');
  process.send?.({ type: 'worker-ready' });
});
worker.on('error', (err) => logger.error({ err }, 'Worker error'));
worker.on('stalled', (jobId) =>
  logger.warn({ jobId }, 'Stalled job recovered; resuming its checkpoint'),
);
worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Job failed');
  void (async () => {
    const id = job?.data?.runId;
    if (typeof id !== 'string') return;
    const run = await repository.get(id);
    if (run && !terminalStatuses.includes(run.status))
      await repository.append(
        id,
        {
          type: 'RUN_ERROR',
          code: 'EXECUTION_FAILED',
          message: 'Workflow execution failed',
        },
        {
          key: 'run:failed',
          status: 'failed',
          error: 'Workflow execution failed',
        },
      );
  })().catch((error) =>
    logger.error({ err: error }, 'Unable to record run failure'),
  );
});
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
  const timeout = setTimeout(() => process.exit(1), 20000).unref();
  await worker.close();
  connection.disconnect();
  await executor.close();
  await mongo.close();
  clearTimeout(timeout);
  logger.info('Worker stopped');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
