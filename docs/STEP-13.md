# Step 13: Time travel and fork

Time travel lets you inspect the state saved after workflow steps, compare two checkpoints, and start an independent child run from a chosen point. Browsing never resumes the parent. Forking records the parent run and checkpoint; links let you move between them.

## Three focused tests

Start Docker and `pnpm dev`, sign in as admin, and use `SUPPORT_LLM_PROVIDER=mock` for predictable results. No new environment variables or packages are required. `CHAOS_ENABLED=false` is fine.

| Test                    | Action                                                                                                                                                                                                                     | Expected result                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inspect and compare     | Create a duplicate-charge ticket. Once it waits for approval, open Time travel. Select the checkpoint ending in draft_reply; compare from retrieve_policy. Open Saved state.                                               | The diff shows the proposed reply and completed-step changes. The parent stays waiting; no refund/email is created by inspection. The slider moves through loaded checkpoints from oldest to newest.                                                                                 |
| Edit and fork           | At draft_reply, enter the JSON below and click Create fork.                                                                                                                                                                | A new run opens with the edited title/reply, a parent link and a fresh approval wait. Approve the child in the inbox. It succeeds with one new fake refund and email. The parent remains waiting; its saved state and checkpoints are unchanged. Reload either run to see the links. |
| Validation and recovery | Try `{"approvalAction":"approve"}` as edits: creation is rejected. Separately create a demo using Permanent failure, choose its summarize checkpoint and fork with `{"title":"Recovered branch","deliveryMode":"normal"}`. | Protected-state edits cannot bypass approval. The recovered child succeeds; the failed parent and its Dead Letter remain available. Forking does not retry, discard or reopen the parent.                                                                                            |

```json
{
  "title": "Kinder duplicate-charge reply",
  "draftMessage": "We are sorry about the duplicate charge. Your refund is ready for review."
}
```

The JSON field accepts an **edit patch**, not a replacement for all saved state. `{}` creates a branch without changing editable inputs. Unknown keys, wrong types, empty strings and overlong values are refused both in the browser and API. Editing a support draft requires a checkpoint where draft_reply has completed. Choose the checkpoint by its completed node name, rather than assuming a particular number.

## What a fork preserves and resets

| Workflow           | Editable fields                               | Reused results                                              | Repeated work                                                                                                                                               |
| ------------------ | --------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durability demo    | title, message, deliveryMode, requireApproval | prepare/summarize results, if message is unchanged          | Approval (when required), complete/delivery. Changing message clears prepare/summarize and runs them again.                                                 |
| Support ticket     | title, draftMessage                           | Completed classify, retrieve_policy and draft_reply results | risk_check under the current policy, fresh human approval, refund/email/close. New ticket ID; no old approval, policy decision or effect receipt is copied. |
| Content moderation | title                                         | Immutable original file reference and completed upload      | automated_check, auto_decide, any required admin review, publish/reject and notify. New content ID; prior human approval is never inherited.                |

Selecting a later checkpoint may therefore rewind to a safe point. Completed pure steps appear in the child graph as preserved; they have no new model attempts. The fork.initialized timeline event explains its origin. For a support fork, a previously human-edited reply becomes the new proposed draft unless draftMessage explicitly replaces it. The child still requires a new review.

All support forks receive high risk in the policy inputs. The existing safety floor forbids auto-approval of high-risk proposals, even if an admin activated a broad auto-approve rule. Current rules can still require two distinct reviewers. Moderation forks rescreen the original file with the currently configured model/rules; a previous manual allow does not bypass review. Text/file replacement is outside this step: submit changed content as a new moderation run.

## Idempotency and durability rule

**A fork is a new intent, not a retry of the parent's effects.** Every child gets a fresh run ID, business ID, approval record and run-scoped idempotency keys. For example, parent and child refunds use different `runId:issue_refund:…` keys. Replaying the child uses its own receipts and does not create another refund/publication within that child. Parent effects are not undone: approving both runs can produce one additional local refund/email per run. Each successful POST creates a separate child; resubmitting it is another intent.

The API reads the chosen parent's native LangGraph state and sanitizes it. It creates the child run, its new ticket/moderation item and the parent's run.forked audit event in one MongoDB transaction. A durable dispatch marker uses the existing queue reconciliation if Redis is temporarily unavailable. The worker seeds the fresh thread with LangGraph updateState using the last retained node as asNode (or START), then invokes the graph from its pending work. After a restart it finds the saved child checkpoint and resumes instead of reseeding. Previous pending writes, interrupts and effects from the parent thread are not copied.

No new notification channel, real payment, customer email or platform publication is introduced. Normal worker delivery still uses fake payments/local Mailpit or local moderation records. Inspection itself never invokes an LLM or any effect adapter. The Step 10 chaos report remains a historical measurement and is not regenerated by this step.

## API and storage

| Route                                                   | Purpose                                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /runs/:id/checkpoints?limit=50&before=CHECKPOINT_ID | Newest-first native history summaries: ID, parent checkpoint, timestamp, native step, next nodes, completed nodes and whether initialized. Default page 50; maximum 100. The optional cursor must belong to this run. |
| GET /runs/:id/checkpoints/:checkpointId                 | Saved state and summary at one checkpoint.                                                                                                                                                                            |
| GET /runs/:id/diff?from=ID&to=ID                        | Read-only JSON diff from one checkpoint to the other.                                                                                                                                                                 |
| GET /runs/:id/forks                                     | Parent and latest 50 children, using titles in the UI.                                                                                                                                                                |
| POST /runs/:id/forks                                    | Body: checkpointId and optional edits object; returns the new run with HTTP 202. Trusted Origin required.                                                                                                             |

All reads use existing runs:read permission. Only approvers/admins have runs:fork; moderation forks require admin. Checkpoint IDs and cursors are checked against the requested run's thread before reading. Missing/foreign checkpoints return 404. The native input checkpoint may have no initialized state and cannot be forked. Current workflow versions are forkable (demo v3, support/moderation v1); older histories remain inspectable.

No checkpoint data is duplicated into a new history collection: getStateHistory/getState read the existing MongoDB checkpoints/checkpointWrites. New run fields are parentRunId, forkCheckpointId and forkAsNode. A parentRunId/createdAt index supports family links. Native checkpoint IDs encode step information and can use nonstandard UUID variants; validation accepts the bounded hexadecimal identifier shape and still checks thread ownership. They are unrelated to the global event numbers in the run timeline.

The dropdown's Step number is LangGraph's checkpoint counter for that thread, including input checkpoints at -1/0. A child starts its own counter; reused parent nodes do not each add a new child checkpoint. Use the completed node name to identify the fork point. These counters are not consecutive workflow-node labels or timeline event IDs.

Diffs use deterministic JSON Pointer paths: `~` becomes `~0`, `/` becomes `~1`. Object key order is ignored; additions/removals differ from null values. Changed arrays are shown as whole before/after values, rather than a misleading element-matching algorithm. Checkpoints with the same state can legitimately have no diff. Dates display in the browser's local timezone. Refresh checkpoints reloads history/family links; reload and SSE reconnection use persisted history. Load older extends the scrubber beyond the first page.

## Automated verification

```powershell
pnpm check
pnpm test:integration
pnpm test:e2e
```

The service-free suite checks diff semantics and state sanitization. The new time-travel integration suite uses a disposable local MongoDB database, mock LLMs and mock email transport: history pagination, ownership/permission/Origin checks, invalid edits, failed-parent forks, queue-outage reconciliation, changed-input recomputation, fresh support effects across restart/duplicate execution, the policy safety floor, and moderation re-review/publication. It is included in the existing pre-push integration runner and CI. Existing recovery/chaos tests continue to cover real BullMQ stalled-job behavior.

The browser flow selects two support checkpoints, sees the draft diff, rejects a protected edit, creates an edited child, approves it, reloads and follows family links while confirming the parent remains waiting. The browser suite signs in through the real UI once per worker and reuses the in-memory session in isolated contexts, avoiding repeated logins that would hit the real rate limit. Scheduled outbox assertions allow 15 seconds because maintenance runs every five seconds. Run the build/check before the browser suite, not concurrently: both use Next's production output. Actual command results are recorded in PROGRESS.md; remote CI execution is not implied by local checks.
