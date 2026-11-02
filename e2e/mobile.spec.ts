import { test, expect } from '@playwright/test';
import { signIn } from './helpers.ts';

test('mobile layout: top bar, slide-over tree, bottom-sheet drawer', async ({ page }) => {
  await signIn(page, '/p/welcome/format-tour.md');
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.locator('.rail')).toBeHidden();
  await page.getByLabel('Open navigation').click();
  await expect(page.locator('.sidebar[data-open="true"]')).toBeVisible();
  await page.getByRole('treeitem', { name: 'Architecture' }).click();
  await expect(page).toHaveURL(/architecture\/index\.md/);
  await page.goto('/p/welcome/format-tour.md');
  await page.getByRole('button', { name: 'Field reference' }).click();
  const panel = page.getByRole('dialog', { name: 'Field reference' });
  const box = await panel.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(389);
  const vw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(vw).toBeLessThanOrEqual(390);
});
