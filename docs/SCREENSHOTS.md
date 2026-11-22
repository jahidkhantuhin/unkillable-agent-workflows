# Application screenshots

The [overview GIF](../screenshots/unkillable-overview.gif) tours all 19 views in 51 seconds. It uses readable viewport highlights; the PNGs below preserve each page's full height at 1440 pixels wide. Open an image at full size to read long timelines. Collapsed controls retain their captured state.

These are actual browser captures using isolated synthetic accounts, MockLLM, fake payments and local Mailpit. Telegram and WhatsApp are disabled. The Workflows page is captured as implemented, including its current placeholder copy. Signed-link URLs and credentials are not shown.

| Page or state                       | Full-page screenshot                                   |
| ----------------------------------- | ------------------------------------------------------ |
| Home                                | [Open PNG](../screenshots/pages/01-home.png)           |
| Sign in                             | [Open PNG](../screenshots/pages/02-login.png)          |
| Registration                        | [Open PNG](../screenshots/pages/03-register.png)       |
| Runs                                | [Open PNG](../screenshots/pages/04-runs.png)           |
| New support ticket                  | [Open PNG](../screenshots/pages/05-new-ticket.png)     |
| Workflows                           | [Open PNG](../screenshots/pages/06-workflows.png)      |
| Run awaiting approval               | [Open PNG](../screenshots/pages/07-run-pending.png)    |
| Checkpoint inspection / time travel | [Open PNG](../screenshots/pages/08-time-travel.png)    |
| Approval Inbox                      | [Open PNG](../screenshots/pages/09-approvals.png)      |
| Signed approval review              | [Open PNG](../screenshots/pages/10-signed-review.png)  |
| Successful support run              | [Open PNG](../screenshots/pages/11-run-succeeded.png)  |
| Content moderation                  | [Open PNG](../screenshots/pages/12-moderation.png)     |
| Published moderation run            | [Open PNG](../screenshots/pages/13-moderation-run.png) |
| Dead Letters                        | [Open PNG](../screenshots/pages/14-dead-letters.png)   |
| Approval policies                   | [Open PNG](../screenshots/pages/15-policies.png)       |
| Analytics                           | [Open PNG](../screenshots/pages/16-analytics.png)      |
| Notification settings               | [Open PNG](../screenshots/pages/17-notifications.png)  |
| Chaos controls                      | [Open PNG](../screenshots/pages/18-chaos.png)          |
| Approval notification bell          | [Open PNG](../screenshots/pages/19-approval-bell.png)  |

## Refresh the captures

From the project root, with dependencies installed and Docker Desktop running:

```powershell
docker compose up -d --wait
pnpm build
pnpm test:e2e --config playwright.media.config.ts
npm install --prefix .local/media-tools --ignore-scripts --no-package-lock --no-save gifenc@1.0.3
node scripts/media/build-overview.mjs
```

The capture uses the existing isolated browser-test harness and production build, not your signed-in development session. It creates and cleans up its own test database and queue namespace. It does not change private `.env`. Ensure the harness ports are available before running it.

The GIF builder uses Next's installed Sharp and an ignored local installation of gifenc; no application dependency is added. [Capture metadata](../screenshots/pages/manifest.json) records image dimensions; [animation metadata](../screenshots/pages/overview.json) records frame count, duration and size. The builder checks full-page image dimensions and decodes the finished GIF to verify its frame count and dimensions.
