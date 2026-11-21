import { spawnSync } from 'node:child_process';
import { prepareDemoEnvironment } from '../apps/api/src/scripts/demo-environment';
const result = await prepareDemoEnvironment(process.cwd());
console.log(
  result.created
    ? 'Created private .env with a random auth secret, MockLLM and external channels disabled.'
    : 'Existing .env retained unchanged. For the deterministic demo, select MockLLM and disable optional external channels.',
);
const docker = spawnSync('docker', ['compose', 'up', '-d', '--wait'], {
  stdio: 'inherit',
  windowsHide: true,
});
if (docker.error) throw docker.error;
if (docker.status !== 0)
  throw new Error(
    'Docker setup failed; start Docker Desktop and rerun pnpm demo:setup',
  );
console.log('Local services ready. Next: pnpm seed:demo, then pnpm dev.');
