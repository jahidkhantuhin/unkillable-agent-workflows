import { spawnSync } from 'node:child_process';
if (!process.env.MONGODB_URI)
  throw new Error('Set MONGODB_URI in .env before integration tests');
if (!process.env.REDIS_URL)
  throw new Error(
    'Set REDIS_URL in .env before integration tests; Redis-dependent suites must not be skipped',
  );
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--maxWorkers=2',
    'apps/api/src/database.integration.test.ts',
    'apps/api/src/runs.integration.test.ts',
    'apps/api/src/reliability.integration.test.ts',
    'apps/api/src/approvals.integration.test.ts',
    'apps/api/src/support.integration.test.ts',
    'apps/worker/src/recovery.integration.test.ts',
    'apps/worker/src/saga.integration.test.ts',
    'apps/api/src/chaos.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      INTEGRATION_MONGODB_URI: process.env.MONGODB_URI,
      INTEGRATION_REDIS_URL: process.env.REDIS_URL,
      INTEGRATION_MAILPIT_URL:
        process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025',
      SUPPORT_LLM_PROVIDER: 'mock',
    },
  },
);
process.exitCode = result.status ?? 1;
