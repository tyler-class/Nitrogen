// Putting images into pages: placing stored images at a spot in a body, and one-time upload links
// (/u/<token>) that let a person hand an image to an assistant from any device.
import { applyEdits, EditError } from '@shared/edit';
import { pageHref } from '@shared/markdown';
import { describePlacement, placementOp, type Placement } from '@shared/placement';
import type { Page } from '@shared/types';
import { first, nowIso } from './db';
import { ConflictError, requirePage, updatePage } from './pages';
import { MAX_IMAGE_BYTES, storeImage } from './routes/files';
import { ApiError } from './routes/util';
import { indexSoon } from './search';

export const UPLOAD_LINK_MINUTES = 60;

export interface Placed {
  page: Page;
  /** Set when the requested spot was not found and the image went to the end of the page. */
  fallback?: string;
}

/** Inserts `markdown` into a page at `placement`, re-reading on concurrent edits. Never loses the
 * image: if the spot can't be found it goes at the end and `fallback` says why. */
export async function placeImage(
  db: D1Database,
  pageId: string,
  markdown: string,
  placement: Placement | undefined,
): Promise<Placed> {
  for (let attempt = 0; ; attempt++) {
    const cur = await requirePage(db, pageId);
    let body: string;
    let fallback: string | undefined;
    try {
      body = applyEdits(cur.body, [placementOp(placement, markdown)]);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      fallback = e.message;
      body = applyEdits(cur.body, [{ type: 'append', text: markdown }]);
    }
    try {
      const page = await updatePage(
        db,
        pageId,
        { body: body.replace(/\n{3,}/g, '\n\n'), base_version: cur.version },
        { snapshot: true },
      );
      return { page, fallback };
    } catch (e) {
      if (e instanceof ConflictError && attempt < 2) continue;
      throw e;
    }
  }
}

/** Markdown for an image with optional explicit alt text. */
export function withAlt(markdown: string, url: string, alt?: string | null): string {
  return alt?.trim() ? `![${alt.trim().replace(/[[\]\n]/g, ' ')}](${url})` : markdown;
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createUploadLink(
  db: D1Database,
  pageId: string,
  placement: Placement | undefined,
  alt: string | undefined,
): Promise<{ token: string; expires_at: string }> {
  await requirePage(db, pageId);
  const t = token();
  const now = Date.now();
  const expires = new Date(now + UPLOAD_LINK_MINUTES * 60_000).toISOString();
  await db.batch([
    db
      .prepare('DELETE FROM image_uploads WHERE expires_at < ?')
      .bind(new Date(now - 86_400_000).toISOString()),
    db
      .prepare(
        'INSERT INTO image_uploads (token, page_id, placement, alt, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(t, pageId, JSON.stringify(placement ?? {}), alt ?? null, nowIso(), expires),
  ]);
  return { token: t, expires_at: expires };
}

interface UploadRow {
  token: string;
  page_id: string;
  placement: string;
  alt: string | null;
  expires_at: string;
  used_at: string | null;
  file_key: string | null;
  markdown: string | null;
  note: string | null;
}

export type UploadStatus =
  | { state: 'waiting'; page_id: string; expires_at: string }
  | { state: 'done'; page_id: string; markdown: string; note: string | null }
  | { state: 'uploading'; page_id: string }
  | { state: 'expired'; page_id: string }
  | { state: 'unknown' };

export async function uploadStatus(db: D1Database, t: string): Promise<UploadStatus> {
  const row = await first<UploadRow>(db, 'SELECT * FROM image_uploads WHERE token = ?', t);
  if (!row) return { state: 'unknown' };
  if (row.markdown)
    return { state: 'done', page_id: row.page_id, markdown: row.markdown, note: row.note };
  if (row.used_at) return { state: 'uploading', page_id: row.page_id };
  if (row.expires_at < nowIso()) return { state: 'expired', page_id: row.page_id };
  return { state: 'waiting', page_id: row.page_id, expires_at: row.expires_at };
}

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function html(body: string, nonce: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

function page(
  opts: { title: string; message: string; placement?: string; active: boolean },
  nonce: string,
) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Add an image · Nitrogen</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#fff;--ink:#17191c;--soft:#5f6672;--line:#e6e7e4;--accent:#2b6e55;--tint:#e8f2ed;--danger:#a33a32;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--ink:#e8e9e6;--soft:#a7adb6;--line:#2c3036;--accent:#6cc3a0;--tint:#1d3329;--danger:#f08a80;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;padding:24px 16px}
main{width:100%;max-width:420px;display:flex;flex-direction:column;gap:14px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}p{margin:0;color:var(--soft);font-size:15px}strong{color:var(--ink)}
.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:180px;border:2px dashed var(--line);border-radius:14px;padding:20px;text-align:center;cursor:pointer;color:var(--soft)}
.drop.over{border-color:var(--accent);background:var(--tint)}
.drop img{max-width:100%;max-height:220px;border-radius:8px}
button{font:inherit;border:0;border-radius:999px;padding:11px 18px;background:var(--accent);color:var(--bg);font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.err{color:var(--danger)}.ok{color:var(--accent);font-weight:600}
a{color:var(--accent)}
</style></head><body><main>
<img src="/favicon.svg" alt="" width="40" height="40">
<h1>Add an image to “${esc(opts.title)}”</h1>
<p>${esc(opts.message)}</p>
${
  opts.active
    ? `${opts.placement ? `<p>It will go <strong>${esc(opts.placement)}</strong>.</p>` : ''}
<label class="drop" id="drop"><span id="hint">Tap to choose a photo, or drop or paste one here</span><img id="prev" alt="" hidden>
<input id="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden></label>
<button id="go" disabled>Upload</button>
<p id="msg" role="status"></p>
<script nonce="${nonce}">
const $=id=>document.getElementById(id),drop=$('drop'),input=$('file'),go=$('go'),msg=$('msg'),hint=$('hint'),prev=$('prev');
let file=null;
function pick(f){if(!f||!/^image\\//.test(f.type)){msg.textContent='Choose a PNG, JPEG, GIF, WebP or AVIF image.';msg.className='err';return}
file=f;go.disabled=false;msg.textContent='';msg.className='';prev.src=URL.createObjectURL(f);prev.hidden=false;hint.hidden=true;}
input.addEventListener('change',()=>pick(input.files[0]));
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over')});
drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');pick(e.dataTransfer.files[0])});
document.addEventListener('paste',e=>{const f=[...e.clipboardData.files][0];if(f)pick(f)});
go.addEventListener('click',async()=>{if(!file)return;go.disabled=true;msg.className='';msg.textContent='Uploading…';
try{const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':file.type,'X-File-Name':encodeURIComponent(file.name||'image')},body:file});
const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Upload failed.');
msg.className='ok';msg.textContent=d.message;const a=document.createElement('a');a.href=d.page_url;a.textContent='Open the page';msg.after(a);
}catch(e){msg.className='err';msg.textContent=e.message;go.disabled=false}});
</script>`
    : ''
}
</main></body></html>`;
}

/** GET/POST /u/<token>. The unguessable, single-use, short-lived token is the credential. */
export async function handleUploadLink(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const nonce = token();
  const t = new URL(request.url).pathname.slice('/u/'.length);
  const row = /^[A-Za-z0-9_-]{20,64}$/.test(t)
    ? await first<UploadRow>(env.DB, 'SELECT * FROM image_uploads WHERE token = ?', t)
    : null;
  const pageRow = row
    ? await first<{ title: string }>(env.DB, 'SELECT title FROM pages WHERE id = ?', row.page_id)
    : null;
  const json = (status: number, body: Record<string, unknown>) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (!row || !pageRow)
      return html(
        page(
          { title: 'Nitrogen', message: 'This upload link is not valid.', active: false },
          nonce,
        ),
        nonce,
        404,
      );
    if (row.markdown || row.used_at)
      return html(
        page(
          {
            title: pageRow.title,
            message: 'This link was already used. Ask for a new one to add another image.',
            active: false,
          },
          nonce,
        ),
        nonce,
        410,
      );
    if (row.expires_at < nowIso())
      return html(
        page(
          {
            title: pageRow.title,
            message: 'This link has expired. Ask for a new one.',
            active: false,
          },
          nonce,
        ),
        nonce,
        410,
      );
    const placement = JSON.parse(row.placement) as Placement;
    return html(
      page(
        {
          title: pageRow.title,
          message:
            'Your assistant asked for an image. It is stored in your wiki and placed in the page.',
          placement: describePlacement(placement),
          active: true,
        },
        nonce,
      ),
      nonce,
    );
  }
  if (request.method !== 'POST') return json(405, { error: 'method', message: 'Use GET or POST.' });
  if (!row || !pageRow)
    return json(404, { error: 'not_found', message: 'This upload link is not valid.' });

  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host)
    return json(403, { error: 'forbidden', message: 'Cross-site upload blocked.' });
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_IMAGE_BYTES)
    return json(413, { error: 'too_large', message: 'Images can be 15 MB at most.' });

  // Claim the link atomically so it can only ever be used once.
  const claim = await env.DB.prepare(
    'UPDATE image_uploads SET used_at = ? WHERE token = ? AND used_at IS NULL AND expires_at > ?',
  )
    .bind(nowIso(), t, nowIso())
    .run();
  if (!claim.meta.changes)
    return json(410, { error: 'gone', message: 'This link was already used or has expired.' });

  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    let name = 'image';
    try {
      name = decodeURIComponent(request.headers.get('X-File-Name') ?? 'image');
    } catch {
      /* keep the default */
    }
    const file = await storeImage(env, bytes, row.alt || name, row.page_id);
    const markdown = withAlt(file.markdown, file.url, row.alt);
    const placement = JSON.parse(row.placement) as Placement;
    const placed = await placeImage(env.DB, row.page_id, markdown, placement);
    const note = placed.fallback
      ? `Couldn’t find the requested spot (${placed.fallback}); added at the end of the page instead.`
      : null;
    await env.DB.prepare(
      'UPDATE image_uploads SET file_key = ?, markdown = ?, note = ? WHERE token = ?',
    )
      .bind(file.key, markdown, note, t)
      .run();
    indexSoon(env, ctx);
    return json(201, {
      ok: true,
      markdown,
      page_url: pageHref(placed.page.id, placed.page.title),
      message: note ?? `Added ${describePlacement(placement)} in “${placed.page.title}”.`,
    });
  } catch (e) {
    // Give the link back so the person can try again with another file.
    await env.DB.prepare(
      'UPDATE image_uploads SET used_at = NULL WHERE token = ? AND markdown IS NULL',
    )
      .bind(t)
      .run();
    if (e instanceof ApiError) return json(e.status, { error: e.code, message: e.message });
    throw e;
  }
}
