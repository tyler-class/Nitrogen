import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exportPages, normalize, summarizeLedger, type Profile } from '@nitrogen/core';
import { loadVault } from '../vault.ts';

export interface ExportCmdOptions {
  root: string;
  out: string;
  profile: Profile;
  path?: string;
  keepImageSize?: boolean;
  frontmatter?: 'keep' | 'strip' | 'inline';
  captions?: 'title' | 'visible';
  images?: boolean;
}

export function runExport(opts: ExportCmdOptions, log: (s: string) => void = (s) => void process.stdout.write(`${s}\n`)): number {
  const v = loadVault(opts.root);
  const prefix = opts.path?.replace(/^\/+/, '');
  const pages = prefix ? v.pages.filter((p) => p.path === prefix || p.path.startsWith(prefix.replace(/\/?$/, '/'))) : v.pages;
  if (pages.length === 0) {
    log(`No pages match ${opts.path ?? 'the vault'}.`);
    return 1;
  }
  const r = exportPages(pages, v.ctx, {
    profile: opts.profile,
    ...(opts.frontmatter ? { frontmatter: opts.frontmatter } : {}),
    ...(opts.keepImageSize ? { keepImageSize: true } : {}),
    ...(opts.captions ? { captions: opts.captions } : {}),
    includeImages: opts.images !== false,
  });
  for (const f of r.files) {
    const dest = join(opts.out, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
  let missing = 0;
  for (const a of r.assets) {
    const dest = join(opts.out, a.to);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      copyFileSync(join(opts.root, a.from), dest);
    } catch {
      missing++;
    }
  }
  const ledger = r.ledger.flatMap((l) => l.entries);
  log(`Exported ${r.files.length} page(s) and ${r.assets.length - missing} image(s) to ${opts.out} (${opts.profile}).`);
  if (missing) log(`${missing} referenced image(s) were missing and not copied.`);
  if (ledger.length) log(summarizeLedger(ledger));
  return 0;
}

export function runNormalize(file: string, opts: { root: string; profile: Profile; frontmatter?: 'keep' | 'strip' | 'inline'; ledger?: boolean }, out: { write(s: string): unknown } = process.stdout): number {
  const v = loadVault(opts.root);
  const rel = file.replace(/^\.\//, '');
  const content = readFileSync(join(opts.root, rel), 'utf8');
  const res = normalize(content, opts.profile, v.ctx, { path: rel, ...(opts.frontmatter ? { frontmatter: opts.frontmatter } : {}) });
  out.write(res.src);
  if (opts.ledger) process.stderr.write(`${summarizeLedger(res.ledger)}\n`);
  return 0;
}
