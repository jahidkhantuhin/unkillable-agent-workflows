import { test, expect } from '@playwright/test';
test('navigation fits mobile/tablet widths and switches to the sidebar at 1024px', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill('step8@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('step8-local-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.goto('/moderation');
  const header = page.getByTestId('mobile-header');
  for (const width of [320, 375, 640, 768, 1023]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(header).toBeVisible();
    const open = header.getByRole('button', {
      name: 'Open navigation',
      exact: true,
    });
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    const brand = await header
      .getByRole('link', { name: /unkillable/ })
      .boundingBox();
    const button = await open.boundingBox();
    expect(brand).toBeTruthy();
    expect(button).toBeTruthy();
    expect(Math.abs(brand!.y - button!.y)).toBeLessThan(4);
    expect(button!.x + button!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await open.click();
    await expect(
      header.getByRole('link', { name: /Moderation/ }),
    ).toBeVisible();
    await expect(
      header.getByRole('button', { name: 'Sign out', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 375)
      await page.screenshot({ path: 'screenshots/mobile-navigation-open.png' });
    await page.keyboard.press('Escape');
    await expect(
      header.getByRole('button', { name: 'Open navigation' }),
    ).toBeFocused();
    if (width === 375)
      await page.screenshot({
        path: 'screenshots/mobile-navigation-closed.png',
      });
  }
  await header.getByRole('button', { name: 'Open navigation' }).click();
  await header.getByRole('link', { name: /Policies/ }).click();
  await expect(page).toHaveURL(/\/policies$/);
  await expect(
    header.getByRole('button', { name: 'Open navigation' }),
  ).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(header).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
});
