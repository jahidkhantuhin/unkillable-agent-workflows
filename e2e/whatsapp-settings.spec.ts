import { test, expect } from './fixtures';
test('WhatsApp settings show linking, delivery feedback and mobile controls without contacting Twilio', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let linked = false;
  const settings = () => ({
    available: true,
    linked,
    enabled: linked,
    sender: 'whatsapp:+15550000000',
    phoneMasked: linked ? '•••• 1111' : '',
    windowOpen: linked,
    windowExpiresAt: linked
      ? new Date(Date.now() + 86400000).toISOString()
      : null,
    lastStatus: linked ? 'delivered' : null,
    lastError: null,
  });
  await page.route('**/api/backend/notifications/whatsapp/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'link')
      return route.fulfill({
        json: {
          command: `LINK ${'a'.repeat(32)}`,
          url: `https://wa.me/15550000000?text=LINK`,
          expiresInSeconds: 600,
        },
      });
    if (action === 'test')
      return route.fulfill({ json: { accepted: true, status: 'queued' } });
    if (action === 'unlink') linked = false;
    return route.fulfill({ json: settings() });
  });
  await page.goto('/notifications');
  const section = page.getByRole('region', {
    name: 'WhatsApp approval settings',
  });
  await expect(
    section.getByRole('button', { name: 'Send WhatsApp test', exact: true }),
  ).toBeDisabled();
  await section
    .getByRole('button', { name: 'Link WhatsApp number', exact: true })
    .click();
  await expect(
    section.getByText(`LINK ${'a'.repeat(32)}`, { exact: true }),
  ).toBeVisible();
  linked = true;
  await section
    .getByRole('button', { name: 'Refresh WhatsApp status' })
    .click();
  await expect(
    section.getByText('Connection: Linked to •••• 1111'),
  ).toBeVisible();
  await section
    .getByRole('button', { name: 'Send WhatsApp test', exact: true })
    .click();
  await expect(
    page.getByText(
      'WhatsApp test message accepted by Twilio. Refresh status or check your phone for delivery.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    section.getByText('Latest message status: delivered'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'screenshots/step-14-whatsapp-mobile.png',
    fullPage: true,
  });
  await section
    .getByRole('button', { name: 'Unlink WhatsApp', exact: true })
    .click();
  await expect(section.getByText('Connection: Not linked')).toBeVisible();
});
