import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { releaseDemoTicket } from '../../packages/shared/src/release-demo';
test('capture every public and workspace page with synthetic demo content', async ({
  page,
}) => {
  const output = resolve('screenshots/pages');
  await mkdir(output, { recursive: true });
  const manifest: {
    file: string;
    title: string;
    route: string;
    width: number;
    height: number;
    focus?: number[];
  }[] = [];
  async function capture(
    p: Page,
    file: string,
    title: string,
    route: string,
    focus?: number[],
  ) {
    await p.evaluate(() => document.fonts.ready);
    const dismiss = p
      .getByRole('region', { name: 'Notifications', exact: true })
      .getByRole('button', { name: 'Dismiss notification' });
    while (await dismiss.count()) await dismiss.first().click();
    await p.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() =>
        p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    const size = await p.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    await p.screenshot({
      path: resolve(output, file),
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
    manifest.push({ file, title, route, ...size, focus });
    console.log(`Captured ${file}: ${size.width}x${size.height}`);
  }
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /Agents that act/ }),
  ).toBeVisible();
  await capture(page, '01-home.png', 'Welcome to Unkillable', '/');
  await page.goto('/login');
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await capture(page, '02-login.png', 'Sign in', '/login');
  await page.goto('/register');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await capture(page, '03-register.png', 'Create an account', '/register');
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('step8@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('step8-local-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
  const origin = 'http://127.0.0.1:3100';
  async function post(path: string, data: object) {
    const r = await page.request.post(`/api/backend/${path}`, {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  }
  async function runState(id: string, status: string) {
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/backend/runs/${id}`)).json())
            .status,
        { timeout: 45000 },
      )
      .toBe(status);
  }
  const { id: _exampleId, ...ticket } = releaseDemoTicket;
  void _exampleId;
  const approved = await post('tickets', {
    ...ticket,
    title: 'Order #4821 — reviewed refund',
    customerEmail: `overview-approved-${Date.now()}@example.test`,
  });
  await runState(approved.id, 'waiting_approval');
  const approvals = await (
    await page.request.get('/api/backend/approvals')
  ).json();
  const first = approvals.find(
    (a: { runId: string }) => a.runId === approved.id,
  );
  await post(`approvals/${first.id}/resolve`, {
    version: first.version,
    decision: {
      action: 'edit',
      payload: {
        message:
          'We reviewed your duplicate charge for order #4821. Your USD 42.00 refund has been approved for our local demo ledger.',
      },
      reason: 'Clarified the refund amount and customer response.',
    },
  });
  await runState(approved.id, 'succeeded');
  const pending = await post('tickets', {
    ...ticket,
    title: 'Order #7318 — awaiting human review',
    orderId: '7318',
    amountCents: 6500,
    customerEmail: `overview-pending-${Date.now()}@example.test`,
  });
  await runState(pending.id, 'waiting_approval');
  const failed = await post('runs', {
    input: {
      title: 'Delivery failure — ready for inspection',
      message: 'Synthetic local failure for the Dead Letters walkthrough.',
      deliveryMode: 'permanent',
      requireApproval: false,
    },
  });
  await runState(failed.id, 'failed');
  async function moderate(title: string, text: string) {
    const r = await page.request.post(
      `/api/backend/moderation/uploads?title=${encodeURIComponent(title)}`,
      {
        headers: { origin, 'content-type': 'text/plain; charset=utf-8' },
        data: text,
      },
    );
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  }
  const published = await moderate(
    'Community update — published',
    'Our support team has updated the help center. Thank you for your feedback.',
  );
  await runState(published.id, 'succeeded');
  const review = await moderate(
    'Community post — administrator review',
    'DEMO_REVIEW A synthetic post held for administrator review before publication.',
  );
  await runState(review.id, 'waiting_approval');
  await page.goto('/runs');
  await expect(
    page.getByText('Order #4821 — reviewed refund', { exact: true }),
  ).toBeVisible();
  await capture(
    page,
    '04-runs.png',
    'Runs · durable workflows at a glance',
    '/runs',
  );
  await page.goto('/tickets/new');
  await page.getByLabel('Load an example').selectOption('release-demo-4821');
  await expect(
    page.getByLabel('Charge amount (USD cents)', { exact: true }),
  ).toHaveValue('4200');
  await capture(
    page,
    '05-new-ticket.png',
    'Start a support workflow',
    '/tickets/new',
  );
  await page.goto('/workflows');
  await expect(
    page.getByRole('heading', { name: /^workflows$/i }),
  ).toBeVisible();
  await capture(
    page,
    '06-workflows.png',
    'Workflows · current catalog page',
    '/workflows',
  );
  await page.goto(`/runs/${pending.id}`);
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
  );
  await expect(page.getByText('Loading saved events…')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Refresh run metrics' }),
  ).toBeVisible();
  await capture(
    page,
    '07-run-pending.png',
    'Live graph · paused for human approval',
    '/runs/:id (pending)',
    [0, 0.13, 0.48, 1],
  );
  const timeTravel = page.getByRole('region', {
    name: 'Time travel',
    exact: true,
  });
  const selected = timeTravel.getByLabel('Selected checkpoint', {
    exact: true,
  });
  await expect(
    selected.locator('option').filter({ hasText: /· draft_reply ·/ }),
  ).toHaveCount(1);
  const checkpoint = await selected
    .locator('option')
    .filter({ hasText: /· draft_reply ·/ })
    .getAttribute('value');
  await selected.selectOption(checkpoint!);
  await expect(timeTravel.getByText('Loading checkpoint…')).toHaveCount(0);
  await capture(
    page,
    '08-time-travel.png',
    'Checkpoint history · inspect and fork',
    '/runs/:id (checkpoint view)',
    [0.13, 0.28],
  );
  await page.goto('/approvals');
  await expect(
    page
      .locator('article')
      .filter({ hasText: 'Order #7318 — awaiting human review' }),
  ).toBeVisible();
  await capture(
    page,
    '09-approvals.png',
    'Approval Inbox · review before action',
    '/approvals',
  );
  const list = await (await page.request.get('/api/backend/approvals')).json(),
    item = list.find((a: { runId: string }) => a.runId === pending.id);
  const links = await post(`notifications/links/${item.id}`, {});
  await page.goto(links.approve);
  await expect(
    page.getByRole('button', { name: 'Confirm approve', exact: true }),
  ).toBeVisible();
  await capture(
    page,
    '10-signed-review.png',
    'Personal signed review · explicit confirmation',
    '/approve',
  );
  await page.goto(`/runs/${approved.id}`);
  await expect(page.getByTestId('graph-node-close_ticket')).toHaveAttribute(
    'data-status',
    'succeeded',
  );
  await expect(page.getByText(/Mailpit reply: sent/)).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText('Loading saved events…')).toHaveCount(0);
  await capture(
    page,
    '11-run-succeeded.png',
    'Completed run · one refund and one email',
    '/runs/:id (succeeded)',
    [0, 0.42, 0.63, 0.82],
  );
  await page.goto('/moderation');
  await expect(
    page.getByText('Community update — published', { exact: true }),
  ).toBeVisible();
  await capture(
    page,
    '12-moderation.png',
    'Text moderation · publish or request review',
    '/moderation',
  );
  await page.goto(`/runs/${published.id}`);
  await expect(page.getByTestId('graph-node-notify')).toHaveAttribute(
    'data-status',
    'succeeded',
  );
  await expect(page.getByText('Loading saved events…')).toHaveCount(0);
  await capture(
    page,
    '13-moderation-run.png',
    'Moderation graph · reusable durable execution',
    '/runs/:id (moderation)',
    [0, 0.6],
  );
  await page.goto('/dead-letters');
  await expect(
    page.getByText('Delivery failure — ready for inspection', { exact: true }),
  ).toBeVisible();
  await capture(
    page,
    '14-dead-letters.png',
    'Dead Letters · inspect, retry or discard',
    '/dead-letters',
  );
  await page.goto('/policies');
  await expect(page.getByText(/Active version 1/)).toBeVisible();
  await capture(
    page,
    '15-policies.png',
    'Versioned policy · mandatory money safety floor',
    '/policies',
  );
  await page.goto('/analytics');
  await expect(page.getByText('Loading metrics…')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Cost per workflow', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Clarified the refund amount and customer response.', {
      exact: false,
    }),
  ).toBeVisible();
  await capture(
    page,
    '16-analytics.png',
    'Analytics · review feedback and workflow costs',
    '/analytics',
  );
  await page.goto('/notifications');
  await expect(page.getByText('Loading WhatsApp settings…')).toHaveCount(0);
  await expect(
    page.getByText(/Telegram: Disabled on this server/),
  ).toBeVisible();
  await capture(
    page,
    '17-notifications.png',
    'Channels · web-first approval notifications',
    '/notifications',
  );
  await page.goto('/chaos');
  await expect(
    page.getByRole('button', { name: 'Crash worker now', exact: true }),
  ).toBeVisible();
  await capture(
    page,
    '18-chaos.png',
    'Chaos controls · guarded local failure injection',
    '/chaos',
  );
  await page.goto('/runs');
  const bell = page.getByRole('button', { name: /^Approval notifications,/ });
  await bell.click();
  await expect(
    page.getByRole('region', {
      name: 'Pending approval notifications',
      exact: true,
    }),
  ).toBeVisible();
  await capture(
    page,
    '19-approval-bell.png',
    'Global alerts · review from any page',
    '/runs (notification dropdown)',
    [0],
  );
  await writeFile(
    resolve(output, 'manifest.json'),
    JSON.stringify(
      {
        viewport: { width: 1440, height: 1000 },
        synthetic: true,
        entries: manifest,
      },
      null,
      2,
    ),
  );
});
