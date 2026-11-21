import { test, expect } from './fixtures';
test('release demo: login, pause, signed approval, one refund and one Mailpit capture', async ({
  page,
}) => {
  // fixtures.ts obtains this context through the real sign-in form.
  await page.goto('/tickets/new');
  await page.getByLabel('Load an example').selectOption('release-demo-4821');
  const recipient = `release-${Date.now()}@example.test`;
  await page
    .getByLabel('Synthetic customer email (.test)', { exact: true })
    .fill(recipient);
  await expect(
    page.getByLabel('Charge amount (USD cents)', { exact: true }),
  ).toHaveValue('4200');
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
  await expect(page.getByTestId('graph-node-approval')).toHaveClass(
    /approval-pulse/,
  );
  const before = await (
    await page.request.get(`/api/backend${runPath}/reliability`)
  ).json();
  expect(before.refunds).toHaveLength(0);
  expect(before.emails).toHaveLength(0);
  const dismiss = page
    .getByRole('region', { name: 'Notifications', exact: true })
    .getByRole('button', { name: 'Dismiss notification' });
  while (await dismiss.count()) await dismiss.first().click();
  await page
    .getByRole('region', { name: 'Live workflow graph' })
    .screenshot({ path: 'screenshots/release-workflow-graph.png' });
  await page.goto('/approvals');
  const card = page
    .locator('article')
    .filter({ hasText: 'Charged twice for order #4821, refund one' });
  await expect(card).toContainText('USD 42.00');
  await card.screenshot({ path: 'screenshots/release-approval.png' });
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
  await page.goto(href!);
  expect(
    (await (await page.request.get(`/api/backend${runPath}`)).json()).status,
  ).toBe('waiting_approval');
  await page
    .getByRole('button', { name: 'Confirm approve', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Open run timeline', exact: true })
    .click();
  await expect(page.getByTestId('graph-node-close_ticket')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await expect(
    page.getByText('Fake refund: USD 42.00 · active', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(`Mailpit reply: sent · ${recipient}`, { exact: false }),
  ).toBeVisible({ timeout: 15000 });
  const details = await (
    await page.request.get(`/api/backend${runPath}/reliability`)
  ).json();
  expect(details.refunds).toHaveLength(1);
  expect(details.emails).toHaveLength(1);
  expect(details.deliveries).toHaveLength(1);
  const captures = await page.request.get(
    `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
  );
  expect(captures.ok()).toBe(true);
  expect((await captures.json()).messages).toHaveLength(1);
  const history = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Event history', exact: true }),
  });
  await expect(
    history.getByText('issue_refund checkpointed', { exact: true }),
  ).toHaveCount(1);
  await expect(
    history.getByText('send_email checkpointed', { exact: true }),
  ).toHaveCount(1);
  const graph = await (
    await page.request.get(`/api/backend${runPath}/graph`)
  ).json();
  expect(graph).toBeTruthy();
  await page.goto(href!);
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    /already used|changed|expired/,
  );
  const after = await (
    await page.request.get(`/api/backend${runPath}/reliability`)
  ).json();
  expect(after.refunds).toHaveLength(1);
  expect(after.emails).toHaveLength(1);
});
