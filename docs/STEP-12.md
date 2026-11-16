# Step 12: Async content moderation

The second workflow moderates synthetic UTF-8 text. An administrator submits text or a file; the worker checks it with the configured LLM and local rules, publishes/rejects automatically or waits for admin review, then queues a local notification. **Published means one local MongoDB publication record.** Nothing is posted to a real platform, and moderation notifications are local database deliveries rather than customer emails.

## Main tests, with expected results

Use SUPPORT_LLM_PROVIDER=mock for predictable examples. Start local Docker services, restart pnpm dev after this update, sign in as admin, and open **Moderation**. CHAOS_ENABLED can stay false for these tests.

| Test            | What to do                                                              | Expected result                                                                                             |
| --------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Safe content    | Click Safe example, then Start moderation                               | published, workflow succeeded; no approval wait, one local publication and one notification intent          |
| Admin review    | Click Review example, then Start moderation; open the run               | waiting approval, no publication yet; graph highlights Admin review                                         |
| Approve         | Open Approval Inbox, download/read the original and Approve publication | resumes the same run, publishes once and queues one local notice                                            |
| Reject          | Submit another Review example; reject it with a reason                  | rejected, workflow succeeded; no publication; one local rejection notice                                    |
| Blocked content | Click Blocked example and submit                                        | rejected automatically, no admin wait and no publication                                                    |
| File handling   | Select a UTF-8 .txt/.md file instead of inline text                     | original can be downloaded; files over 16000 characters require review unless rejected; maximum size 10 MiB |

A succeeded run means **the moderation process completed**, not that the content was approved. Skipped graph branches are marked skipped. Notifications may be delivered shortly after the workflow finishes by the existing outbox maintenance loop. Open the run's effect receipts or MongoDB localDeliveries to inspect them.

Admins can submit/download/review moderation content. Approvers and viewers cannot use the queue/upload/download endpoints or resolve moderation approvals; the shared inbox hides these approvals from non-admins. The existing workspace-wide Runs permissions still apply to run graphs/state, including a bounded content preview. Use synthetic text only, not confidential uploads. Moderation content is immutable: approval editing is refused by the repository, and the UI offers only approve/reject. To change text, create a new submission/run.

## Workflow and decision rules

The stored definition is content-moderation version 1:

```text
HTTP upload → persistent run → BullMQ queue
upload → automated_check → auto_decide
                          ├─ allow → publish ─┐
                          ├─ reject → reject ─┤→ notify
                          └─ review → admin review → publish / reject ─┘
```

The graph's upload node acknowledges an already-stored artifact; it does not upload the file again. Admin review uses the shared approval node ID, labelled Admin review in this workflow. A LangGraph interrupt checkpoints the state and releases the worker slot; the existing approval transaction/dispatch marker resumes the same thread after a decision.

Automated checks validate structured verdict, confidence and reason. The model sees only the first 16000 characters, treated as untrusted data. Local rules scan the complete bounded file:

- DEMO_BLOCK anywhere, or a model reject, causes automatic rejection.
- DEMO_REVIEW, a model review, confidence below 0.9, more than five HTTP(S) links, or content beyond the model preview requires an admin.
- Otherwise content can be published automatically.

MockModerationLLM returns predictable results from the demo markers. In normal worker startup, SUPPORT_LLM_PROVIDER selects MockLLM, Gemini or Ollama through an injected ModerationLLM interface, using the existing model/key settings. Tests and browser harnesses force mocks. This is a demonstration rule set, not a comprehensive safety classifier or a production moderation policy. Step 11's support approval-policy editor and support-only analytics do not control these moderation decisions.

## What is reused

| Existing platform part            | Use in moderation                                                     |
| --------------------------------- | --------------------------------------------------------------------- |
| Run creation / durable dispatch   | Persist a run before queueing; reconcile dispatch after queue outages |
| LangGraph / MongoDB checkpointer  | One thread per run; resume completed checkpoints after restart        |
| Shared retries and nodeAttempts   | Bound retries, classify failures and show attempts/backoff            |
| Approval repository/service/inbox | Transactional single-resolution, actor/reason audit, queued resume    |
| executeOnce                       | Stable publish/reject/notify receipts independent of attempts         |
| Transactional outbox / local sink | Queue one notice and acknowledge one local delivery                   |
| Saga registry / compensator       | Reverse committed effects in durable reverse order                    |
| Run graph, SSE and node timeline  | Render the new stored definition and recover after reload             |
| Dead letters / worker maintenance | Handle exhausted jobs and continue pending compensation               |
| Chaos controls                    | Inject moderation-node faults; respect the global pause/hard lock     |

Publication uses runId:publish:publication, rejection uses runId:reject:decision, and notice creation uses runId:notify:notice. Unique indexes, transactional receipts and publication uniqueness prevent duplicated jobs/retries from creating another publication for the same run. A new submission is a new intent/run; the upload endpoint does not deduplicate arbitrary resubmitted HTTP requests after a lost response.

Effect transactions also touch the run while it is running. This serializes them against compensation; local notification delivery checks a running/succeeded run and pending outbox intent in the delivery transaction. A terminal failure after publication starts the shared saga: void_moderation_notice first, then unpublish_content (or restore_moderation after a rejected decision). Notices not yet delivered are failed; existing local deliveries are marked voided, not erased. Published records and the content decision become withdrawn. Compensation is idempotent/checkpointed, and maintenance retries unfinished compensation. A failure before any committed effect uses the ordinary dead-letter path instead.

For a manual rollback demo, enable development chaos and its UI switch, start a Review example, inject **notify → after → permanent failure**, then approve. Expect a compensated run, a withdrawn publication and voided/failed notice, with the reverse path visible on the graph. Reset/pause Chaos when finished. Already delivered local notices remain historical records marked voided; they are not claimed to have never existed.

## Files and storage boundaries

ContentStorage abstracts put/read/open/remove; LocalContentStorage is the local implementation. The API streams text directly to an exclusive random UUID .txt file under the repository's ignored .local/moderation directory. The web proxy forwards the request stream rather than converting it to JSON or embedding the file in MongoDB. Input is bounded at 10 MiB, validated as UTF-8 and hashed while streaming. Empty, invalid and oversized partial uploads are removed. Normal UI size validation reports the limit before sending; an oversized chunked/raw client can receive a connection error when the streaming limit terminates its request.

Only the file key, byte length, SHA-256, title and bounded results/preview enter MongoDB/checkpoints/events. The worker verifies the content hash before checking it. Keys cannot contain paths, and originals are downloaded as text attachments through an authenticated admin endpoint, never served as executable HTML.

API and worker must share the same local filesystem. Multi-machine storage requires another adapter/shared storage; no cloud storage is configured. Files are retained for audit, including rejected/withdrawn content, with no automatic retention/garbage collector. A process crash between storing a file and committing its run can leave an orphan. On ordinary create errors, deletion happens only when the repository confirms no saved reference; an unavailable database conservatively leaves the file. Do not manually delete a referenced file while a run may resume. Test harnesses remove only their owned files/databases/queues.

## Queue metrics and storage

The queue polls every two seconds and shows the latest 50 submissions. Its headline metrics cover the full moderation dataset:

- Backlog: runs queued, running, waiting approval or compensating. Failed/cancelled runs are not counted; inspect them through Runs/Dead Letters.
- Waiting for admin: moderation runs with waiting_approval status.
- Decisions in last 24 hours: current published/rejected moderation items with decidedAt within a rolling 24-hour window. Withdrawn records are excluded; this is decision throughput, not completed notification delivery or a model-speed benchmark.

moderationItems stores artifact metadata/current outcome (unique runId); publishedContent stores local publication records (unique runId). Shared runs, runEvents, approvals, checkpoints, nodeAttempts, idempotencyKeys, outbox and localDeliveries retain execution/audit history. Pending item status queued means no final content decision; consult the separate workflow status for a failed job. API bootstrap/migrate and worker startup create the new indexes idempotently. No existing database migration/backfill or new dependencies/environment variables are required.

API endpoints: GET /moderation, POST /moderation/uploads?title=... (raw text/plain), and GET /moderation/:runId/content. Uploads require an admin, trusted Origin, valid title and UTF-8 content. Review uses the existing /approvals/:id/resolve endpoint with additional admin enforcement and no edit action for moderation.

## Automated verification

```powershell
pnpm check
pnpm test:integration
pnpm test:e2e
```

Unit tests cover routing/confidence, whole-file rules beyond the model preview, invalid structured output, storage limits/UTF-8/path validation/partial cleanup and skipped graph branches. Service-backed tests exercise the real queue, retries after publication, duplicate delivery, concurrent first publication, process-runtime restart during review, authorization and immutable decisions, local outbox deduplication and rollback before/after delivery. Playwright submits safe, blocked and review-required content through the actual UI, uploads a file larger than the JSON limit, approves it, observes the graph after reload and checks one local notification. CI and pre-push include the integration file. Actual results are in PROGRESS.md; remote CI is not confirmed.

References: [LangGraph interrupts](https://reference.langchain.com/javascript/langchain-langgraph/index/LangGraphRunnableConfig/interrupt), [Node.js streaming pipeline](https://nodejs.org/api/stream.html), [AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data). Step 13 remains unstarted.
