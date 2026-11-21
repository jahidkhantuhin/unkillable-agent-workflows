import type { MongoClient } from 'mongodb';
import {
  demoSeedConfigSchema,
  releaseDemoTicket,
  releaseDemoPolicy,
} from '@unkillable/shared';
import { SupportRepository, PolicyRepository } from '@unkillable/storage';
import { createMongoAuth } from '../auth';
import {
  MongoMembershipRepository,
  UserRepository,
} from '../repositories/documents';
import { bootstrapIndexes } from '../repositories/indexes';
import type { configSchema } from '../config';
import type { z } from 'zod';
export async function seedReleaseDemo(
  client: MongoClient,
  config: z.infer<typeof configSchema>,
  values: unknown = {},
) {
  if (config.NODE_ENV === 'production')
    throw new Error('Demo seeding is disabled in production');
  const hostname = new URL(config.MONGODB_URI).hostname;
  if (!['localhost', '127.0.0.1', '[::1]', 'mongo'].includes(hostname))
    throw new Error('Demo seeding requires local MongoDB');
  const input = demoSeedConfigSchema.parse(values),
    db = client.db(),
    policies = new PolicyRepository(client),
    head = await policies.current();
  if (
    head.version > 0 &&
    JSON.stringify(head.policy) !== JSON.stringify(releaseDemoPolicy)
  )
    throw new Error(
      'Existing approval policy preserved. Use an isolated demo database or explicitly activate the documented demo policy before seeding.',
    );
  await bootstrapIndexes(db);
  const members = new MongoMembershipRepository(db),
    users = new UserRepository(db),
    auth = createMongoAuth(client, members, {
      secret: config.BETTER_AUTH_SECRET,
      baseURL: config.BETTER_AUTH_URL,
      trustedOrigins: config.CORS_ORIGINS,
    });
  const result: { email: string; id: string; role: string }[] = [];
  for (const account of [
    {
      name: 'Demo administrator',
      email: input.DEMO_ADMIN_EMAIL,
      password: input.DEMO_ADMIN_PASSWORD,
      role: 'admin' as const,
    },
    {
      name: 'Demo approver',
      email: input.DEMO_APPROVER_EMAIL,
      password: input.DEMO_APPROVER_PASSWORD,
      role: 'approver' as const,
    },
  ]) {
    let user = await users.byEmail(account.email);
    if (!user) {
      await auth.api.signUpEmail({
        body: {
          name: account.name,
          email: account.email,
          password: account.password,
        },
      });
      user = await users.byEmail(account.email);
    } else {
      await auth.api.signInEmail({
        body: { email: account.email, password: account.password },
      });
    }
    if (!user) throw new Error('Demo account was not persisted');
    await members.ensureViewer(user.id);
    await members.setRole(user.id, account.role);
    result.push({ email: account.email, id: user.id, role: account.role });
  }
  const support = new SupportRepository(client);
  await support.seedExamples();
  await support.seedExample(releaseDemoTicket);
  if (head.version === 0)
    await policies.save(0, releaseDemoPolicy, result[0].id);
  return {
    users: result,
    exampleId: releaseDemoTicket.id,
    policy: releaseDemoPolicy.name,
  };
}
