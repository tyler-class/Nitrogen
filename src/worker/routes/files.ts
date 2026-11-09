// Images. Uploads go to R2 under img/<id>.<ext>; page bodies reference them as /files/<key>,
// which the Worker serves to signed-in viewers only.
import { Hono } from 'hono';
import { imageMarkdown } from '@shared/markdown';
import type { UploadedFile } from '@shared/types';
import { requestSignedIn } from '../auth';
import { all, chunks, first, getSetting, marks, newId, nowIso, setSettingStmt } from '../db';
import { ApiError, type AppEnv } from './util';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
} as const;
type ImageType = keyof typeof TYPES;

/** The real type from the file's first bytes. SVG and anything unknown are refused. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, j) => bytes[i + j] === b);
  const ascii = (i: number, s: string) => at(i, ...[...s].map((ch) => ch.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif';
  return null;
}

export function fileUrl(key: string): string {
  return `/files/${key}`;
}

/** Stores an image and records it. Shared by the upload route and the MCP add_image tool. */
export async function storeImage(
  env: Cloudflare.Env,
  bytes: Uint8Array,
  name: string,
  pageId: string | null,
): Promise<UploadedFile> {
  if (!bytes.byteLength) throw new ApiError(400, 'invalid', 'The image is empty.');
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new ApiError(413, 'too_large', 'Images can be 15 MB at most.');
  const type = sniffImage(bytes);
  if (!type) throw new ApiError(415, 'unsupported', 'Use a PNG, JPEG, GIF, WebP or AVIF image.');
  if (pageId && !(await first(env.DB, 'SELECT 1 FROM pages WHERE id = ?', pageId)))
    throw new ApiError(400, 'invalid', 'That page does not exist.');

  const key = `img/${newId()}.${TYPES[type]}`;
  const cleanName =
    name
      .replace(/[\\/\0\n\r]/g, ' ')
      .trim()
      .slice(0, 200) || `image.${TYPES[type]}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: type, cacheControl: 'private, max-age=31536000, immutable' },
    customMetadata: { name: cleanName },
  });
  await env.DB.prepare(
    'INSERT INTO files (key, page_id, name, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(key, pageId, cleanName, type, bytes.byteLength, nowIso())
    .run();
  const url = fileUrl(key);
  return {
    key,
    url,
    name: cleanName,
    content_type: type,
    size: bytes.byteLength,
    markdown: imageMarkdown(url, cleanName),
  };
}

export async function deleteFiles(env: Cloudflare.Env, keys: string[]): Promise<void> {
  for (const part of chunks(keys, 900)) if (part.length) await env.FILES.delete(part);
}

export const files = new Hono<AppEnv>();

// Raw body upload: Content-Type image/*, optional X-File-Name (URI-encoded) and ?page_id=.
files.post('/files', async (c) => {
  const declared = Number(c.req.header('Content-Length') ?? 0);
  if (declared > MAX_IMAGE_BYTES)
    throw new ApiError(413, 'too_large', 'Images can be 15 MB at most.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  let name = 'image';
  try {
    name = decodeURIComponent(c.req.header('X-File-Name') ?? 'image');
  } catch {
    /* keep the default */
  }
  const out = await storeImage(c.env, bytes, name, c.req.query('page_id') || null);
  return c.json(out, 201);
});

/** How long a new image is safe from cleanup: its page may not be saved yet. */
export const UNUSED_GRACE_MS = 60 * 60 * 1000;
/** Images checked per cleanup run; a cursor walks the rest on later runs. */
const CLEANUP_BATCH = 200;

/**
 * Deletes images nothing points at any more: not a page, not a saved version in page history,
 * not an upload that's still being placed. Images newer than an hour are left alone. Runs from
 * the scheduled handler; checks a batch per run and picks up where it left off. Never throws.
 */
export async function purgeUnusedFiles(env: Cloudflare.Env, now = Date.now()): Promise<number> {
  try {
    const db = env.DB;
    const cutoff = new Date(now - UNUSED_GRACE_MS).toISOString();
    const cursor = (await getSetting(db, 'files_cleanup_cursor')) ?? '';
    let batch = await all<{ key: string }>(
      db,
      'SELECT key FROM files WHERE created_at < ? AND key > ? ORDER BY key LIMIT ?',
      cutoff,
      cursor,
      CLEANUP_BATCH,
    );
    // Reached the end: start again from the beginning next time.
    if (!batch.length && cursor) {
      await setSettingStmt(db, 'files_cleanup_cursor', null).run();
      batch = await all<{ key: string }>(
        db,
        'SELECT key FROM files WHERE created_at < ? ORDER BY key LIMIT ?',
        cutoff,
        CLEANUP_BATCH,
      );
    }
    if (!batch.length) return 0;
    const unused: string[] = [];
    for (const { key } of batch) {
      const url = fileUrl(key);
      const used = await first(
        db,
        `SELECT 1 FROM pages WHERE instr(body, ?1) > 0
         UNION ALL SELECT 1 FROM page_revisions WHERE instr(body, ?1) > 0
         UNION ALL SELECT 1 FROM image_uploads WHERE file_key = ?2
         LIMIT 1`,
        url,
        key,
      );
      if (!used) unused.push(key);
    }
    await deleteFiles(env, unused);
    for (const part of chunks(unused))
      await db
        .prepare(`DELETE FROM files WHERE key IN (${marks(part.length)})`)
        .bind(...part)
        .run();
    await setSettingStmt(
      db,
      'files_cleanup_cursor',
      batch.length < CLEANUP_BATCH ? null : batch[batch.length - 1]!.key,
    ).run();
    if (unused.length) console.log(`images: removed ${unused.length} no page uses`);
    return unused.length;
  } catch (e) {
    console.warn('image cleanup skipped:', e instanceof Error ? e.message : e);
    return 0;
  }
}

/** GET /files/<key>: streams an image from R2 to a signed-in viewer. */
export async function serveFile(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', { status: 405 });
  if (!(await requestSignedIn(request, env)))
    return new Response('Sign in first.', { status: 401 });
  const key = decodeURIComponent(new URL(request.url).pathname.slice('/files/'.length));
  if (!/^img\/[a-z0-9]+\.(png|jpg|gif|webp|avif)$/.test(key))
    return new Response('Not found', { status: 404 });

  const obj = await env.FILES.get(key, { onlyIf: request.headers });
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  // Images only: nothing in them may run script or load anything else.
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}
