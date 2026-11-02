/**
 * Serve FakeGitHub over HTTP for `wrangler dev` e2e runs:
 *   tsx packages/testing/src/serve.ts --port 9999 --seed examples/notes-repo
 * Control endpoints: POST /__push {"files": {"path": "content" | null}, "message": "..."}, GET /__head
 */
import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FakeGitHub } from './fake-github.ts';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []));
const port = Number(args.port ?? 9999);
const seed = args.seed;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === '.git' || n === 'node_modules') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files: Record<string, string | Uint8Array> = {};
if (seed) for (const f of walk(seed)) files[relative(seed, f).split(sep).join('/')] = new Uint8Array(readFileSync(f));
const fake = new FakeGitHub({ owner: 'octo', repo: 'notes', files: seed ? files : undefined });

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const url = `http://127.0.0.1:${port}${req.url}`;
  if (req.url === '/__head') return void res.end(fake.head());
  if (req.url === '/__push' && req.method === 'POST') {
    const j = JSON.parse(body.toString()) as { files: Record<string, string | null>; message?: string };
    return void res.end(fake.push(j.files, j.message));
  }
  const r = await fake.fetch(url, { method: req.method, headers: req.headers as Record<string, string>, ...(body.length ? { body } : {}) });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`fake github on http://127.0.0.1:${port} (${Object.keys(files).length} files)`));
