import { test, expect } from '@playwright/test';
import { head, pushExternal, readRepo, signIn } from './helpers.ts';

test('edit, idle, one bundled commit; wikilinks canonicalized on save', async ({ page }) => {
  await signIn(page, '/edit/guides/images.md');
  const before = await head();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nSee [[Format tour]].\n');
  await expect(page.locator('.sync-pill')).toContainText('queued');
  await expect.poll(head, { timeout: 15_000 }).not.toBe(before);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.prose a[data-page="welcome/format-tour.md"]')).toBeVisible();
  expect(await readRepo(page, 'guides/images.md')).toContain('[Format tour](/welcome/format-tour.md)');
});

test('conflict: clean merge resubmits automatically', async ({ page }) => {
  await signIn(page, '/edit/decisions/index.md');
  await expect(page.locator('.cm-content')).toContainText('Architecture decision records');
  await pushExternal({ 'decisions/index.md': '---\ntitle: Decisions\nicon: scale\norder: 30\n---\n\n# Decisions\n\nArchitecture decision records. The current one is [ADR-004](/decisions/adr-004-direct-commits.md).\n\nRemote line added on a laptop.\n' });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited title line.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Merged with a newer version.')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => readRepo(page, 'decisions/index.md')).toContain('Remote line added on a laptop.');
  expect(await readRepo(page, 'decisions/index.md')).toContain('Edited title line.');
});

test('conflict: overlapping edits open the merge view', async ({ page }) => {
  await signIn(page, '/edit/welcome/index.md');
  await expect(page.locator('.cm-content')).toContainText('This folder introduces Nitrogen');
  await pushExternal({ 'welcome/index.md': '---\ntitle: Welcome\nicon: sparkles\norder: 10\n---\n\n# Welcome\n\nTHEIRS version of the intro.\n' });
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('End');
  await page.keyboard.type(' MINE.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Resolve changes' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('radio', { name: 'Both' }).click();
  await page.getByRole('button', { name: 'Save merge' }).click();
  await expect.poll(() => readRepo(page, 'welcome/index.md'), { timeout: 15_000 }).toContain('THEIRS version');
  expect(await readRepo(page, 'welcome/index.md')).toContain('MINE.');
});

test('offline edit commits after reconnect', async ({ page, context }) => {
  await signIn(page, '/edit/architecture/index.md');
  await expect(page.locator('.cm-content')).toContainText('How Nitrogen fits together');
  await context.setOffline(true);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nWritten in airplane mode.\n');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.sync-pill')).toContainText('Offline');
  const before = await head();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(head, { timeout: 15_000 }).not.toBe(before);
  expect(await readRepo(page, 'architecture/index.md')).toContain('Written in airplane mode.');
});

test('table builder and mermaid templates insert valid blocks', async ({ page }) => {
  await signIn(page, '/new?dir=guides');
  await page.getByLabel('Title').fill('Builder test');
  await page.getByRole('button', { name: 'Create page' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByLabel('Header column 1').fill('Name');
  await page.getByRole('button', { name: 'Insert table' }).click();
  await page.getByRole('button', { name: 'Mermaid' }).click();
  await page.getByRole('button', { name: 'Insert diagram' }).click();
  await expect(page.getByText('0 errors')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Builder test' })).toBeVisible();
  await expect(page.locator('.table-wrap[data-style="zebra"]')).toBeVisible();
  await expect(page.locator('.mermaid-svg svg')).toBeVisible({ timeout: 15_000 });
});

test('activity shows the commit and revert works', async ({ page }) => {
  await signIn(page, '/activity');
  const first = page.locator('.list-plain > li').first();
  await expect(first).toBeVisible();
  page.on('dialog', (d) => void d.accept());
  const before = await head();
  await first.getByRole('button', { name: 'Revert' }).click();
  await expect.poll(head).not.toBe(before);
});

test('export dialog shows the loss ledger and a gfm preview', async ({ page }) => {
  await signIn(page, '/export?path=welcome/format-tour.md');
  await expect(page.getByText(/callout: kept as GFM alert/)).toBeVisible();
  await expect(page.getByLabel('Changes')).toContainText('[!WARNING]');
  await page.getByLabel('Profile').selectOption('commonmark');
  await expect(page.getByLabel('Changes')).toContainText('**Warning: Foldable warning**');
});
