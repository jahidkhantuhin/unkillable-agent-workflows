import { test, expect } from '@playwright/test';
test('admin moderates safe, review and blocked uploads with the durable graph', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('step8@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('step8-local-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByRole('link', { name: /Moderation/ }).click();
  await page.getByRole('button', { name: 'Safe example', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start moderation', exact: true })
    .click();
  const safeURL = await page
    .getByRole('link', { name: 'Open moderation run', exact: true })
    .getAttribute('href');
  expect(safeURL).toBeTruthy();
  await page
    .getByRole('link', { name: 'Open moderation run', exact: true })
    .click();
  await expect(page.getByTestId('graph-node-notify')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/backend${safeURL}/reliability`);
      const body = await r.json();
      return body.deliveries?.length;
    })
    .toBe(1);
  await page.goto('/moderation');
  await page
    .getByLabel('Content title', { exact: true })
    .fill('Browser review upload');
  const zone = page.getByRole('region', {
    name: 'Text file upload',
    exact: true,
  });
  const choose = zone.getByRole('button', { name: 'Choose file', exact: true });
  await expect(choose).toBeVisible();
  await expect(choose).toHaveCSS('cursor', 'pointer');
  const picker = page.waitForEvent('filechooser');
  await choose.click();
  await (
    await picker
  ).setFiles({
    name: 'review.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'DEMO_REVIEW: Synthetic content for an administrator to check.' +
        ' Synthetic large-file content.'.repeat(40000),
    ),
  });
  await expect(zone.getByText('review.txt', { exact: true })).toBeVisible();
  const invalid = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(['not a text submission'], 'image.png', { type: 'image/png' }),
    );
    return data;
  });
  await zone.dispatchEvent('drop', { dataTransfer: invalid });
  await invalid.dispose();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Choose a .txt or .md file' }),
  ).toBeVisible();
  await expect(zone.getByText('review.txt', { exact: true })).toBeVisible();
  await zone.getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(page.getByLabel('Text content', { exact: true })).toBeEnabled();
  const dropped = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [
          'DEMO_REVIEW: Synthetic content for an administrator to check.' +
            ' Synthetic large-file content.'.repeat(40000),
        ],
        'dragged-review.txt',
        { type: 'text/plain' },
      ),
    );
    return data;
  });
  await zone.dispatchEvent('dragenter', { dataTransfer: dropped });
  await zone.dispatchEvent('dragover', { dataTransfer: dropped });
  await expect(zone).toHaveAttribute('data-dragging', 'true');
  await zone.dispatchEvent('drop', { dataTransfer: dropped });
  await dropped.dispose();
  await expect(zone).toHaveAttribute('data-dragging', 'false');
  await expect(
    zone.getByText('dragged-review.txt', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Text content', { exact: true })).toBeDisabled();
  await zone.screenshot({ path: 'screenshots/moderation-drop-zone-dark.png' });
  await page
    .getByRole('button', { name: 'Start moderation', exact: true })
    .click();
  await expect(page.getByLabel('Content title', { exact: true })).toHaveValue(
    '',
  );
  await expect(page.getByLabel('Text content', { exact: true })).toHaveValue(
    '',
  );
  await expect(
    zone.getByRole('button', { name: 'Remove file', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Open moderation run', exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  const reviewURL = page.url();
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  await page.goto('/approvals');
  const card = page
    .locator('article')
    .filter({ hasText: 'Browser review upload' });
  await expect(
    card.getByRole('link', {
      name: 'Download full original content before reviewing',
    }),
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Approve edited draft' }),
  ).toHaveCount(0);
  await card.getByRole('button', { name: 'Approve publication' }).click();
  await expect(card).toHaveCount(0);
  await page.goto(reviewURL);
  await expect(page.getByTestId('graph-node-publish')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await page.reload();
  await expect(page.getByTestId('graph-node-publish')).toHaveAttribute(
    'data-status',
    'succeeded',
  );
  await page.goto('/moderation');
  await page
    .getByRole('button', { name: 'Blocked example', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Start moderation', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Open moderation run', exact: true })
    .click();
  await expect(page.getByTestId('graph-node-reject')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 30000 },
  );
  await page.goto('/moderation');
  await expect(
    page.locator('article').filter({ hasText: 'Blocked example' }),
  ).toContainText('rejected');
  await page.screenshot({
    path: 'screenshots/step-12-moderation.png',
    fullPage: true,
  });
});
