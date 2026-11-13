import { betterAuth } from 'better-auth/minimal';
import type { BetterAuthOptions } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import type { MongoClient, Db } from 'mongodb';
import { userSchema } from '@unkillable/shared';
import type { MembershipRepository } from './repositories/documents';

export type AuthConfig = {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  production?: boolean;
  test?: boolean;
};
export function createAuth(
  database: BetterAuthOptions['database'],
  memberships: MembershipRepository,
  config: AuthConfig,
) {
  return betterAuth({
    appName: 'Unkillable',
    database,
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/auth',
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    user: { modelName: 'users' },
    session: {
      modelName: 'sessions',
      expiresIn: 60 * 60 * 24 * 7,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    advanced: {
      useSecureCookies: config.production ?? false,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    rateLimit: {
      enabled: !config.test,
      storage: 'database',
      modelName: 'authRateLimits',
      window: 60,
      max: 30,
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            userSchema.parse(user);
            await memberships.ensureViewer(user.id);
          },
        },
      },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
export function createMongoAuth(
  client: MongoClient,
  memberships: MembershipRepository,
  config: AuthConfig,
  database: Db = client.db(),
) {
  return createAuth(mongodbAdapter(database, { client }), memberships, config);
}
