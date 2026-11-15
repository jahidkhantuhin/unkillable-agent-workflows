import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import {
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
} from 'node:timers';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const service = process.argv[2];
if (
  !['worker', 'api'].includes(service) ||
  process.env.CHAOS_ENABLED !== 'true' ||
  (process.env.NODE_ENV ?? 'development') !== 'development'
)
  throw new Error(
    'Supervisor requires api/worker, development mode and CHAOS_ENABLED=true',
  );
const delay = Number(process.env.CHAOS_RESTART_DELAY_MS ?? 1000);
if (!Number.isInteger(delay) || delay < 100 || delay > 30000)
  throw new Error('CHAOS_RESTART_DELAY_MS must be 100–30000');
const require = createRequire(resolve(root, 'apps/worker/package.json'));
const { Redis } = require('ioredis');
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2000,
});
redis.on('error', () => {});
const prefix = `unkillable:chaos:${process.env.RUN_QUEUE_NAME ?? 'workflow-runs'}`;
const lease = `${prefix}:lease:${service}`,
  status = `${prefix}:supervisor:${service}`,
  owner = randomUUID();
let acquired = false;
const leaseDeadline = Date.now() + 11000;
while (Date.now() < leaseDeadline) {
  if ((await redis.set(lease, owner, 'EX', 10, 'NX')) === 'OK') {
    acquired = true;
    break;
  }
  await sleep(250);
}
if (!acquired) {
  redis.disconnect();
  throw new Error(`A ${service} supervisor already owns this queue`);
}
let child,
  instance,
  state = 'starting',
  restarts = 0,
  stopping = false,
  restartTimer;
async function publish() {
  await redis.setex(status, 4, JSON.stringify({ state, instance, restarts }));
}
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  clearTimeout(restartTimer);
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = new Promise((resolve) => child.once('exit', resolve));
    if (process.platform === 'win32')
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    else child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 12000).unref();
    await done;
    clearTimeout(force);
  }
  await redis
    .eval(
      "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('DEL',KEYS[1]);redis.call('DEL',KEYS[2]);return 1 end return 0",
      2,
      lease,
      status,
      owner,
    )
    .catch(() => {});
  redis.disconnect();
}
const heartbeat = setInterval(
  () =>
    void (async () => {
      const owned = await redis.eval(
        "local current=redis.call('GET',KEYS[1]); if current == ARGV[1] then return redis.call('EXPIRE',KEYS[1],10) elseif not current then redis.call('SET',KEYS[1],ARGV[1],'EX',10); return 1 end return 0",
        1,
        lease,
        owner,
      );
      if (!owned) {
        await stop();
        process.exitCode = 1;
        return;
      }
      await publish();
    })().catch(() => {}),
  1000,
);
function launch() {
  if (stopping) return;
  instance = randomUUID();
  state = restarts ? 'restarting' : 'starting';
  void publish().catch(() => {});
  child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(root, `apps/${service}/src/index.ts`)],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        CHAOS_INSTANCE_ID: instance,
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    },
  );
  child.on('message', (message) => {
    if (message?.type === `${service}-ready`) {
      state = 'up';
      void publish().catch(() => {});
    }
  });
  child.on('error', (error) =>
    console.error(`[supervisor] ${service}: ${error.message}`),
  );
  child.once('exit', () => {
    if (stopping) return;
    restarts++;
    state = 'restarting';
    void publish().catch(() => {});
    console.log(`[supervisor] ${service} restarting in ${delay}ms`);
    restartTimer = setTimeout(launch, delay);
  });
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
launch();
