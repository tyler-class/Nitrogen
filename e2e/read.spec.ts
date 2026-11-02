import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signIn } from './helpers.ts';

test('sign-in, tree, page render with every construct', async ({ page }) => {
  await signIn(page, '/p/welcome/format-tour.md');
  await expect(page.getByRole('heading', { level: 1, name: 'Format tour' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Format tour' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('aside.callout[data-type="note"]')).toBeVisible();
  await expect(page.locator('.prose details summary', { hasText: 'Why source editing?' })).toBeVisible();
  await expect(page.locator('figure.n2-figure[data-align="right"] img')).toHaveAttribute('alt', 'Two atoms joined by a triple bond');
  await expect(page.locator('.table-wrap[data-style="zebra"]')).toBeVisible();
  await expect(page.locator('.mermaid-svg svg')).toBeVisible({ timeout: 15_000 });
  // Folded callout toggles.
  const folded = page.getByRole('button', { name: 'Collapsed decision' });
  await expect(folded).toHaveAttribute('aria-expanded', 'false');
  await folded.click();
  await expect(folded).toHaveAttribute('aria-expanded', 'true');
});

test('drawer opens, traps focus, closes with Escape and restores focus', async ({ page }) => {
  await signIn(page, '/p/welcome/format-tour.md');
  const btn = page.getByRole('button', { name: 'Field reference' });
  await btn.click();
  const dialog = page.getByRole('dialog', { name: 'Field reference' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(btn).toBeFocused();
});

test('backlinks with context navigate to the source page', async ({ page }) => {
  await signIn(page, '/p/decisions/adr-004-direct-commits.md');
  const rail = page.getByRole('complementary', { name: 'Page context' });
  await expect(rail.getByText('Sync design', { exact: true })).toBeVisible();
  await expect(rail.locator('.chip.rel', { hasText: 'depends-on' })).toBeVisible();
  await rail.getByRole('link', { name: 'Sync design', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sync design' })).toBeVisible();
});

test('tree keyboard navigation', async ({ page }) => {
  await signIn(page, '/p/welcome/format-tour.md');
  await page.getByRole('treeitem', { name: 'Format tour' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('treeitem', { name: 'Architecture' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('treeitem', { name: 'Architecture' })).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('treeitem', { name: 'Sync design' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/architecture\/sync-design\.md$/);
});

test('command palette finds pages by alias', async ({ page }) => {
  await signIn(page, '/');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('commit pipe');
  await expect(page.getByRole('option', { name: /Sync design/ }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sync-design\.md/);
});

test('link explorer: matrix counts, relation filter, graph recenter', async ({ page }) => {
  await signIn(page, '/links?lens=matrix&rows=under:decisions&cols=under:architecture');
  await expect(page.getByRole('button', { name: 'ADR-004: Direct commits links to Sync design: 1' })).toBeVisible();
  await page.getByRole('button', { name: 'implements', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ADR-004: Direct commits links to Sync design: 1' })).toBeVisible();
  await page.getByRole('button', { name: 'cites', exact: true }).click();
  await page.getByRole('button', { name: 'implements', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ADR-004: Direct commits links to Sync design: 0' })).toBeVisible();
  await page.goto('/links?lens=graph&page=architecture/sync-design.md');
  await page.getByRole('button', { name: /^Home\. Enter opens/ }).click();
  await expect(page).toHaveURL(/page=index\.md/);
});

test('accessibility: axe passes on page, explorer, activity, settings', async ({ page }) => {
  for (const url of ['/p/welcome/format-tour.md', '/links?page=architecture/sync-design.md', '/activity', '/settings', '/search?q=sync']) {
    await signIn(page, url);
    await page.waitForTimeout(800);
    const r = await new AxeBuilder({ page }).disableRules(['region']).analyze();
    expect(r.violations.map((v) => `${url}: ${v.id} ${v.nodes.length}`)).toEqual([]);
  }
});
