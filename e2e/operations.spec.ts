import { test, expect } from './fixtures';
test('SLA countdown escalates and run metrics show zero-cost mock usage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/runs');
  await page
    .getByRole('textbox', { name: /^Test title/ })
    .fill('Step 15 SLA smoke');
  await page
    .getByLabel('Notice content', { exact: true })
    .fill('Local deadline demonstration');
  await page.getByLabel('Require human approval', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Start demo run', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await page.goto('/approvals');
  const card = page.locator('article').filter({ hasText: 'Step 15 SLA smoke' });
  await expect(card.getByLabel('Approval deadline')).toContainText(
    'Time remaining:',
  );
  await expect(card.getByLabel('Approval deadline')).toContainText(
    'Escalated to admin reviewers.',
    { timeout: 15000 },
  );
  await card.screenshot({ path: 'screenshots/step-15-sla-mobile.png' });
  await card.getByLabel('Review reason').fill('Local SLA test completed');
  await card.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.goto('/tickets/new');
  await page
    .getByLabel('Ticket title', { exact: true })
    .fill('Step 15 token usage');
  await page
    .getByRole('button', { name: 'Start support workflow', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  await page
    .getByRole('button', { name: 'Refresh run metrics', exact: true })
    .click();
  await expect(page.getByText(/Recorded model calls: 2/)).toBeVisible();
  await expect(
    page.getByText(/Known estimated cost: USD 0.000000/),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: /classify/ }).first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('heading', { name: 'Run cost and latency' })
    .scrollIntoViewIfNeeded();
  await page
    .locator('section')
    .filter({
      has: page.getByRole('heading', {
        name: 'Run cost and latency',
        exact: true,
      }),
    })
    .screenshot({ path: 'screenshots/step-15-run-metrics.png' });
  await page.goto('/analytics');
  await expect(
    page.getByRole('heading', { name: 'Cost per workflow', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'support-ticket-router', exact: true }),
  ).toBeVisible();
});
