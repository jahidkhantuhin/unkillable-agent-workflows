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

## Step 4: Reliability layer

Added transactional `executeOnce` receipts with stored result replay, unique keys, per-node durable retry budgets/deadlines, capped exponential backoff with jitter, retryable/permanent error classification, and dead letters with saved failure context. Version 2 of the demo uses a transactional outbox and an idempotent MongoDB local notice sink; existing version 1 workflows remain pure. No model calls, emails, payments, or customer effects occur.

Added the admin Dead Letters page and inspect/retry/discard APIs with role checks, trusted origins, and optimistic concurrency. Manual retry preserves checkpoints and effect keys while advancing the execution generation and queue job ID. Generation checks fence stale jobs and dispatch acknowledgements. Discard retains failed-run history and records the actor. Timelines now show attempts and scheduled delays; run details expose receipts, outbox status, and local delivery counts. Four local simulation scenarios exercise healthy delivery, transient recovery, retry exhaustion/manual recovery, and permanent failure/discard. See STEP-4.md for usage and boundaries.

The receipt callback is restricted to session-bound MongoDB writes. A transaction callback can re-enter after rollback; the guarantee covers one committed local effect, not arbitrary external network calls. The dispatcher commits its delivery and acknowledgement atomically. Outbox exhaustion remains visible on its row and does not retroactively fail a completed run. BullMQ infrastructure retries are separate from node budgets, and failed-job reconciliation handles worker crashes before dead-letter publication.

Verification performed locally:

- `pnpm check` passes lint/format, all workspace typechecks, 48 service-free tests (10 integration tests deliberately skipped), and the production build, including the dynamic Dead Letters route.
- `pnpm test:integration`: 10 pass across four files with isolated MongoDB databases and a Redis queue. Includes two child processes racing on one effect key, rollback, exit after commit and result replay, concurrent dispatchers, real worker kill after effect commit before its checkpoint, exhausted/permanent node failures, admin RBAC, concurrent manual retry (one success/one 409), and discard. Earlier auth, dispatch, ordered-event/SSE, and checkpoint recovery cases still pass.
- Browser verification through the actual Next.js proxy: seeded admin sign-in; exhausted run shows three attempts and two jittered delays; failure context exposes checkpoint, policy, stack and saved state; Retry from checkpoint resumes only complete and reaches succeeded with one sent outbox intent and one local delivery. Two stored receipts represent the intent and delivery, not two notices. The smoke-test run is retained for inspection. Development processes started for verification were stopped afterward.
- CI integration selection includes the new reliability suite; no remote CI result is claimed. The pre-push hook continues to run `pnpm check`; integration tests remain a separate local command and a CI check.

New optional environment variable: `NODE_RETRY_POLICIES={}`; defaults require no local .env changes. Documented in .env.example and STEP-4.md. No dependencies added. No Git commands, commits, or pushes performed. Step 5 has not started; awaiting review and continuation.

### Step 4 follow-up: identifiable test scenarios

Added shared color-highlighted scenario labels to every Runs list entry, the run timeline header, and Dead Letters cards. Healthy delivery is green, transient recovery blue, exhausted retries amber, and permanent failure rose. Labels remain separate from execution status, so a recovered exhausted-retry test keeps its scenario name. The entered demo message is prominent on all three views; IDs remain available for precise identification. Older runs without a delivery mode default to Healthy delivery. No new environment variables or dependencies.

Verification: `pnpm lint`, web typecheck, and web production build pass. This presentation-only follow-up was not rechecked in the browser. No Git commands were run; Step 5 remains unstarted.

Title hierarchy follow-up (corrected per user clarification): the test title (entered demo message) appears first in a larger, semibold font on Runs, run timelines, and Dead Letters. The smaller highlighted scenario label sits immediately underneath, before the run ID. `pnpm lint` and web typecheck pass; browser verification was not repeated for this styling change. No new environment variables or Git commands.

Rendered-layout verification follow-up: rebuilt the web production output successfully, then opened a fresh browser view of the existing development app at localhost:3000/runs. Confirmed the retained Fourth run entry renders its test title before Permanent failure; discard example and its run ID. The earlier screenshot showed the older ordering; the exact cause of that stale view was not established. No source layout changes or Git commands were needed.

## Step 5: Human approval gates

Added an optional approval node to version 3 of the demo, using native LangGraph interrupt and Command resume with the existing MongoDB checkpointer. The worker publishes pending approvals only after the interrupt is durable, returns its job, and releases the queue slot. A fresh generation-specific job resumes the same thread after a decision. Redelivery recovers a checkpoint saved before approval publication, and recovery after the resumed decision checkpoint does not submit that decision twice. Existing version 1/2 behavior and the four default reliability scenarios are preserved.

Added layered approval list/get/resolve APIs with approver/admin RBAC, strict decision schemas, trusted-origin mutation checks, and transactional optimistic concurrency. Decisions record reviewer user ID, timestamp, original proposal, and approve/edit/reject payload in the approval record and run events. Resolution durably sets pending dispatch; the existing reconciliation loop recovers Redis outages. Rejection resumes the graph to its end and marks the run cancelled, without queueing a local notice. There is one optional gate per demo run; resolved decisions cannot be reopened.

Added the protected Approval Inbox, with two-second refresh, proposed action, draft editing, deterministic reasoning, reject reason, busy/error states, and original-versus-edited approval controls. Runs can opt into approval; timelines show the waiting state, inbox link, reviewer decision, and checkpointed approval step. Test title/scenario hierarchy is preserved. The landing page and README now describe the implemented approval flow; STEP-5.md explains the action walkthroughs, API, guarantees, and boundaries.

Verification performed locally:

- `pnpm check` passes lint/format, all workspace typechecks, 49 service-free tests (16 integration checks deliberately skipped), and production build with the dynamic /approvals route.
- `pnpm test:integration`: all 16 pass across five files. Six approval cases verify queue-slot release and a second run completing during the wait, fresh-executor approve/reject, edited notice delivery, viewer denial/approver/admin access, strict input and Origin checks, concurrent decision (one 200/one 409), reviewer audit, queue-outage reconciliation, recovery before approval publication, recovery after the resumed checkpoint, and an older checkpoint without approval channels. Existing effect concurrency, killed-worker, event/SSE, auth and dispatch tests still pass.
- Browser test through the actual web proxy: start a gated demo, observe waiting approval with zero receipts/deliveries, open Inbox, edit the draft, verify Approve original disables and Approve edited draft enables, submit, and observe succeeded with edited noticeMessage, reviewer audit, one sent outbox intent and one local delivery. Screenshots: screenshots/step-5-approval.png and screenshots/step-5-approved-run.png. The local smoke-test run is retained; development processes started for this check were stopped afterward.
- CI selects the new approval integration file; remote CI execution is not confirmed.

Issues fixed during implementation: optional approval-state channels round-tripped as null through MongoDB checkpoints, breaking normal runs; explicit state defaults restore normal/retry paths. The legacy-checkpoint test now uses the native saver serializer to remove the new channels and verify their actual absence before recovery. Command resume uses explicit graph node generics to satisfy the installed LangGraph types. Formatting checks were rerun after normalizing newly added tests.

Final recovery review: a late failed queue acknowledgement after a durable approval pause must not convert its pending review to a dead letter. Added a transactional failure-recording guard, skipped waiting reviews in failed-job maintenance, and included a regression assertion in the approval integration suite.

Resumed final verification: Docker Desktop was initially stopped, so the first integration attempt failed during database setup without running its tests. Started the installed Docker Desktop and healthy local Compose services. The older killed-worker test then exposed a timing-sensitive crash boundary: STEP_STARTED did not guarantee that the following attempt-record transaction had committed. Changed the harness to wait for the committed summarize node.attempt event before killing the child during its simulated node delay, registered cleanup exit listeners before killing, and added run/job/log diagnostics on recovery timeout. The full integration suite then passed all 16 tests across five files (29.62 seconds), including the final pending-approval failure guard. No Step 6 work or Git commands were performed.

No new environment variables, dependencies, model calls, external emails/payments, Git commands, commits, or pushes. Step 6 has not started; awaiting review and continuation.

### Step 5 follow-up: separate test title and notice content

The Runs form now has a required Test title (up to 200 characters) and separate Notice content (up to 500). New runs store title independently of message, which remains the notice field for API compatibility. Lists, timelines, Dead Letters and Approval Inbox headings use the title. The Inbox edits only notice content; run detail displays original notice content and approved edited content separately. Existing runs, checkpoints, pending approvals and message-only API requests remain supported through message fallback and explicit title defaults. No migration, new dependencies or environment variables.

Verification: `pnpm check` passes lint/format, all typechecks, 50 service-free tests and the production build. `pnpm test:integration` passes all 16 tests; the edited-approval test now proves that title and original message remain unchanged while noticeMessage/delivery contain approved edits, and the older checkpoint fixture also omits title. Browser test on the existing development app creates Separate title verification with distinct notice content, verifies the Inbox heading/draft differ, approves edited content, and observes succeeded with the unchanged title and both content versions displayed. Screenshot: screenshots/step-5-separate-title-content.png. Existing development processes were reused; no Git commands or Step 6 work.

### Step 5 follow-up: demo control alignment

Right-aligned Start demo run with a bordered, clickable Require human approval control beside it. Matched selector and checkbox heights, added a selected-state highlight, and allowed responsive wrapping below the scenario selector on smaller screens. `pnpm lint` and web typecheck pass. Browser visual verification could not complete because navigation and tab selection timed out. No behavioral changes, new environment variables, dependencies, Git commands or Step 6 work.

### Step 5 follow-up: initial session experience

The client provider previously began with an unknown session on every full page load and waited for hydration plus a separate same-origin proxy request; cold development compilation could extend that checking state. RootLayout now loads the existing serverIdentity result and seeds the provider, so a verified identity or anonymous state is present in initial HTML. React cache shares that server read only within the render request; requests without cookies skip the API entirely. Protected pages and API permission checks still verify authorization. Session-bearing pages are now dynamic/private, including the landing page; public identities are never cached across users or persisted in browser storage.

Client focus/login/logout refreshes remain supported, with in-flight request deduplication and a five-second timeout. API failures clear client identity and show an explicit Retry control rather than silently showing Sign in or checking forever. Server-unavailable public pages can fall back to this bounded client check. Server-provided identity updates synchronize on router refresh. Development first-page compilation remains a separate startup cost; no numerical latency improvement is claimed.

Verification: `pnpm check` passes lint/format, workspace typechecks, 59 service-free tests (16 integration checks skipped), and production build. Nine new tests cover initial authenticated/anonymous server rendering, unverified fallback, concurrent request deduplication, request retry after failure, timeout, cookie forwarding, no-cookie API avoidance, and outage versus signed-out semantics. A temporary production server on port 3100 returned initial HTML containing a separately authenticated identity on both / and /runs, no Checking session placeholder, and private cache headers. Anonymous HTML had no checking placeholder; logout returned 204 and subsequent anonymous HTML contained no prior identity. A fresh browser tab showed the authenticated user and navigation in its initial snapshot. The temporary server and its separate test session were stopped/revoked; existing development sessions were preserved. No new dependencies/environment variables, Git commands or Step 6 work.

### Step 5 follow-up: dev reload loop and terminal shutdown

The existing Next.js dev log showed repeated recompiles and repeated browser DevTools startup messages without source edits, confirming a full-reload loop. Identified and stopped only this workspace's Next dev and tsx-watch process trees to release the stuck session. Changed development to Next's supported Webpack mode; production build configuration remains unchanged. The upstream Turbopack trigger is not confirmed, so this is an observed-stable development workaround, not a claimed upstream fix.

Replaced nested pnpm parallel dev execution with scripts/dev.mjs, launching the actual Next/tsx Node entries directly. It tracks only its own child roots, rejects duplicate managed sessions, handles Ctrl+C/termination across the group, and provides pnpm dev:stop from a separate terminal. Recovery metadata stays in the OS temporary directory, outside Next's watched source tree. The fallback checks recorded entry paths against current process commands before targeting a process. Windows stops whole process trees; Unix uses process-group termination and bounded escalation. Stopping during an active job relies on existing checkpoint/idempotency recovery when restarted. Docker and unrelated apps are not stopped.

Successful API GET logging is now debug-level; mutations/errors remain visible. Request/response serializers retain method, URL, request ID, and status without verbose headers. API standalone shutdown also closes idle keep-alive connections and has a forced HTTP connection fallback after its existing timeout.

Manual verification: managed startup brings web/API/worker ready; the Runs page's unsent test title remains intact across idle background polling, with no repeated recompile/browser-reload messages (screenshot: screenshots/dev-reload-stability.png). Actual Ctrl+C in the test PTY prints All development processes stopped. Restarted a fresh session, verified a second pnpm dev refuses duplicates, and verified pnpm dev:stop closes the launcher with exit code 0. Afterwards, zero app listeners on ports 3000/4000 and zero workspace dev CLI processes remain. No customer effects, new dependencies/environment variables, Git commands or Step 6 work.

Final checks: `pnpm check` passes lint/format, workspace typechecks, 59 service-free tests and production build; `pnpm test:integration` passes all 16 tests across five files. These ran with dev servers stopped. The workspace's app processes are left stopped for a clean user restart.

Documentation follow-up: added README's Development bundler: why Webpack section immediately after setup/development guidance. It explains each bundler, configuration differences, the observed local reload loop and limits of that diagnosis, the dev-only switch, unchanged production bundler, and the separate terminal-cleanup fix. Linked official references and the verification record. No runtime changes or new tests were needed for this documentation-only update.

Production bundler documentation follow-up: added commands for the current default Turbopack production build, explicit `next build --turbopack`, an optional permanent build-script selection when switching from Webpack, and serving the generated output with next start. Clarified that development can remain on Webpack independently and that bundler selection happens at build time. No runtime configuration was changed.

## Step 6: Support ticket router

Added support-ticket-router version 1 with classify → retrieve_policy → draft_reply → risk_check → approval → issue_refund → send_email → close_ticket. It reuses durable MongoDB checkpoints, generation-specific dispatch, retry budgets, approval audit and Dead Letters. Rejection cancels the run and records a rejected ticket without either effect. Existing demo versions remain supported.

Added injected LLM, Retriever, PaymentsClient, Mailer and TicketStore interfaces. Default MockLLM and the local policy corpus are deterministic; classification and cited drafts are validated with Zod. Only a sufficiently confident duplicate-charge classification with an allowing cited policy can propose a refund, and all replies/refunds require human approval. Optional Gemini/Ollama providers use AI SDK structured output; an optional local OrgMind HTTP bridge has an explicitly documented contract. Default worker startup loads optional provider SDKs lazily. No live model quota was used; live Gemini/Ollama and OrgMind compatibility are not confirmed.

Fake refunds use executeOnce and a unique MongoDB ledger key. Email intent and receipt commit atomically with an outbox intent; SMTP runs outside transactions. Stable Message-IDs plus local Mailpit receiver deduplication cover concurrent sends and the accepted-before-acknowledgement crash gap. Compose enables persistent Mailpit storage, duplicate-ID suppression and unlimited retained message count. This guarantee depends on retained receiver IDs, not SMTP alone. Failed email intents stop background delivery until authorized retry; retries reuse the committed refund and email identity. Compensation remains Step 7 and is not implemented.

Added authenticated ticket APIs, three idempotently seeded synthetic examples, strict .test recipient validation, the New ticket form, support scenario identification, node outputs and fake refund/email cards on run detail. Approvals show the proposed amount, recipient, reasoning and policy citation; editing changes only reply text. Title and original ticket description remain unchanged. README and STEP-6.md document setup, walkthroughs, provider configuration, storage, failure recovery and guarantee boundaries.

Verification performed locally:

- `pnpm check` passes lint/format, workspace typechecks, **66 service-free tests** (23 integration checks intentionally skipped), and the production build including dynamic /tickets/new.
- `pnpm test:integration` passes **23 tests across six files**; the final run completed in 29.82 seconds. New coverage includes ticket API/RBAC/input validation, seeded examples, edited approval, rejection with no effects, how-to without refund, one refund and one Mailpit capture, acceptance before a lost acknowledgement, concurrent SMTP dispatch, permanent email failure and Dead Letters retry without repeating the refund, terminal redelivery, and final-checkpoint recovery. Existing auth, approval, queue and killed-worker checks remain passing. Tests use MockLLM, fake payments and local Mailpit only; synthetic captures are retained.
- An earlier parallel integration run encountered a MongoDB monitor network timeout across multiple suites. Limited integration concurrency to two in both the local runner and CI; subsequent complete runs passed. Remote CI execution is not confirmed.
- `pnpm db:migrate` passes. `pnpm seed` run twice passes without duplicate examples or resetting existing account passwords. Compose successfully recreated local Mailpit with the configured persistence/deduplication settings.
- Browser verification through the actual web proxy: created Step 6 duplicate-charge browser test, observed waiting approval with zero receipts/deliveries and the USD 49 proposal/citation, edited the reply in Approvals, and observed succeeded, unchanged title, approved edited text, one fake refund, one sent email/outbox delivery and closed ticket. Screenshot: screenshots/step-6-run.png. The synthetic smoke-test run is retained. The managed development processes started for verification were stopped; no listeners remained on ports 3000/4000.

New environment variables (safe defaults are in .env.example): SUPPORT_LLM_PROVIDER, GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_MODEL, OLLAMA_BASE_URL, OLLAMA_MODEL, ORGMIND_RETRIEVER_ENABLED, ORGMIND_RETRIEVER_URL, MAILPIT_SMTP_HOST, MAILPIT_SMTP_PORT and MAILPIT_API_URL. Existing .env was not modified. Added pinned AI SDK 7.0.173, Google provider 4.0.121, OpenAI-compatible provider 3.0.92, Nodemailer 10.5.0 and its types; workflows declares Zod directly. Existing LangGraph/checkpointer versions remain unchanged.

No Git commands, commits, pushes, real customer messages or real payments. Step 6 is complete; awaiting review and explicit continuation before Step 7.

## Step 7: Saga compensation and failure injection hooks

Added a support compensation registry mapping issue_refund → reverse_refund, send_email → send_correction_or_void and close_ticket → reopen_ticket. A terminal node failure after any committed effect stores a durable reverse-order plan in run.state.saga and transitions to compensating. Plans read committed effect receipts, including an effect saved before its forward checkpoint. Refund reversal marks the existing fake ledger row reversed; ticket reopening and reversal each use executeOnce. The original reply is marked voided and one separately keyed correction is queued/sent to local Mailpit, also protected by executeOnce and stable Message-ID deduplication. Captured messages are not deleted or recalled. With no committed effects, failure still uses Dead Letters. Existing durability-demo scenarios remain unchanged.

Compensation progress and action events are durable. An interrupted rollback resumes before any forward graph invocation. Failed compensation remains compensating, records an audit event and is retried by worker maintenance every five seconds, including after restart; it is never silently declared complete. Terminal queue failure also checks for support effects requiring compensation. Completed runs become compensated, retain the original failure and reopen the local ticket for follow-up. Original forward checkpoints remain historical evidence. Runtime generation coalescing keeps maintenance and queue execution from racing locally without swallowing a new approval generation; transactional receipts/progress handle separate workers. Forward effects serialize against saga creation via the run audit, and expected-status fencing prevents a stale forward checkpoint overwriting the saga plan. Background outbox maintenance no longer sends support replies/corrections independently of their owning executor.

Added injected RedisFaultInjector hooks before/after demo/support task nodes, native approval control boundaries and compensation actions. CHAOS_ENABLED=false returns before reading flags. Enabled per-run/node/phase flags implement retryable throw_once, permanent throw_always, bounded delay_ms and consume-before-exit crash_process. One-shot consumption uses atomic Redis compare/delete. The native approval interrupt remains outside retry catches. No Chaos API/UI or process supervisor was added; a deliberately crashed worker needs a replacement. Added CHAOS_ENABLED=false to .env.example without changing the existing .env or user-selected provider settings. No dependencies or migrations beyond existing index bootstrap were needed.

Run detail now distinguishes compensating/compensated status, explains recovery and preserves the original failure. Refund/email cards show active/reversed, reply/correction and original-message voiding. Timeline labels identify compensation actions, and forward outputs explain their historical meaning after rollback. README, STEP-6.md and the new STEP-7.md describe current semantics, exact PowerShell Redis commands, four fault modes, replacement-worker recovery and Mailpit guarantee boundaries. Step 8 graph work is not included.

Verification performed locally:

- `pnpm check` passes lint/format, all workspace typechecks, **69 service-free tests** (30 integration tests deliberately skipped), and the production build.
- Final `pnpm test:integration`: **30 passed across seven files**, 42.62 seconds. Seven saga cases cover failure before/after the last effect, reverse-order compensation, throw_once recovery without rollback, racing correction/reversal executors, stale checkpoint fencing, correction SMTP acceptance before lost acknowledgement, no-effect failure using Dead Letters, and a real child-process exit during compensation. The crash occurs after the fake reversal receipt commits but before progress is saved; a replacement worker completes without duplicate reversal/correction. Terminal redelivery adds no events. Existing auth, approval, checkpoint, SMTP and reliability cases remain passing.
- The earlier support SMTP-failure integration now asserts pending compensation, recovery, a reversed refund and one correction instead of forward retry after a committed refund. Mailpit contains only synthetic captures; test databases, queues and their fault flags are cleaned up. The normal user's development processes were not stopped.
- An attempted additional managed dev launch correctly refused because an existing user dev session was running. It was left in place, and .env was not changed. A separate Step 7 browser smoke test was not performed; UI changes were checked through types and build. CI selects the saga suite; remote CI execution is not confirmed. No live LLM or OrgMind requests were used.

Issues addressed: an effect can commit before its graph checkpoint, so rollback must discover receipts rather than rely only on completed-node state. SMTP acceptance cannot be inferred from a missing acknowledgement, so a persisted reply intent receives an explicit correction with its own deduplicated identity. TypeScript required explicit Record typing for saga state updates; formatting was normalized after the first lint check identified the new saga file. These changes introduce no real payment or customer-email effects.

No Git commands, commits or pushes were run. Step 7 is complete; awaiting review and explicit continuation before Step 8.

## Step 8: Live workflow graph and node timeline

Added React Flow graph rendering from the run's versioned workflow definition through a protected GET /runs/:id/graph endpoint and same-origin proxy. Definition nodes supply labels/types/edges; gated and ungated demos show their actual branch, with legacy demo fallback for older versions. Support compensation actions come from its persisted plan/events and render as a separate reverse path. Nodes distinguish pending, running, succeeded, failed, pulsing waiting approval, retrying, compensating, compensated and cancelled. Active forward edges animate; reverse edges are orange/dashed. Dark-mode controls follow the app theme and reduced-motion preferences disable animation.

Graph selection opens input/output, persisted attempt count, reviewer/decision and wall-clock duration inspection. The grouped node timeline shows ordered attempt/retry/reviewer events while retaining the raw event log and latest state. STEP_STARTED/STEP_FINISHED now optionally carry input/checkpoint output state, preserving compatibility with historical events. Missing historical payloads/timing are labelled unavailable; duration includes review, backoff and downtime and is not CPU/model time. Original forward outputs remain historical during compensation.

Added an ordered event projection and reconnect controller. Fresh pages replay from zero without regressing the server's newer canonical run DTO. Reconnect resumes after the last accepted sequence, ignores duplicates, and replays gaps rather than skipping events. Closed/old stream callbacks cannot schedule duplicate reconnects or mutate an unmounted view. Stream completion refreshes final run state. Added the first Mermaid architecture diagram to README, current capability/setup docs, and STEP-8.md with behavior, limitations and verification. v0.5 is the intended milestone; the user manages the release tag and no Git operation was performed.

Added pinned @xyflow/react 12.12.1 and @playwright/test 1.65.1 after checking registry versions and official docs. No new application environment variables and no existing .env edits. The isolated Playwright harness uses only temporary child-process settings: ports 3100/4100, a token-protected cleanup listener on 4101, a unique test database/queue, synthetic seeded admin credentials, MockLLM and disabled faults. It refuses occupied ports. Vitest explicitly selects .test.ts/.test.tsx files so Playwright .spec.ts files run only under Playwright. CI installs Chromium and runs the smoke after building; actual remote CI execution is not confirmed.

Verification performed locally:

- `pnpm check` passes lint/format, all workspace typechecks, **82 service-free unit/component tests** (30 integration tests intentionally skipped), and the production build. New tests cover accessible state/pulse rendering, ordered replay, input/output/elapsed timing, attempts/retries, reviewer reconstruction, compensation mapping and reconnect cursor/gap handling.
- `pnpm test:integration`: **30 tests pass across seven files**, 51.02 seconds. Existing queue/auth/approval/support/compensation recovery remains passing. The run API test additionally verifies unauthenticated definition denial, the normal demo's node list and gated branch selection.
- The first integration attempt started while the local Docker services were stopped, causing Mongo connection/setup failures. Started the project's Compose services and reran the suite successfully; no assertion failure was hidden or reclassified as a pass.
- `pnpm exec playwright install chromium` completed. Final `pnpm test:e2e`: **1 passed**, 9.8 seconds. The actual production web form logs in to its isolated admin account, creates a mock ticket, observes classification succeeded/approval pulsing, opens the inspector and checks the recorded ticket title, reloads and confirms the same graph state. Screenshot: screenshots/step-8-approval-graph.png. Visual inspection found low-contrast default React Flow controls in dark mode; theme-aware colorMode fixed that before final verification.
- The browser harness cleaned up: no listeners remained on its test ports and a read-only Mongo check found zero remaining unkillable_e2e_ databases. The normal app database/account settings were not altered; synthetic smoke work paused before effects. Existing development applications were not stopped by the harness.

Implementation issues fixed: TypeScript required REDIS_URL to be explicitly declared in the child environment object; reconnect callbacks now bind to their own source and guard against duplicate/stale callbacks; failed-node elapsed timing stops at compensation start. No real customer, payment or live model calls were used. No Git commands, commits, tags or pushes were run. Step 8 is complete; awaiting review and explicit continuation before Step 9.

Step 8 documentation follow-up: explained run-wide event sequence numbers beside the timeline guidance in README and STEP-8.md. Node groups intentionally omit snapshots and unrelated run-level events, preserving original sequence numbers; an illustrative Classify #3–#5, snapshot #6, Retrieve Policy #7–#9 example points readers to the full Event history. Documentation only; no runtime changes, new tests or Git commands.
