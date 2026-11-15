import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
const root = process.cwd();
if (!process.env.MONGODB_URI || !process.env.REDIS_URL)
  throw new Error(
    'Start local Docker services and configure MONGODB_URI/REDIS_URL',
  );
// Own database/queue/ports; never reuse a developer app or its authentication settings.
const name = `unkillable_e2e_${randomUUID().replaceAll('-', '')}`;
const uri = new URL(process.env.MONGODB_URI);
uri.pathname = `/${name}`;
const env = {
  ...process.env,
  REDIS_URL: process.env.REDIS_URL,
  MONGODB_URI: uri.toString(),
  RUN_QUEUE_NAME: name,
  NODE_ENV: 'test',
  API_PORT: '4100',
  BETTER_AUTH_URL: 'http://127.0.0.1:4100',
  BETTER_AUTH_SECRET: 'e2e-local-only-signing-secret-at-least-32-chars',
  CORS_ORIGINS: 'http://127.0.0.1:3100',
  API_INTERNAL_URL: 'http://127.0.0.1:4100',
  NEXT_PUBLIC_API_URL: 'http://127.0.0.1:4100',
  SUPPORT_LLM_PROVIDER: 'mock',
  ORGMIND_RETRIEVER_ENABLED: 'false',
  CHAOS_ENABLED: 'false',
  SEED_EMAIL: 'step8@example.test',
  SEED_PASSWORD: 'step8-local-test-password',
  SEED_NAME: 'Step 8 tester',
  SEED_ROLE: 'admin',
  LOG_LEVEL: 'warn',
};
const children: ChildProcess[] = [];
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    if (process.platform === 'win32')
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    else child.kill('SIGTERM');
    await done;
  }
  const queue = new Queue(name, {
    connection: { url: env.REDIS_URL!, maxRetriesPerRequest: 1 },
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
  const mongo = new MongoClient(uri.toString());
  await mongo.connect();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
  const keys = await redis.keys(`unkillable:chaos:${name}:*`);
  if (keys.length) await redis.del(...keys);
  const records = await mongo
    .db(name)
    .collection('runs')
    .find({}, { projection: { id: 1 } })
    .toArray();
  for (const row of records) {
    const flags = await redis.keys(`unkillable:fault:${row.id}:*`);
    if (flags.length) await redis.del(...flags);
  }
  redis.disconnect();
  await mongo.db(name).dropDatabase();
  await mongo.close();
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));
process.on('SIGTERM', () => void cleanup().then(() => process.exit(0)));
for (const port of [3100, 4100, 4101])
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(
        new Error(`E2E port ${port} is in use; existing apps were not stopped`),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
if (!process.env.E2E_CLEANUP_TOKEN)
  throw new Error('E2E must be started through Playwright');
const control = httpServer(async (req, res) => {
  if (
    req.method !== 'POST' ||
    req.url !== '/cleanup' ||
    req.headers['x-e2e-cleanup'] !== process.env.E2E_CLEANUP_TOKEN
  ) {
    res.writeHead(404).end();
    return;
  }
  try {
    await cleanup();
    res.end('Cleaned up');
    control.close();
  } catch (error) {
    console.error(error);
    res.writeHead(500).end();
  }
});
control.listen(4101, '127.0.0.1');
function child(
  args: string[],
  cwd = root,
  production = false,
  supervised = false,
) {
  const proc = spawn(process.execPath, args, {
    cwd,
    env: {
      ...env,
      NODE_ENV: production ? 'production' : supervised ? 'development' : 'test',
      CHAOS_ENABLED: supervised ? 'true' : 'false',
      CHAOS_RESTART_DELAY_MS: '300',
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  children.push(proc);
  return proc;
}
try {
  const seed = child([
    '--import',
    'tsx',
    resolve(root, 'apps/api/src/scripts/seed.ts'),
  ]);
  await new Promise<void>((resolve, reject) => {
    seed.once('error', reject);
    seed.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('E2E seed failed')),
    );
  });
  child([resolve(root, 'scripts/supervise.mjs'), 'api'], root, false, true);
  child([resolve(root, 'scripts/supervise.mjs'), 'worker'], root, false, true);
  const require = createRequire(resolve(root, 'apps/web/package.json'));
  child(
    [
      require.resolve('next/dist/bin/next'),
      'start',
      '-H',
      '127.0.0.1',
      '-p',
      '3100',
    ],
    resolve(root, 'apps/web'),
    true,
  );
} catch (error) {
  await cleanup();
  throw error;
}
