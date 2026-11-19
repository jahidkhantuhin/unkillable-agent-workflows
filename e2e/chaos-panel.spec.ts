import { test, expect } from './fixtures';
test('admin sees chaos warning, model controls and supervised process recovery', async ({
  page,
}) => {
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/runs$/);
  await page.goto('/chaos');
  await expect(page.getByText(/CHAOS MODE ENABLED/)).toBeVisible();
  const panel = page.getByRole('region', { name: 'Chaos controls' });
  await expect(
    panel.getByRole('button', { name: 'Crash worker now' }),
  ).toBeEnabled();
  await panel.getByRole('button', { name: 'Slow LLM', exact: true }).click();
  await expect(
    panel.getByText('Current profile: slow', { exact: true }),
  ).toBeVisible();
  const toggle = panel.getByRole('switch', { name: 'Enable fault injection' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByText('Paused', { exact: true })).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Crash worker now' }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: 'Slow LLM', exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByText('Current profile: off', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/CHAOS MODE ENABLED/)).toHaveCount(0);
  await page.screenshot({
    path: 'screenshots/chaos-toggle-paused.png',
  });
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(
    panel.getByRole('button', { name: 'Slow LLM', exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(/CHAOS MODE ENABLED/)).toBeVisible();
  await page.screenshot({
    path: 'screenshots/chaos-toggle-active.png',
  });
  await panel.getByRole('button', { name: 'Reset LLM simulation' }).click();
  await expect(
    panel.getByText('Current profile: off', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Crash worker now' }).click();
  await expect(panel.getByText(/Worker: up · restarts 1/)).toBeVisible({
    timeout: 20000,
  });
  await panel.getByRole('button', { name: 'Crash API now' }).click();
  await expect(panel.getByText(/API: up · restarts 1/)).toBeVisible({
    timeout: 20000,
  });
  await panel.screenshot({ path: 'screenshots/step-9-chaos-panel.png' });
  await page.goto('/tickets/new');
  const title = 'Step 9 run fault browser test';
  await page.getByLabel('Ticket title', { exact: true }).fill(title);
  await page
    .getByLabel('Synthetic customer email (.test)', { exact: true })
    .fill('step9-run-fault@example.test');
  await page.getByRole('button', { name: /start/i }).click();
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  const runURL = page.url();
  const quick = page.getByRole('region', { name: 'Run chaos actions' });
  await quick
    .getByRole('combobox', { name: 'Fault node', exact: true })
    .selectOption('send_email');
  await quick.getByRole('button', { name: 'Apply run fault' }).click();
  await expect(quick.getByText(/Control saved/)).toBeVisible();
  await page.getByRole('link', { name: 'Approval Inbox', exact: true }).click();
  await page
    .locator('article')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Approve original', exact: true })
    .click();
  await page.goto(runURL);
  await expect(page.getByTestId('graph-node-send_email')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await page.getByTestId('graph-node-send_email').click();
  await expect(
    page.getByRole('region', { name: 'Node inspector' }),
  ).toContainText('2 recorded attempts');
});
