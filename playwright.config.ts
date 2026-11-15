import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const cleanupToken = randomUUID();
export default defineConfig({
  metadata: { cleanupToken },
  globalTeardown: './e2e/teardown.ts',
  testDir: './e2e',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    env: { E2E_CLEANUP_TOKEN: cleanupToken },
    command: 'node --import tsx apps/api/src/e2e-server.ts',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
  },
});
