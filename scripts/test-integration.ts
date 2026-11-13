import { spawnSync } from 'node:child_process';
if (!process.env.MONGODB_URI)
  throw new Error('Set MONGODB_URI in .env before integration tests');
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'apps/api/src/database.integration.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, INTEGRATION_MONGODB_URI: process.env.MONGODB_URI },
  },
);
process.exitCode = result.status ?? 1;
