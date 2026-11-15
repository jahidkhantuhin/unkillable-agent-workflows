# Chaos test report

Generated: 2026-11-15T22:17:32.917Z. Author: Jahid Khan Tuhin.

**PASS** — 500/500 terminal runs; 0 duplicate refund records; 0 duplicate email intents; 0 duplicate Mailpit captures; 0 lost/nonterminal runs; 0 runs with invariant violations.

## Configuration

Seed 20261116; batch size 8; timeout 600000 ms; MockLLM; one worker; isolated database/queue. Default CLI run count is 500. Each enabled scenario is guaranteed once before seeded weighted selection/shuffle. Seed repeats the fault schedule, not operating-system timing or random UUIDs. All decisions are synthetic test-admin approvals.

| Scenario           | Planned runs |
| ------------------ | -----------: |
| normal             |          163 |
| worker_crash       |           80 |
| api_kill           |           44 |
| throw_once         |           57 |
| permanent          |           46 |
| delay              |           53 |
| duplicate          |           24 |
| compensation_crash |           33 |

Configured rates: {"normal":0.35,"worker_crash":0.15,"api_kill":0.1,"throw_once":0.1,"permanent":0.1,"delay":0.1,"duplicate":0.05,"compensation_crash":0.05}.

## Measured results

| Metric                   |   Value |
| ------------------------ | ------: |
| requested                |     500 |
| created                  |     500 |
| terminal                 |     500 |
| succeeded                |     421 |
| compensated              |      79 |
| duplicateRefunds         |       0 |
| duplicateEmails          |       0 |
| duplicateMailpitCaptures |       0 |
| lostRuns                 |       0 |
| stuckRunning             |       0 |
| refundRecords            |     500 |
| emailRecords             |     579 |
| mailpitCaptures          |     579 |
| durationMs               | 1185346 |

## Recovery measured from persisted event timestamps

| Recovery | Samples | p50 ms | p95 ms | p99 ms |
| -------- | ------: | -----: | -----: | -----: |
| worker   |     113 |   3119 |   5856 |   7134 |
| api      |      44 |   2348 |   2726 |   3457 |

Worker recovery is the durable chaos.triggered crash marker to the first later run.resumed/compensation.resumed event. It includes process restart, queue lock/stalled recovery and checkpoint loading. API recovery is the harness-persisted kill-request marker to a new ready API instance observed through authenticated status polling; it includes polling overhead. These are local configured-test measurements, not production SLAs. Lock duration 2000 ms, stalled scan 1000 ms, supervisor delay 100 ms; these differ from normal dev defaults.

## Method and boundaries

The harness creates support tickets through the actual isolated API, approves them as a synthetic seeded admin and uses supervised API/worker processes. Faults include crashes after committed email work, API kills after mutation acknowledgements, one-shot/permanent throws, delays, distinct duplicate jobs and a crash during compensation after refund reversal. Duplicate jobs have different IDs so BullMQ cannot discard them as an identical job ID. One worker processes them as redelivery, not parallel workers; earlier integration tests cover concurrent effects.

MongoDB checks cover terminal/expected outcomes, refund/email cardinality and status, fully acknowledged outbox/deliveries, receipt uniqueness/completion, ticket state and ordered compensation. Mailpit search independently checks actual captures for each unique synthetic recipient. A correction is a separate intended email, not a duplicate. Exactly-once SMTP capture relies on configured Mailpit Message-ID deduplication and retained receiver data. No real payments, external customers, live AI models or provider quota.

Reproduce: start Docker services, then run pnpm chaos --runs 500 --seed 20261116 --batch-size 8 --timeout-ms 600000. Full options/rates and per-run evidence are in CHAOS-REPORT.json. The CI gate permits zero invariant violations and exits nonzero on failure, timeout or incomplete evidence.

## Failures

No harness execution error.

No invariant violations.
