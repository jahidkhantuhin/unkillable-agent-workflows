import { existsSync } from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
if (!process.env.CI && process.env.HUSKY !== '0' && existsSync('.git')) {
  const result = spawnSync(process.execPath, ['node_modules/husky/bin.js'], {
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
}
