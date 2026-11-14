# Unkillable Agent Workflows

Durable agent workflows with human approval, built to demonstrate recovery you can inspect.

The platform targets five goals: crash durability, exactly-once side effects, human control, debuggable run history, and measured chaos-test evidence. This is a separate project from OrgMind; a future optional HTTP retriever adapter is its only integration.

## Current scope

Steps 1–4 provide authentication/RBAC, durable execution, configurable retries, transactional effect receipts/outbox, and an admin Dead Letters page. Runs survive killed workers, save MongoDB checkpoints, and expose live/replayable timelines. The demo delivers a stored local notice; no AI model, email, or payment is used. Approvals, external adapters, compensation, and chaos controls arrive in later steps. No chaos-report numbers are claimed yet.

## Quickstart

Install Node.js 24 or newer, pnpm 12.16.1, and Docker with Compose. From the repository root:

```powershell
Copy-Item .env.example .env
# Replace BETTER_AUTH_SECRET with the output of:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
pnpm install
docker compose up -d
pnpm seed
pnpm dev
```

Open http://localhost:3000. The API badge turns green when MongoDB and Redis are reachable. The worker logs `Worker ready`, then its health every 30 seconds. The API is at http://localhost:4000/health; Mailpit is at http://localhost:8025. Stop app processes with Ctrl+C and infrastructure with `docker compose stop` (retains data).

MongoDB runs as a single-node replica set. The one-shot initializer safely initiates `rs0` on a fresh volume. Host applications use `directConnection=true` because the replica set advertises the internal Compose hostname `mongo`. Services bind only to local loopback ports. This setup is for local development.

API and worker load the root `.env`. Existing Step 1 installations must add `BETTER_AUTH_SECRET` (a private random value, at least 32 characters) and `BETTER_AUTH_URL=http://localhost:4000`. Keep `CORS_ORIGINS=http://localhost:3000`; auth mutations require an allowed `Origin` header. No model, payment, SMTP, or Telegram credentials are needed.

For a custom API address, set `API_INTERNAL_URL` in `apps/web/.env.local` and update `NEXT_PUBLIC_API_URL` there for the health proxy. Both default to `http://localhost:4000`. The signing secret belongs only in the API environment; never expose it through a `NEXT_PUBLIC_` variable.

## Authentication and roles (Step 2)

Register at `/register`; accounts start as viewers. Registration accepts name, email, and a password of 12–128 characters; callers cannot supply a role. The seed command creates the local administrator using `SEED_EMAIL`, `SEED_PASSWORD`, `SEED_NAME`, and `SEED_ROLE` from `.env`. Example defaults are **local demo credentials only**: `admin@example.test` / `local-demo-password-change-me`. Set your own values before seeding if preferred. Re-running seed preserves existing passwords and applies the configured role; seeding is disabled in production.

| Role     | Workspace access                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------- |
| viewer   | Runs and Workflows                                                                                 |
| approver | Viewer access plus starting demo runs and Approvals; permission to resolve future approval actions |
| admin    | All sections, including Chaos and Analytics                                                        |

Step 2 controls access to these sections; it does not implement their later workflow actions. Navigation hides unauthorized sections, protected pages recheck the session on the server, and API permission checks read the current membership on every request. Role changes do not require re-login; the navigation refreshes on window focus. Missing memberships fail closed. This is one local workspace (`workspaceId=local`), not a multi-tenant implementation.

API endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, and `GET /auth/access/:section` (a permission check, not workflow execution). Browser requests use the same-origin `/api/backend/auth/*` proxy, which forwards HTTP-only cookies. API responses do not expose session tokens. Better Auth 1.7.23 hashes passwords and stores sessions in MongoDB. Sessions have a fixed seven-day lifetime, no cookie cache, and server-side revocation on logout; production cookies are Secure, all session cookies are HttpOnly/SameSite=Lax. Auth mutations require trusted origins, native auth rate limits use the database, and logs redact cookies and authorization headers. Email verification and password recovery are not configured in this local showcase; no email is sent.

The app bootstraps indexes before accepting API traffic; `pnpm db:migrate` repeats the same idempotent bootstrap manually. Collections:

| Collection                                        | Purpose                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| users, memberships                                | Identity and the workspace role                                       |
| sessions, accounts, verifications, authRateLimits | Better Auth session, credential, verification, and rate-limit storage |
| workflowDefinitions                               | Versioned workflow structure                                          |
| runs, runEvents                                   | Execution state and append-only event history                         |
| approvals                                         | Proposed decisions and future resolution records                      |
| idempotencyKeys                                   | Committed effect results returned unchanged on replay                 |
| deadLetters, outbox                               | Failed-work context and transactional outbound intents                |
| nodeAttempts, localDeliveries                     | Durable retry budgets/deadlines and the local notification sink       |

The unique `idempotencyKeys.key` index is tested. Other indexes protect emails, memberships, event sequence numbers, and outbox keys. Shared Zod schemas define every document and the AG-UI-shaped run-event union; application repositories validate writes and reads. Better Auth owns its MongoDB adapter and auth-record lifecycle. Execution now uses transactional run/event writes; the unique index alone does not claim exactly-once external effects.

## Durable demo runs (Step 3)

Step 4 extends these runs with retries and a local outbox; see [docs/STEP-4.md](docs/STEP-4.md) for the four test scenarios, effect guarantees, admin Dead Letters actions, and per-node `NODE_RETRY_POLICIES` configuration.

**What the worker does:** The API accepts requests and queues jobs. The worker performs the workflow work. Currently, it uses no AI model and sends no emails or payments.

**What happens if it crashes:** A replacement worker picks up the abandoned job and resumes from the last saved checkpoint. The interrupted step may run again; completed, checkpointed steps are preserved. A replacement worker must be started for recovery to happen; automatic process supervision comes in a later step.

Sign in as the seeded admin, open **Runs**, enter a message, choose a delivery scenario, and choose **Start demo run**. Approvers can start runs too; viewers can inspect them. The nodes are `prepare → summarize → complete`, with a configurable delay so progress is visible. Workflow version 2 queues one local notice at complete; existing version 1 runs remain pure. No model, payment, email, or external action is called. The list refreshes automatically; each detail page shows the timeline, checkpointed steps, saved state, reconnect status, recovery events, effect receipts, and outbox deliveries.

`POST /runs` accepts `{"input":{"message":"Keep this run alive"}}` and returns HTTP 202. The optional workflowId is fixed to `durability-demo`. `GET /runs` supports limit (1–100) and status; `GET /runs/:id` returns state. Routes require a session; creation also requires a trusted Origin and runs:create permission. All runs are in the one local workspace. The server generates run UUIDs; clients never choose LangGraph thread IDs.

The API saves the queued run/event transactionally, then adds a BullMQ job with jobId=runId. Its five-second reconciliation loop (also run at startup) retries pending dispatch after an API crash or Redis outage. It never invokes graphs. The worker uses LangGraph.js 1.7.4 and MongoDBSaver 1.5.1 with thread_id=runId and synchronous durability. Completed nodes are reported after their native checkpoint write; missing notifications are reconciled on resume. An interrupted node can run again; version 2's local effect uses the durable receipt described below.

`GET /runs/:id/events` streams append-only MongoDB events with numeric per-run SSE IDs. Last-Event-ID resumes strictly after that sequence; a fresh client can use ?after=N. Invalid/ahead cursors are rejected. Completed runs replay through the same endpoint. Heartbeats and session rechecks occur every 15 seconds; writes respect backpressure, headers disable buffering, and disconnects stop polling. The Next.js proxy forwards the streaming body and cursor header. EventSource reconnects automatically; the UI deduplicates sequences and reconstructs history after refresh.

New optional settings in .env.example: RUN_QUEUE_NAME=workflow-runs, WORKER_LOCK_DURATION_MS=15000, WORKER_STALLED_INTERVAL_MS=5000, WORKER_MAX_STALLED_COUNT=3, DEMO_NODE_DELAY_MS=1500. API and worker must share a queue name. Locks renew every half lock duration; replacement workers recover expired locks during stalled scans. Exhausted stalled jobs become failed runs. Checkpoints are retained without TTL. There is no supervisor/kill button yet. Reserved approval, compensation, and cancellation states gain their behavior in later steps.

See [docs/STEP-3.md](docs/STEP-3.md) for boundaries and verification. Shared Node-only run/event persistence lives in `packages/storage`; browser code only imports shared contracts.

## Workspace

| Package              | Responsibility                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/web`           | Next.js App Router, Tailwind, local Button, themes, auth forms, protected pages and role-aware navigation |
| `apps/api`           | Express routes → controllers → services → repositories; health, Better Auth, RBAC and indexes             |
| `apps/worker`        | BullMQ consumer, LangGraph executor and checkpoint recovery                                               |
| `packages/shared`    | Zod document/API/event contracts, permissions and infrastructure configuration                            |
| `packages/workflows` | Typed demo definition, pure nodes and durable graph runtime                                               |

Validation results are available on `res.locals.body`, `.query`, or `.params`, avoiding mutation of Express 5 request getters. Health returns HTTP 503 with per-service flags when a dependency fails. Shutdown stops accepting work, closes connections, and has a ten-second deadline.

The worker allows up to twenty seconds for graceful shutdown; the API retains its ten-second deadline.

## Development checks

Before each push, Husky runs `pnpm check`: lint/formatting → typecheck → tests → production build. The first failed check stops the sequence and blocks the push. You can run `pnpm check` manually without pushing. The pre-commit hook still runs lint-staged.

After pulling these changes, run `pnpm prepare` once to activate the Git hooks (normal `pnpm install` also runs prepare). Hook setup is skipped if `HUSKY=0` or `CI` is set. Hook files use LF endings on Windows too. Local hooks can be bypassed, so CI remains the remote check.

The pre-push checks do not start Docker or require MongoDB. Run `pnpm test:integration` separately with local MongoDB and Redis running; CI also runs those database checks.

If `pnpm dev` reports missing `tsx` or Next.js CLI files, stop the dev processes, restore the installed packages and links with `pnpm install --frozen-lockfile --force`, then retry `pnpm dev`. A normal install can report everything up to date even when local package links are damaged. This repair keeps the dependency versions in the lockfile. If React declarations still fail to resolve, the generated hoisted links in `node_modules/.pnpm/node_modules` may also need rebuilding; remove only that generated directory and repeat the forced install.

The prepare script uses Husky 9's `bin.js` entry point and skips hook setup when `CI` is set, `HUSKY=0`, or the directory has no `.git` entry.

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

`pnpm test` runs auth, RBAC, schema, lifecycle, and health checks without external services or models. Integration files skip unless their connection variables are set. `pnpm test:integration` loads .env, uses random unkillable_test_* databases and a unique test queue, and removes only those resources. It covers persistent auth, indexes, run API/dispatch recovery, ordered events, SSE replay, a real child-worker kill followed by stalled recovery, the final-checkpoint crash boundary, and terminal redelivery. Tests never kill your normal worker or API.

CI runs on Node 24 and starts Compose services for the MongoDB integration suite before building the web app. `pnpm format` formats the workspace. Husky installs only when a Git checkout exists; lint-staged checks staged files.

Auth implementation references: [Better Auth MongoDB adapter](https://better-auth.com/docs/adapters/mongo), [database customization/hooks](https://better-auth.com/docs/concepts/database), and [session management](https://better-auth.com/docs/concepts/session-management). Registration provisions a viewer membership after identity creation; if that write fails, access remains denied until membership is repaired by local seed. The signing secret must remain stable across API restarts.

Official references consulted for the foundation: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [Express error handling](https://expressjs.com/en/guide/error-handling/), [BullMQ graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown), and [shadcn manual installation](https://ui.shadcn.com/docs/installation/manual). Exact installed dependency versions are recorded in `pnpm-lock.yaml`.

## Roadmap and working agreement

The complete user-approved specification is preserved in [docs/BUILD-PROMPT.md](docs/BUILD-PROMPT.md). Work proceeds one step at a time, with review between steps. See [docs/PROGRESS.md](docs/PROGRESS.md) for actual implementation and verification status.

## Author

**Jahid Khan Tuhin — Full Stack JavaScript Engineer**

GitHub: [placeholder] · LinkedIn: [placeholder] · Email: [placeholder]
