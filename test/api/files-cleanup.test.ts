import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeUnusedFiles, UNUSED_GRACE_MS } from '../../src/worker/routes/files';

const NOW = Date.parse('2027-03-01T12:00:00Z');
const old = new Date(NOW - UNUSED_GRACE_MS - 60_000).toISOString();
const fresh = new Date(NOW - 5 * 60_000).toISOString();

async function file(key: string, createdAt: string) {
  await env.FILES.put(key, 'img');
  await env.DB.prepare(
    'INSERT INTO files (key, page_id, name, content_type, size, created_at) VALUES (?, NULL, ?, ?, 3, ?)',
  )
    .bind(key, 'x.png', 'image/png', createdAt)
    .run();
}
const exists = async (key: string) =>
  !!(await env.FILES.head(key)) &&
  !!(await env.DB.prepare('SELECT 1 FROM files WHERE key = ?').bind(key).first());

describe('unused image cleanup', () => {
  it('removes images nothing uses, and keeps new ones and ones a page or its history uses', async () => {
    await file('img/gone.png', old);
    await file('img/new.png', fresh);
    await file('img/in-history.png', old);
    await file('img/on-page.png', old);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO pages (id, title, body, created_at, updated_at)
         VALUES ('p1', 'Page', 'Now: ![a](/files/img/on-page.png)', ?1, ?1)`,
      ).bind(old),
      env.DB.prepare(
        `INSERT INTO page_revisions (page_id, version, title, body, created_at)
         VALUES ('p1', 1, 'Page', 'Before: ![b](/files/img/in-history.png)', ?)`,
      ).bind(old),
    ]);

    expect(await purgeUnusedFiles(env, NOW)).toBe(1);
    expect(await exists('img/gone.png')).toBe(false);
    expect(await exists('img/new.png')).toBe(true);
    expect(await exists('img/in-history.png')).toBe(true);
    expect(await exists('img/on-page.png')).toBe(true);

    // Once its last version is gone too, the image goes on the next run.
    await env.DB.prepare('DELETE FROM page_revisions WHERE page_id = ?').bind('p1').run();
    expect(await purgeUnusedFiles(env, NOW)).toBe(1);
    expect(await exists('img/in-history.png')).toBe(false);
    expect(await exists('img/on-page.png')).toBe(true);
  });
});
