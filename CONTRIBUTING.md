# Contributing

Maintainer: **Jahid Khan Tuhin — Full Stack JavaScript Engineer**

## Local setup

Use Node.js 24+, pnpm 12.16.1 and Docker Compose. Follow the four-command [quickstart](README.md). Setup preserves an existing private `.env`; never commit credentials, personal phone data or real customer records. The private build prompt is intentionally ignored. Keep synthetic `.test` recipients, fake payments, local Mailpit and MockLLM in tests. Do not contact live model/messaging/payment providers from automated tests or CI.

## Working agreement

Follow the repository's AGENTS.md. Work one requested step/change at a time and preserve unrelated user changes. Do not run Git operations unless explicitly authorized; the user commits and tags releases. Document behavior and limitations in README and PROGRESS, recording real command results rather than inferred numbers. Author/maintainer attribution remains Jahid Khan Tuhin; contact fields stay placeholders until supplied.

Keep validation/contracts in `packages/shared`, queries/transactions in `packages/storage`, workflow definitions/providers in `packages/workflows`, execution in the worker, and thin HTTP routes in the API. Every external-effect adapter must respect the local sandbox and the transactional idempotency/outbox boundaries. Changes to review flows must preserve roles, distinct-reviewer quorum, version checks and signed-token single use. Read local Next.js documentation before editing the web app, as instructed in its AGENTS.md.

## Checks

Stop managed development before production builds/browser tests. Run sequentially:

```powershell
pnpm check
pnpm test:integration
pnpm test:e2e
```

Docker services are required for integration/browser tests. Tests own random databases/queues and clean only their own resources. Do not purge Mailpit or delete shared volumes to make a test pass. Diagnose readiness/transport errors and keep assertions meaningful; do not hide failures with retries, longer timeouts or skipped cases. The pre-push hook runs the check and integration commands; do not bypass it.

CI adds a seeded 50-run chaos gate. For local reproduction without overwriting the historical published report:

```powershell
pnpm chaos --runs 50 --seed 20261116 --report-dir docs/chaos-release
```

Keep test evidence explicit: local passed checks do not confirm a remote GitHub Actions run, live bot delivery or production readiness. Use Conventional Commit suggestions and clear descriptions of behavior/verification. See [release preparation](docs/STEP-16.md) for the user-controlled v1.0.0 tag/release checklist.
