import { expect, type Page } from '@playwright/test';

export const FAKE = 'http://127.0.0.1:9999';

export async function signIn(page: Page, to = '/'): Promise<void> {
  await page.goto(`/auth/login?return=${encodeURIComponent(to)}`);
  await expect(page.locator('.sidebar .tree').first()).toBeVisible();
}

export async function head(): Promise<string> {
  return (await fetch(`${FAKE}/__head`)).text();
}

export async function pushExternal(files: Record<string, string | null>, message = 'External edit'): Promise<string> {
  const r = await fetch(`${FAKE}/__push`, { method: 'POST', body: JSON.stringify({ files, message }) });
  return r.text();
}

export async function readRepo(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => (await (await fetch(`/api/page?path=${encodeURIComponent(p)}&include=content`)).json()).content as string, path);
}
