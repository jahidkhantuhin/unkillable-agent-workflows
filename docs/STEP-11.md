# Step 11: Approval policies and analytics

Admins can now decide which support replies proceed automatically, need one reviewer, or need two different reviewers. Every proposed refund still needs a human. The default remains one review for every ticket, so existing demos and the chaos suite keep their original behavior unless you activate another policy. Only fake refunds and local Mailpit email are supported.

## Main tests

Start local Docker services and the application as usual. Sign in as your seeded admin. Set SUPPORT_LLM_PROVIDER=mock for predictable examples; CHAOS_ENABLED can remain false.

1. **Preview before changing anything:** create a normal support ticket and wait at approval. Open **Policies → Load example rules → Dry-run past decisions**. Inspect the before/after outcomes for past support decisions. No policy, run, approval, checkpoint or effect changes. Click **Activate new version** to apply the draft to future policy evaluations; the already-waiting ticket retains its old version and still needs its original review.
2. **Automatic safe reply:** after activating the example, create the **How do I download my invoice?** example. Expect succeeded without an inbox wait, no refund, one local email. Run detail explains the matched rule and saved policy version. An automatic decision does not mean delivery can never fail.
3. **Two reviewers:** load the duplicate-charge example, set Charge amount to **15000** cents (USD 150), and start it. Expect waiting approval and Reviews 0/2. The first admin can edit with a reason or approve; the run stays paused with no effects. The same account cannot vote again. A different approver/admin reviews the same frozen content, then the workflow proceeds with one fake refund and one email. Either reviewer can reject before completion; rejection sends nothing. Editing after the first review is refused so both reviewers approve the same content.
4. **Feedback and metrics:** open **Analytics** after an approved edit or rejection, then **Refresh metrics**. Check the counts, formulas, rejection reasons and recorded original/edited text. Restore the conservative default by activating `{ "name": "Human review by default", "rules": [], "fallback": "require_approval" }` on Policies.

For a second local reviewer, use the existing seed command in a separate PowerShell terminal, then sign in to that account in a different browser/private window:

```powershell
$env:SEED_NAME = 'Local second reviewer'
$env:SEED_EMAIL = 'reviewer@example.test'
$env:SEED_PASSWORD = 'local-reviewer-test-password'
$env:SEED_ROLE = 'approver'
pnpm seed
```

These settings affect that terminal only. An existing account's password is not changed. Normal registration still creates viewers; it cannot grant approval rights. Policies and Analytics are admin-only; the inbox remains available to approvers and admins. No new environment variables or dependencies were added.

## Rules and decision inputs

Version history displays the policy/version as its heading, followed by a readable local date/time and **Saved by [name]**. The timezone label identifies the browser's local timezone; the original ISO timestamp is available on hover. Expand **Author details** for the full user ID. Current names are presentation-only; stored author IDs/timestamps remain unchanged, and missing accounts fall back to IDs.

The JSON editor validates a small declarative rule language; it does not execute code. Rules are ordered: the first matching rule wins, otherwise fallback applies. All conditions in a rule must match. An empty condition matches everything. Each rule has a unique id, explanation, conditions and outcome. Allowed conditions:

| Condition                       | Meaning                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| riskTier                        | high for a proposed refund or confidence below 0.8; low otherwise              |
| minAmountCents / maxAmountCents | Inclusive bounds on the **proposed refund**, not the original charge           |
| minConfidence                   | Inclusive lower bound on the validated classifier score                        |
| customerTier                    | standard or vip; supplied by the signed-in demo operator, defaults to standard |
| hoursUtc                        | List of allowed hours 0–23, using the run's creation hour in UTC               |

The evaluated action is `support_reply`: one approval decision covers the support workflow's refund/reply/close bundle. This does not replace retrieved support eligibility policies; those still determine whether any refund is eligible. Customer tier is synthetic demo input, not a verified CRM entitlement. In a real integration it would come from a trusted customer record. UTC creation time stays stable across queue delays/restarts; it is not the browser's local hour or time when the review happens.

Outcomes are `auto_approve`, `require_approval`, and `require_two_approvals`. An unconditional safety floor upgrades auto approval to one review if risk is high or a refund is proposed. The trace records that override. The engine does not use the LLM to approve money movement.

Version 0 is the built-in default. Activating a draft saves a new immutable version, actor and timestamp in MongoDB and atomically updates the current pointer. The UI shows the latest 100 saved versions; loading an older version edits the draft, and reactivation creates another version. Concurrent saves use expectedVersion; stale saves return 409 rather than overwriting another admin's work.

Risk Check records a single policy decision per run in policyDecisions, atomically with a policy.evaluated event. Its inputs, matched/nonmatched rule explanations, outcome, required reviewers and version are checkpointed in run state and displayed on run detail and the inbox. Retries reuse that decision even if the active policy changes. Existing pre-Step-11 approval waits continue under their original single-review behavior; historical runs are not retroactively evaluated.

Dry-run evaluates the draft against saved inputs from the latest 100 decisions and reports the total available. It neither activates a version nor reruns the workflow, calls a model or emits effects. It tests the candidate's logic, not a prediction of future delivery success. The result lists each previous/new outcome and candidate trace.

## Durable human review

The same MongoDB transaction records each reviewer, action, timestamp, edited message and available reason, increments the approval version, and checks the run is still waiting. Repeated actors, stale versions, concurrent duplicate resolution and edits after another person's review are rejected with 409. The first of two approvals emits approval.reviewed and keeps the worker slot released. The final approval/rejection emits approval.resolved and queues the next execution through the existing durable dispatch marker. First-review edits are preserved when the second reviewer approves. A rejection by the remaining reviewer overrides an earlier approval/edit.

The web UI requires a reason for edits and rejections. For compatibility, older clients can still submit an edit without a reason; analytics shows **Not recorded** rather than inventing one. Reviews are audit records, not training data. Demo notice approvals still work, but are excluded from these support-policy metrics.

## What each metric means

Feedback cards show the ticket title first, a smaller run ID, and **Rejected/Edited · Reviewed by [name]**. Expand **Reviewer details** for the full reviewer ID. Names are resolved from current user profiles; the durable review keeps the original actor ID. Deleted/missing/unnamed accounts fall back to that ID, and missing titles fall back to the run ID. Older approvals without a saved title use the run's saved title when available.

Metrics cover **all persisted support policy decisions**, not only the first page or completed workflows. Legacy runs without a policy decision and local notice demos are excluded. Refresh to obtain a new snapshot; this is not a live stream or a delivery-success dashboard.

| Metric                        | Exact calculation                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Human approval rate           | Decisions requiring one/two humans divided by all policy decisions; pending reviews count as requiring a human                                                                 |
| Median time to approve        | Median of final resolvedAt minus approval createdAt for approved/edited records only; two-review waits include both reviewers; rejections/pending/automatic decisions excluded |
| Edit rate                     | Final approvals with status edited divided by all resolved approvals, including rejections in the denominator; an edit followed by rejection counts as rejected                |
| Rejection reasons             | Count of final rejected approvals grouped by the exact saved reason                                                                                                            |
| Auto-approved share over time | Auto decisions divided by all evaluated decisions for each decision-creation date in UTC, including workflows that later fail                                                  |

No samples means **Not measured**, rather than a misleading zero. Original/edited text, reviewer, reason and run links appear in the latest 50 edit/rejection feedback records, sorted by review time. This includes an initial edit still awaiting another reviewer even though it does not yet count as a resolved edited approval. Analytics uses a cursor over all decision records with approval lookups; this simple local implementation has no date-range filter or precomputed rollups and may need aggregation/caching for large installations. Reads may span concurrent updates; refresh after reviews settle for reconciled counts.

## API, storage and verification

| Endpoint               | Access / behavior                                                                 |
| ---------------------- | --------------------------------------------------------------------------------- |
| GET /policies          | Admin; current version and latest 100 saved versions                              |
| POST /policies         | Admin + trusted Origin; expectedVersion and validated policy; activate atomically |
| POST /policies/dry-run | Admin + trusted Origin; validated candidate policy, read-only evaluation          |
| GET /analytics         | Admin; support-policy metrics and feedback                                        |

New collections: approvalPolicyHead (fixed support pointer), approvalPolicyVersions (unique version), policyDecisions (unique runId, date index). Index bootstrap remains idempotent. Existing approvals gain requiredApprovals and reviews with backward-compatible defaults. Existing state gains nullable policyDecision. No backfill or destructive migration is needed.

```powershell
pnpm check
pnpm test:integration
pnpm test:e2e
```

Policy table tests cover risk, amount boundaries, confidence, tier, UTC hours, first-match precedence, invalid rules and the money safety floor. Integration tests verify RBAC/Origin, immutable versions/stale updates, dry-run without writes, pinning across policy changes, actual automatic and dual-review workflow execution, edited payload preservation, rejection without effects, racing reviewers, and exact metric denominators/median/daily shares. CI and the local pre-push integration runner include these tests. Playwright exercises policy preview/activation, an automatic invoice reply, saved trace and analytics using isolated MockLLM/local effects. Actual results are recorded in PROGRESS.md; remote CI success must be checked separately.

The Step 10 report remains the historical measurement from that step; it is not silently regenerated or presented as a new Step 11 measurement. Step 12 has not started.

Browser verification also exposed a graph refresh issue: measured node dimensions were being discarded when live views rebuilt controlled nodes. The graph now retains dimension updates, following the [React Flow controlled-flow API](https://reactflow.dev/api-reference/react-flow#onnodeschange). The browser harness waits for its own API health before web startup so the first login cannot race an unready dependency. Neither fix changes approval policy semantics.
