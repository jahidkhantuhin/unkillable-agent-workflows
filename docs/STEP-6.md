# Step 6: Support ticket router

The support workflow runs **classify → retrieve_policy → draft_reply → risk_check → approval → issue_refund → send_email → close_ticket**. Rejection ends at approval without refunding or sending. Existing durability demos remain available.

Default execution uses deterministic MockLLM, local policies, a fake MongoDB refund ledger, and SMTP captured by local Mailpit. No bank, payment provider, or real customer mailbox is contacted. Gemini and local Ollama are optional provider adapters; tests never invoke live models or spend quota.

## Run and test locally

From the repository root:

```powershell
pnpm dev:stop
pnpm install --frozen-lockfile
docker compose up -d
pnpm db:migrate
pnpm seed
pnpm dev
```

Use your existing .env; new settings have safe defaults. Do not overwrite an existing .env or signing secret. Re-running seed preserves account passwords and upserts three synthetic ticket examples without creating workflow runs. Compose recreates Mailpit with Message-ID deduplication and a persistent local database; keep those settings enabled.

Sign in as your seeded admin or an approver. Open **Runs → New ticket** (or /tickets/new). Choose the duplicate-charge example. Its fields are independent: Ticket title identifies the run, Ticket description is the incoming request, and the generated reply is editable later in Approvals. Synthetic customer email must end in .test. Amount is integer USD cents: 4900 means USD 49.00.

Start the workflow. The timeline and Support node outputs show classification/confidence, retrieved policy, generated draft and citation, and the proposed refund. At waiting approval, neither effect has happened and the worker slot is free. Open **Approvals** to inspect the policy, recipient, fake refund amount and reasoning. Only reply text is editable; the proposed refund/recipient cannot be changed through the decision body.

| Example/action                           | Expected result                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Duplicate charge, Approve original       | One USD 49.00 fake refund, one reply captured in Mailpit, closed ticket and succeeded run                          |
| Duplicate charge, Approve edited draft   | Same proposed fake refund; Mailpit contains the edited reply; ticket title and original description stay unchanged |
| Any example, Reject with a reason        | Cancelled run, rejected ticket, no refund and no email                                                             |
| Invoice/how-to, Approve original         | Helpful cited reply, no refund, one Mailpit email and closed ticket                                                |
| General refund request, Approve original | Reply explains manual eligibility review; no automatic refund; one Mailpit email                                   |

Inspect fake refund/email records on run detail and open http://localhost:8025 for the captured message. A successful duplicate-charge run has one refund record and one email record; multiple internal receipts represent separate operations, not duplicate effects. Node outputs also include receipt IDs, the approved reply and ticket status. Viewers can inspect runs and examples, but cannot create tickets or resolve approvals. Approvers/admins can do both.

## How it works

- API POST /tickets validates synthetic input, then commits an open tickets document, a queued run and its first event together. It queues a BullMQ job; the existing pending-dispatch loop recovers a queue outage. The API never executes graph nodes.
- Support workflow version 1 uses the existing run UUID as its LangGraph thread. MongoDB checkpoints and ordered STATE_SNAPSHOT/STEP events expose each node's result. The demo's earlier workflow versions keep their existing behavior.
- LLM classification has a validated label, confidence and reason. Draft output has reply text, cited policy ID and snippet. A draft is rejected if its citation does not match retrieved policy text. Policy retrieval defaults to the small in-repo corpus.
- Risk checking determines the proposed refund in integer cents. Only duplicate-charge classification with confidence at least 0.8, an allowing cited policy, and an amount within the policy limit can propose it. This is simulated ticket evidence; the human must review the claim. All tickets require human approval, including no-refund replies.
- The native approval interrupt is outside the retry wrapper. A durable pending approval releases the worker. A version-checked decision records reviewer identity/time and resumes via a new generation-specific job on the same thread. Reject routes to END. Effect nodes additionally refuse to run without an approve/edit decision.
- issue_refund calls an injected PaymentsClient whose implementation uses executeOnce and a unique fakeRefunds key in a MongoDB transaction. It performs no external payment. Replayed/concurrent calls return the same receipt.
- send_email calls an injected Mailer. Its implementation uses executeOnce to atomically persist one fakeEmails record and one email outbox intent. SMTP happens after commit, never inside the Mongo transaction. The node waits for SMTP acceptance and a committed delivery acknowledgement before close_ticket marks the local ticket closed.
- SMTP uses a stable Message-ID derived from the run's effect key. Mailpit's MP_IGNORE_DUPLICATE_IDS=true suppresses repeated captures after an acceptance/acknowledgement crash gap or concurrent dispatch. The delivery receipt, email sent status, local delivery audit and outbox acknowledgement commit together.

The email guarantee depends on this configured Mailpit receiver and retained Message-IDs. SMTP by itself does not provide exactly-once delivery. Mailpit storage is persistent, automatic message-count deletion is disabled, and this app configures no outbound relay. Purging Mailpit data or disabling deduplication invalidates receiver-side replay protection. A future real mail service would need its own idempotent receiving contract; it cannot inherit this guarantee from MongoDB alone.

## Failures and recovery

Support task nodes use the existing persisted retry budget, capped exponential backoff and jitter. Override keys now include classify, retrieve_policy, draft_reply, risk_check, issue_refund, send_email and close_ticket; approval remains native control flow, never a retry-wrapped exception. Explicit transient failures, network/model timeouts, HTTP 429 and 5xx retry. Invalid structured outputs/citations, explicit permanent errors and permanent SMTP rejection stop and enter Dead Letters.

Step 7 extends this behavior: a terminal support-node failure after any effect now starts reverse-order compensation, stops pending forward delivery, voids the original reply through a correction and reverses the fake refund. Such runs finish compensated instead of offering forward retry through Dead Letters. Failure before any effect still uses Dead Letters. See [STEP-7.md](STEP-7.md) for current recovery and fault-testing instructions; the Step 6 verification record describes behavior at that earlier milestone.

## Configuration and injected adapters

| Variable                     | Default / use                                                  |
| ---------------------------- | -------------------------------------------------------------- |
| SUPPORT_LLM_PROVIDER         | mock; optional gemini or ollama                                |
| GOOGLE_GENERATIVE_AI_API_KEY | Empty; required only for gemini; keep server-side              |
| GEMINI_MODEL                 | Empty; choose an available model name when opting into gemini  |
| OLLAMA_BASE_URL              | http://127.0.0.1:11434/v1; local HTTP(S) endpoint only         |
| OLLAMA_MODEL                 | Empty; select an installed local model when opting into ollama |
| ORGMIND_RETRIEVER_ENABLED    | false; local policy corpus is the default                      |
| ORGMIND_RETRIEVER_URL        | http://127.0.0.1:8000/retrieve; optional local HTTP(S) adapter |
| MAILPIT_SMTP_HOST            | 127.0.0.1; accepted aliases: localhost, ::1, mailpit           |
| MAILPIT_SMTP_PORT            | 1025; other SMTP ports are rejected                            |
| MAILPIT_API_URL              | http://127.0.0.1:8025; integration-test capture verification   |

Restart the worker after changing settings. Missing opt-in model names/keys fail configuration validation. Mock/default worker startup does not load remote model SDKs; optional providers load only when needed. AI SDK calls disable their internal retries so the durable node wrapper owns the retry budget, and calls have a 30-second deadline. No live Gemini/Ollama call was used for verification.

LLM, Retriever, PaymentsClient, Mailer and TicketStore interfaces are injected into the support graph. Google uses the AI SDK Google provider; Ollama uses its OpenAI-compatible chat endpoint. Optional OrgMind retrieval posts JSON {"query":"...","topK":3} and expects {"policies":[{"id":"...","text":"...","allowRefund":false,"maxRefundCents":0}]}. This is the explicit bridge contract, not a claim that an existing OrgMind deployment already exposes that route. Its adapter response/error handling is mocked in tests; live OrgMind compatibility is not confirmed.

## API, storage and tests

POST /tickets accepts a direct JSON body such as:

```json
{
  "title": "Duplicate charge review",
  "description": "I was charged twice for order DEMO-1001.",
  "customerEmail": "alex@example.test",
  "orderId": "DEMO-1001",
  "amountCents": 4900,
  "currency": "USD"
}
```

It returns HTTP 202 with the run DTO. GET /tickets/examples returns seed examples (with an in-repo fallback). Existing /runs/:id, /events, /reliability, /approvals and /dead-letters endpoints serve the ticket workflow too. The same-origin web proxy forwards ticket endpoints with method restrictions. Shared Zod schemas validate inputs, node outputs, effects and records. New collections: tickets, ticketExamples, fakeRefunds, fakeEmails; unique effect-key indexes and a unique ticket runId are bootstrapped by API/migration and worker as appropriate.

Stop dev before production checks:

```powershell
pnpm dev:stop
pnpm check
pnpm test:integration
```

Tests cover mock classification/citations, invalid model output, risk limits, approval-before-effects, safe endpoints/recipients, default no-network model behavior, optional retriever response validation, authenticated ticket creation and RBAC, reject/no-refund paths, edited approval, one refund/email per eligible run, concurrent SMTP dispatch, SMTP accepted before lost acknowledgement, email DLQ retry, terminal redelivery and final-checkpoint restart. Existing auth/checkpoint/reliability suites remain included. Integration suites run at most two at once to limit local service contention; the runner and CI force MockLLM. They use random temporary databases, a unique queue and unique .test recipients. MongoDB/Redis resources are removed; captured synthetic Mailpit messages are retained for inspection, without deleting anyone else's messages. Actual counts/results are in PROGRESS.md.

Versions checked: AI SDK 7.0.173, @ai-sdk/google 4.0.121, @ai-sdk/openai-compatible 3.0.92, Nodemailer 10.5.0, Zod 4.6.7. LangGraph.js 1.7.4, MongoDBSaver 1.5.1 and existing MongoDB driver versions are retained. References: [AI SDK structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers), [Nodemailer message configuration](https://nodemailer.com/message), [Mailpit deduplication options](https://mailpit.axllent.org/docs/configuration/runtime-options/), [Mailpit search/API](https://mailpit.axllent.org/docs/api-v1/).

Step 7 adds compensation and fault hooks; see [STEP-7.md](STEP-7.md).
