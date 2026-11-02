import { test, expect } from '@playwright/test';

test.skip(!process.env.E2E_BASE_URL, 'set E2E_BASE_URL to run e2e against a running Worker');

test('app shell loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Nitrogen/);
});
