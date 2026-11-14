import { spawnSync } from 'node:child_process';
if (!process.env.MONGODB_URI)
  throw new Error('Set MONGODB_URI in .env before integration tests');
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/api/src/database.integration.test.ts',
    'apps/api/src/runs.integration.test.ts',
    'apps/api/src/reliability.integration.test.ts',
    'apps/api/src/approvals.integration.test.ts',
    'apps/worker/src/recovery.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      INTEGRATION_MONGODB_URI: process.env.MONGODB_URI,
      INTEGRATION_REDIS_URL: process.env.REDIS_URL,
    },
  },
);
process.exitCode = result.status ?? 1;
