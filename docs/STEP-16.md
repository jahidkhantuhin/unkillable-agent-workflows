# Step 16: Demo, documentation and release preparation

Author: **Jahid Khan Tuhin — Full Stack JavaScript Engineer**

## Included

- `pnpm demo:setup`: create a missing private `.env` with random auth secret, MockLLM and external channels disabled, then start local Compose. Existing environments are never overwritten.
- `pnpm seed:demo`: local synthetic admin/approver accounts, the USD 42 order #4821 ticket example and a versioned policy that demonstrates the mandatory human safety floor. No run/model/message/payment is triggered. Repeated seeds reuse users/examples/policy; custom policies and existing passwords are preserved.
- Chromium release-demo coverage using the real sign-in fixture, exact seeded example, graph/approval pause, signed confirmation, refund/email UI, receipt cardinality, Mailpit capture, effect checkpoint counts and replay refusal. Existing policy tests derive version assertions from the seeded current version instead of assuming an empty database.
- Consolidated README with tagline, badges, Mermaid architecture, feature list, measured report table, screenshots, design trade-offs, roadmap and author. Detailed previous operating notes remain in DEVELOPMENT.md. ARCHITECTURE.md, DECISIONS.md, DEMO-SCRIPT.md and CONTRIBUTING.md cover implementation, ADRs, the interview flow and contribution boundaries. Existing MIT attribution is retained.
- Root package version prepared as `1.0.0`; private workspace package versions/workflow definition versions are independent and unchanged.

## Local testing

```powershell
pnpm install --frozen-lockfile
pnpm demo:setup
pnpm seed:demo
pnpm dev
```

Use the [demo script](DEMO-SCRIPT.md). Default demo login details and optional synthetic overrides are in README/.env.example. Existing custom-policy workspaces should use an isolated demo database or intentionally activate the documented demo policy before seeding. Docker must already be installed with its Linux engine running. No production/remote MongoDB seeding is supported.

New optional local account settings: `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, `DEMO_APPROVER_EMAIL`, `DEMO_APPROVER_PASSWORD`. Example defaults are public local-test values; override before seeding if needed. Private `.env` is not edited by development work. The setup command only creates it if absent.

## Release checks and manual publication boundary

Before tagging, run `pnpm check`, `pnpm test:integration`, `pnpm test:e2e`, and the same 50-run chaos gate as CI with a separate report directory. Preserve the historical 500-run report and its measured README values. Current verification results belong in PROGRESS.md; a successful build alone does not establish integration or CI success.

The user controls Git: review the change, commit it, push it and inspect the remote CI result. Only after that should the user create/push the annotated `v1.0.0` tag and publish release notes summarizing features, measured local evidence and known limits. No Git/tag/push/publish command is run automatically. An existing tag must not be overwritten. A prepared root version is not evidence that a release/tag exists.

Optional generated OpenAPI documentation was not added; shared Zod contracts and the step-specific API guides remain the source of truth. A hosted tracing UI, real channel delivery, external billing accuracy and offline desktop execution are outside this release's verified local scope.

## Recorded local release evidence

- Full check: lint/format, workspace typechecks, 133 unit/component tests and production build passed; see PROGRESS for the final confirmation.
- Integration: 75 tests across 15 suites passed in 170.31 seconds.
- Browser: 12 tests passed in 2.7 minutes, including the seeded release walkthrough and actual local Mailpit capture.
- CI-sized chaos gate: 50/50 terminal runs (46 succeeded, 4 compensated), zero duplicate refunds/emails/Mailpit captures, zero lost runs and zero invariant violations. Seed 20261116; generated report duration 248374 ms. Detailed local scratch evidence remains in ignored docs/chaos-release; the historical tracked 500-run report remains unchanged.
- Frozen-lockfile offline installation passed. Documentation links and release screenshots were checked. Focused final seed verification passed both cases with explicit test-only input and guarded cleanup.

This is local verification of the CI commands, not a confirmed remote GitHub Actions result or published tag. Remaining user actions are commit/push, remote CI review and v1.0.0 tag/release publication.
