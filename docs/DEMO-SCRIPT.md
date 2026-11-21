# Five-minute interview demo

Author: **Jahid Khan Tuhin — Full Stack JavaScript Engineer**

This script demonstrates the implemented local boundaries. All customers are synthetic, payments are fake, email goes to Mailpit and MockLLM spends no quota. Practice first; restart recovery timing varies. Telegram/WhatsApp are optional, and the entire demonstration works through web signed links.

## Prepare once

Use the four-command quickstart in [README](../README.md). Keep Docker's Linux engine running. Default demo accounts are `admin@unkillable.test` / `local-demo-admin-password` and `approver@unkillable.test` / `local-demo-approver-password`. These are local-only; environment overrides are documented in `.env.example`.

`pnpm seed:demo` seeds the order #4821 example, distinct admin/approver accounts and this versioned policy:

```json
{
  "name": "Interview demo: safe replies under USD 50",
  "rules": [
    {
      "id": "under-50",
      "when": { "maxAmountCents": 5000, "minConfidence": 0.9 },
      "outcome": "auto_approve",
      "reason": "Under the demo USD 50 threshold; the mandatory money/high-risk safety floor still requires a human."
    }
  ],
  "fallback": "require_approval"
}
```

If the seed reports **Existing approval policy preserved**, do not delete data. Either use a separate local MongoDB database name in your private `.env`, or intentionally load the policy above in **Policies** and activate it as a new version, then rerun the seed. Seed never starts a workflow or resets an existing account's password. If an existing demo account has another password, supply that password locally; the seed verifies it rather than changing it.

For the crash section, set `NODE_ENV=development`, `CHAOS_ENABLED=true`, `SUPPORT_LLM_PROVIDER=mock`, `TELEGRAM_ENABLED=false` and `WHATSAPP_ENABLED=false` in your private `.env`, then restart managed development with `pnpm dev:stop` followed by `pnpm dev`. The root launcher supplies supervised API/worker processes. The warning banner must be visible; enable runtime chaos on the Chaos page if paused. Keep approval deadlines longer than the presentation. Normal demo defaults expire after 24 hours.

## 0:00–1:00 — Show the graph and safety floor

1. Sign in as admin at `http://localhost:3000`.
2. Open **Runs → New ticket**. In **Load an example**, select **Charged twice for order #4821, refund one**.
3. Confirm order `4821`, amount `4200` USD cents and synthetic recipient. Click **Start support workflow**.
4. Point to classify → retrieve policy → draft reply → risk check. The draft cites `duplicate-charge` and the refund policy.
5. Explain: “The amount is USD 42, below this demo rule's USD 50 threshold. The deterministic safety floor still requires a human for money/high-risk actions.” Show the stored policy decision trace and pulsing approval node. No refund/email exists yet.

## 1:00–2:15 — Human control and a crash after refund

1. While the run is waiting, use the Chaos page's **Crash worker now**. Wait for the supervised worker status to recover. The approval remains pending because its durable state is in MongoDB, not worker memory. No worker slot is held for the wait.
2. Return to the run and use its fault controls: node **issue_refund**, timing **After work, before checkpoint/progress**, fault **Crash worker at node**. Apply it before approving. This makes the crash boundary deterministic; clicking randomly during a fast refund is unreliable.
3. Open **Approval Inbox**, select this run and **Create personal approval links → Open approve link**. Opening it is read-only. Click **Confirm approve**. For editing, use the full inbox instead.
4. Return to the run. The worker crashes after the fake refund commits, restarts and resumes from a checkpoint. The effect receipt returns the saved refund instead of making another.
5. Show **one active fake refund**, **one sent Mailpit reply**, stable effect keys and the succeeded graph. Open Mailpit on port 8025 and filter by this ticket's recipient. Inspect node attempts/receipts; the UI does not promise a literal “skipped duplicate” toast for every replay.

Phone option: use a reachable HTTPS dashboard and the same authorized reviewer. `localhost` on a phone is the phone itself. If mobile/channel setup is unavailable, the same browser signed-link flow demonstrates the decision contract. Do not claim a bot message arrived unless it actually did.

## 2:15–3:15 — Fail and compensate

1. Start another copy with a distinguishable title and synthetic recipient. Wait for approval.
2. To show reverse-order rollback of both refund and reply, inject **close_ticket → Before node work → Permanent failure**, then approve.
3. The run enters compensation. The original reply is retained; an intended correction is sent, then the fake refund is reversed. Inspect compensation events and current receipt states. The failed step appears in diagnostic/dead-letter state where applicable; a compensated run is not blindly restarted into forward effects.
4. Alternative: inject **send_email → Before node work → Permanent failure**. Since no original email exists, only completed earlier effects need compensation. For automatic retry/backoff instead, use **Fail once, then retry** on a fresh run; it succeeds. Permanent failure does not exhaust retries first.

## 3:15–4:15 — Time travel and fork

1. On the failed/compensated run, open **Time travel** and select the checkpoint after `draft_reply`. Inspect the state diff.
2. Use an allowed edit such as:

```json
{
  "draftMessage": "We reviewed your duplicate charge. A human will confirm the local demo refund before any action."
}
```

3. Create the fork. It has a new run ID/effect scope and still passes policy/human review. Approve its current proposal and follow it to completion.
4. Explain: this is a new experimental run, not an undo or overwrite of parent history. Refunds from different forks are separate intended demo actions; compare counts within each run ID.

## 4:15–5:00 — Evidence and operations

Open [the generated chaos report](CHAOS-REPORT.md): 500 terminal runs, no duplicate refund/email records or Mailpit captures, no lost runs, measured worker/API recovery percentiles. State its local date, seed and configured timing limits; it is not a production SLA. A correction email is intentional, not a duplicate.

Optionally show the global approval bell, countdown/escalation, per-run timing/token estimates and Analytics cost by workflow. Mock calls have zero token usage/cost. Unknown real-provider pricing is explicitly unknown. No browser-closed push or offline approval is implemented.

Finish by returning `CHAOS_ENABLED=false` and restarting development if leaving the demo unattended.

## Focused verification

- `pnpm seed:demo` twice: same accounts/example/policy version; no new workflow runs.
- `pnpm test:e2e e2e/demo-release.spec.ts`: real UI login, seeded ticket, approval pause, signed confirmation, one active fake refund, one persisted email/delivery, one actual Mailpit capture, one checkpoint completion per effect and rejected link replay.
- `pnpm test:integration`: repeatable seed, protected policy state, transactional effects and race/recovery coverage.

If setup fails: start Docker Desktop's Linux engine; check `docker compose ps`; use the existing SMTP readiness tests rather than bypassing hooks. If the web login stalls, confirm API `/health`, shared auth secret and local ports. See [DEVELOPMENT](DEVELOPMENT.md) for Webpack/Turbopack and managed-process notes.
