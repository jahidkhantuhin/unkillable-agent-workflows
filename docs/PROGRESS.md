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
