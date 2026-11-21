import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareDemoEnvironment } from './demo-environment';
it('creates a private mock-only environment and never overwrites an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unkillable-demo-env-'));
  try {
    await writeFile(
      join(root, '.env.example'),
      'BETTER_AUTH_SECRET=placeholder\nSUPPORT_LLM_PROVIDER=gemini\nTELEGRAM_ENABLED=true\nWHATSAPP_ENABLED=true\nCHAOS_ENABLED=true\n',
    );
    expect(await prepareDemoEnvironment(root)).toEqual({ created: true });
    const first = await readFile(join(root, '.env'), 'utf8');
    expect(first).toMatch(/BETTER_AUTH_SECRET=[a-f0-9]{64}/);
    expect(first).toContain('SUPPORT_LLM_PROVIDER=mock');
    expect(first).toContain('TELEGRAM_ENABLED=false');
    expect(first).toContain('WHATSAPP_ENABLED=false');
    expect(await prepareDemoEnvironment(root)).toEqual({ created: false });
    expect(await readFile(join(root, '.env'), 'utf8')).toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
