import { test, expect } from './fixtures';
test('admin dry-runs and activates a policy, observes auto approval and analytics', async ({
  page,
}) => {
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByRole('link', { name: /Policies/ }).click();
  await expect(
    page.getByText('Active version 0', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Load example rules' }).click();
  await page.getByRole('button', { name: 'Dry-run past decisions' }).click();
  await expect(
    page.getByRole('status', { name: 'Policy update' }),
  ).toContainText('No run or policy was changed');
  await expect(
    page.getByText('Active version 0', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activate new version' }).click();
  await expect(
    page.getByRole('status', { name: 'Policy update' }),
  ).toContainText('New version activated');
  try {
    await page.screenshot({
      path: 'screenshots/step-11-policies.png',
      fullPage: true,
    });
    await page.goto('/tickets/new');
    await page.getByLabel('Load an example').selectOption('how-to');
    await page
      .getByLabel('Ticket title', { exact: true })
      .fill('Step 11 automatic invoice reply');
    await page
      .getByLabel('Synthetic customer email (.test)', { exact: true })
      .fill('step11-auto@example.test');
    await page.getByRole('button', { name: 'Start support workflow' }).click();
    await expect(page.getByTestId('graph-node-close_ticket')).toHaveAttribute(
      'data-status',
      'succeeded',
      { timeout: 30000 },
    );
    await expect(
      page.getByRole('heading', { name: 'Approval policy decision' }),
    ).toBeVisible();
    await expect(page.getByText(/version 1 · auto approve/)).toBeVisible();
    await page.getByRole('link', { name: /Analytics/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Approval analytics' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Human approval rate' }),
    ).toBeVisible();
    await expect(
      page
        .locator('section')
        .filter({
          has: page.getByRole('heading', {
            name: 'Auto-approved',
            exact: true,
          }),
        })
        .getByText('1', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Auto-approved share over time (UTC)',
      }),
    ).toBeVisible();
    await page.screenshot({
      path: 'screenshots/step-11-analytics.png',
      fullPage: true,
    });
  } finally {
    const current = await page.request.get('/api/backend/policies');
    const body = await current.json();
    const reset = await page.request.post('/api/backend/policies', {
      headers: { origin: 'http://127.0.0.1:3100' },
      data: {
        expectedVersion: body.current.version,
        policy: {
          name: 'Human review by default',
          rules: [],
          fallback: 'require_approval',
        },
      },
    });
    expect(reset.ok()).toBe(true);
  }
});
