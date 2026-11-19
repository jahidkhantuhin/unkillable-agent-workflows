import { test as base, expect, type BrowserContext } from '@playwright/test';
type SignedInState = Awaited<ReturnType<BrowserContext['storageState']>>;
// One real UI login per worker; isolated contexts reuse its session without
// racing the production sign-in rate limit as more feature cases are added.
export const test = base.extend<object, { signedInState: SignedInState }>({
  signedInState: [
    async ({ browser }, use) => {
      const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:3100',
      });
      try {
        const page = await context.newPage();
        await page.goto('/login');
        await page
          .getByLabel('Email', { exact: true })
          .fill('step8@example.test');
        await page
          .getByLabel('Password', { exact: true })
          .fill('step8-local-test-password');
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .click();
        await expect(page).toHaveURL(/\/runs$/);
        const state = await context.storageState();
        await context.close();
        await use(state);
      } finally {
        await context.close();
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ signedInState }, use) => {
    await use(signedInState);
  },
});
export { expect } from '@playwright/test';
