# Step 15: Approval deadlines, tracing and cost

Step 15 makes waiting visible and bounded. A pending approval has a reminder, escalation and deadline. The API's separate BullMQ SLA worker handles those timers; it does not occupy the workflow worker's slot. Run pages show elapsed time, approval waiting, completed attempt spans, model usage and configured cost estimates. Analytics groups retained usage by workflow. Web functionality needs no Telegram, WhatsApp or chaos mode.

## Start and try three focused tests

Keep your normal private `.env` connection/auth settings. Use `SUPPORT_LLM_PROVIDER=mock`, `TELEGRAM_ENABLED=false`, `WHATSAPP_ENABLED=false` and `CHAOS_ENABLED=false`. Add this short **local demo** policy, then restart the API and worker:

```ini
APPROVAL_SLA_ENABLED=true
APPROVAL_SLA_POLICIES={"durability-demo":{"remindMs":30000,"escalateMs":60000,"expireMs":120000,"timeoutAction":"reject","escalateRole":"admin"}}
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=
LLM_PRICING_JSON={}
```

```powershell
docker compose up -d
pnpm dev
```

| Test               | Action                                                                                                                                                                      | Expected                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadline lifecycle | Sign in as admin. Create a Healthy delivery demo titled `SLA deadline test`, notice `Local timed review`, with Require human approval checked. Leave it pending.            | Inbox counts down. Around 30 seconds, timeline records `approval.sla.remind`; around 60 seconds it records `approval.sla.escalate` and the card identifies admin reviewers. Around 120 seconds it records `approval.sla.expire`; rejection resumes the rejection path, so this demo becomes cancelled without a notice delivery. |
| Human wins first   | Create another gated demo and approve it before its deadline. Return after the deadline.                                                                                    | It stays succeeded. Old timers cannot reject, cancel or add another review. For a cancellation test instead, change `timeoutAction` to `cancel`, restart and create a new pending demo: it cancels directly at the deadline.                                                                                                     |
| Timing and usage   | Start a synthetic support ticket with the mock provider. Open its run, wait for the approval gate, and use Refresh run metrics. Then inspect Analytics → Cost per workflow. | Classify/draft have recorded mock calls with zero tokens and zero cost. Completed node attempts have durations and trace IDs. Approval wait increases while pending; after resolution an `approval.wait` span records the completed wait. No model quota is spent.                                                               |

Timers are due times, not exact delivery guarantees. Polling, Redis availability and worker load can delay execution. Approval cards update from the inbox's normal polling; run metrics also offer explicit refresh after the worker finishes persisting spans.

## Configuration and semantics

| Setting                              | Meaning                                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPROVAL_SLA_ENABLED`               | Defaults true; false omits SLA snapshots from **new** approvals. Existing snapshots still apply.                                                                                                          |
| `APPROVAL_SLA_POLICIES`              | JSON keyed by `durability-demo`, `support-ticket-router` or `content-moderation`. Values: `remindMs`, `escalateMs`, `expireMs`, `timeoutAction` (`reject`/`cancel`), `escalateRole` (`admin`/`approver`). |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional full OTLP/HTTP trace URL, e.g. `http://127.0.0.1:4318/v1/traces`. Empty disables external export; MongoDB span summaries remain available.                                                       |
| `LLM_PRICING_JSON`                   | JSON keyed by `provider:model` with `inputPerMillion` and `outputPerMillion` in USD. Empty means price unknown for real providers.                                                                        |

Unspecified workflow policies default to reminding after 30 minutes, escalating to admins after 60 minutes and rejecting after 24 hours. Require `1000 <= remindMs < escalateMs < expireMs`. Partial workflow entries use field defaults. Invalid JSON, unknown workflow keys, unordered durations and negative prices fail validation. Content moderation always escalates to administrators because approvers cannot review moderation.

A policy is snapshotted at the **original approval request**, not when a reviewer opens a card. Partial reviews and API/worker restarts do not reset deadlines. Existing pre-Step-15 approvals without a snapshot are left unchanged. Change configuration and create a new run to test a different policy. A human mutation after the stored deadline is rejected even if the timer worker has not processed expiry yet. A human action already committed cannot be overridden by a later timer.

Reminder records an inbox/timeline status and resets this approval's existing optional channel delivery claims. Escalation also records the configured **role group** and resets claims only for members currently in that group. All authorized reviewers retain inbox access; escalation does not grant new permissions, change quorum or assign a particular person. People who already reviewed cannot vote twice. If a group has no eligible members or no connected messaging channel, the web notice remains the fallback. Telegram/WhatsApp preferences, role checks, provider availability and WhatsApp reply-window rules still apply. These reminders are not emails.

`reject` records a rejection as actor `system:sla`, using the same approval transaction and durable run-dispatch marker as a human rejection. The workflow then follows its existing rejection path. `cancel` records the timeout decision and directly marks the waiting run cancelled, without queuing workflow effects. Neither timeout option approves a proposal or bypasses quorum. Timers, human actions and signed-channel decisions compete transactionally; only one terminal outcome commits.

## Durable timer processing

The API reconciles pending approval snapshots every second into a separate `${RUN_QUEUE_NAME}-approval-sla` BullMQ queue. Each approval/stage has a stable job ID with a delayed due time. Missing jobs are rebuilt after restart. Each stage has a persisted timestamp and a unique run-event key, making duplicate job processing harmless. Jobs retry transient failures up to five times with exponential backoff starting at one second. Resolved approvals make late jobs no-ops. Completed/failed job retention is bounded to 10,000 each; business receipts stay in MongoDB. Operators should inspect failed jobs after persistent infrastructure failures.

The database is the source of truth; Redis alone is not the timer history. If the API is stopped past the deadline, expiry runs after restart and reconciliation. When already expired, reminder/escalation jobs skip obsolete notifications. Queue names follow the existing environment namespace, including isolated test namespaces. The API owns and gracefully closes the timer worker and its Redis connection.

## Traces and latency

OpenTelemetry packages: `@opentelemetry/api` 1.10.0, `@opentelemetry/sdk-trace-node` 2.12.1 and `@opentelemetry/exporter-trace-otlp-http` 0.301.2. The initially reported SDK 2.12.0 was deprecated; the verified non-deprecated patch was selected. Existing root lint/test tool versions were preserved.

The executor starts a run segment for each execution/recovery invocation. A deterministic trace ID derived from the run ID groups its segments across restarts; every segment and node span has a fresh span ID. Fork run IDs create separate traces. AsyncLocalStorage carries run, execution, node and attempt attribution; overlapping runs cannot mix usage. The common retry wrapper creates a span per attempted node operation, including failures. Approval wait is reconstructed from persisted request/resolution dates, not a worker held open for hours. Spans include IDs and timings, never ticket text, draft content, credentials or full prompts.

Run elapsed time is creation to terminal update, or current time while active. Approval waiting is request to resolution, or current time while pending. Completed attempt duration measures that invocation's operation; retry sleep is visible in elapsed time but not included in the node operation span. Nested/root spans overlap: **do not sum them to obtain total elapsed time**. A hard kill can lose an unfinished span; persisted checkpoints and attempt events remain the correctness record. Telemetry storage/export failures must not replay a business operation. Old runs without instrumentation have no historic spans to reconstruct, except persisted approval wait when resumed.

### Optional local collector

```powershell
docker compose --profile observability up -d otel-collector
```

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces` in private `.env` and restart the worker. Run a mock demo, then inspect:

```powershell
docker compose logs --tail 100 otel-collector
```

The optional `otel/opentelemetry-collector:0.165.0` receives OTLP/HTTP only on local host port 4318 and prints debug spans. It is not a trace-search UI or durable trace backend. Normal `docker compose up -d` does not start this profile. No external collector is contacted unless explicitly configured. Worker shutdown flushes the exporter; abrupt kills may lose buffered spans. Local run summaries are stored in `runSpans` independently of export.

## Token and cost accounting

Successful Gemini/Ollama responses report AI SDK `totalUsage`; the adapter records input/output counts before returning structured output. Mock implementations explicitly record zero-token, zero-cost calls. Usage rows identify the run, execution, attempted node, provider and model in `runUsage`. Checkpointed nodes do not call the model again; genuine repeated model invocations are additional usage, even if a later workflow effect is deduplicated.

Cost formula: `(inputTokens × inputPerMillion + outputTokens × outputPerMillion) / 1,000,000`. Rates are configuration snapshots reflected in each persisted call's estimated cost. No provider price is invented or fetched. Missing token usage or missing pricing leaves cost unknown. The UI shows the known subtotal and unpriced/missing-usage call counts. A no-model demo has zero calls, not fabricated tokens. Ollama has unknown monetary cost unless a local rate is configured; no assumption is made that running hardware costs nothing.

Analytics aggregates **all retained runs** by workflow, including failed runs and forks, and totals their persisted usage. It reports counts and known estimated USD, not a provider invoice or complete infrastructure cost. Calls that fail before returning usage, process death after provider acceptance, telemetry write loss, cached-token discounts and provider-specific billing adjustments can make estimates incomplete. Usage for those failures is not fabricated. Prompt/output text and API keys are never stored as usage metadata.

Read-only endpoints: `GET /runs/:id/metrics` requires run-read permission; `GET /analytics/costs` requires administrator analytics permission. Shared schemas validate stored span/usage documents and API DTOs. API bootstrap creates `runSpans`/`runUsage` run/time indexes. Existing approval and notification indexes support timers and reminder claims.

## Verification

Run sequentially after stopping managed development services:

```powershell
pnpm dev:stop
pnpm check
pnpm test:integration
pnpm test:e2e
```

Clock tests verify snapshot anchoring and policy ordering. Tracing tests verify concurrent attribution, stable run trace IDs, error spans, approval waiting and failure isolation. Integration tests exercise once-only reminders, role-group escalation, concurrent timeout/human decisions, rejection/cancellation with no duplicate effects, protected metrics, unknown pricing and actual delayed-job recovery after timer-process restart. Pre-push and CI include the operations suite; providers remain mocked. Browser checks cover mobile countdown/escalation, real mock usage and Analytics. Actual results and any limits are recorded in PROGRESS.md.

References: [BullMQ delayed jobs](https://docs.bullmq.io/guide/jobs/delayed), [job IDs](https://docs.bullmq.io/guide/jobs/job-ids), [OpenTelemetry instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/), [Collector configuration](https://opentelemetry.io/docs/collector/configuration/), [AI SDK usage](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text).

## Global approval bell (Step 15 follow-up)

A bell in the desktop header and mobile navbar shows actionable approvals while you work on any page. A shared authenticated poll runs every five seconds (also on window focus), so the two responsive header placements do not create duplicate polling or toasts. The list uses the existing bounded Approval Inbox endpoint; it is not a separate push service.

- The badge counts pending requests this reviewer has not already reviewed. Viewer accounts have no bell; moderation remains admin-only. Expired/resolved requests are removed, subject to polling latency for remote changes.
- A brief shake plays for new requests, reminders or escalation events. A gentle halo remains until the list is opened. Opening acknowledges the attention signal, not the approval: the count remains while action is needed. Unchanged polls and navigation do not repeatedly notify. Initial loading shows pending attention without flooding the screen with old-request toasts.
- Amber means pending/reminder; orange means escalation to the signed-in reviewer's configured role group. Text and icons explain the status without relying on colour. Other authorized reviewers retain ordinary inbox access but do not receive another group's escalation alert.
- New events after the initial load produce one summary toast per poll with **Review now**. The dropdown shows titles, time remaining and direct links to the relevant inbox card. Clicking a link never submits an approval. Escape closes the list and returns focus to the bell; pointer clicks outside close it too.
- Opening the list stops its animation; reduced-motion preferences disable shaking and halo animation. A static badge and colours remain. Failed polling clears actionable entries and displays an unavailable indicator/message rather than treating stale data as current. Signing out or changing reviewer identity/role clears personal alert state and approval toasts.

To try it: stay on **Runs** or **Analytics**, create a new gated demo in another tab, then watch the bell within the next polling cycle. With the short SLA policy above, a reminder and then a targeted escalation produce fresh alerts. Open the bell, use **Review now**, resolve the request, and confirm the badge drops after refresh/polling. Try a 320px viewport and enable your OS/browser reduced-motion setting. These are in-app alerts while the application is open; there are no browser-closed push alerts, sounds or new environment variables.
