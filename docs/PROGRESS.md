# Progress

## Step 1: Monorepo foundation

Added pnpm workspaces, strict TypeScript, formatting/linting, staged-file hooks, CI, Express health and validation/error infrastructure, a logging BullMQ worker, dashboard navigation and themes, and local MongoDB replica set/Redis/Mailpit Compose services.

Preserved the complete build specification in BUILD-PROMPT.md and future-session guidance in ../AGENTS.md. Execution, auth, and approval features remain scoped to later steps.

Verification performed locally:

- `pnpm install` succeeds; lockfile recorded. TypeScript 6.0.3 is used because the current typescript-eslint peer range excludes TypeScript 7. ESLint 10 is supported by that parser.
- `pnpm lint` and `pnpm typecheck` pass across the workspace.
- `pnpm test`: 6 tests pass (healthy/degraded probes, headers/CORS, validation, async errors, invalid config).
- `pnpm build` passes, including the optimized Next.js build.
- `docker compose config --quiet` passes. MongoDB, Redis, and Mailpit become healthy; the replica-set initializer exits 0; MongoDB reports `rs0` and writable primary.
- `pnpm dev` starts the dashboard, API, and worker. Dashboard HTTP returns 200. Direct API and web health proxy return 200 with both dependencies healthy.
- A harmless `foundation-smoke` BullMQ job completes through the running worker and is removed afterward.
- Stopping MongoDB changes health to 503; starting it restores 200 without restarting the API. This exposed and fixed the need to explicitly reconnect the driver after an initial connection failure.
- Browser visual inspection was unavailable because the browser tool timed out; HTTP startup and production compilation were verified.

All verification uses local services and injected mocks. No real customer side effects or model calls occur. No Git commands were run. Step 2 has not started; awaiting user review and continuation.

### Step 1 follow-up: local startup repair

The user's startup exposed missing local CLI entry points. A forced frozen-lockfile install restored the package files/links without changing dependency versions. It also exposed a setup-script bug that the earlier Git-less scaffold did not exercise: Husky 9 ships `bin.js`, not `bin.mjs`. Corrected that path, used the active Node executable, and made `HUSKY=0` skip hook setup. Repair verification used `HUSKY=0` to avoid Git configuration changes.

Verification also uncovered empty directories where pnpm's hoisted dependency junctions should have been, preventing transitive React type resolution. Rebuilt only the generated `node_modules/.pnpm/node_modules` directory and repeated the forced install; all five workspace typechecks now pass.

Verified installation succeeds and `pnpm dev` starts all three apps, including `API listening`, `Worker ready`, and Next.js ready on port 3000. Dashboard, API health, and the web health proxy return HTTP 200 with MongoDB and Redis healthy. The six tests pass. Added dependency-repair instructions to README. Step 2 remains unstarted.

## Step 2: Domain model, authentication, and RBAC

Added shared Zod document schemas and an AG-UI-shaped event union; created/indexed users, memberships, workflowDefinitions, runs, runEvents, approvals, idempotencyKeys, deadLetters, outbox, and Better Auth's supporting collections. Added idempotent index bootstrap, validated application repositories, migration and local seed commands. The idempotency key index is unique; effect execution remains outside this step.

Better Auth 1.7.23 now provides MongoDB-backed email/password authentication and persistent cookie sessions. Registration defaults to viewer; admin/approver assignment is restricted to local seed configuration. Added login/register/logout/me endpoints, server-enforced permission checks, protected workspace pages, role-aware navigation, a user menu, and a same-origin auth proxy. See STEP-2.md for session, role, and failure-handling decisions.

Verification performed locally:

- `pnpm lint` and `pnpm typecheck` pass.
- `pnpm test`: 23 pass; the 2 external MongoDB checks are deliberately skipped in this command.
- `pnpm test:integration`: 2 pass using isolated temporary MongoDB databases. Verified repeated index bootstrap, duplicate-key rejection, actual MongoDB auth transactions, sessions reused by a second API instance, role checks, logout, and rejection of revoked sessions.
- `pnpm build` passes; workspace and auth routes are dynamic.
- `pnpm db:migrate` succeeds. `pnpm seed` run twice succeeds without duplicating the account or resetting its password.
- `pnpm dev` starts web/API/worker. Through the actual web proxy: anonymous `/runs` redirects to `/login`; login/me return 200, authenticated workspace pages render, logout returns 204, and cookie replay returns 401. A local viewer sees an access restriction at `/chaos`; the API returns 403 for the same permission.
- Browser sign-in as the seeded local administrator was verified. The UI shows the current role, all admin sections, and healthy API status. A screenshot is saved at screenshots/step-2-admin.jpg.
- CI now starts local Compose services for the MongoDB integration tests. A remote CI run is not confirmed here.

Implementation issue fixed: the current MongoDB driver does not accept the attempted `dbName` constructor option, so the auth factory accepts an explicit database for isolated tests while sharing the transaction-capable client.

New configuration: BETTER_AUTH_SECRET, BETTER_AUTH_URL, API_INTERNAL_URL, SEED_EMAIL, SEED_PASSWORD, SEED_NAME, SEED_ROLE. The existing local .env was extended with missing settings and a private generated secret; .env.example documents all variables. No real model calls, external emails/payments, or Git commands were used. Step 3 has not started; awaiting review and continuation.

### Step 2 follow-up: checks before pushing

Added `pnpm check` and a Husky pre-push hook that runs lint/formatting, typecheck, tests, and the production build in order, stopping at the first failure. Added LF rules for hook files on Windows. MongoDB integration tests stay separate locally and remain required by CI. No new environment variables or dependencies.

Hook activation is left to the user's `pnpm prepare` because the repository instructions reserve Git commands for the user, and Husky setup runs `git config` internally. No commit or push is performed by this follow-up.

Verification: `pnpm check` passes lint/formatting, all workspace typechecks, 23 tests (the 2 MongoDB integration checks are deliberately skipped), and the production build. Hook shell syntax passes; a simulated failing check propagates exit code 23. Actual push invocation is not tested because Git commands were not run. No new environment variables.

## Step 3: Durable execution core

Added authenticated run creation/list/detail endpoints, a deterministic prepare → summarize → complete graph, MongoDB-backed LangGraph checkpoints, BullMQ stalled-job recovery, transactional ordered run events, and SSE live/replay streaming. The Runs UI now starts demos, refreshes live statuses, shows checkpointed steps/state, and reconstructs its timeline after refresh or reconnect. Admins/approvers create runs; viewers retain read access.

Added a small Node-only `packages/storage` workspace so the API and worker share validated run/event repositories without importing each other's application code. Run creation and its queued event commit together; pending-dispatch reconciliation handles the MongoDB/Redis handoff after an API crash or queue outage. Stable job IDs prevent duplicate reconciliation jobs. Event/state changes are transactional; completed checkpoint notifications are deduplicated and reconciled after recovery. See STEP-3.md for the boundaries and configuration rationale.

Runtime versions checked against official documentation and installed types: LangGraph.js 1.7.4, MongoDBSaver 1.5.1, BullMQ 6.7.6. The saver requires MongoDB driver 6.x, so its connection uses an explicit 6.22.0 alias; application repositories use 7.9.0. The worker calls setup and checks returned index errors, uses one thread per run UUID and synchronous durability, and resumes existing threads with null input.

Verification performed locally:

- Lint and all workspace typechecks pass; the production Next.js build passes with dynamic Runs/detail routes.
- `pnpm test`: 34 pass; 6 integration checks deliberately skip without service connection variables.
- `pnpm test:integration`: all 6 pass, including existing auth/index checks, run API/RBAC, enqueue outage and restart reconciliation, concurrent ordered event allocation/deduplication, strict Last-Event-ID replay, a real child-process worker kill/stalled recovery test, final-checkpoint recovery before terminal publication, and terminal redelivery without extra events.
- The killed-worker test asserts the checkpointed prepare node starts/finishes once, the interrupted summarize node starts again, all three nodes complete, and event sequence IDs remain continuous. It uses its own temporary database and queue and never kills the normal dev worker.
- Live HTTP through the actual web proxy: POST returns 202; an SSE event arrives before completion; an interrupted stream resumes beyond its cursor and receives RUN_FINISHED; GET returns succeeded and all three completed nodes.
- CI now includes the run API and real worker recovery integration suites with MongoDB and Redis.
- Final `pnpm check` passes the same lint, typecheck, 34 service-free tests, and production build sequence used by the pre-push hook. Browser preview verification could not finish because the browser connection failed; direct HTTP login-page and API-health requests still return 200. Visual inspection of the new timeline is unverified.

New optional environment variables documented in .env.example: RUN_QUEUE_NAME, WORKER_LOCK_DURATION_MS, WORKER_STALLED_INTERVAL_MS, WORKER_MAX_STALLED_COUNT, DEMO_NODE_DELAY_MS. Defaults work with the existing local .env. No model calls or real customer effects, Git commands, commits, or pushes were used. Exactly-once effects, retry policies, approvals, compensation, React Flow, and chaos controls remain in their assigned later steps. Step 4 has not started.

Documentation follow-up: added a plain-language explanation of API versus worker responsibilities, checkpoint recovery, possible replay of the interrupted step, and the current absence of AI calls, emails, and payments to README.md and STEP-3.md. Clarified that recovery needs a running replacement worker; process supervision is not implemented in Step 3.
