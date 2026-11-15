import { test, expect } from '@playwright/test';
test('ticket graph pulses at approval and rebuilds after reload', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('step8@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('step8-local-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByRole('link', { name: 'New ticket', exact: true }).click();
  await page
    .getByLabel('Ticket title', { exact: true })
    .fill('Step 8 approval graph smoke');
  await page
    .getByLabel('Synthetic customer email (.test)', { exact: true })
    .fill('step8-graph@example.test');
  await page.getByRole('button', { name: /start/i }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const approval = page.getByTestId('graph-node-approval');
  await expect(approval).toHaveAttribute('data-status', 'waiting_approval', {
    timeout: 30000,
  });
  await expect(approval).toHaveClass(/approval-pulse/);
  await expect(page.getByTestId('graph-node-classify')).toHaveAttribute(
    'data-status',
    'succeeded',
  );
  await approval.click();
  await expect(
    page.getByRole('region', { name: 'Node inspector' }),
  ).toContainText('Input');
  await expect(
    page.getByRole('region', { name: 'Node inspector' }),
  ).toContainText('Step 8 approval graph smoke');
  await page.reload();
  await expect(approval).toHaveAttribute('data-status', 'waiting_approval');
  await expect(page.getByTestId('graph-node-classify')).toHaveAttribute(
    'data-status',
    'succeeded',
  );
  await page
    .getByRole('region', { name: 'Live workflow graph' })
    .screenshot({ path: 'screenshots/step-8-approval-graph.png' });
});
