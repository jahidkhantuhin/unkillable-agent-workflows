# Step 5: Human approval gates

The demo can wait for an authorized human before queueing its local notice. It still uses no AI model and sends no emails or payments. Inbox reasoning is a deterministic explanation, not generated model reasoning.

## How to test locally

```powershell
docker compose up -d
pnpm dev
```

Sign in as the configured seeded administrator or an existing approver. On Runs, enter a recognizable test title/message, select Healthy delivery, check **Require human approval**, and start the demo. Prepare and summarize finish; the timeline shows **waiting approval**. No notice has been queued yet.

Open **Approvals**. Each pending card shows its proposed action, original draft, editable content, reasoning, and run link. The inbox refreshes every two seconds. Try three separate runs:

| Action               | How to try it                                         | Expected result                                                                         |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Approve original     | Leave the draft unchanged and select Approve original | Same run resumes and delivers its original local notice once                            |
| Approve edited draft | Change the draft, then select Approve edited draft    | Same run resumes; its outbox and local delivery contain the edited message              |
| Reject               | Enter a reason and select Reject                      | Same run resumes, records the decision, and becomes cancelled without queueing a notice |

Approve original is disabled while the draft is changed, preventing silent loss of edits. Edited approval requires nonempty content up to 500 characters. Rejection requires a nonempty reason up to 1000 characters. The API enforces these rules too. The original test title stays unchanged after editing; inspect noticeMessage in saved state and the outbox payload for approved content.

While a run waits, start another demo without approval: it should finish normally. Restart the worker while the first waits, then resolve it; its saved interrupt survives. Concurrent reviewers get one successful decision and one conflict. Refresh the inbox after a conflict; the timeline retains the winning decision. Only approvers/admins can read or resolve approvals. Registration still creates a viewer.

## Pause and resume

Version 3 conditionally routes summarize → approval → complete when requireApproval is true. Its default is false, preserving the four Step 4 scenarios. Existing version 1/2 checkpoints keep their original path; the gate is introduced on new version 3 runs.

The approval node calls native LangGraph interrupt() outside the retry wrapper. LangGraph checkpoints the interrupt and returns control. After that saved interrupt is visible, the worker transactionally creates the pending approval and approval.requested event and marks the run waiting_approval. The queue processor returns, completes its job, and releases the slot. No worker sleeps or polls waiting for a human.

If a worker stops after saving the interrupt but before publishing the approval, redelivery reconstructs the request from saved graph state. The unique (runId, nodeId) index and event key prevent duplicate requests. Redelivered waiting runs return without advancing the graph.

Once a pending review is durable, a late failure acknowledging the old queue job cannot move it into the dead-letter queue. Resolution creates a separate generation-specific job, so the review remains actionable even across that queue boundary.

Resolution transactionally checks pending status/version, stores the decision and reviewer ID/time, increments the version, and appends approval.resolved with its actor and decision. It also increments run execution generation and sets queued/dispatchPending. Concurrent or repeated decisions return HTTP 409. Actor identity comes from the authenticated session; clients cannot supply it.

The API queues a new generation-specific BullMQ job. Its existing dispatch loop recovers a Redis outage or API restart. The worker passes Command({ resume: decision }) to the same graph thread only while its saved task is interrupted. If the resumed decision already checkpointed before a crash, normal null-input recovery continues without resubmitting it. Prepare/summarize stay checkpointed. Approve/edit continues to complete; reject routes to END and publishes cancelled. Step 4's stable effect keys still prevent duplicate committed local effects.

Resolved decisions are immutable. There is one optional gate per demo run; re-requesting review and workflow-specific payloads belong to future workflows. Combining approval with a failing delivery scenario requires its decision first, then complete follows Step 4 retry/DLQ rules. Rejection is cancellation, not a dead letter.

## API

- GET /approvals: pending records, oldest first, up to 100.
- GET /approvals/:id: inspect a pending or resolved record.
- POST /approvals/:id/resolve: approver/admin and trusted Origin, with the current version and decision:

```json
{ "version": 0, "decision": { "action": "approve" } }
```

```json
{
  "version": 0,
  "decision": {
    "action": "edit",
    "payload": { "message": "Human-approved local notice" }
  }
}
```

```json
{
  "version": 0,
  "decision": { "action": "reject", "reason": "Do not deliver this notice" }
}
```

Unknown records return 404; invalid bodies return 400; unauthorized roles return 403; stale/already-resolved records return 409. The same-origin Next.js proxy forwards the endpoints/cookies. Existing SSE updates run timelines for requested/resolved decisions; inbox polling is separate and stops on unmount.

## Verification and boundaries

```powershell
pnpm check
pnpm test:integration
```

Integration tests use isolated databases and a unique Redis queue. They verify fresh-executor pause/resume, actual slot release and another job finishing while approval waits, approve/edit/reject, viewer denial, approver/admin access, invalid payloads/origins, concurrent resolution, reviewer audit, queue-outage reconciliation, and recovery after interrupt checkpoint before approval publication. Existing concurrency and killed-worker checks remain in CI. Actual results are in PROGRESS.md. No new environment variables or dependencies.

References: [LangGraph interrupt/resume](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [interrupt API](https://reference.langchain.com/javascript/langchain-langgraph/index/LangGraphRunnableConfig/interrupt). Retained versions: LangGraph.js 1.7.4, MongoDBSaver 1.5.1, BullMQ 6.7.6, application MongoDB driver 7.9.0, checkpoint alias 6.22.0. Explicit defaults prevent empty approval-state channels from becoming invalid nulls after checkpoint serialization.

Step 6 has not started.
