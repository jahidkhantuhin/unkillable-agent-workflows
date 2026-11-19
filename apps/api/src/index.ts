import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import pino from 'pino';
import { configSchema } from './config';
import { createApp } from './app';
import { TimeTravelService } from './services/time-travel';
import { NotificationService } from './services/notifications';
import { ApprovalService } from './services/approvals';
import { ApprovalSigner } from './services/approval-signing';
import { NotificationRepository } from '@unkillable/storage';
import { WhatsAppRepository } from '@unkillable/storage';
import { WhatsAppService } from './services/whatsapp';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createMongoAuth } from './auth';
import { AuthService } from './services/auth';
import { Queue } from 'bullmq';
import { RunRepository } from '@unkillable/storage';
import { RunService } from './services/runs';
import { closeRunStreams } from './controllers/runs';
import { ChaosService } from './services/chaos';
import { startChaosRuntime } from '@unkillable/storage';
import { chaosEnabled } from '@unkillable/shared';
const config = configSchema.parse(process.env);
const logger = pino({ level: config.LOG_LEVEL });
const mongo = new MongoClient(config.MONGODB_URI, {
  serverSelectionTimeoutMS: 2000,
});
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2000,
  connectTimeout: 2000,
});
redis.on('error', (err) => logger.warn({ err }, 'Redis unavailable'));
await mongo.connect();
await bootstrapIndexes(mongo.db());
const memberships = new MongoMembershipRepository(mongo.db());
const auth = createMongoAuth(mongo, memberships, {
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  trustedOrigins: config.CORS_ORIGINS,
  production: config.NODE_ENV === 'production',
});
const queue = new Queue(config.RUN_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000, jitter: 0.2 },
  },
});
queue.on('error', (err) => logger.warn({ err }, 'Run queue unavailable'));
const runService = new RunService(new RunRepository(mongo), queue, (error) =>
  logger.warn({ err: error }, 'Run persisted; dispatch will be retried'),
);
await runService.initialize();
const notifications = new NotificationService(
  new NotificationRepository(mongo),
  new ApprovalService(runService.repository.approvals(), runService),
  runService,
  memberships,
  new ApprovalSigner(config.BETTER_AUTH_SECRET),
  config,
);
const notificationTimer = setInterval(() => {
  void notifications
    .deliver()
    .catch(() =>
      logger.warn(
        'Approval notification delivery deferred; web inbox remains available',
      ),
    );
}, 5000).unref();
const whatsapp = new WhatsAppService(
  new WhatsAppRepository(mongo),
  notifications,
  config,
);
const whatsappTimer = setInterval(() => {
  void whatsapp
    .deliver()
    .catch(() =>
      logger.warn(
        'WhatsApp delivery deferred; check Notification settings or use the web inbox',
      ),
    );
}, 5000).unref();
const dispatchTimer = setInterval(() => {
  void runService
    .reconcile()
    .catch((error) =>
      logger.warn({ err: error }, 'Queue reconciliation will retry'),
    );
}, 5000).unref();
void runService
  .reconcile()
  .catch((error) =>
    logger.warn({ err: error }, 'Startup queue reconciliation will retry'),
  );
const app = createApp(
  {
    mongo: async () => {
      await mongo.connect();
      return mongo.db().command({ ping: 1 });
    },
    redis: () => redis.ping(),
  },
  config.CORS_ORIGINS,
  config.LOG_LEVEL,
  new AuthService(auth, memberships, config.BETTER_AUTH_URL),
  runService,
  new ChaosService(
    redis,
    runService.repository,
    config.RUN_QUEUE_NAME,
    process.env,
  ),
  undefined,
  new TimeTravelService(
    runService,
    config.MONGODB_URI,
    mongo.db().databaseName,
  ),
  notifications,
  whatsapp,
);
let stopChaos = async () => {};
const server = app.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'API listening');
  stopChaos = startChaosRuntime(
    redis,
    config.RUN_QUEUE_NAME,
    'api',
    chaosEnabled(process.env),
  );
  process.send?.({ type: 'api-ready' });
});
server.on('error', (err) => {
  logger.fatal({ err }, 'API failed to listen');
  redis.disconnect();
  void mongo.close();
  process.exitCode = 1;
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(dispatchTimer);
  clearInterval(notificationTimer);
  clearInterval(whatsappTimer);
  await stopChaos();
  closeRunStreams();
  const timeout = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 10000).unref();
  server.close(async () => {
    await queue.close();
    await mongo.close();
    redis.disconnect();
    clearTimeout(timeout);
    logger.info('API stopped');
  });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
