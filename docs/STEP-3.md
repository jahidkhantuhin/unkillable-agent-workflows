# Step 3: Durable execution core

Author: Jahid Khan Tuhin, Full Stack JavaScript Engineer.

## Execution and persistence

The API accepts requests and queues jobs. The worker performs the workflow work. Currently, it uses no AI model and sends no emails or payments.

If the worker crashes, a replacement worker picks up the abandoned job and resumes from the last saved checkpoint. The interrupted step may run again; completed, checkpointed steps are preserved. Recovery requires a replacement worker to be running; this step does not automatically restart a crashed process.

The API validates authenticated run requests, saves `queued` plus its event in a MongoDB transaction, and submits a stable BullMQ job (`jobId=runId`). A startup/periodic dispatcher retries `dispatchPending` queued records after an API crash or Redis outage. Retaining the job ID prevents repeated reconciliation from creating another job. Jobs are retained in Redis in this step; retention policies are future work.

The worker executes the fixed `durability-demo` graph. `prepare` normalizes whitespace, `summarize` produces a word count, and `complete` formats the result. Nodes are deterministic, inject start/checkpoint callbacks, and make no LLM or external-effect calls. Admins and approvers can create runs; all workspace members can read them. Inputs are capped at 500 characters. Thread IDs are generated UUIDs, never arbitrary client objects.

The graph uses LangGraph.js 1.7.4 and MongoDBSaver 1.5.1. Each run has `configurable.thread_id=runId`; synchronous durability waits for the native checkpoint write before proceeding. A new attempt loads the existing tuple and invokes with `null` to resume, rather than passing the original input again. A terminal run ignores duplicate delivery.

The checkpointer uses driver 6.22.0 through the explicit `mongodb-checkpoint-driver` alias, matching its supported major. Application repositories use driver 7.9.0. These clients share the database, not types or transactions. Saver setup checks index errors, creates `checkpoints`/`checkpointWrites` indexes, and retains history without TTL.

## Event consistency and recovery boundaries

`packages/storage` is a Node-only workspace shared by API and worker. It keeps validation, sequence allocation, run status/state updates, and event inserts in one repository layer. Status changes and their events are transactional. Event rows are append-only. A unique `(runId, sequence)` index protects ordering; a partial unique `(runId, key)` index deduplicates durable start/finish/checkpoint notifications.

The observed saver completes the native checkpoint write, then records step completion and a snapshot. On recovery, the worker reconciles completed steps from the stored checkpoint before continuing. A crash between checkpoint persistence and event publication therefore does not lose the visible result. A crash before a node's checkpoint may repeat that in-flight pure node. External-effect idempotency, executeOnce, outbox, and retry policies remain Step 4 work.

The demo drives queued → running → succeeded, or failed on execution errors/stalled exhaustion. Shared rules reserve waiting_approval, compensating, compensated, and cancelled for later features; no approval, cancellation, compensation, or chaos endpoints are added here.

## BullMQ settings

| Setting         | Default           | Reason                                                    |
| --------------- | ----------------- | --------------------------------------------------------- |
| lockDuration    | 15000 ms          | Bound local crash-detection time                          |
| lockRenewTime   | Half lockDuration | Renew before expiry while alive                           |
| stalledInterval | 5000 ms           | A replacement worker finds abandoned jobs                 |
| maxStalledCount | 3                 | Bound repeated crashes; exhausted jobs become failed runs |
| concurrency     | 1                 | Keep the initial sequential demo easy to inspect          |

A replacement worker must be running; there is no supervisor in this step. Detection depends on lock expiry, stalled-scan timing, and machine load; no measured percentile is claimed. Tests use isolated queue timings of 2000/1000 ms. Environment validation prevents sub-second lock/scan values. Shorter values increase Redis work and sensitivity to event-loop stalls.

## Streaming and UI

The SSE controller replays ordered MongoDB events in batches, then polls for new entries. IDs are per-run sequences. Last-Event-ID takes precedence over the query cursor; both are validated. The server flushes headers, honors backpressure, sends heartbeat comments, revalidates sessions every 15 seconds, and stops polling on disconnect. Finished runs replay then send a `stream-end` control frame. Graceful API shutdown ends streams so EventSource can reconnect after restart.

The allowlisted Next.js proxy forwards Cookie, Origin, and Last-Event-ID and returns the upstream ReadableStream directly. Its JSON timeout does not apply to SSE. The detail UI deduplicates events by sequence and rejects older state updates during replay. Refresh reconstructs the timeline from persisted history. The list polls every three seconds. React Flow remains Step 8 work.

## Verification

Run local services, then `pnpm test:integration`. Tests use disposable databases and a dedicated queue, not application resources:

- HTTP auth/RBAC, bad input/IDs, queued persistence while enqueue fails, and reconciliation by a new service instance.
- Atomic event sequences under concurrent writes and deduplicated checkpoint events.
- Finished-run SSE replay and strict Last-Event-ID behavior, including invalid cursors.
- A child worker is killed after `summarize` starts. Another child recovers its stalled job; `prepare` starts/finishes once, the interrupted node starts again, and the run succeeds with continuous event sequences.
- Terminal publication is interrupted after the final native checkpoint. A new executor finishes without rerunning nodes; terminal redelivery produces no extra events.

Live HTTP verification through the web proxy also confirmed an event arrives before completion, reconnect starts after its cursor, and all three completed nodes are retained.

References checked: [LangGraph checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers), [streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming), [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs), and the installed MongoDBSaver README/types and LangGraph durability documentation.
