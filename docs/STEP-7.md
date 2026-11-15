# Step 7: Saga compensation and failure injection hooks

Support workflows can now undo their committed local effects after a node fails permanently or exhausts its durable retry budget. This is a saga: several individually committed actions, followed by explicit compensating actions when later work fails. It is not one transaction spanning the whole workflow, and history is retained.

## What gets compensated

| Forward effect | Compensation            | Observable result                                                                               |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| issue_refund   | reverse_refund          | The original fake refund ledger entry is marked reversed; its compensation has a unique receipt |
| send_email     | send_correction_or_void | Original reply is marked voided, and one separate correction is captured in Mailpit             |
| close_ticket   | reopen_ticket           | Ticket returns to open                                                                          |

The registry runs in reverse order: reopen_ticket → send_correction_or_void → reverse_refund. Only actions with committed forward receipts enter the plan. Failing before close_ticket means no reopen is necessary. Failing after its effect but before its checkpoint includes reopening, because the plan reads actual receipts rather than trusting only completed checkpoints. Zero-refund tickets do not create a refund receipt and therefore need no reversal.

The original reply cannot be unsent. An email intent may have reached Mailpit even if its acknowledgement was lost, so compensation always sends a correction for a persisted reply intent. The correction says the previous simulated reply is void and any fake refund is being reversed. It does not claim reversal has already succeeded. Expect an original and a correction when the original was delivered: those are two different intended messages, not a duplicate. They have distinct stable Message-IDs. Mailpit deduplicates retries of each message while its IDs are retained. An already in-flight SMTP request cannot be recalled; do not interpret compensation as deleting a recipient's message.

All payments remain fake MongoDB records, all recipients must end in .test, and SMTP remains local Mailpit. No external customer or payment service is used.

## Durability and failure behavior

The worker transactionally stores state.saga (plan, completed actions and original failure), stops pending forward email, and changes running → compensating. Each compensation uses executeOnce: ledger reversal/ticket reopening commit with their receipt, and correction intent commits with its receipt/outbox. SMTP stays outside transactions; its own delivery receipt and receiver-side Message-ID deduplication cover acknowledgement gaps. Compensation progress and ordered events are durable. A crash after the effect commits but before its progress marker reuses the existing receipt on restart.

The worker checks compensating before invoking LangGraph, so recovery continues rollback rather than the failed forward graph. Worker maintenance scans pending compensations every five seconds. A compensation error records compensation.failed and leaves the run compensating; later actions wait until it succeeds. A persistent fault must be cleared, or unavailable local infrastructure restored. There is no bounded abandonment that silently declares rollback complete. Maintenance and queue executions of the same generation share an in-process promise; MongoDB receipts and transactional progress handle racing workers. New approval generations are kept separate.

Forward effect transactions touch the run audit, serializing them against saga creation. Forward checkpoint updates require running status so a stale executor cannot overwrite the rollback plan. Terminal compensated runs do no additional work when redelivered. Final state is compensated, the original failure remains, and the local ticket is open for follow-up. Original forward checkpoint outputs remain historical evidence; current effect status appears in the ledger cards and saga state.

Failures before any support effect still enter Dead Letters and can use the existing admin retry/discard behavior. The durability demo's existing reliability scenarios retain their behavior. Demo nodes receive fault hooks, but its local notice workflow has no support compensation registry. No Step 8 graph redesign, Step 9 Chaos UI/API/supervisor, or published chaos measurements are included.

## Test locally, one action at a time

Use your existing .env. For predictable tests, set:

```env
SUPPORT_LLM_PROVIDER=mock
ORGMIND_RETRIEVER_ENABLED=false
CHAOS_ENABLED=true
```

CHAOS_ENABLED is the only new environment variable; its code and .env.example default is false. Restart the worker after changing it. Disabled hooks return before reading Redis, so leftover flags cannot trigger faults while disabled. Do not enable hooks for ordinary operation.

```powershell
docker compose up -d
pnpm db:migrate
pnpm seed
pnpm dev
```

As admin, create a duplicate-charge ticket titled Step 7 rollback test with 4900 cents and a fresh synthetic recipient such as rollback1@example.test. Wait for approval and copy the run UUID from its timeline URL. In a second PowerShell terminal at the repository root:

```powershell
$runId = 'PASTE-RUN-UUID-HERE'
$faultKey = "unkillable:fault:${runId}:close_ticket:after"
'{"mode":"throw_always"}' | docker compose exec -T redis redis-cli -x SET $faultKey
docker compose exec -T redis redis-cli EXPIRE $faultKey 600
```

Approve the ticket. It will refund locally, send its reply, close the ticket, then fail at the after hook. Watch compensating → compensated. Timeline actions must finish in order: reopen_ticket, send_correction_or_void, reverse_refund. Refund status becomes reversed, the original reply is voided, the correction is sent and ticket is open. Inspect the original plus correction at http://localhost:8025. The original failure remains visible. Clear the test flag:

```powershell
docker compose exec -T redis redis-cli DEL $faultKey
```

Each scenario needs a new ticket/run UUID. Set its flag while waiting for approval, then approve:

| Node / phase          | JSON value                         | Expected behavior                                                                                                                    |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| send_email / before   | {"mode":"throw_once"}              | One transient failure, normal durable retry, succeeded with one original email and active refund; no compensation                    |
| close_ticket / before | {"mode":"throw_always"}            | Terminal failure before closing; correction then refund reversal; no reopen action                                                   |
| close_ticket / after  | {"mode":"delay_ms","delayMs":5000} | Pause after closing, then succeed; no compensation                                                                                   |
| send_email / after    | {"mode":"crash_process"}           | Worker exits abruptly after effect/ack but before the node checkpoint; start a replacement and recover without duplicating the reply |

The key format is unkillable:fault:RUN_UUID:NODE:PHASE, where PHASE is before or after. Any forward node, including approval, has hooks; native interrupt itself is never caught/retried as an error. Compensation node names are reopen_ticket, send_correction_or_void and reverse_refund. For example, combine close_ticket:after throw_always with reverse_refund:after crash_process to crash after reversal commits but before its progress marker. A replacement worker finishes rollback using the same reversal receipt.

throw_once is consumed atomically and raises a retryable error. throw_always remains until cleared/expired and raises a permanent error. delay_ms remains until cleared/expired and accepts integer delays from 1 to 30000 ms. crash_process is consumed atomically before process.exit(137), so replacement workers do not repeatedly hit the same crash flag. Hooks run inside durable retries for normal task work; compensation retries come from worker recovery instead. Only local operators with Redis access can set these flags at this step; no remote mutation endpoint is added.

Step 9 now starts automatic API/worker supervisors when root pnpm dev runs with CHAOS_ENABLED=true in development. Its browser controls replace the need to type these Redis commands. Without a supervisor, stop the managed app session with pnpm dev:stop and restart pnpm dev to start a replacement. An abandoned queue job recovers through BullMQ's lock/stalled-job handling; a compensating run is also found by maintenance. See [STEP-9.md](STEP-9.md). Remove persistent flags and reset CHAOS_ENABLED=false when finished.

## Verification

Stop dev before running production checks; keep Docker services running:

```powershell
pnpm dev:stop
pnpm check
pnpm test:integration
```

Unit tests cover disabled isolation, atomic one-shot flags, phase/run isolation, persistent errors, bounded delay and consume-before-crash behavior. Integration tests use temporary databases, unique queues and synthetic recipients with MockLLM. They verify reverse-order rollback before/after the final effect, transient recovery without compensation, racing compensators, stale checkpoint fencing, lost correction acknowledgement, failure before any effect, and an actual child-process exit during compensation followed by replacement-worker recovery. The earlier SMTP-failure test now expects compensation rather than forward retry after a refund. Existing auth, approval, reliability and crash tests remain included. See PROGRESS.md for actual results; no remote CI or live model success is implied.

No dependencies were added for this step. Existing versions: BullMQ 6.7.6, MongoDB application driver 7.9.0, LangGraph.js 1.7.4 and MongoDBSaver 1.5.1. References: [MongoDB transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/), [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs), [Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/).

Step 8 has not started.
