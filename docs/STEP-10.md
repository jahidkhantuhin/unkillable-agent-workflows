# Step 10: Measured chaos suite

The CLI runs the real support workflow with deterministic MockLLM, automatically approves synthetic tickets as a test admin, injects seeded faults and checks the resulting database records. It also searches local Mailpit for actual message captures. No customer, bank, real payment service or live AI provider is contacted.

## Run it locally

Use your existing root .env with local MONGODB_URI and REDIS_URL. MAILPIT_API_URL defaults to http://127.0.0.1:8025. The harness rejects remote service hosts, forces child processes to MockLLM/local policies/local SMTP and supplies its own temporary signing secret and account. It does not edit .env or require changing your normal CHAOS_ENABLED setting.

```powershell
docker compose up -d
pnpm chaos
```

The published 500-run measurement passed using `pnpm chaos --runs 500 --seed 20261116 --timeout-ms 600000`. The explicit ten-minute condition limit accommodates pauses observed during earlier local trials; it does not change the CLI's two-minute default or the CI command below. Both earlier failures and final verification are recorded in PROGRESS.md.

The default is 500 tickets, seed 20261116, batches of eight and one worker. Progress prints after each batch and during evidence verification. This is a sustained service-backed test, not a quick unit test. It starts its own supervised API/worker, ephemeral loopback API port, random temporary MongoDB database and queue. Normal application processes and the normal database are not targeted.

For the lightweight CI workload:

```powershell
pnpm chaos --runs 50 --seed 20261116 --report-dir docs/chaos-ci
```

The full command produces [CHAOS-REPORT.md](CHAOS-REPORT.md) and [CHAOS-REPORT.json](CHAOS-REPORT.json) in docs. The CI path keeps its report separate so it cannot overwrite the full measured report. Trial/CI subdirectories are ignored by Git; the main report is available for the user's reviewed commit. No commit or push is performed automatically.

| Option       | Default         | Purpose                                                                                              |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------- |
| --runs       | 500             | 8–10000 synthetic support tickets                                                                    |
| --seed       | 20261116        | Unsigned integer seed for the fault schedule                                                         |
| --batch-size | 8               | 1–32 tickets in each submitted batch; worker concurrency remains one                                 |
| --timeout-ms | 120000          | Bound on each waiting/recovery condition                                                             |
| --report-dir | docs            | Output directory restricted to this repository's docs tree                                           |
| --rates      | See table below | Complete JSON object of scenario weights summing to one                                              |
| --keep-data  | Off             | Keep the temporary MongoDB database for inspection; queue/children/control keys are still cleaned up |

The seed reproduces scenario selection, order and delay choices. Random run UUIDs, process scheduling, service latency and recovery timestamps are not deterministic. Every enabled scenario is placed at least once before the seeded shuffle, so small CI runs still exercise all fault types; actual counts may differ from configured rates and are reported separately.

## Faults and expected outcomes

| Scenario           | Default weight | What actually happens                                                                                            | Expected outcome                                 |
| ------------------ | -------------: | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| normal             |            35% | No injected failure                                                                                              | succeeded                                        |
| worker_crash       |            15% | Worker exits after send_email work and its delivery acknowledgement, before the graph checkpoint                 | succeeded, no duplicate effects                  |
| api_kill           |            10% | Chaos API crashes its supervised API after this batch's mutations have been acknowledged                         | replacement API ready; workflow succeeds         |
| throw_once         |            10% | One transient send_email error before work                                                                       | retry then succeeded                             |
| permanent          |            10% | Permanent failure after close_ticket's effect                                                                    | compensated in reverse order                     |
| delay              |            10% | Seeded 20–100 ms delay before issue_refund                                                                       | succeeded                                        |
| duplicate          |             5% | A second distinct job ID carries the same run/execution after its primary job exists                             | both deliveries processed, effects remain single |
| compensation_crash |             5% | Permanent failure after closing, then worker exits after refund reversal commits but before progress is recorded | replacement finishes compensation once           |

The workflow always uses a USD 49 duplicate-charge example. Compensation should leave one reversed fake refund, an open ticket, a voided original reply and one correction. Successful cases leave one active fake refund, a closed ticket and one original reply. A correction is a separate intended email, not a duplicate original.

API crashes intentionally occur after mutation acknowledgements. This suite does not claim safe automatic resubmission of arbitrary ticket-creation HTTP requests after lost responses. Duplicate jobs use different IDs, because BullMQ would otherwise ignore an identical job ID without delivering it. One worker means this workload measures redelivery rather than simultaneous independent workers racing; the existing integration suite separately exercises concurrent effect/SMTP calls.

## Invariants and hard failure gate

The harness reads MongoDB directly after workflow execution and requires:

- The exact requested run inventory, no missing/nonterminal runs and no run still running beyond the configured timeout.
- Expected terminal outcomes, not merely any terminal state. Unexpected failed/cancelled runs fail the gate.
- At most one refund record and one email intent per intended purpose; expected status and number of records for every run.
- Completed unique idempotency receipts, acknowledged outbox records and the expected delivery audit count.
- Closed tickets for success; open tickets, reversed refunds, voided original emails, correction delivery and exact reverse-order progress for compensation.
- Actual Mailpit capture count per unique synthetic recipient: one for success, two for compensation. Extra or missing captures fail even if the workflow says it succeeded.
- Evidence that each planned throw/delay/crash triggered, both distinct duplicate jobs were processed, and recovery markers exist for crashes.

Any violation, execution timeout or incomplete evidence makes the command exit nonzero. CI runs 50 tickets with zero tolerance for invariant violations. It preserves both generated reports as a workflow artifact, including on failure. Remote CI success must be checked separately; local results are in PROGRESS.md.

## Recovery timing

Worker fault hooks persist chaos.triggered immediately before their injected action. Worker recovery is the timestamp difference to the first later run.resumed or compensation.resumed event. Compensation recovery now has its own durable resume marker, deduplicated per worker instance. It includes supervisor restart, queue lock/stalled handling and checkpoint loading.

API recovery is measured between a harness-persisted kill-request event and a later event recorded after authenticated status polling sees a new ready API instance. That measurement includes polling overhead; the worker may continue while the API is unavailable. Worker and API distributions are separate, with sample counts and nearest-rank p50/p95/p99; zero samples are reported as not measured, never zero recovery time.

The harness uses a 2000 ms worker lock, 1000 ms stalled scan, 100 ms supervisor restart delay and deterministic email-node retry backoff (20 ms initial, 100 ms cap, multiplier 2, jitter 0). These are test settings, not the application's normal development defaults. Report numbers are local observations, not production SLAs or measurements of Gemini/provider behavior. JSON retains selected sequence numbers/timestamps alongside per-run outcomes for audit after cleanup.

## Cleanup and boundaries

The harness stops only its own supervisor trees, removes only its random queue/control keys and drops only its temporary database unless --keep-data was requested. It does not purge Mailpit or remove other users' messages; synthetic captures remain for inspection. Keep Mailpit's Message-ID deduplication and persistent receiver storage enabled. MongoDB receipts alone cannot guarantee generic exactly-once SMTP delivery.

A sustained trial exposed the supervisor's handling of an expired ownership lease: it stopped even when no other owner existed. Renewal now atomically reacquires only an unowned lease; it still shuts down when a different owner is present. Integration tests explicitly cover both cases. Failed trials are not counted as passing workload results; the verification history is recorded in PROGRESS.md.

Tests validate seeded schedules, mandatory coverage, percentile calculation and deliberate invariant failures. The normal pnpm check includes these service-free tests. The full chaos workload is separate from the local pre-push hook; CI adds the 50-run service-backed gate alongside the existing integration/browser checks. No new application environment variables are required. The new chaos workspace pins the already-used MongoDB 7.9.0, ioredis 6.0.0, BullMQ 6.7.6 and Zod 4.6.7 versions.

References: [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [Mailpit API](https://mailpit.axllent.org/docs/api-v1/), [GitHub report artifacts](https://github.com/actions/upload-artifact). The optional Reliability UI is not included; the generated Markdown/JSON are the result artifacts. Step 11 has not started.
