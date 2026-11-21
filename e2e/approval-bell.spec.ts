import { test, expect } from './fixtures';
test('global bell signals pending approvals and reminders, acknowledges attention and respects reduced motion', async ({
  page,
}) => {
  const id = '11111111-1111-4111-8111-111111111111',
    now = Date.now();
  let items: object[] = [];
  const approval = {
    id,
    runId: '22222222-2222-4222-8222-222222222222',
    nodeId: 'approval',
    title: 'Bell attention test',
    status: 'pending',
    version: 0,
    proposedAction: { message: 'Synthetic notice' },
    reasoning: 'Local human review',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    sla: {
      remindAt: new Date(now + 1000).toISOString(),
      escalateAt: new Date(now + 2000).toISOString(),
      expireAt: new Date(now + 120000).toISOString(),
      escalateRole: 'admin',
      timeoutAction: 'reject',
    },
  };
  await page.route('**/api/backend/approvals', (route) =>
    route.fulfill({ json: items }),
  );
  const initialPoll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/backend/approvals' &&
      response.status() === 200,
  );
  await page.goto('/runs');
  await initialPoll;
  const bell = page.getByRole('button', { name: /^Approval notifications,/ });
  await expect(bell).toHaveAccessibleName('Approval notifications, 0 pending');
  items = [approval];
  await expect(bell).toHaveAccessibleName('Approval notifications, 1 pending', {
    timeout: 12000,
  });
  await expect(bell).toHaveClass(/approval-bell-halo/);
  const notices = page.getByRole('region', {
    name: 'Notifications',
    exact: true,
  });
  await expect(
    notices.getByText(/New approval request: Bell attention test/),
  ).toBeVisible();
  await notices.getByRole('button', { name: 'Dismiss notification' }).click();
  await bell.click();
  const panel = page.getByRole('region', {
    name: 'Pending approval notifications',
    exact: true,
  });
  await expect(
    panel.getByText('Bell attention test', { exact: true }),
  ).toBeVisible();
  await expect(bell).not.toHaveClass(/approval-bell-halo/);
  await page.keyboard.press('Escape');
  await expect(bell).toBeFocused();
  await expect(bell).toHaveAccessibleName('Approval notifications, 1 pending');
  items = [
    {
      ...approval,
      sla: { ...approval.sla, remindedAt: new Date().toISOString() },
    },
  ];
  await expect(notices.getByText(/Your approval review is needed/)).toBeVisible(
    { timeout: 12000 },
  );
  await notices.getByRole('button', { name: 'Dismiss notification' }).click();
  items = [
    {
      ...approval,
      sla: {
        ...approval.sla,
        remindedAt: new Date().toISOString(),
        escalatedAt: new Date().toISOString(),
      },
    },
  ];
  await expect(
    notices.getByText(/Approval escalated to your reviewer group/),
  ).toBeVisible({ timeout: 12000 });
  await notices.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(bell).toHaveAccessibleName('Approval notifications, 1 pending');
  expect(await bell.evaluate((e) => getComputedStyle(e).animationName)).toBe(
    'none',
  );
  await bell.click();
  await expect(
    panel.getByText('Escalated to your group', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'screenshots/step-15-approval-bell-mobile.png',
  });
  await panel.getByRole('link', { name: /Review now/ }).click();
  await expect(page).toHaveURL(new RegExp(`/approvals#approval-${id}$`));
  items = [];
  await expect(bell).toHaveAccessibleName('Approval notifications, 0 pending', {
    timeout: 12000,
  });
});
