# Step 8: Live workflow graph and run timeline

Run detail now renders its workflow definition with React Flow. This applies to support tickets and the durability demo, including older demo versions. The protected GET /runs/:id/graph endpoint uses runs:read permission, returns only graph metadata and chooses the run's version. The optional approval branch is omitted for ungated demos; gated demos use the approval route rather than the direct completion edge. Old demo versions without persisted definitions use the documented built-in legacy definition. Unknown definitions produce an explicit unavailable message.

## Test the main behavior

Use the existing local infrastructure and account. Set SUPPORT_LLM_PROVIDER=mock for repeatable results; CHAOS_ENABLED can remain false for this step.

```powershell
docker compose up -d
pnpm dev
```

1. Sign in as admin or approver. Open Runs → New ticket, choose the duplicate-charge example, give it a recognizable title and submit.
2. The first nodes finish, then approval turns amber and pulses. Refund/email nodes remain pending. Reduced-motion preferences disable animation while preserving text/color state.
3. Select Classify or Approval. Inspect input/output, recorded attempt count and elapsed duration. A waiting node has no output yet. Duration includes review wait, backoff and downtime; it is not CPU time or model latency.
4. Refresh. Saved history rebuilds the same graph and node timeline. Brief network loss reconnects from the accepted cursor; no events are counted twice.
5. Approve/edit/reject through Approvals, then inspect the run. Reviewer user ID, decision and timestamp appear in the approval group. Successful nodes turn green. Rejection leaves unexecuted effect nodes pending and the approval cancelled.

For retry/failure/compensation visuals, repeat the documented Step 7 Redis fault examples with fresh run IDs. A retry is violet; terminal failure is red. Compensation actions appear separately in reverse order with orange dashed edges; active rollback is orange and completed compensation is teal. Forward outputs/receipts remain historical, and the ledger cards show current reversed/voided effect status. No fault-control buttons or Chaos API are added in this step.

## What is recorded and rebuilt

### Why event numbers skip in the node timeline

Numbers such as #3 and #7 are event sequence numbers for the entire run, not row numbers that restart within each node. The grouped Node timeline shows only events associated with that node. Saved-state snapshots and other run-level events appear in the full Event history, so gaps in a node group are intentional and do not mean events were lost.

For example, Classify might show #3 step started, #4 node.attempt and #5 step finished. Event #6 can be a saved-state snapshot, followed by Retrieve Policy at #7–#9 and another snapshot at #10. These numbers are illustrative; actual numbers depend on the run, retries and other events. Open Event history to inspect the complete ordered sequence. The same sequence numbers are used for replay/reconnect; the UI does not renumber filtered entries.

- STEP_STARTED now optionally carries the node's input state. STEP_FINISHED carries its durable checkpoint output state. No input/output is logged before the corresponding existing event boundary. Existing events without those optional fields remain valid.
- Node state comes from ordered, sequence-deduplicated events plus the current run/checkpoint status. A fresh page replays from zero even if the server already supplied a newer run DTO, so old attempt/reviewer history is available without regressing the canonical run status.
- EventSource reconnects explicitly with ?after=lastAcceptedSequence. Repeated events are ignored. A sequence gap closes the stream and replays from the last accepted cursor rather than skipping missing work. The existing API also supports Last-Event-ID. Unmount closes the stream and cancels reconnect timers.
- Clicking a node shows recorded input/output state, persisted attempt count and elapsed start-to-finish time. Failed/in-progress nodes without a recorded finish show an open elapsed interval. Historical missing input/output/timing is labelled unavailable. Internal approval-control attempt records are part of the recorded count; it is not a count of LLM calls or physical process executions.
- Compensation graph nodes/edges are derived from its persisted plan and compensation events; the forward graph still comes from the versioned definition. A correction and reversal remain separate operations. Raw events and latest state stay available for audit.

## Automated verification

Stop development before builds/checks so Next's generated output is not shared between build/dev processes. Keep MongoDB, Redis and Mailpit running.

```powershell
pnpm dev:stop
pnpm check
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

The first command stops only the project's managed development session. Unit/component tests check node-state rendering/pulse, replay deduplication, attempts/retries, input/output/duration, reviewer reconstruction, compensation mapping and reconnect gap recovery. Integration checks include authenticated definition access and demo branch selection alongside the existing durable workflow suites.

The Playwright smoke test uses the production build, logs into a temporary seeded admin account, submits a real mock ticket through the form and verifies the pulsing waiting-approval node and completed classification. It selects the inspector, reloads, and confirms the graph rebuilds. A screenshot is saved to screenshots/step-8-approval-graph.png. No live model, refund provider or external customer is contacted.

The smoke harness starts its own API/worker/web on loopback ports 4100/3100 plus a token-protected test cleanup listener on 4101. It uses a random temporary MongoDB database and BullMQ queue, fixed synthetic test credentials, MockLLM and disabled fault hooks. It refuses occupied ports instead of stopping existing applications. Teardown targets only its own children/database/queue. Playwright traces/results are ignored by Git. CI runs the same smoke after the production build; remote CI success must be checked separately.

New dependencies: @xyflow/react 12.12.1 and @playwright/test 1.65.1, checked against the registry and official docs. No new application environment variables. Existing .env is unchanged; harness-specific environment values apply only to its child processes.

References: [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes), [React Flow component API](https://reactflow.dev/api-reference/react-flow), [Playwright web servers](https://playwright.dev/docs/test-webserver). Actual verification results are recorded in PROGRESS.md.

## v0.5 milestone

Step 8 is the intended v0.5 milestone: durable runs, approvals, support workflow, compensation and a live graph. The user manages Git. No commit, tag or push is performed by this step; create the v0.5 tag on the reviewed commit when ready. Step 9 now adds supervised browser chaos controls; see [STEP-9.md](STEP-9.md). Its extended smoke harness also uses temporary enabled development supervisors to test the Chaos panel, while keeping MockLLM and the isolated database/queue.
