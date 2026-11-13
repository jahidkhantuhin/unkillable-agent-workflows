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
