import { test, expect } from './fixtures';
test('inspect a draft diff, validate edits and fork into a new human approval', async ({
  page,
}) => {
  await page.goto('/runs');
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByRole('link', { name: 'New ticket', exact: true }).click();
  await page
    .getByLabel('Ticket title', { exact: true })
    .fill('Time travel parent');
  await page.getByRole('button', { name: /start/i }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const parentURL = page.url();
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  const panel = page.getByRole('region', { name: 'Time travel', exact: true });
  const selected = panel.getByLabel('Selected checkpoint', { exact: true });
  await expect(
    selected.locator('option').filter({ hasText: /· draft_reply ·/ }),
  ).toHaveCount(1);
  const draftId = await selected
    .locator('option')
    .filter({ hasText: /· draft_reply ·/ })
    .getAttribute('value');
  const policyId = await selected
    .locator('option')
    .filter({ hasText: /· retrieve_policy ·/ })
    .getAttribute('value');
  await selected.selectOption(draftId!);
  await panel
    .getByLabel('Compare from', { exact: true })
    .selectOption(policyId!);
  await expect(panel).toContainText('/draft/message');
  await panel
    .getByLabel('State edits (JSON)', { exact: true })
    .fill('{"approvalAction":"approve"}');
  await panel.getByRole('button', { name: 'Create fork', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Unrecognized key');
  await expect(page).toHaveURL(parentURL);
  await panel.getByLabel('State edits (JSON)', { exact: true }).fill(
    JSON.stringify({
      title: 'Time travel child',
      draftMessage:
        'We are sorry about the duplicate charge. Please review this refund.',
    }),
  );
  await panel.getByRole('button', { name: 'Create fork', exact: true }).click();
  await expect(page).not.toHaveURL(parentURL);
  await expect(
    page.getByRole('heading', { name: 'Time travel child', exact: true }),
  ).toBeVisible();
  const childURL = page.url();
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  await expect(
    panel.getByRole('link', { name: 'Time travel parent', exact: true }),
  ).toHaveAttribute('href', new URL(parentURL).pathname);
  await page.goto('/approvals');
  const card = page.locator('article').filter({ hasText: 'Time travel child' });
  await expect(card).toContainText('We are sorry about the duplicate charge');
  await card
    .getByRole('button', { name: 'Approve original', exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page.goto(childURL);
  await expect(page.getByTestId('graph-node-close_ticket')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await page.reload();
  await expect(
    panel.getByRole('link', { name: 'Time travel parent', exact: true }),
  ).toBeVisible();
  await panel.screenshot({ path: 'screenshots/step-13-time-travel.png' });
  await panel
    .getByRole('link', { name: 'Time travel parent', exact: true })
    .click();
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
  );
  await page
    .getByRole('region', { name: 'Time travel', exact: true })
    .getByText('Child runs (latest 1)', { exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Time travel', exact: true })
      .getByRole('link', { name: 'Time travel child', exact: true }),
  ).toBeVisible();
});
