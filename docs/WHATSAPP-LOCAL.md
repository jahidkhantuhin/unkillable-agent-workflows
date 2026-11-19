# WhatsApp approvals with your local app

Keep Telegram configured as before. WhatsApp is a separate optional channel, using Twilio's official Node SDK 6.3.1. You do not need a production WhatsApp business sender for this Sandbox walkthrough. Use only your own test phone and synthetic tickets. Automated tests mock Twilio; they never contact a phone.

## 1. Create your testing account

1. Create a [Twilio account](https://www.twilio.com/try-twilio) and complete its account/phone verification requirements.
2. In the console, open **Try out WhatsApp** or **Messaging → Try it out → Send a WhatsApp message**, then activate the Sandbox. Console labels can differ between accounts.
3. From your own WhatsApp phone, send the console's exact `join …` message to its displayed Sandbox number. Wait for confirmation. This joins Twilio's Sandbox; it does not yet link your Unkillable reviewer account.
4. Find your **Account SID** and **Auth Token** in the console. Keep them in your private root `.env`, never screenshots, source files or chat. Copy the actual Sandbox sender rather than assuming the example number.

Sandbox membership expires after three days; rejoin when needed. Trial restrictions and messaging charges can apply. This is a low-volume test channel: the Sandbox documents one message per three seconds. See [Twilio Sandbox instructions](https://www.twilio.com/docs/whatsapp/sandbox).

## 2. Expose only the local web app

Install and authenticate [ngrok](https://ngrok.com/docs/getting-started/) with your own account. Start a tunnel in a separate terminal:

```powershell
ngrok http 3000
```

Keep it running. Replace `https://YOUR-TUNNEL.ngrok-free.app` below with the actual HTTPS forwarding address. Set these values in your private root `.env`:

```ini
WEB_PUBLIC_URL=https://YOUR-TUNNEL.ngrok-free.app
CORS_ORIGINS=http://localhost:3000,https://YOUR-TUNNEL.ngrok-free.app
WHATSAPP_ENABLED=true
TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
TWILIO_WHATSAPP_FROM=whatsapp:+YOUR_CONSOLE_SANDBOX_NUMBER
WHATSAPP_WEBHOOK_URL=https://YOUR-TUNNEL.ngrok-free.app/api/whatsapp/webhook
SUPPORT_LLM_PROVIDER=mock
```

Use real credential values locally; the placeholders above are intentionally invalid. Leave existing MongoDB, Redis, authentication secret and local Mailpit settings intact. `CHAOS_ENABLED` is unrelated to WhatsApp. Do not overwrite Telegram settings.

Start/restart the application after changing configuration:

```powershell
docker compose up -d
pnpm dev
```

The root launcher loads `.env`; Next allows the configured public hostname during development. In Twilio Sandbox settings, set **When a message comes in** to the exact `WHATSAPP_WEBHOOK_URL`, with method **POST**, and save. The app supplies `https://YOUR-TUNNEL.ngrok-free.app/api/whatsapp/status` as the delivery callback when sending messages.

Only one tunnel is needed. Next forwards the original form and Twilio signature to the local API. The API validates against the configured public URL, not a client-controlled Host header. Public callbacks do not require a browser session; settings and decisions still enforce reviewer identity. If the tunnel hostname changes, update both public URLs, CORS, Twilio's console callback, and restart the app. Do not expose unrelated local services.

## 3. Link your reviewer and test a message

1. Sign in as an **admin or approver** and open **Notification settings → WhatsApp**. A viewer cannot connect an approval channel.
2. Click the link/connect control. Open its WhatsApp link or copy and send its `LINK …` command from your joined phone. The command expires after ten minutes and can be used once.
3. Click **Refresh WhatsApp status**. Expect a masked linked number, notifications enabled and an open reply window.
4. Click **Send WhatsApp test**. Expect a synthetic test message on your phone. The UI first reports provider acceptance; refresh to inspect delivery status. Acceptance is not proof of delivery.

A phone can belong to only one reviewer. Use a separate joined phone and reviewer for a two-person approval policy. Manual test/resend requests share a one-minute cooldown.

## 4. Approve, reject and edit

1. Create a **demo run requiring human approval**, with title `WhatsApp approval test` and notice `Send this local demo notice`. Wait for its approval gate. This avoids depending on support-ticket policy rules that may automatically approve safe tickets.
2. Within the notification polling cycle, WhatsApp receives the proposal, review count, expiry and commands such as `APPROVE AbCdEf123456`. **Copy the actual code from your message.** Reply with that command from the linked phone.
3. Expect “Review recorded.” The run resumes once its required distinct reviewers have approved. Inspect the web timeline and local delivery. Repeating the command cannot add a second vote or repeat the workflow effect.
4. Create another gated demo and reply `REJECT <actual-code>` instead. Expect rejection rather than delivery.
5. For an edit, reply `EDIT <actual-code>`. Open the returned web inbox link, sign in as the linked reviewer, and review/edit there. WhatsApp never silently changes the draft. Existing version checks and reviewer quorum still apply; after a version change, use the newest notification.

Commands:

| Command                            | Result                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `HELLO` / `HELP`                   | Opens the inbound reply window and returns instructions.                                     |
| `PENDING`                          | Schedules fresh messages for currently pending approvals.                                    |
| `APPROVE <code>` / `REJECT <code>` | Records this reviewer's decision for that exact proposal version.                            |
| `EDIT <code>`                      | Returns the authenticated web review link.                                                   |
| `STOP`                             | Pauses this app's WhatsApp notifications. Provider-level opt-out can also apply.             |
| `START`                            | Enables this app's notifications again; follow Twilio's opt-in guidance if provider-blocked. |
| `UNLINK`                           | Disconnects this phone from this reviewer.                                                   |

Free-form outbound messages require a verified inbound message within the last **24 hours**. Send `HELLO`, then `PENDING`, when returning later. Replaying an old webhook does not reopen that window. This local implementation does not send template messages outside the window. Codes use the existing approval-link expiry, default fifteen minutes. Neither Telegram nor web approvals require the WhatsApp window.

## Security and delivery limits

Twilio signatures cover the exact configured HTTPS URL and every submitted form field. Wrong signatures/accounts/recipients are rejected. Pairing tokens and decision codes are stored as hashes. Decisions bind the phone, reviewer, approval version and expiring single-use approval token. Current membership and admin-only moderation rules are rechecked; a phone cannot approve for another reviewer. Web, Telegram and WhatsApp share the same transactional decision protection.

Incoming message SIDs have durable replay receipts and a processing lease. Completed duplicate callbacks return the original response without repeating actions or extending the reply window. Delivery status callbacks are signed and cannot regress from delivered to an earlier queued status. The UI masks the phone; the private database must retain the actual address for delivery. Do not log or publish credentials or phone contents.

Background notification claims use a one-minute lease and at most five attempts, separate from Telegram. A crash after Twilio accepted a message but before acknowledgement can duplicate an advisory notification. Single-use transactional decisions still prevent duplicate votes and workflow effects. Only the latest 100 enabled connections are scanned; this is a local demonstration, not a large-scale messaging service. Status records expire after seven days; inbound replay receipts remain retained.

## Troubleshooting

| Symptom                      | Check                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| WhatsApp unavailable         | Set `WHATSAPP_ENABLED=true`, valid credentials and HTTPS callback, then restart.                                       |
| Callback 403                 | Exact URL, Auth Token, Account SID, console sender and POST callback. A changed tunnel URL invalidates old signatures. |
| Twilio 63015                 | Rejoin the console's Sandbox from that exact phone.                                                                    |
| Twilio 63016 / window closed | Send `HELLO`, then `PENDING`, from WhatsApp.                                                                           |
| Twilio 20003                 | Correct Account SID/Auth Token pair in private `.env`.                                                                 |
| Accepted but no message      | Refresh status and inspect Twilio's message log for delivery failure, account limits or opt-out.                       |
| Cooldown                     | Wait one minute before another manual test/resend.                                                                     |
| No new request               | Create a new gated run; resolved approvals are not reopened. Check window, preferences and current role.               |
| Edit link asks to sign in    | Expected: authenticate in that phone browser using the public app URL.                                                 |

## Automated verification

```powershell
pnpm check
pnpm test:integration
pnpm test:e2e
```

Integration tests use isolated local MongoDB databases, fake Twilio transport and independently signed webhook fixtures. They cover linking, auth/Origin/signatures, approval/rejection, replay, membership revocation, reply windows, opt-out, cooldown and ordered status callbacks. Real phone delivery requires your own account and tunnel; it is not established by mocked tests.

References: [Sandbox](https://www.twilio.com/docs/whatsapp/sandbox), [webhook signature security](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [message API and status callbacks](https://www.twilio.com/docs/messaging/api/message-resource).
