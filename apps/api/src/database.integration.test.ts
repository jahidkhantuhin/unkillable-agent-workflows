import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { bootstrapIndexes, collectionIndexes } from './repositories/indexes';
import {
  DocumentRepository,
  MongoMembershipRepository,
} from './repositories/documents';
import { idempotencyKeySchema } from '@unkillable/shared';
import { createMongoAuth } from './auth';
import { AuthService } from './services/auth';
import { createApp } from './app';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('MongoDB auth and index integration', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017', {
    serverSelectionTimeoutMS: 5000,
  });
  const db = client.db(`unkillable_test_${randomUUID().replaceAll('-', '')}`);
  beforeAll(async () => {
    await client.connect();
    await bootstrapIndexes(db);
  }, 30000);
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
  it('bootstraps all collections repeatedly and rejects duplicate idempotency keys', async () => {
    await bootstrapIndexes(db);
    const names = (await db.listCollections().toArray()).map(
      (value) => value.name,
    );
    for (const name of Object.keys(collectionIndexes))
      expect(names).toContain(name);
    const repository = new DocumentRepository(
      db,
      'idempotencyKeys',
      idempotencyKeySchema,
    );
    const now = new Date();
    const document = {
      id: randomUUID(),
      key: 'run:node:stable',
      runId: 'run',
      nodeId: 'node',
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    };
    await repository.insert(document);
    await expect(
      repository.insert({ ...document, id: randomUUID() }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await repository.get(document.id)).toEqual(document);
    await expect(
      repository.insert({ ...document, id: randomUUID(), key: '' }),
    ).rejects.toThrow();
  });
  it('persists auth sessions across API instances and enforces role changes', async () => {
    const memberships = new MongoMembershipRepository(db);
    // Pass the isolated database explicitly; the adapter still uses real transactions.
    const config = {
      secret: 'integration-test-secret-that-is-long-enough-123456',
      baseURL: 'http://localhost:4000',
      trustedOrigins: ['http://localhost:3000'],
      test: true,
    };
    const auth = createMongoAuth(client, memberships, config, db);
    const app = createApp(
      { mongo: async () => true, redis: async () => true },
      config.trustedOrigins,
      'silent',
      new AuthService(auth, memberships, config.baseURL),
    );
    const signed = await request(app)
      .post('/auth/register')
      .set('Origin', config.trustedOrigins[0])
      .send({
        name: 'Mongo Test',
        email: 'mongo@example.test',
        password: 'strong-local-test-password',
      });
    expect(signed.status, JSON.stringify(signed.body)).toBe(201);
    const cookie = (signed.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    const second = createApp(
      { mongo: async () => true, redis: async () => true },
      config.trustedOrigins,
      'silent',
      new AuthService(
        createMongoAuth(client, memberships, config, db),
        memberships,
        config.baseURL,
      ),
    );
    expect(
      (await request(second).get('/auth/me').set('Cookie', cookie)).body.role,
    ).toBe('viewer');
    await memberships.setRole(signed.body.user.id, 'admin');
    expect(
      (await request(second).get('/auth/access/chaos').set('Cookie', cookie))
        .status,
    ).toBe(200);
    expect(
      (
        await request(second)
          .post('/auth/logout')
          .set('Origin', config.trustedOrigins[0])
          .set('Cookie', cookie)
          .send({})
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get('/auth/me').set('Cookie', cookie)).status,
    ).toBe(401);
  }, 30000);
});
