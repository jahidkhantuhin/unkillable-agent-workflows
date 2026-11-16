# Step 9: Chaos control panel and process supervision

Chaos now has browser controls. The admin-only page can abruptly crash the worker or API, inject faults at a particular run/node/phase, slow upcoming support model calls, or simulate random retryable model errors. Run detail has the same run-specific fault controls. No Step 10 harness, recovery percentile or published chaos report is included.

## Setup

Use the existing root .env; do not replace signing keys or account settings. For repeatable demonstrations:

```env
NODE_ENV=development
SUPPORT_LLM_PROVIDER=mock
CHAOS_ENABLED=true
CHAOS_RESTART_DELAY_MS=1000
```

CHAOS_RESTART_DELAY_MS is the only new application setting, accepting 100–30000 milliseconds, default 1000. CHAOS_ENABLED still defaults false. Root pnpm dev selects supervisors only when development chaos is enabled; ordinary development keeps tsx watch. API/worker source changes require restarting pnpm dev in supervised mode; the web still uses Next's existing Webpack dev mode.

```powershell
pnpm dev:stop
docker compose up -d
pnpm dev
```

Sign in as admin and open Chaos. A red warning banner appears on signed-in pages whenever the API reports enabled mode. The panel polls API/worker supervision status and restart counts. If the API is down, the browser reports it unreachable and the worker status unknown until polling succeeds; it does not invent a worker heartbeat.

## Enable or pause from the UI

Once CHAOS_ENABLED=true is allowed in development and the app has been restarted, the admin Chaos page has an **Enable fault injection** switch:

| Status      | Meaning                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Active      | Crash buttons, run faults and Slow/Flaky model simulations are available; red warning banner is visible                              |
| Paused      | New injections are blocked, pending faults cleared, model profile reset and warning banner hidden; supervision and recovery continue |
| Unavailable | CHAOS_ENABLED=false or production mode; the disabled switch cannot override this hard lock                                           |

To test: set Slow LLM, turn the switch off, and check **Paused**, disabled crash/model buttons and **Current profile: off**. Refresh: it should still be Paused. Turn it on: controls and warning return, but the old simulation/faults do not return. Run-detail fault buttons honor the same state. The switch does not stop workflows, undo an effect, cancel a delay/error already claimed by a worker, or restart/stop supervision.

The paused flag is queue-scoped in Redis and persists across app restarts until enabled or that Redis data is removed. Existing installations with development chaos allowed and no saved pause retain Active startup behavior. Pause cleanup removes run fault keys only for run IDs in this application's MongoDB database, preserving other isolated databases' faults; use a separate database/queue for independent app instances as the test harnesses do. It also removes this queue's pending kill requests and model profile. Resuming repeats cleanup before releasing a saved pause, so interrupted cleanup does not restore old settings. New API writes check the gate atomically; process kill claims check it atomically too. Already-claimed/in-flight fault work cannot be undone. Pause/resume changes are serialized with a short-lived Redis lock; failures leave the gate paused for a retry.

POST /chaos/toggle accepts only `{ "active": true }` or `{ "active": false }`, requires an admin and trusted Origin, and refuses disabled/production operation. Status reports both environment permission (`enabled`) and runtime state (`active`); signed-in users receive only these mode flags from /chaos/mode. No new environment variables or dependencies. API/worker changes require one pnpm dev restart before using this follow-up.

## Three main manual tests

These tests answer three simple questions. Use a new duplicate-charge ticket for each ticket test. All refunds are fake and all emails stay in local Mailpit.

1. **Can the app restart a crashed process?** On Chaos, click **Crash worker now**. This deliberately stops the worker; the supervisor should start a replacement automatically. Wait until it returns to **up** and its restart count increases. Repeat with **Crash API now**. The API may briefly become unreachable, but your account/session and run history remain.
2. **Can it recover from a temporary error?** Create a ticket and wait for approval. In its run's Fault controls, choose **send_email → Before node work → Fail once**, then **Apply run fault**. Approve through Approvals. The first email attempt deliberately fails, and Unkillable retries automatically. Expect **succeeded**, one active fake refund and one original Mailpit email.
3. **Can it recover from a crash without doing the same action twice?** Create another ticket and wait for approval. Choose **send_email → After work → Crash worker at node**, then apply and approve. The worker sends the email and crashes before saving the next checkpoint. Its replacement should continue the saved workflow without another refund or duplicate email. Expect **succeeded**, one active fake refund and one original Mailpit email.

Process restart and job recovery are separate: the supervisor starts a replacement, then BullMQ recovers the abandoned job after its lock expires. Recovery may take several seconds; the default lock duration is 15 seconds and stalled scans run every 5 seconds. During an API restart, the browser's event stream reconnects after the API becomes reachable. Check that the red chaos warning banner is visible during testing. When finished, restore CHAOS_ENABLED=false and restart development.

For compensation, use a fresh ticket and set close_ticket / After work / Permanent failure before approving. Expect compensated, reopened ticket, reversed fake refund and one correction beside the original Mailpit message. Clear selected fault removes a persistent flag, including on a terminal run. Applying new faults to terminal runs is refused. Run IDs/nodes are validated against the selected workflow; there is no arbitrary code or PID field.

## Model simulation

These controls test what happens when the AI service is slow or unreliable. They work with MockLLM as well as Gemini; a real model connection is not required.

- **Slow LLM:** Adds an artificial wait before classification and reply drafting, using Delay (milliseconds), default 2000 ms. Think of Gemini responding slowly: the node stays running while you can still use the dashboard. This adds a wait before the call; it does not change the provider's actual response speed.
- **Flaky LLM · 50%:** Each classification or drafting attempt has a 50% chance of a simulated error. HTTP 429 means too many requests; HTTP 500 means the service encountered a problem. This is random, not a promise to fail every second call. Unkillable follows its retry/backoff policy: the run may succeed after retrying or fail when attempts are exhausted.
- **Reset LLM simulation:** Removes the artificial delay/error profile for future attempts. It does not restart failed runs or undo a delay already in progress.
- **Current profile: off:** Neither model-simulation profile is active. Independently configured run-specific faults can still apply.

To try it, choose Slow LLM or Flaky LLM, then create a new ticket and watch its classification/drafting nodes. A ticket already waiting for approval has passed these nodes, so the setting does not change its existing draft. Reset the simulation when finished.

Simulation happens before the provider is invoked, so an injected error consumes no model quota. Attempts that reach Gemini can still consume quota, including after an artificial delay. Use MockLLM to avoid live model calls during verification.

These are queue-scoped profiles affecting future model calls, including newly submitted tickets, not changes to an existing approval draft. A run-specific fault takes precedence at that node/phase. Profiles and API-set run flags expire after five minutes. Reset LLM simulation removes the profile immediately. Clear persistent run faults and reset profiles after testing, then restore CHAOS_ENABLED=false and restart development. Disabled hooks ignore leftover flags; TTL still applies.

## Supervision and safeguards

- scripts/supervise.mjs accepts only api or worker and refuses startup unless CHAOS_ENABLED=true and NODE_ENV=development. It spawns that repository entry with Node/tsx and waits for its ready message. Crash exits trigger a new child after the configured delay. API/worker publish short-lived runtime heartbeats; supervisors publish starting/up/restarting and restart count.
- Redis controls are namespaced by RUN_QUEUE_NAME. Supervisor leases prevent two owners for the same service/queue. Child instance UUIDs change on restart; kill requests target the current UUID and expire quickly, so a stale request cannot kill a replacement or unrelated process. If a supervisor was force-killed, a new one waits for the old ten-second lease to expire; a live renewing lease is not stolen. An existing supervisor can atomically reacquire an expired, unowned lease after a scheduling/connectivity pause. If another owner has acquired it, the old supervisor stops instead of overwriting that owner.
- The current child consumes its own kill request and exits abruptly with code 137. The API responds accepted before its polling loop consumes the request. No Docker socket is mounted and the HTTP API cannot execute arbitrary shell commands, send arbitrary signals or target caller-supplied PIDs.
- Chaos mutations require a current admin session, trusted Origin, strict Zod body validation, development environment and enabled flag. Viewers/approvers are denied. Production and disabled mutations return 403. A requested process must be up under a fresh supervisor/runtime identity, otherwise the request returns 409.
- Run-fault changes record actor ID, node/phase and mode in run audit events. Mode detection is available to signed-in users for the warning banner; full status/mutations require admin permission. Redis failure makes status/actions unavailable rather than bypassing safeguards.
- Ctrl+C/pnpm dev:stop stop the managed group. Normal shutdown does not schedule a restart. Forced Windows tree termination can leave a short lease until TTL; no other app processes or Docker services are stopped. Manual standalone API/worker dev scripts are not automatically supervised.

## API

| Endpoint          | Access / purpose                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| GET /chaos/mode   | Signed-in users; enabled warning flag                                                            |
| GET /chaos/status | Admin; enabled state, process statuses/counts, current model profile                             |
| POST /chaos/kill  | Admin + Origin + enabled development; {"target":"worker"} or api                                 |
| POST /chaos/fault | Same guards; {"runId":"UUID","node":"send_email","phase":"before","fault":{"mode":"throw_once"}} |
| POST /chaos/clear | Same guards; runId/node/phase to remove a flag                                                   |
| POST /chaos/llm   | Same guards; {"mode":"slow","delayMs":2000}, {"mode":"flaky","rate":0.5} or {"mode":"off"}       |

The same-origin web proxy restricts paths and methods. Underlying throw_once/throw_always/delay_ms/crash_process hook semantics remain in [STEP-7.md](STEP-7.md). Per-run phase before means before work; after means after the effect but before checkpoint/progress. Compensation actions are valid support node targets too.

## Verification

Stop normal dev before production builds, and leave local Docker services running:

```powershell
pnpm dev:stop
pnpm check
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

Tests use MockLLM, temporary databases/queues, fixed synthetic accounts and local Mailpit. The chaos integration suite checks auth/RBAC, Origin, disabled/production denial, strict input, node validation, fault TTL/audit, model profiles, worker crash during an active node with automatic checkpoint recovery, and supervised API replacement. Existing approval, compensation and duplicate-effect checks remain included. Model fault unit tests exercise delay and synthetic retryable errors without provider calls.

The Playwright harness uses its own enabled development supervisors, loopback ports and cleanup token. It verifies the red banner, slow/reset model controls, worker/API restart counts and a run-specific temporary failure submitted through the UI. It retains the approval-pulse/reload smoke. Temporary children, scoped control keys, queue and database are cleaned up; only synthetic Mailpit captures/screenshots remain. Remote CI results must be checked separately; see PROGRESS.md for actual local outcomes.

No new dependencies. Existing BullMQ 6.7.6, Redis client, MongoDB driver and React/Next stack are retained. References: [Node child-process lifecycle](https://nodejs.org/api/child_process.html#event-exit), [Redis GETDEL](https://redis.io/docs/latest/commands/getdel/), [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs).

Step 10 adds a separate seeded measurement harness and generated report; see [STEP-10.md](STEP-10.md). The interactive controls remain the way to demonstrate individual failures manually.
