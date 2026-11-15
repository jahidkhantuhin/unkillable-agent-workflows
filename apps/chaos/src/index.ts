import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve, relative, sep } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient, type Document } from 'mongodb';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { RunRepository } from '@unkillable/storage';
import {
  runDTOSchema,
  chaosStatusSchema,
  chaosPrefix,
  type RunDTO,
} from '@unkillable/shared';
import {
  settingsSchema,
  schedule,
  kinds,
  distribution,
  type Plan,
} from './config';
import { check, type Evidence } from './check';

const args: Record<string, unknown> = {};
const options: Record<string, string> = {
  runs: 'runs',
  seed: 'seed',
  'batch-size': 'batchSize',
  'timeout-ms': 'timeoutMs',
  'report-dir': 'reportDir',
  rates: 'rates',
};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--') continue;
  if (arg === '--keep-data') {
    args.keepData = true;
    continue;
  }
  const key = options[arg.replace(/^--/, '')];
  if (!key || !arg.startsWith('--') || process.argv[i + 1] === undefined)
    throw new Error(`Unknown/incomplete chaos option: ${arg}`);
  const value = process.argv[++i];
  args[key] = key === 'rates' ? JSON.parse(value) : value;
}
const config = settingsSchema.parse(args),
  plans = schedule(config),
  root = resolve(import.meta.dirname, '../../..');
const output = resolve(root, config.reportDir);
if (
  relative(resolve(root, 'docs'), output).startsWith('..') ||
  relative(root, output).startsWith(`..${sep}`)
)
  throw new Error('Reports must remain within this repository docs directory');
function local(value: string | undefined, label: string) {
  if (!value) throw new Error(`Configure ${label} before running chaos`);
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error(`${label} must target local test services`);
  return url;
}
const mongoURL = local(process.env.MONGODB_URI, 'MONGODB_URI');
local(process.env.REDIS_URL, 'REDIS_URL');
const mailpit = local(
  process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025',
  'MAILPIT_API_URL',
).origin;
const id = randomUUID().replaceAll('-', ''),
  name = `unkillable_chaos_${id}`;
mongoURL.pathname = `/${name}`;
const client = new MongoClient(mongoURL.toString(), {
    serverSelectionTimeoutMS: 5000,
  }),
  db = client.db(name),
  repository = new RunRepository(client, db);
const redis = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: 1,
  commandTimeout: 5000,
});
redis.on('error', () => {});
const queue = new Queue(name, {
  connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: 1 },
});
const children: ChildProcess[] = [],
  tracked: {
    plan: Plan;
    run: RunDTO;
    recipient: string;
    duplicateJobId?: string;
  }[] = [];
const started = Date.now();
let cookie = '',
  api = '',
  logs = '',
  fatal: string | null = null,
  stopped = false;
async function until<T>(
  read: () => Promise<T>,
  match: (value: T) => boolean,
  ms = config.timeoutMs,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (match(value)) return value;
    await sleep(80);
  }
  throw new Error(`Chaos condition timed out after ${ms}ms`);
}
async function request(path: string, body?: unknown) {
  const response = await fetch(`${api}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Chaos HTTP ${response.status} at ${path}`);
  if (path === '/auth/login')
    cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  return (await response.json()) as unknown;
}
function child(argv: string[], env: NodeJS.ProcessEnv) {
  const proc = spawn(process.execPath, argv, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(proc);
  proc.stdout?.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-12000);
  });
  proc.stderr?.on('data', (chunk) => {
    logs = (logs + String(chunk)).slice(-12000);
  });
  return proc;
}
async function cleanup() {
  if (stopped) return;
  stopped = true;
  for (const proc of children)
    if (proc.exitCode === null && proc.signalCode === null) {
      const done = new Promise<void>((resolve) =>
        proc.once('exit', () => resolve()),
      );
      if (process.platform === 'win32')
        spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else proc.kill('SIGTERM');
      await done;
    }
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
  const controls = await redis.keys(`${chaosPrefix(name)}:*`);
  if (controls.length) await redis.del(...controls);
  for (const item of tracked) {
    const flags = await redis.keys(`unkillable:fault:${item.run.id}:*`);
    if (flags.length) await redis.del(...flags);
  }
  redis.disconnect();
  if (!config.keepData) await db.dropDatabase();
  await client.close();
}
process.on('SIGINT', () => {
  fatal = 'Interrupted by operator';
  void cleanup().finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  fatal = 'Terminated by operator';
  void cleanup().finally(() => process.exit(143));
});
async function ready(target: 'api' | 'worker', previous?: string) {
  return until(
    async () => {
      try {
        return chaosStatusSchema.parse(await request('/chaos/status'))[target];
      } catch {
        return null;
      }
    },
    (value) =>
      value?.state === 'up' && (!previous || value.instance !== previous),
  );
}
async function inject(
  runId: string,
  node: string,
  mode: string,
  phase = 'after',
  delayMs?: number,
) {
  await request('/chaos/fault', {
    runId,
    node,
    phase,
    fault: mode === 'delay_ms' ? { mode, delayMs } : { mode },
  });
}
try {
  await client.connect();
  await redis.ping();
  const captureHealth = await fetch(`${mailpit}/api/v1/info`);
  if (!captureHealth.ok) throw new Error('Local Mailpit unavailable');
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const value = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(value));
    });
  });
  api = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    MONGODB_URI: mongoURL.toString(),
    REDIS_URL: process.env.REDIS_URL!,
    RUN_QUEUE_NAME: name,
    NODE_ENV: 'development',
    CHAOS_ENABLED: 'true',
    CHAOS_RESTART_DELAY_MS: '100',
    API_PORT: String(port),
    BETTER_AUTH_URL: api,
    BETTER_AUTH_SECRET:
      'chaos-harness-only-signing-secret-at-least-32-characters',
    CORS_ORIGINS: 'http://localhost:3000',
    SUPPORT_LLM_PROVIDER: 'mock',
    ORGMIND_RETRIEVER_ENABLED: 'false',
    MAILPIT_SMTP_HOST: '127.0.0.1',
    MAILPIT_SMTP_PORT: '1025',
    SEED_EMAIL: 'chaos-harness@example.test',
    SEED_PASSWORD: 'chaos-harness-local-password',
    SEED_NAME: 'Synthetic chaos reviewer',
    SEED_ROLE: 'admin',
    WORKER_LOCK_DURATION_MS: '2000',
    WORKER_STALLED_INTERVAL_MS: '1000',
    WORKER_MAX_STALLED_COUNT: '3',
    NODE_RETRY_POLICIES: JSON.stringify({
      send_email: {
        maxAttempts: 3,
        initialDelayMs: 20,
        maxDelayMs: 100,
        multiplier: 2,
        jitter: 0,
      },
    }),
    LOG_LEVEL: 'warn',
  };
  const seed = child(
    ['--import', 'tsx', resolve(root, 'apps/api/src/scripts/seed.ts')],
    env,
  );
  await new Promise<void>((resolve, reject) => {
    seed.once('error', reject);
    seed.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Isolated chaos seed failed')),
    );
  });
  child([resolve(root, 'scripts/supervise.mjs'), 'api'], env);
  child([resolve(root, 'scripts/supervise.mjs'), 'worker'], env);
  await until(async () => {
    try {
      return (
        await fetch(`${api}/health`, { signal: AbortSignal.timeout(1000) })
      ).ok;
    } catch {
      return false;
    }
  }, Boolean);
  await request('/auth/login', {
    email: env.SEED_EMAIL,
    password: env.SEED_PASSWORD,
  });
  await ready('api');
  await ready('worker');
  console.log(
    `Chaos seed=${config.seed}, runs=${config.runs}, batch=${config.batchSize}, MockLLM; isolated ${name}`,
  );
  for (let offset = 0; offset < plans.length; offset += config.batchSize) {
    const batch = await Promise.all(
      plans.slice(offset, offset + config.batchSize).map(async (plan) => {
        const recipient = `${id}-${plan.index}@chaos.test`;
        const run = runDTOSchema.parse(
          await request('/tickets', {
            title: `Chaos ${plan.index}: duplicate charge`,
            description:
              'I was charged twice for one order. Please refund the duplicate charge.',
            customerEmail: recipient,
            orderId: `CHAOS-${plan.index}`,
            amountCents: 4900,
            currency: 'USD',
          }),
        );
        const item = {
          plan,
          run,
          recipient,
          duplicateJobId: undefined as string | undefined,
        };
        tracked.push(item);
        return item;
      }),
    );
    await until(
      () =>
        db.collection('runs').countDocuments({
          id: { $in: batch.map((item) => item.run.id) },
          status: 'waiting_approval',
        }),
      (count) => count === batch.length,
    );
    for (const item of batch) {
      const { kind, delayMs } = item.plan,
        runId = item.run.id;
      if (kind === 'worker_crash')
        await inject(runId, 'send_email', 'crash_process');
      if (kind === 'throw_once')
        await inject(runId, 'send_email', 'throw_once', 'before');
      if (kind === 'permanent' || kind === 'compensation_crash')
        await inject(runId, 'close_ticket', 'throw_always');
      if (kind === 'compensation_crash')
        await inject(runId, 'reverse_refund', 'crash_process');
      if (kind === 'delay')
        await inject(runId, 'issue_refund', 'delay_ms', 'before', delayMs);
    }
    await Promise.all(
      batch.map(async (item) => {
        const approval = await repository.approvals().forRun(item.run.id);
        if (!approval) throw new Error('Pending approval missing');
        await request(`/approvals/${approval.id}/resolve`, {
          version: approval.version,
          decision: { action: 'approve' },
        });
      }),
    );
    for (const item of batch.filter((item) => item.plan.kind === 'duplicate')) {
      await until(
        async () => Boolean(await queue.getJob(`${item.run.id}-1`)),
        Boolean,
      );
      item.duplicateJobId = `duplicate-${item.run.id}`;
      await queue.add(
        'execute-run',
        { runId: item.run.id, execution: 1 },
        { jobId: item.duplicateJobId },
      );
      await repository.append(
        item.run.id,
        {
          type: 'CUSTOM',
          name: 'chaos.triggered',
          value: { mode: 'duplicate_delivery', jobId: item.duplicateJobId },
        },
        { allowTerminal: true },
      );
    }
    // API crashes occur after this batch's mutation acknowledgements: lost HTTP
    // responses are not mistaken for permission to submit duplicate tickets.
    for (const item of batch.filter((item) => item.plan.kind === 'api_kill')) {
      const before = await ready('api');
      await repository.append(
        item.run.id,
        {
          type: 'CUSTOM',
          name: 'chaos.triggered',
          value: { mode: 'api_kill' },
        },
        { allowTerminal: true },
      );
      await request('/chaos/kill', { target: 'api' });
      const after = await ready('api', before!.instance);
      await repository.append(
        item.run.id,
        {
          type: 'CUSTOM',
          name: 'chaos.api_recovered',
          value: { instance: after!.instance },
        },
        { allowTerminal: true },
      );
    }
    await until(
      () =>
        db.collection('runs').countDocuments({
          id: { $in: batch.map((item) => item.run.id) },
          status: {
            $in: ['succeeded', 'failed', 'compensated', 'cancelled'],
          },
        }),
      (count) => count === batch.length,
    );
    await until(
      async () =>
        (await queue.getActiveCount()) +
        (await queue.getWaitingCount()) +
        (await queue.getDelayedCount()),
      (count) => count === 0,
    );
    console.log(
      `Chaos completed ${Math.min(offset + config.batchSize, config.runs)}/${config.runs} (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
  }
} catch (error) {
  fatal = error instanceof Error ? error.message : String(error);
  console.error('Chaos execution failed:', fatal);
}

const evidence: Evidence[] = [];
const violations: { index: number; runId?: string; errors: string[] }[] = [];
const recovery: number[] = [],
  apiRecovery: number[] = [];
try {
  for (const plan of plans) {
    const item = tracked.find((item) => item.plan.index === plan.index);
    if (!item) {
      violations.push({ index: plan.index, errors: ['run was not created'] });
      continue;
    }
    const runId = item.run.id;
    const [run, refunds, emails, outbox, receipts, deliveries, ticket, events] =
      await Promise.all([
        db.collection('runs').findOne({ id: runId }),
        db.collection('fakeRefunds').find({ runId }).toArray(),
        db.collection('fakeEmails').find({ runId }).toArray(),
        db.collection('outbox').find({ runId }).toArray(),
        db.collection('idempotencyKeys').find({ runId }).toArray(),
        db.collection('localDeliveries').find({ runId }).toArray(),
        db.collection('tickets').findOne({ runId }),
        db
          .collection('runEvents')
          .find({ runId })
          .sort({ sequence: 1 })
          .toArray(),
      ]);
    const response = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${item.recipient}`)}`,
    );
    if (!response.ok) throw new Error('Mailpit evidence search failed');
    const capture = (await response.json()) as { messages: Document[] };
    const row: Evidence = {
      plan,
      run: run ?? undefined,
      refunds,
      emails,
      outbox,
      receipts,
      deliveries,
      ticket: ticket ?? undefined,
      captures: capture.messages.length,
      events,
    };
    evidence.push(row);
    if (evidence.length % 50 === 0)
      console.log(`Verified evidence ${evidence.length}/${config.runs}`);
    const errors = check(row, Date.now(), config.timeoutMs);
    const triggered = events.filter(
      (e) => e.type === 'CUSTOM' && e.name === 'chaos.triggered',
    );
    if (
      ['worker_crash', 'compensation_crash'].includes(plan.kind) &&
      !triggered.some((e) => e.value.mode === 'crash_process')
    )
      errors.push('planned worker crash not observed');
    if (
      ['permanent', 'compensation_crash'].includes(plan.kind) &&
      !triggered.some((e) => e.value.mode === 'throw_always')
    )
      errors.push('planned permanent failure not observed');
    if (
      plan.kind === 'throw_once' &&
      !triggered.some((e) => e.value.mode === 'throw_once')
    )
      errors.push('planned transient failure not observed');
    if (
      plan.kind === 'delay' &&
      !triggered.some((e) => e.value.mode === 'delay_ms')
    )
      errors.push('planned delay not observed');
    if (item.duplicateJobId) {
      const job = await queue.getJob(item.duplicateJobId);
      const primary = await queue.getJob(`${runId}-1`);
      if (!primary?.processedOn || (await primary.getState()) !== 'completed')
        errors.push('primary job was not processed alongside duplicate');
      if (!job?.processedOn || (await job.getState()) !== 'completed')
        errors.push('duplicate job was not processed');
    }
    for (const marker of triggered.filter(
      (e) => e.value.mode === 'crash_process',
    )) {
      const resumed = events.find(
        (e) =>
          e.sequence > marker.sequence &&
          e.type === 'CUSTOM' &&
          ['run.resumed', 'compensation.resumed'].includes(e.name),
      );
      if (resumed) recovery.push(resumed.timestamp - marker.timestamp);
      else errors.push('worker recovery event missing');
    }
    for (const marker of triggered.filter((e) => e.value.mode === 'api_kill')) {
      const up = events.find(
        (e) => e.sequence > marker.sequence && e.name === 'chaos.api_recovered',
      );
      if (up) apiRecovery.push(up.timestamp - marker.timestamp);
      else errors.push('API recovery event missing');
    }
    if (errors.length) violations.push({ index: plan.index, runId, errors });
  }
} catch (error) {
  fatal = `${fatal ?? ''} Evidence collection: ${error instanceof Error ? error.message : String(error)}`;
}
let actualRunCount = 0;
try {
  actualRunCount = await db.collection('runs').countDocuments();
  if (actualRunCount !== config.runs)
    violations.push({
      index: -1,
      errors: [
        `MongoDB contains ${actualRunCount} runs; expected ${config.runs}`,
      ],
    });
} catch (error) {
  fatal = `${fatal ?? ''} Run inventory: ${error instanceof Error ? error.message : String(error)}`;
}
const ended = Date.now();
const report = {
  schemaVersion: 1,
  author: 'Jahid Khan Tuhin',
  generatedAt: new Date(ended).toISOString(),
  passed: !fatal && violations.length === 0 && evidence.length === config.runs,
  config: {
    ...config,
    coverage:
      'ensure each enabled scenario once, then seeded weighted schedule/shuffle',
    provider: 'MockLLM',
    workflow: 'support-ticket-router v1',
    workerConcurrency: 1,
    lockDurationMs: 2000,
    stalledIntervalMs: 1000,
    restartDelayMs: 100,
    retryInitialDelayMs: 20,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    mongodbDriver: '7.9.0',
    bullmq: '6.7.6',
    redisClient: '6.0.0',
  },
  scope: {
    database: name,
    queue: name,
    isolated: true,
    keepData: config.keepData,
  },
  durationMs: ended - started,
  planned: Object.fromEntries(
    kinds.map((kind) => [
      kind,
      plans.filter((plan) => plan.kind === kind).length,
    ]),
  ),
  results: {
    requested: config.runs,
    created: actualRunCount,
    terminal: evidence.filter((row) =>
      ['succeeded', 'compensated', 'failed', 'cancelled'].includes(
        row.run?.status,
      ),
    ).length,
    succeeded: evidence.filter((row) => row.run?.status === 'succeeded').length,
    compensated: evidence.filter((row) => row.run?.status === 'compensated')
      .length,
    duplicateRefunds: evidence.reduce(
      (sum, row) => sum + Math.max(0, row.refunds.length - 1),
      0,
    ),
    duplicateEmails: evidence.reduce(
      (sum, row) =>
        sum +
        ['reply', 'correction'].reduce(
          (n, purpose) =>
            n +
            Math.max(
              0,
              row.emails.filter(
                (email) => (email.purpose ?? 'reply') === purpose,
              ).length - 1,
            ),
          0,
        ),
      0,
    ),
    duplicateMailpitCaptures: evidence.reduce(
      (sum, row) =>
        sum +
        Math.max(
          0,
          row.captures -
            (['permanent', 'compensation_crash'].includes(row.plan.kind)
              ? 2
              : 1),
        ),
      0,
    ),
    lostRuns:
      config.runs -
      evidence.filter((row) =>
        ['succeeded', 'compensated', 'failed', 'cancelled'].includes(
          row.run?.status,
        ),
      ).length,
    stuckRunning: evidence.filter(
      (row) =>
        row.run?.status === 'running' &&
        ended - new Date(row.run.updatedAt).getTime() > config.timeoutMs,
    ).length,
    refundRecords: evidence.reduce((n, row) => n + row.refunds.length, 0),
    emailRecords: evidence.reduce((n, row) => n + row.emails.length, 0),
    mailpitCaptures: evidence.reduce((n, row) => n + row.captures, 0),
  },
  recovery: { worker: distribution(recovery), api: distribution(apiRecovery) },
  violations,
  fatal,
  runs: evidence.map((row) => ({
    index: row.plan.index,
    kind: row.plan.kind,
    runId: row.run?.id,
    status: row.run?.status,
    refunds: row.refunds.length,
    emails: row.emails.length,
    mailpitCaptures: row.captures,
    ticketStatus: row.ticket?.status,
    refundStatuses: row.refunds.map((refund) => refund.status),
    emailStates: row.emails.map((email) => ({
      purpose: email.purpose ?? 'reply',
      status: email.status,
      voided: email.voided ?? false,
    })),
    compensationCompleted: row.run?.state.saga?.completed ?? [],
    recoveryEvents: row.events
      .filter(
        (event) =>
          event.type === 'CUSTOM' &&
          [
            'chaos.triggered',
            'run.resumed',
            'compensation.resumed',
            'chaos.api_recovered',
          ].includes(event.name),
      )
      .map((event) => ({
        sequence: event.sequence,
        timestamp: event.timestamp,
        name: event.name,
        mode: event.value.mode,
        nodeId: event.value.nodeId,
      })),
  })),
};
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, 'CHAOS-REPORT.json'),
  JSON.stringify(report, null, 2) + '\n',
);
const md = `# Chaos test report\n\nGenerated: ${report.generatedAt}. Author: Jahid Khan Tuhin.\n\n**${report.passed ? 'PASS' : 'FAIL'}** — ${report.results.terminal}/${config.runs} terminal runs; ${report.results.duplicateRefunds} duplicate refund records; ${report.results.duplicateEmails} duplicate email intents; ${report.results.duplicateMailpitCaptures} duplicate Mailpit captures; ${report.results.lostRuns} lost/nonterminal runs; ${violations.length} runs with invariant violations.\n\n## Configuration\n\nSeed ${config.seed}; batch size ${config.batchSize}; timeout ${config.timeoutMs} ms; MockLLM; one worker; isolated database/queue. Default CLI run count is 500. Each enabled scenario is guaranteed once before seeded weighted selection/shuffle. Seed repeats the fault schedule, not operating-system timing or random UUIDs. All decisions are synthetic test-admin approvals.\n\n| Scenario | Planned runs |\n| --- | ---: |\n${kinds.map((kind) => `| ${kind} | ${report.planned[kind]} |`).join('\n')}\n\nConfigured rates: ${JSON.stringify(config.rates)}.\n\n## Measured results\n\n| Metric | Value |\n| --- | ---: |\n${Object.entries(
  report.results,
)
  .map(([key, value]) => `| ${key} | ${value} |`)
  .join(
    '\n',
  )}\n| durationMs | ${report.durationMs} |\n\n## Recovery measured from persisted event timestamps\n\n| Recovery | Samples | p50 ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: |\n${Object.entries(
  report.recovery,
)
  .map(
    ([kind, value]) =>
      `| ${kind} | ${value.samples} | ${value.p50Ms ?? 'not measured'} | ${value.p95Ms ?? 'not measured'} | ${value.p99Ms ?? 'not measured'} |`,
  )
  .join(
    '\n',
  )}\n\nWorker recovery is the durable chaos.triggered crash marker to the first later run.resumed/compensation.resumed event. It includes process restart, queue lock/stalled recovery and checkpoint loading. API recovery is the harness-persisted kill-request marker to a new ready API instance observed through authenticated status polling; it includes polling overhead. These are local configured-test measurements, not production SLAs. Lock duration 2000 ms, stalled scan 1000 ms, supervisor delay 100 ms; these differ from normal dev defaults.\n\n## Method and boundaries\n\nThe harness creates support tickets through the actual isolated API, approves them as a synthetic seeded admin and uses supervised API/worker processes. Faults include crashes after committed email work, API kills after mutation acknowledgements, one-shot/permanent throws, delays, distinct duplicate jobs and a crash during compensation after refund reversal. Duplicate jobs have different IDs so BullMQ cannot discard them as an identical job ID. One worker processes them as redelivery, not parallel workers; earlier integration tests cover concurrent effects.\n\nMongoDB checks cover terminal/expected outcomes, refund/email cardinality and status, fully acknowledged outbox/deliveries, receipt uniqueness/completion, ticket state and ordered compensation. Mailpit search independently checks actual captures for each unique synthetic recipient. A correction is a separate intended email, not a duplicate. Exactly-once SMTP capture relies on configured Mailpit Message-ID deduplication and retained receiver data. No real payments, external customers, live AI models or provider quota.\n\nReproduce: start Docker services, then run pnpm chaos --runs ${config.runs} --seed ${config.seed} --batch-size ${config.batchSize} --timeout-ms ${config.timeoutMs}. Full options/rates and per-run evidence are in CHAOS-REPORT.json. The CI gate permits zero invariant violations and exits nonzero on failure, timeout or incomplete evidence.\n\n## Failures\n\n${fatal ?? 'No harness execution error.'}\n\n${violations.length ? violations.map((v) => `- Run ${v.index}: ${v.errors.join('; ')}`).join('\n') : 'No invariant violations.'}\n`;
await writeFile(resolve(output, 'CHAOS-REPORT.md'), md);
const formatting = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/prettier/bin/prettier.cjs'),
    '--write',
    resolve(output, 'CHAOS-REPORT.md'),
    resolve(output, 'CHAOS-REPORT.json'),
  ],
  { stdio: 'pipe', windowsHide: true },
);
if (formatting.status !== 0) {
  console.error('Report formatting failed');
  process.exitCode = 1;
}
try {
  await cleanup();
} catch (error) {
  console.error('Chaos cleanup failed:', error);
  process.exitCode = 1;
}
console.log(
  `${report.passed ? 'PASS' : 'FAIL'} chaos: ${JSON.stringify(report.results)}; report ${relative(root, output)}`,
);
if (!report.passed) {
  for (const violation of violations.slice(0, 20))
    console.error(`Run ${violation.index}: ${violation.errors.join('; ')}`);
  if (fatal) console.error(logs);
  process.exitCode = 1;
}
