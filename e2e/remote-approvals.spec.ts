import { test, expect } from './fixtures';
test('mobile signed approval requires confirmation, rejects replay and installs a network-only app', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/notifications');
  await expect(
    page.getByRole('heading', { name: 'Notification settings', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Telegram: Disabled on this server. Web approvals still work.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Link private Telegram chat',
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Save preferences', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Notifications', exact: true })
      .getByRole('status')
      .filter({ hasText: 'Notification preferences saved.' }),
  ).toBeVisible();
  const manifest = await (
    await page.request.get('/manifest.webmanifest')
  ).json();
  expect(manifest.start_url).toBe('/approvals');
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(
      (await response.body())
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ).toBe(true);
  }
  const worker = await page.request.get('/sw.js');
  expect(worker.headers()['cache-control']).toContain('no-store');
  await page.goto('/tickets/new');
  await page
    .getByLabel('Ticket title', { exact: true })
    .fill('Step 14 mobile review');
  await page
    .getByRole('button', { name: 'Start support workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const runPath = new URL(page.url()).pathname;
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  await page.goto('/approvals');
  const card = page
    .locator('article')
    .filter({ hasText: 'Step 14 mobile review' });
  await card
    .getByRole('button', {
      name: 'Create personal approval links',
      exact: true,
    })
    .click();
  const href = await card
    .getByRole('link', { name: 'Open approve link', exact: true })
    .getAttribute('href');
  expect(href).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await card.screenshot({ path: 'screenshots/step-14-mobile-inbox.png' });
  await page.goto(href!);
  await expect(
    page.getByRole('button', { name: 'Confirm approve', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/approve$/);
  expect(
    (await (await page.request.get(`/api/backend${runPath}`)).json()).status,
  ).toBe('waiting_approval');
  await page.screenshot({ path: 'screenshots/step-14-signed-review.png' });
  await page
    .getByRole('button', { name: 'Confirm approve', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Open run timeline', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Open run timeline', exact: true })
    .click();
  await expect(page.getByTestId('graph-node-close_ticket')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await page.goto(href!);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    /already used|changed|expired/,
  );
  await expect(
    page.getByRole('button', { name: 'Confirm approve', exact: true }),
  ).toHaveCount(0);
  await page.goto('/approvals');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await context.setOffline(true);
  await page.goto('/approvals');
  await expect(
    page.getByRole('heading', { name: 'Connection required', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Connect to the internet and reopen the Approval Inbox. No approval has been submitted or queued offline.',
    ),
  ).toBeVisible();
  await context.setOffline(false);
  await page.goto('/notifications');
  await expect(
    page.getByRole('heading', { name: 'Notification settings', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
