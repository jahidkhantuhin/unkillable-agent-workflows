import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const chaos =
  process.env.CHAOS_ENABLED === 'true' &&
  (process.env.NODE_ENV ?? 'development') === 'development';
const require = createRequire(join(root, 'package.json'));
const windows = process.platform === 'win32';
const stateFile = join(
  tmpdir(),
  `unkillable-dev-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`,
);
function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}
function commandFor(pid) {
  const result = windows
    ? spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ],
        { encoding: 'utf8', windowsHide: true },
      )
    : spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
function owned(record) {
  return (
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.entry === 'string' &&
    record.entry.startsWith(root + sep) &&
    commandFor(record.pid).toLowerCase().includes(record.entry.toLowerCase())
  );
}
function terminate(record, force = false) {
  if (windows) {
    // Windows signals do not reliably stop nested CLI children; target this tree only.
    const result = spawnSync(
      'taskkill.exe',
      ['/PID', String(record.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    return result.status === 0;
  }
  try {
    process.kill(-record.pid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
function removeState(owner) {
  if (readState()?.owner === owner) {
    try {
      unlinkSync(stateFile);
    } catch {
      /* already removed */
    }
  }
}
if (process.argv.includes('--stop')) {
  const state = readState();
  if (!state || state.root !== root || !Array.isArray(state.children)) {
    process.stdout.write('No managed dev session found.\n');
  } else {
    writeFileSync(stateFile, JSON.stringify({ ...state, stopping: true }));
    for (const record of state.children)
      if (owned(record)) {
        terminate(record, true);
        process.stdout.write(`Stopped workspace dev tree ${record.pid}.\n`);
      }
    removeState(state.owner);
  }
} else {
  const previous = readState();
  if (previous?.root === root && previous.children?.some(owned)) {
    process.stderr.write(
      'A managed dev session is already running. Use pnpm dev:stop first.\n',
    );
    process.exitCode = 1;
  } else {
    const webRequire = createRequire(join(root, 'apps/web/package.json'));
    const tsx = require.resolve('tsx/cli');
    const services = [
      {
        name: 'web',
        cwd: join(root, 'apps/web'),
        entry: webRequire.resolve('next/dist/bin/next'),
        args: ['dev', '--webpack'],
      },
      {
        name: 'api',
        cwd: join(root, 'apps/api'),
        entry: chaos ? join(root, 'scripts/supervise.mjs') : tsx,
        args: chaos
          ? ['api']
          : ['watch', '--env-file=../../.env', 'src/index.ts'],
      },
      {
        name: 'worker',
        cwd: join(root, 'apps/worker'),
        entry: chaos ? join(root, 'scripts/supervise.mjs') : tsx,
        args: chaos
          ? ['worker']
          : ['watch', '--env-file=../../.env', 'src/index.ts'],
      },
    ];
    const children = [];
    let stopping = false;
    function forceAll() {
      for (const record of children) terminate(record, true);
    }
    async function shutdown(code = 0) {
      if (stopping) {
        forceAll();
        return;
      }
      stopping = true;
      process.stdout.write('\n[dev] Stopping web, API, and worker…\n');
      for (const record of children) terminate(record);
      const force = setTimeout(forceAll, 5000);
      const deadline = setTimeout(() => {
        forceAll();
        removeState(process.pid);
        process.exit(1);
      }, 8000);
      await Promise.all(children.map((record) => record.closed));
      forceAll();
      clearTimeout(force);
      clearTimeout(deadline);
      removeState(process.pid);
      process.exitCode = code;
      process.stdout.write('[dev] All development processes stopped.\n');
    }
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    process.on('exit', () => removeState(process.pid));
    for (const service of services) {
      const child = spawn(process.execPath, [service.entry, ...service.args], {
        cwd: service.cwd,
        stdio: 'inherit',
        detached: !windows,
        windowsHide: true,
      });
      const record = {
        pid: child.pid,
        entry: service.entry,
        closed: new Promise((resolveClosed) =>
          child.once('close', resolveClosed),
        ),
      };
      children.push(record);
      child.once('error', (error) => {
        process.stderr.write(`[dev] ${service.name}: ${error.message}\n`);
        void shutdown(1);
      });
      child.once('exit', (code) => {
        const requested = readState();
        if (!stopping)
          void shutdown(
            requested?.owner === process.pid && requested.stopping
              ? 0
              : (code ?? 1),
          );
      });
      process.stdout.write(
        `[dev] ${service.name} started (PID ${child.pid}).\n`,
      );
    }
    writeFileSync(
      stateFile,
      JSON.stringify({
        root,
        owner: process.pid,
        children: children.map(({ pid, entry }) => ({ pid, entry })),
      }),
    );
  }
}
