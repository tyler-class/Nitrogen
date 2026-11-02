import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractIndexRows, isAssetPath, type IndexRows } from '@nitrogen/core';
import { loadVault } from '../vault.ts';
import { gitBlobSha } from '../git.ts';

export interface IngestBatch {
  head: string | null;
  mode: 'full';
  batch: number;
  of: number;
  /** All page paths in the repo (sent with every batch so the server can prune deletions on the last). */
  allPaths: string[];
  pages: Omit<IndexRows, 'meta'>[];
  /** Sent with the first batch: raw .nitrogen/config.yml and the asset list. */
  config?: string | null;
  assets?: { path: string; sha: string; size: number }[];
}

export function buildIndex(root: string): { head: string | null; rows: Omit<IndexRows, 'meta'>[]; config: string | null; assets: { path: string; sha: string; size: number }[] } {
  const v = loadVault(root);
  const config = v.files.find((f) => f.path === '.nitrogen/config.yml')?.content ?? null;
  const assets = v.files
    .filter((f) => isAssetPath(f.path, v.ctx.config))
    .map((f) => {
      const bytes = readFileSync(join(root, f.path));
      return { path: f.path, sha: gitBlobSha(bytes), size: bytes.length };
    });
  let head: string | null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    head = null;
  }
  const rows = v.pages.map((p) => {
    const { meta: _meta, ...rest } = extractIndexRows(p.path, p.content, gitBlobSha(p.content), v.ctx);
    return rest;
  });
  return { head, rows, config, assets };
}

/** HMAC signature used by /admin/ingest: hex(HMAC-SHA256(secret, `${timestamp}.${body}`)). */
export function signIngest(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function runIndex(opts: { root: string; out?: string; post?: string; secret?: string; batchSize?: number }, log: (s: string) => void = (s) => void process.stdout.write(`${s}\n`)): Promise<number> {
  const { head, rows, config, assets } = buildIndex(opts.root);
  if (opts.out) {
    writeFileSync(opts.out, `${JSON.stringify({ head, pages: rows }, null, 2)}\n`);
    log(`Wrote ${rows.length} page row(s) to ${opts.out}.`);
  }
  if (opts.post) {
    const secret = opts.secret ?? process.env.NITROGEN_INGEST_SECRET;
    if (!secret) {
      log('Set NITROGEN_INGEST_SECRET (or --secret) to post the index.');
      return 1;
    }
    const size = opts.batchSize ?? 25;
    const of = Math.max(1, Math.ceil(rows.length / size));
    const allPaths = rows.map((r) => r.page.path);
    for (let b = 0; b < of; b++) {
      const batch: IngestBatch = { head, mode: 'full', batch: b + 1, of, allPaths, pages: rows.slice(b * size, (b + 1) * size), ...(b === 0 ? { config, assets } : {}) };
      const body = JSON.stringify(batch);
      const ts = String(Math.floor(Date.now() / 1000));
      const url = `${opts.post.replace(/\/$/, '')}/admin/ingest`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nitrogen-timestamp': ts, 'x-nitrogen-signature': `sha256=${signIngest(secret, ts, body)}` },
        body,
      });
      if (!res.ok) {
        log(`Ingest batch ${b + 1}/${of} failed: ${res.status} ${await res.text()}`);
        return 1;
      }
    }
    log(`Posted ${rows.length} page row(s) in ${of} batch(es) to ${opts.post}.`);
  }
  if (!opts.out && !opts.post) process.stdout.write(`${JSON.stringify({ head, pages: rows }, null, 2)}\n`);
  return 0;
}
