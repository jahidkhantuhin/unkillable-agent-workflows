# Architecture decision records

Author: **Jahid Khan Tuhin — Full Stack JavaScript Engineer**

These records describe implemented choices. Status: accepted for the local showcase; production trade-offs remain explicit.

## ADR-001: LangGraph checkpoints plus BullMQ

**Context:** workflows must survive process death and human waits. **Decision:** LangGraph stores graph checkpoints in MongoDB; BullMQ handles dispatch, leases and stalled recovery. Human waits finish the active queue job and resume through a new execution. **Consequence:** the interrupted node may repeat. Checkpoint durability is not effect idempotency; both mechanisms are required. Redis and MongoDB remain separate services to operate.

## ADR-002: Transactional idempotency receipts and outbox

**Context:** a worker can die after work commits but before progress is checkpointed. **Decision:** stable run/node/action keys have a unique MongoDB index; receipts, fake effects and outbox intents commit transactionally. **Consequence:** concurrent retries converge on saved results. SMTP remains outside MongoDB and requires receiver deduplication with a stable Message-ID. Claims apply to the local fake ledger/Mailpit boundary, not every external provider.

## ADR-003: Separate Unkillable from OrgMind

**Context:** the showcase focuses on taking controlled actions, not a required retrieval deployment. **Decision:** standalone workflows and a deterministic local policy retriever; OrgMind is an optional local HTTP adapter behind `Retriever`. **Consequence:** anyone can reproduce the demo without OrgMind, model keys or vector services. A real permission-aware retriever remains an integration responsibility.

## ADR-004: Money movement always requires human review

**Context:** a permissive policy or model should not authorize money. **Decision:** deterministic policy evaluation applies a safety floor after matching rules; nonzero refund/high risk cannot auto-approve. Version checks and distinct reviewers guard decisions. **Consequence:** the USD 42 demo can match a USD 50 auto rule and still pause. Models classify/draft; they do not decide payment authorization.

## ADR-005: Explicit saga compensation

**Context:** effects in separate nodes cannot share one database transaction across the workflow. **Decision:** record compensation steps and undo completed work in reverse order, with stable keys for rollback too. **Consequence:** history remains visible; a correction email is an additional intended message, not erasure of an email already received. Compensated runs are not blindly retried into new forward effects.

## ADR-006: One decision path for all channels

**Context:** web, signed links and optional chat callbacks can race. **Decision:** use current memberships, proposal versions and one transactional resolution path; signed tokens are private, expiring and single-use. **Consequence:** opening a link never mutates the run. Channel transport is advisory and can fail independently; the web inbox remains available.

## ADR-007: Network-only PWA and in-app alerts

**Context:** stale offline approval decisions are unsafe to accept blindly. **Decision:** installable web shell with no private response cache or offline mutation queue; a global bell polls authorized pending approvals. **Consequence:** mobile review requires a reachable server and a connection. Browser-closed push and desktop/offline packaging are not implemented.

## ADR-008: Snapshot SLA policy and keep telemetry advisory

**Context:** configuration changes and restarts must not reset deadlines, while observability failures must not replay business work. **Decision:** snapshot per-approval deadlines, use durable delayed jobs with transactional stage receipts, and keep span/usage recording outside effect correctness. **Consequence:** existing policies survive configuration changes. Hard kills may lose spans/usage; configured costs are known estimates with explicit unknowns.

## ADR-009: Local deterministic demo and guarded seed

**Context:** interview setup must be repeatable without damaging existing work. **Decision:** setup creates `.env` only when absent, uses a random secret/MockLLM, and seeds synthetic users/examples without starting runs. Seed preserves conflicting policies and existing passwords; versioned policy activation stays explicit. **Consequence:** reruns are repeatable, but a custom-policy workspace needs an isolated demo database or an intentional policy change. Published demo credentials are unsuitable for deployment.

## ADR-010: Measured claims and user-controlled release

**Context:** screenshots and passing tests are not proof of remote deployment or live channel setup. **Decision:** retain generated chaos evidence, record exact local checks and leave Git commits/tags/releases to the user. **Consequence:** root version `1.0.0` expresses release preparation, not an already-published tag. OpenAPI generation remains optional and is not required for this release.
