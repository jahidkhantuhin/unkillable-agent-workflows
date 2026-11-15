import type { FullConfig } from '@playwright/test';
export default async function teardown(config: FullConfig) {
  // This loopback harness can only clean up resources it created, not arbitrary databases.
  await fetch('http://127.0.0.1:4101/cleanup', {
    method: 'POST',
    headers: { 'x-e2e-cleanup': String(config.metadata.cleanupToken) },
    signal: AbortSignal.timeout(20000),
  })
    .then((response) => {
      if (!response.ok) throw new Error('E2E cleanup failed');
    })
    .catch((error) => {
      console.error('E2E cleanup not confirmed:', error.message);
    });
}
