import { test, expect } from './fixtures';
test('action notifications show errors, survive navigation and remain usable on mobile', async ({
  page,
}) => {
  await page.goto('/tickets/new');
  const notices = page.getByRole('region', {
    name: 'Notifications',
    exact: true,
  });
  await page.route('**/api/backend/tickets', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'Test API unavailable. Please retry.' },
      }),
    }),
  );
  const start = page.getByRole('button', {
    name: 'Start support workflow',
    exact: true,
  });
  const amount = page.getByRole('spinbutton', {
    name: 'Charge amount (USD cents)',
  });
  await amount.fill('');
  await start.click();
  await expect(notices.getByRole('alert')).toBeInViewport();
  await notices
    .getByRole('alert')
    .getByRole('button', { name: 'Dismiss notification' })
    .click();
  await amount.fill('4900');
  await start.click();
  const failure = notices
    .getByRole('alert')
    .filter({ hasText: 'Test API unavailable' });
  await expect(failure).toBeInViewport();
  await start.click();
  await expect(failure).toHaveCount(1);
  await expect(notices.getByRole('status')).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(failure).toBeInViewport();
  const box = await failure.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await notices.screenshot({ path: 'screenshots/action-toast-mobile.png' });
  await failure.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(failure).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.unroute('**/api/backend/tickets');
  await start.click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(
    notices
      .getByRole('status')
      .filter({ hasText: 'Support ticket created and queued.' }),
  ).toBeVisible();
  await expect(page.getByTestId('graph-node-approval')).toHaveAttribute(
    'data-status',
    'waiting_approval',
    { timeout: 30000 },
  );
  await notices.screenshot({ path: 'screenshots/action-toast-success.png' });
  await page.clock.install();
  await page
    .getByRole('button', { name: 'Toggle color theme', exact: true })
    .click();
  const theme = notices
    .getByRole('status')
    .filter({ hasText: 'theme enabled.' });
  await expect(theme).toBeVisible();
  await theme.hover();
  await page.clock.fastForward(7000);
  await expect(theme).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(7000);
  await expect(theme).toHaveCount(0);
});
