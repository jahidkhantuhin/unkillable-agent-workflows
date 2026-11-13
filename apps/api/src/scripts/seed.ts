import { z } from 'zod';
import { MongoClient } from 'mongodb';
import { registerSchema, roleSchema } from '@unkillable/shared';
import { configSchema } from '../config';
import { bootstrapIndexes } from '../repositories/indexes';
import {
  MongoMembershipRepository,
  UserRepository,
} from '../repositories/documents';
import { createMongoAuth } from '../auth';
const config = configSchema.parse(process.env);
if (config.NODE_ENV === 'production')
  throw new Error('The local seed command is disabled in production');
const input = registerSchema.parse({
  name: process.env.SEED_NAME ?? 'Jahid Khan Tuhin',
  email: process.env.SEED_EMAIL,
  password: process.env.SEED_PASSWORD,
});
const role = roleSchema.parse(process.env.SEED_ROLE ?? 'admin');
z.email().parse(input.email);
const client = new MongoClient(config.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});
try {
  await client.connect();
  await bootstrapIndexes(client.db());
  const memberships = new MongoMembershipRepository(client.db());
  const users = new UserRepository(client.db());
  const auth = createMongoAuth(client, memberships, {
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: config.CORS_ORIGINS,
  });
  let user = await users.byEmail(input.email);
  if (!user) {
    await auth.api.signUpEmail({ body: input });
    user = await users.byEmail(input.email);
  }
  if (!user) throw new Error('Seed user was not persisted');
  await memberships.ensureViewer(user.id);
  await memberships.setRole(user.id, role);
  console.log(
    `Local seed user ready with role ${role}; existing passwords are not changed`,
  );
} finally {
  await client.close();
}
