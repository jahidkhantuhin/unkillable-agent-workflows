# Step 4: Reliability layer

The API accepts requests and queues jobs. The worker performs the workflow work. Currently, it uses no AI model and sends no emails or payments. Version 2 of the demo records a local notification in MongoDB. Existing version 1 runs keep their original pure behavior.

If it crashes, a replacement worker picks up the abandoned job and resumes from the last saved checkpoint. The interrupted step may run again; completed, checkpointed steps are preserved. A replacement process must be running; automatic supervision remains a later step.

## Try the four scenarios

Start the local Compose services and run `pnpm dev`. Sign in with your configured seeded administrator. On Runs, choose a scenario and start a demo:

| Scenario          | Expected result                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Normal            | Succeeds with one outbox intent and one stored local delivery                                               |
| Retry once        | Complete fails transiently once, shows its retry delay and attempt 2, then succeeds                         |
| Exhaust retries   | Complete exhausts three attempts and opens a dead letter; Retry from checkpoint succeeds in a new execution |
| Permanent failure | Complete fails on attempt 1 without automatic retry; inspect it in Dead Letters and Discard                 |

The run detail page shows attempts, scheduled delay, effect receipts, outbox status, and local deliveries. Two internal receipts after delivery are expected: one for the node's intent and one for the dispatcher's delivery. They represent one delivered notice.

Only admins can inspect or resolve Dead Letters. Viewers and approvers receive 403 from those APIs. Public registration still creates viewers. Retry and Discard require the displayed record version; concurrent resolutions return one success and one 409. Retry preserves the run/thread and checkpoint, increments its execution generation, and creates a distinct queue job. Stale jobs cannot update the new generation or clear its dispatch marker. Discard closes the failure record with actor identity; the run remains failed, history is retained, and committed effects are not undone.

## Retry policy

Node attempts, classification, policy, and retry deadlines persist in `nodeAttempts`. Defaults are three total attempts, initial delay 1000 ms, multiplier 2, maximum delay 10000 ms, and jitter 0.2. Delay is capped exponential backoff multiplied by a random value from 0.8 to 1. A restart waits the remaining stored deadline and retains the budget. An interrupted running attempt may repeat with its same attempt number; checkpoint recovery and effect receipts handle that uncertainty.

Optional worker setting in `.env`:

```dotenv
NODE_RETRY_POLICIES={"complete":{"maxAttempts":4,"initialDelayMs":500,"maxDelayMs":5000,"multiplier":2,"jitter":0.2}}
```

Restart the worker after configuration changes. Overrides accept prepare, summarize, and complete; invalid settings fail startup. A persisted attempt keeps its original policy. Explicit transient errors, network failures, HTTP 429, and HTTP 5xx retry; validation errors, explicit permanent failures, and unknown errors fail closed. The permanent demo does not consume the remaining budget. BullMQ's separate three-attempt exponential retry handles infrastructure failures; it does not multiply an exhausted node budget. Exhausted/stalled jobs are reconciled into dead letters even after a worker restart.

## Effect and outbox boundaries

`executeOnce(key, fn, resultSchema)` uses a unique `runId:nodeId:stable-key` receipt, a MongoDB transaction, and a validated stored result. Concurrent invocations race at the unique index. The winner's receipt, session-bound Mongo writes, and outbox intent commit together; replay returns that original result. A crash before commit rolls everything back. A crash after commit but before checkpoint publication reuses the receipt. Effect keys stay stable across manual retries.

The callback must contain only MongoDB writes using the supplied session, including the provided enqueue helper. MongoDB may re-enter the callback after an aborted transaction. This guarantees one committed local effect, not a single callback invocation. Never perform an HTTP call, email send, or payment inside this transaction. Future external adapters need receiver-side idempotency because a database transaction cannot atomically commit an external service's response.

The worker dispatches pending outbox records to `localDeliveries`. Its delivery receipt, sink insert, sent acknowledgement, and audit event commit together, so concurrent dispatchers and restarts produce one local delivery. Dispatch failures use bounded retries; after exhaustion the outbox row becomes failed with its error visible. An outbox failure does not retroactively fail an already completed workflow or create a node dead letter. Email/payment kinds are reserved for future adapters; neither is sent in Step 4. SSE waits for pending outbox work before closing a terminal stream.

Dead letters retain error code/message/classification/stack, node and attempt count, policy, workflow version, saved state, execution generation, checkpoint identifier where available, and queue context. Inspect these through the admin page before retrying. No failure history or checkpoints are deleted by either action.

## API and verification

- `GET /runs/:id/reliability`: authenticated receipt/outbox/local delivery details.
- `GET /dead-letters` and `GET /dead-letters/:id`: admin failure inspection.
- `POST /dead-letters/:id/retry` and `/discard`: admin, trusted Origin, JSON `{ "version": 0 }` (use the current version).
- `pnpm check`: lint/format, all typechecks, service-free unit tests, production build.
- `pnpm test:integration`: isolated temporary MongoDB databases and Redis queue; requires the local Compose services and `.env`.

Integration checks cover two child processes racing on one key, transaction rollback, receipt replay after process exit, two concurrent dispatchers, a real worker kill after effect commit before checkpoint, retry exhaustion, permanent failure, RBAC, concurrent manual retry, and discard. Existing auth, event/SSE, dispatch recovery, and checkpoint recovery checks remain included. Tests never kill the normal development worker or send real side effects. Actual verification results are recorded in PROGRESS.md.

Step 5 approvals have not started.
