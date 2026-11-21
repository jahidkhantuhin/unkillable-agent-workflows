import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { seedReleaseDemo } from './services/demo-seed';
import { configSchema } from './config';
import { RunRepository, PolicyRepository } from '@unkillable/storage';
import {
  releaseDemoTicket,
  releaseDemoPolicy,
  evaluateApprovalPolicy,
} from '@unkillable/shared';
const uri = process.env.INTEGRATION_MONGODB_URI;
describe.skipIf(!uri)('release demo seed', () => {
  const url = new URL(uri ?? 'mongodb://127.0.0.1:27017');
  url.pathname = `/unkillable_test_${randomUUID().replaceAll('-', '')}`;
  const client = new MongoClient(url.toString());
  const config = configSchema.parse({
    NODE_ENV: 'test',
    MONGODB_URI: url.toString(),
    REDIS_URL: 'redis://127.0.0.1:6379',
    BETTER_AUTH_SECRET: 'local-demo-seed-test-secret-at-least-32',
  });
  beforeAll(() => client.connect());
  afterAll(async () => {
    try {
      if (!/^unkillable_test_[a-f0-9]{32}$/.test(client.db().databaseName))
        throw new Error(
          'Refusing cleanup outside the isolated seed-test database',
        );
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }
  });
  it('seeds exact synthetic fixture, distinct roles and a safe policy without creating a run', async () => {
    const first = await seedReleaseDemo(client, config);
    expect(first.users.map((u) => u.role)).toEqual(['admin', 'approver']);
    expect(first.users[0].id).not.toBe(first.users[1].id);
    expect(await client.db().collection('runs').countDocuments()).toBe(0);
    expect(
      (await new RunRepository(client).support().examples()).find(
        (e) => e.id === releaseDemoTicket.id,
      ),
    ).toEqual(releaseDemoTicket);
    const decision = evaluateApprovalPolicy(
      releaseDemoPolicy,
      {
        action: 'support_reply',
        riskTier: 'high',
        amountCents: 4200,
        confidence: 0.98,
        customerTier: 'standard',
        hourUtc: 12,
      },
      1,
    );
    expect(decision.outcome).toBe('require_approval');
    expect(decision.trace.at(-1)!.ruleId).toBe('safety-floor');
    const second = await seedReleaseDemo(client, config);
    expect(second.users).toEqual(first.users);
    expect(await client.db().collection('users').countDocuments()).toBe(2);
    expect(
      await client.db().collection('approvalPolicyVersions').countDocuments(),
    ).toBe(1);
  });
  it('preserves custom policies and refuses production or non-synthetic account inputs', async () => {
    await expect(
      seedReleaseDemo(client, config, {
        DEMO_ADMIN_EMAIL: 'person@example.com',
      }),
    ).rejects.toThrow();
    const policies = new PolicyRepository(client),
      head = await policies.current();
    await policies.save(
      head.version,
      { name: 'Custom policy', rules: [], fallback: 'require_two_approvals' },
      'local-admin',
    );
    await expect(seedReleaseDemo(client, config)).rejects.toThrow('preserved');
    expect((await policies.current()).policy.name).toBe('Custom policy');
    await expect(
      seedReleaseDemo(client, { ...config, NODE_ENV: 'production' }),
    ).rejects.toThrow('production');
  });
});
