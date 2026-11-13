import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';
import pino from 'pino';
import { configSchema } from './config';
import { createApp } from './app';
import { bootstrapIndexes } from './repositories/indexes';
import { MongoMembershipRepository } from './repositories/documents';
import { createMongoAuth } from './auth';
import { AuthService } from './services/auth';
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
);
const server = app.listen(config.API_PORT, () =>
  logger.info({ port: config.API_PORT }, 'API listening'),
);
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
  const timeout = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await mongo.close();
    redis.disconnect();
    clearTimeout(timeout);
    logger.info('API stopped');
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
