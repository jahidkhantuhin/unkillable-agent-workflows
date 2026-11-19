# Step 14: Approve from anywhere

Personal signed links, optional Telegram notifications and a home-screen Approval Inbox now use the existing ApprovalService. Current roles, distinct-reviewer requirements, frozen first-review edits and transactional version checks apply through every channel. Refunds remain fake; emails remain local Mailpit deliveries. Tests never contact a real bot or model.

## Three focused tests without Telegram

Keep TELEGRAM_ENABLED=false, start Docker and pnpm dev, and sign in as admin. Use SUPPORT_LLM_PROVIDER=mock for predictable results; CHAOS_ENABLED can remain false.

| Test                   | Action                                                                                                                           | Expected result                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed review          | Create a ticket or gated demo. In Approval Inbox, click Create personal approval links, then Open approve link.                  | The current proposal is shown. Opening the link does not change the run. Confirm approve records your review; execution continues only after all required reviews.                                                       |
| Replay / identity      | Open the same link after submitting. Try another personal link while signed in as a different reviewer.                          | Used/stale links are refused; another account cannot use your personal link. A demoted/viewer account cannot approve.                                                                                                    |
| Mobile / disabled mode | Open Notifications on a phone-width screen. Install with the browser's Install app option, or Share → Add to Home Screen on iOS. | Web works without bot credentials; Telegram controls explain the disabled state. Touch controls fit. Offline navigation shows Connection required and never queues a decision. Installation requires HTTPS or localhost. |

Under a two-reviewer policy, the first review changes the version and invalidates older links. The remaining reviewer creates a fresh link or receives a current notification. If the first review edited the draft, the next signed screen/Telegram message shows that exact frozen edit. Editing stays in the full inbox. Reject links record a channel-specific rejection reason; use the inbox for a custom reason. Approve records a vote, not a guarantee that the workflow has finished.

## Optional private Telegram setup

Use your own demo bot/chat and synthetic content. Create a bot through Telegram's BotFather. Configure private .env settings, then restart pnpm dev:

```ini
WEB_PUBLIC_URL=https://YOUR-DASHBOARD-HOST
APPROVAL_LINK_TTL_SECONDS=900
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=YOUR_PRIVATE_BOT_TOKEN
TELEGRAM_BOT_USERNAME=YOUR_BOT_USERNAME_WITHOUT_AT
TELEGRAM_WEBHOOK_SECRET=YOUR_PRIVATE_URL_SAFE_SECRET_AT_LEAST_32_CHARACTERS
```

WEB_PUBLIC_URL is the dashboard origin used in links. Your phone needs a reachable dashboard, and Telegram needs a public HTTPS API endpoint. localhost is only for same-machine web testing. Include the dashboard origin in CORS_ORIGINS; production also requires HTTPS WEB_PUBLIC_URL and the existing private-secret/HTTPS authentication configuration. Link signatures use a domain-separated HMAC with BETTER_AUTH_SECRET; rotating that secret invalidates outstanding links. No new package or separate signing secret is required.

Generate the webhook secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Register your bot's webhook yourself after exposing the API over HTTPS. Keep credentials out of commits, screenshots and shared shell history:

```powershell
$botToken = 'YOUR_PRIVATE_BOT_TOKEN'
$webhookSecret = 'SAME_PRIVATE_WEBHOOK_SECRET_FROM_ENV'
$publicApi = 'https://YOUR-API-HOST'
$telegramBody = @{
  url = "$publicApi/notifications/telegram/webhook"
  secret_token = $webhookSecret
  allowed_updates = @('message', 'callback_query')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot${botToken}/setWebhook" -ContentType 'application/json' -Body $telegramBody
```

In Notifications, click Link private Telegram chat, open Telegram and press Start within ten minutes, then Refresh settings. The single-use pairing link is a credential: never share it. Pairing enables Telegram; Save preferences can pause/resume it. Unlink removes the mapping and pending pairing request. One Telegram identity can belong to only one reviewer. Groups, bot senders and mismatched sender/chat IDs cannot pair or approve.

Create a new approval wait. The API checks pending approvals every five seconds and sends a summary, current draft, review count, Approve/Reject buttons and a Review / Edit link. A callback checks the currently linked sender's live membership, action token, expiry and approval version. Moderation notifications/decisions remain admin-only. Disable TELEGRAM_ENABLED and restart to stop delivery and reject webhook calls; web approvals continue. Previously visible bot messages never override current permissions or the server flag.

## Security and consistency

- HMAC-SHA256 binds a random nonce, reviewer ID, approval ID/version, action and expiry. Constant-time comparison rejects signature tampering. Payloads contain no client-supplied role or editable workflow state. Expiry is checked explicitly; MongoDB TTL cleanup is not relied on for enforcement.
- Web tokens travel in URL fragments, not query strings. The review page removes the fragment and keeps the token only in that tab's sessionStorage across sign-in/reload. Successful submission clears it. The page uses no-referrer/no-store headers. API calls send tokens in POST bodies, while request logging records URL/status rather than bodies. Do not forward personal links.
- Opening a link is read-only; confirmation requires sign-in, current reviewer permission, trusted Origin and ownership of an unused stored token. Token consumption and the existing approval update share one MongoDB transaction, so losing races roll both back. Inbox, signed-link and Telegram decisions use the same ApprovalService and distinct-reviewer rules.
- Telegram verifies its secret webhook header and private sender/chat binding. Pairing codes are random, hashed, expiring and single-use. Callback data contains a short opaque token ID; the server recovers its signed decision and checks the linked owner. Invalid/replayed callbacks cannot record another review. Transport errors do not expose bot credentials.
- Notifications inspect at most 100 pending approvals/linked recipients per batch, matching the bounded inbox. Durable per-approval-version/reviewer records use a one-minute lease and at most five delivery attempts while pending. Normal successful sends are recorded once. A crash after Telegram acceptance but before database acknowledgement may duplicate an advisory message: Telegram sendMessage has no idempotency key. This cannot duplicate approval decisions or workflow effects. After a message expires, generate a current web link in the inbox.

## API and storage

Settings/link routes require approver/admin access; mutations require trusted Origin. The webhook uses its secret/sender checks instead of a browser session. Use the direct API webhook URL, not the browser proxy.

| Route                                | Purpose                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| GET /notifications/settings          | Own preferences/availability; web always enabled.                        |
| POST /notifications/settings         | Save telegram boolean; enabling requires a linked chat and enabled flag. |
| POST /notifications/telegram/link    | Generate private-chat pairing URL.                                       |
| POST /notifications/telegram/unlink  | Remove own chat and pending pairing request.                             |
| POST /notifications/links/:id        | Issue personal approve/reject links for a pending approval.              |
| POST /notifications/links/inspect    | Read current proposal from a token without consuming it.                 |
| POST /notifications/links/resolve    | Consume token and record its bound decision atomically.                  |
| POST /notifications/telegram/webhook | Handle secret-authenticated message/callback fixtures.                   |

New indexed collections: notificationSettings (preferences/unique Telegram identity), telegramPairings (hashed expiring codes), approvalLinks (hashed token, bound payload, expiry/use marker) and approvalNotifications (durable attempts). Startup/migration creates indexes. The worker still requests approval normally; API polling discovers pending records after restart. Existing durable run dispatch survives queue outages after a decision commits.

## PWA and verification

Next.js serves manifest.webmanifest, home-screen metadata and local PNG icons. Production registers a network-only root service worker; dev does not. It never writes CacheStorage, intercepts approval POSTs, schedules background sync or queues offline decisions. Failed navigations receive only a generic connection-required document. Private HTTP responses are not cached by it. Supported browsers offer an install prompt; others show manual guidance. Device-specific installation and real bot delivery need your own setup; local mocked tests do not prove them.

Run sequentially after stopping managed dev:

```powershell
pnpm dev:stop
docker compose up -d
pnpm check
pnpm test:integration
pnpm test:e2e
```

Signer tests cover payload/action/owner/version tampering, malformed signatures, wrong keys and exact expiry. Integration cases cover Origin/roles, disabled Telegram, read-only previews, single-use/cross-channel races and rollback, edited first reviews, callback replay/forgery/revocation, pairing expiry/unlinking, admin-only moderation and delivery recovery. Telegram fixtures/transport mocks avoid real messages. The suite is included in pre-push and CI. Browser checks cover phone review/confirmation/replay, disabled settings, manifest PNGs, service-worker headers and offline behavior. Actual results are recorded in PROGRESS.md.

Official references: [Telegram Bot API](https://core.telegram.org/bots/api), [Telegram deep linking](https://core.telegram.org/bots/features#deep-linking), [Next.js PWA guide](https://nextjs.org/docs/app/guides/progressive-web-apps).

## WhatsApp follow-up

Step 14 also supports an independent optional WhatsApp Sandbox channel. Follow [the complete local setup guide](WHATSAPP-LOCAL.md), including creating a Twilio account, joining its Sandbox, exposing the local web app through one HTTPS tunnel, linking a reviewer and testing approve/reject/edit. Telegram implementation and preferences remain separate.
