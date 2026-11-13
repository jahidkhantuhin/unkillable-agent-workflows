import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { infrastructureSchema, queueName } from '@unkillable/shared';
const config = infrastructureSchema.parse(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) =>
  logger.error({ err }, 'Worker Redis unavailable'),
);
const worker = new Worker(
  queueName,
  async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Foundation job received');
  },
  { connection },
);
worker.on('ready', () => logger.info('Worker ready'));
worker.on('error', (err) => logger.error({ err }, 'Worker error'));
worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err }, 'Job failed'),
);
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
  const timeout = setTimeout(() => process.exit(1), 10000).unref();
  await worker.close();
  connection.disconnect();
  clearTimeout(timeout);
  logger.info('Worker stopped');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
