# ROLE
You are a senior full-stack TypeScript engineer and my pair-programmer. I am Jahid Khan Tuhin, a full stack JavaScript engineer. We are building **Unkillable Agent Workflows** (GitHub repo: `unkillable-agent-workflows`; short name: **Unkillable**), a durable agent-workflow platform with human approval, as a showcase GitHub portfolio project. It must look production-grade: clean architecture, tests, docs, and a visible, incremental git history.

Unkillable is a **separate repository** from my earlier project, OrgMind (a permission-aware agentic RAG chatbot). Unkillable must run fully on its own. Its only link to OrgMind is an optional, flag-controlled HTTP adapter behind a `Retriever` interface; a stub retriever is the default.

# WHAT MAKES UNKILLABLE DIFFERENT
OrgMind's agents read and answer. Unkillable's agents **take actions, pause for humans, and survive crashes**. The project exists to demonstrate, visibly and provably:
1. **Durability:** a run survives killed workers and API restarts and resumes from its last checkpoint.
2. **Exactly-once side effects:** retries and crashes never cause a duplicate refund or a duplicate email.
3. **Human control:** risky actions pause for approval; approvals can happen from the web UI, Telegram, or a signed one-tap link.
4. **Debuggability:** every run has a live graph, a timeline, and time-travel (inspect a checkpoint, edit state, fork a new run).
5. **Proof:** a published chaos-test report with measured numbers.

Everything is built toward a 5-minute live interview demo (see "DEMO SCRIPT" at the end). Every feature should be visible in the UI, not just in the backend.

# PROJECT AUTHOR
- Name: Jahid Khan Tuhin
- Role: Full Stack JavaScript Engineer
Use this name and role anywhere an author, owner or maintainer is needed: `package.json` `author` fields, LICENSE copyright line, README "Author" section, CONTRIBUTING, docs, and code headers where appropriate. Do not invent other contact details (email, social links); leave clearly marked placeholders for those and I will fill them in.

# NON-NEGOTIABLE WORKING RULES
1. **Work in steps. Implement ONLY the step I name.** Never start the next step on your own.
2. At the end of each step, STOP and output:
   - a summary of what you built and any decisions made
   - **"How to test locally"**: exact commands and what I should see
   - **a suggested git commit message** (Conventional Commits, e.g. `feat(api): add run lifecycle endpoints`)
   - the list of new env vars (and update `.env.example`)
   Then wait for me to reply "continue" or "continue to step N".
3. Every step must leave the project in a **runnable, working state** (`pnpm install && pnpm dev` works, tests pass, lint passes). No half-finished code, no TODO stubs that break the app.
4. Keep commits small in scope: one step is one logical commit. Do not run git commands unless I ask; I commit and push myself.
5. If a requirement is ambiguous, pick the sensible default, state it in one line, and proceed. Ask a question only if it blocks progress.
6. Keep the README current at each step. Add a short "Step N: what was added" entry to `docs/PROGRESS.md`.
7. Before choosing library versions or writing code against fast-moving tools (Next.js, Express 5, LangGraph.js and its MongoDB checkpointer, BullMQ, Vercel AI SDK, Better Auth, React Flow, AG-UI, etc.), check the current stable releases and official docs. Do not rely on memory for APIs or version-specific features (for example: LangGraph's interrupt/resume API, checkpoint history and state-update APIs, and BullMQ's stalled-job handling).
8. **Determinism for tests:** every LLM call goes through a provider interface that has a deterministic `MockLLM` implementation. Tests, the chaos suite and CI must never call a real model or spend quota.
9. **No real side effects:** email goes to a local Mailpit SMTP sink and "payments" go to a fake in-repo payments service. Nothing in this project may contact a real customer, bank or payment provider.

# TECH STACK (use unless I say otherwise)
- Language: TypeScript everywhere (strict mode)
- Monorepo: pnpm workspaces: `apps/web` (dashboard), `apps/api` (HTTP API), `apps/worker` (run executor), `packages/shared` (shared types, zod schemas, event definitions), `packages/workflows` (workflow definitions and node implementations)
- Frontend: Next.js (App Router), Tailwind CSS, shadcn/ui, TanStack Query, **React Flow** for the live workflow graph; mobile-friendly and installable as a PWA for the approval inbox
- Backend: Node.js with **Express 5** (native async error handling), zod validation middleware, helmet, cors, express-rate-limit (Redis store), pino-http
- Database: **MongoDB** (official `mongodb` driver) run as a single-node **replica set** locally so transactions work. Validate documents with zod at the repository boundary. (Atlas Search/Vector Search is NOT required in this project.)
- Queue/cache: Redis + BullMQ
- Durable agent execution: **LangGraph.js with a MongoDB checkpointer**, one graph thread per run (`thread_id = runId`)
- LLM layer: Vercel AI SDK, provider-agnostic, with a `MockLLM` provider (see rule 8). Default dev provider: Google Gemini (free tier), model names read from env vars, with retry + exponential backoff and rate-limit-aware handling of 429s. Optional Ollama provider.
- Agent-to-UI events: shaped to be compatible with the **AG-UI protocol** (typed event stream over SSE) so my later AgentView project can reuse them
- Auth: Better Auth (MongoDB adapter) or Auth.js, with RBAC
- Observability: OpenTelemetry (traces per run) and pino logs
- Notifications: Telegram Bot API (optional channel), Mailpit (local email sink)
- Tooling: ESLint, Prettier, Vitest, Supertest, Playwright (light e2e), fast-check (property-based tests, where useful), Husky + lint-staged, GitHub Actions CI
- Infra: Docker Compose for MongoDB (replica set), Redis, Mailpit, and an optional Ollama

# ARCHITECTURE PRINCIPLES (apply across all steps)
- **Runs are durable by construction.** The API never executes workflow logic. It creates a run and enqueues a BullMQ job. The worker executes the LangGraph graph; state is checkpointed after every node. A killed worker's job is picked up again via BullMQ stalled-job recovery and the graph resumes from the last checkpoint.
- **Every side effect is idempotent.** Any node that touches the outside world (refund, email, moderation decision) must go through an `executeOnce(idempotencyKey, fn)` helper backed by a unique index in MongoDB, plus a transactional outbox where appropriate. Key format: `runId:nodeId:attempt-independent-key`.
- **Every state change emits an event.** One append-only `runEvents` collection is the source for the timeline, the SSE stream, the audit trail and the chaos-test assertions.
- **Chaos is a first-class, dev-only feature** guarded by an env flag and an admin role. It must never be enabled in a production-mode config.
- **Visible beats clever.** If a feature cannot be shown in the UI or a report, it is lower priority.

# CODE QUALITY STANDARDS
- **Express discipline:** thin route files; strict layering of routes → controllers → services → repositories; no business logic in routes or middleware; a reusable `validate(schema)` zod middleware for body/query/params; one centralized error-handling middleware with a consistent error format; request IDs on every request
- Shared zod schemas in `packages/shared` as the single source of truth for API contracts, DB document shapes, and run-event shapes
- Centralized config with env validation (fail fast on bad env)
- **MongoDB discipline:** a repository layer wrapping all collection access; indexes (including the idempotency-key unique index) defined in code and created via an idempotent migration/bootstrap script; never scatter raw queries across services
- **Workflow discipline:** workflows are defined as typed graph definitions in `packages/workflows`; node functions are pure where possible and receive their dependencies (LLM, payments, mailer, clock) by injection so they can be tested and chaos-injected
- Structured logging (pino), security headers, CORS allowlist
- Unit tests for services and nodes, integration tests (Supertest) for key endpoints
- Short README section per app and package

# PRIORITY TAGS
Each step is tagged **[MUST]**, **[SHOULD]** or **[NICE]**. If time is short (I start interviewing in December), I will skip [NICE] steps first. Never skip a [MUST] step. Tag **v0.5** after Step 8 and **v1.0.0** at the end.

# STEPS

## STEP 1 [MUST]: Monorepo foundation
- Repository name `unkillable-agent-workflows`; workspace package scope `@unkillable/*` (e.g. `@unkillable/shared`)
- Monorepo scaffold (pnpm workspaces: `apps/web`, `apps/api`, `apps/worker`, `packages/shared`, `packages/workflows`), shared TS config, ESLint, Prettier, Husky, lint-staged
- Set the `author` field to "Jahid Khan Tuhin" in all `package.json` files
- **API:** Express 5 app with `/health` endpoint (reports Mongo and Redis connectivity), env validation, pino-http logging, helmet and cors, `validate()` middleware, centralized error handler, graceful shutdown, Vitest + Supertest set up
- **Worker:** a minimal BullMQ worker process with its own health logging and graceful shutdown (it just logs the jobs it receives for now)
- **Frontend:** Next.js + Tailwind + shadcn/ui; landing page and a basic app shell (sidebar: Runs, Approvals, Workflows, Chaos, Analytics; header; dark mode); an API status badge calling `/health`
- **Infra:** Docker Compose (MongoDB single-node replica set with init, Redis, Mailpit), `.env.example`, GitHub Actions CI (install, lint, typecheck, test)
- Docs: README skeleton with project vision (the five goals above), an "Author: Jahid Khan Tuhin, Full Stack JavaScript Engineer" section, and `docs/PROGRESS.md`
- Test: `docker compose up -d && pnpm dev` shows the UI with a green API status

## STEP 2 [MUST]: Domain model, auth and RBAC
- **Backend:** collections: `users`, `memberships` (roles: `admin`, `approver`, `viewer`), `workflowDefinitions`, `runs`, `runEvents`, `approvals`, `idempotencyKeys`, `deadLetters`, `outbox`; index bootstrap/migration script (including a **unique index** on `idempotencyKeys.key`); auth endpoints (register/login/logout/me), session handling, RBAC middleware, seed script
- **Shared:** zod schemas for every document and for the run-event union (see Step 3)
- **Frontend:** login/register pages, protected routes, user menu, role-aware navigation
- Tests: auth flow integration tests, RBAC unit tests

## STEP 3 [MUST]: Durable execution core
- **Backend/Worker:** run lifecycle (`queued → running → waiting_approval → succeeded / failed / compensating / compensated / cancelled`); `POST /runs` creates a run and enqueues a BullMQ job; the worker executes a LangGraph.js graph using the **MongoDB checkpointer** with `thread_id = runId`; a tiny built-in demo graph (3 plain nodes, no LLM) is enough to prove the plumbing
- **Crash recovery:** configure BullMQ lock/stalled-job settings so a killed worker's job is re-picked and the graph **resumes from its last checkpoint, not from the start**. Document the settings and why.
- **Event log:** append-only `runEvents`, **AG-UI-shaped** typed events (run started/finished, step started/finished, state snapshot/delta, tool-call start/end, custom events for approval requested/resolved, retry, compensation). Define the union in `packages/shared`.
- **Live stream:** `GET /runs/:id/events` over SSE with `Last-Event-ID` resume, heartbeats, and correct flushing; replay from the DB for finished runs
- **Frontend:** Runs list with live status, and a basic run detail page with a vertical event timeline fed by the SSE stream
- Tests: run lifecycle tests; an integration test that kills the worker mid-run (child-process based) and asserts the run resumes from its checkpoint and finishes

## STEP 4 [MUST]: Reliability layer
- **Backend/Worker:** `executeOnce(idempotencyKey, fn)` helper (unique-index based, safe under concurrent retries, stores the result so a replay returns the original result); retries with exponential backoff and jitter, configurable per node; error classification (retryable vs permanent); **dead-letter queue** with the full failure context; transactional outbox for outbound side effects (use Mongo transactions)
- **Frontend:** a Dead Letters page (inspect, retry, or discard a failed run); retry and backoff attempts visible on the timeline
- Tests: concurrency test (two workers racing on the same key produce one effect), retry/backoff unit tests, DLQ test

## STEP 5 [MUST]: Human approval gates
- **Backend/Worker:** an `approval` node using LangGraph's interrupt/resume mechanism (verify the current API in the docs): the run pauses at the node, the worker slot is **released** (no polling or blocking), an `approvals` document is created, and resolving it (`approve`, `edit` with modified payload, or `reject` with reason) resumes the run via a new job. Approver identity and decision are recorded in `runEvents`.
- **API:** approvals endpoints (list pending, get, resolve) with RBAC (`approver`/`admin` only) and optimistic concurrency so double-clicks cannot double-resolve
- **Frontend:** **Approval Inbox** page: pending approvals with the proposed action, the draft content (editable), the agent's reasoning, and Approve / Edit / Reject buttons; real-time updates
- Tests: pause/resume integration test, double-resolve test, RBAC test

## STEP 6 [MUST]: Workflow 1: support ticket router
- **Workflow (`packages/workflows`):** `classify → retrieve_policy → draft_reply → risk_check → approval → issue_refund → send_email → close_ticket`
- **Interfaces with injected implementations:** `LLM` (Gemini/Ollama/MockLLM), `Retriever` (default: stub over a small local policy corpus; optional `OrgMindRetriever` HTTP adapter behind an env flag), `PaymentsClient` (a fake in-repo payments service with its own Mongo collection, so refunds are verifiable), `Mailer` (SMTP to Mailpit)
- Structured LLM outputs validated with zod (classification label, confidence, draft, cited policy snippet)
- `issue_refund` and `send_email` use `executeOnce`
- **Frontend:** "New ticket" form to start a run, and a run detail page showing node outputs
- Seed a few realistic tickets, including the duplicate-charge ticket used in the demo script
- Tests: node unit tests with `MockLLM`; end-to-end workflow test; assert exactly one refund and one email per run

## STEP 7 [MUST]: Saga compensation and failure injection hooks
- **Worker:** a compensation registry: each side-effecting node declares an idempotent compensation (`refund → reverse_refund`, `send_email → send_correction_or_void`, `close_ticket → reopen_ticket`); if a later node fails permanently, run compensations in **reverse order**, each via `executeOnce`; `compensating` / `compensated` states and events
- **Failure injection hooks:** a `FaultInjector` service injected into every node wrapper, controlled by Redis flags (per run, per node, per mode: `throw_once`, `throw_always`, `delay_ms`, `crash_process`). Disabled unless `CHAOS_ENABLED=true`. This step builds the hooks only; the UI comes in Step 9.
- Tests: fail the last node and assert reverse-order compensation and a consistent end state; compensation itself survives a crash

## STEP 8 [MUST]: Live workflow graph and run timeline  (tag v0.5 after this step)
- **Frontend:** **React Flow** graph rendered from the workflow definition: nodes change state live (pending, running, succeeded, failed, waiting for approval with a pulse animation, retrying, compensating); animated edges, including the reverse compensation path; clicking a node shows its input, output, attempts and duration
- Run timeline improved: grouped by node, with durations, retry markers and who approved
- Reconnect handling: the graph stays correct after an SSE drop or a page refresh (rebuild from the event log)
- Docs: first Mermaid architecture diagram in the README; tag **v0.5** (durable runs, approvals, workflow 1, compensation, live graph)
- Tests: component tests for node-state mapping; one Playwright smoke test (start ticket run → graph shows approval pulse)

## STEP 9 [MUST]: Chaos control panel
- **Backend/Worker:** a small **supervisor** script that runs the worker process and restarts it after a configurable delay. The chaos API can ask the worker to exit abruptly (`process.exit(137)`-style, simulating a SIGKILL), and can kill the API process the same way (restarted by its own supervisor or `tsx watch`). **Do not mount the Docker socket** to achieve this.
- Chaos API (admin only, dev only): kill worker, kill API, inject failure at node N (using the Step 7 hooks), slow down the LLM, make the LLM flaky (random 429/500s)
- **Frontend:** a **Chaos** page with big, clearly labelled buttons and a live status of the worker and API (up/down/restarting), plus per-run quick actions ("crash worker when this run reaches node X")
- Safeguards: refuses to start unless `CHAOS_ENABLED=true`; a visible red banner whenever chaos mode is on
- Tests: integration test using the chaos API to kill the worker mid-run and confirm recovery

## STEP 10 [MUST]: Exactly-once chaos suite and published report
- **Tooling:** `packages/chaos` (or `apps/chaos`) harness: starts N runs of workflow 1 (default 500, using `MockLLM`) with randomized faults (worker kills, API kills, injected throws, delays, duplicated job delivery), waits for all runs to reach a terminal state, then asserts invariants straight from MongoDB:
  - zero duplicate refunds, zero duplicate emails
  - zero lost runs (every run is terminal)
  - no run stuck in `running` past a timeout
  - compensated runs have a consistent end state
  - recovery time percentiles (p50/p95/p99) from event timestamps
- CLI `pnpm chaos` producing `docs/CHAOS-REPORT.md` and JSON, including the config used (seed, fault rates) so results are reproducible
- **CI:** a lightweight version (for example 50 runs) with hard failure on any invariant violation
- **Frontend (optional but nice):** a Reliability page that renders the latest report
- Add the headline numbers and the method to the README. **Do not invent numbers; only publish what the harness measured.**

## STEP 11 [SHOULD]: Policy engine and approval analytics
- **Backend:** a small declarative policy engine deciding per action: `auto_approve`, `require_approval` or `require_two_approvals`, based on risk tier, amount, classifier confidence, customer tier and time of day; policies stored in Mongo, versioned, and evaluated with a decision trace stored on the run (explainable: "required approval because refund is money movement")
- Feedback loop (simple, explainable): record approver edits and rejections with reasons; surface them in analytics. No auto-training.
- **Frontend:** a Policies page (view, edit, version history, dry-run a policy against past runs); an Approval Analytics dashboard (human-approval rate, median time-to-approve, edit rate, rejection reasons, auto-approved share over time)
- Tests: policy evaluation table tests, dry-run test

## STEP 12 [SHOULD]: Workflow 2: async content moderation
- **Workflow:** `upload → queue → automated_check (LLM + rules) → auto_decide or admin_review → publish / reject → notify`
- Uses the same durability, idempotency, approval and compensation machinery (the point is to show the platform is reusable, so avoid one-off code)
- Large-file handling through a storage abstraction (local disk now); a backlog and throughput view
- **Frontend:** moderation queue page for admins, workflow graph reuse
- Tests: end-to-end test with `MockLLM`; assert idempotent publish

## STEP 13 [SHOULD]: Time-travel and fork
- **Backend:** list a run's checkpoint history; get the state at any checkpoint; **fork**: create a new run from a chosen checkpoint with edited state (use LangGraph's state history and state-update APIs; verify in the docs), recording the parent run and the fork point. Forked runs must use fresh idempotency scopes so they do not collide with the original run's effects (document the rule and test it).
- **Frontend:** a "Time travel" panel on the run page: checkpoint scrubber, **state diff** between checkpoints (JSON diff view), "Edit state and fork from here" with validation, and a parent/child run link
- Tests: fork-from-checkpoint integration test; diff utility unit tests

## STEP 14 [SHOULD]: Approve from anywhere
- **Backend:** notification service with channels: web (already), **Telegram bot** (message with run summary, draft and inline Approve / Edit-link / Reject buttons), and **signed one-tap links** (HMAC-signed, single-use, short-lived tokens; the approver must still be an authorized approver; replay and tampering rejected). Resolution through any channel goes through the same approval service and concurrency rules as Step 5.
- **Frontend:** make the Approval Inbox excellent on mobile, and installable as a PWA; a Notification settings page (link a Telegram chat, choose channels)
- Telegram is optional behind env flags; the app must work fully without it
- Tests: token signing/expiry/replay tests; Telegram webhook handler test with fixtures

## STEP 15 [NICE]: SLA timers, escalation, tracing and cost
- **Backend:** per-approval SLA timers (delayed BullMQ jobs): remind after X minutes, escalate to another approver or group after Y, auto-reject or auto-cancel after Z (configurable per workflow); OpenTelemetry traces per run (spans per node, with attempts and approval wait time) and an optional collector in Docker Compose; token and cost accounting per run
- **Frontend:** SLA countdown on approval cards; per-run cost and latency breakdown on the run page; an Analytics page with cost per workflow
- Tests: timer tests with fake clocks; escalation path test

## STEP 16 [MUST]: Polish and release
- **Demo seed:** a `pnpm seed:demo` command that prepares the exact scenario in the DEMO SCRIPT below (duplicate-charge ticket, policies, an approver user, a Telegram-less fallback)
- Playwright e2e covering login → start ticket run → approval pause → approve → refund and email visible → timeline shows exactly-once
- README: a one-line tagline near the top ("I called it unkillable, so I built a button to kill it."), badges, Mermaid architecture diagram, feature list, **chaos report table with measured numbers**, design decisions and trade-offs (include "why LangGraph checkpoints plus BullMQ", "why idempotency keys and an outbox", "why a separate repo from OrgMind"), screenshots/GIF of the graph and approval flow, quickstart in under 5 commands, roadmap, and an **Author section: Jahid Khan Tuhin, Full Stack JavaScript Engineer** (with placeholders for my GitHub/LinkedIn/email links)
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (ADR-style, authored by Jahid Khan Tuhin), `docs/DEMO-SCRIPT.md`, CONTRIBUTING (maintainer: Jahid Khan Tuhin), LICENSE (MIT, copyright "Jahid Khan Tuhin")
- Optional: OpenAPI docs generated from the zod schemas
- Final CI check, tag `v1.0.0`

# DEMO SCRIPT (what the finished project must support in 5 minutes)
1. Start the duplicate-charge ticket ("charged twice for order #4821, refund one"). The **live graph** lights up node by node; the draft cites the refund policy. (Steps 6, 8)
2. The policy shows the $42 refund is below the auto-approve limit, but money movement still requires a human, so the **Approval node pulses** and the run pauses. (Steps 5, 11)
3. A **Telegram message / signed link** arrives on my phone with Approve / Edit / Reject. (Step 14)
4. Before approving, click **Kill worker** in the Chaos panel; the graph freezes, the worker restarts, and the run reappears at the same node. Approve from the phone. Then kill the worker again mid-refund: the retry shows "idempotency key matched, skipped duplicate". One refund, one email. (Steps 3, 4, 9)
5. Inject a failure at `send_email`: retries with backoff, then dead-letter, then the graph **animates compensation in reverse order**. (Steps 4, 7)
6. Open the failed run, **time-travel** to the Draft checkpoint, view the state diff, change the tone, **fork** a new run, and watch it finish. (Step 13)
7. Show the **chaos report**: N runs, random kills, zero duplicate refunds, zero lost runs, recovery p95. (Step 10)

# OUTPUT FORMAT FOR EACH STEP
1. Brief plan (max 8 bullets)
2. Implementation
3. Summary of changes
4. How to test locally
5. Suggested commit message
6. "Ready for step N+1. Reply 'continue' when you've tested and committed."

# START
Begin with **STEP 1 only**. Do not proceed beyond it.
