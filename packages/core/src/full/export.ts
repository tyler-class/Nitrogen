import { normalize, type Profile } from './normalize.ts';
import { parsePage } from './parse.ts';
import { resolvePath, splitHash, stripSlashes, isExternal } from '../paths.ts';
import { splitImageSrc } from '../syntax.ts';
import type { LedgerEntry, VaultContext } from '../types.ts';

export interface ExportOptions {
  profile?: Profile;
  frontmatter?: 'keep' | 'strip' | 'inline';
  keepImageSize?: boolean;
  captions?: 'title' | 'visible';
  /** Copy referenced images into `assets/` and rewrite paths (default true). */
  includeImages?: boolean;
}

export interface ExportResult {
  files: { path: string; content: string }[];
  /** Image copies: from repo path to export path. */
  assets: { from: string; to: string }[];
  ledger: { path: string; entries: LedgerEntry[] }[];
}

/** Export pages (path + content) to standard markdown. Pure; the caller writes files. */
export function exportPages(pages: { path: string; content: string }[], ctx: VaultContext | null, opts: ExportOptions = {}): ExportResult {
  const profile = opts.profile ?? ctx?.config.default_profile ?? 'gfm';
  const assetsDir = stripSlashes(ctx?.config.assets_dir ?? 'images');
  const imageMap = new Map<string, string>();
  if (opts.includeImages !== false) {
    for (const p of pages) {
      for (const img of parsePage(p.content).scan.images) {
        const { path } = splitImageSrc(img.src);
        if (isExternal(path)) continue;
        const r = resolvePath(splitHash(path).path, p.path);
        if (!r) continue;
        const rest = r.startsWith(`${assetsDir}/`) ? r.slice(assetsDir.length + 1) : r;
        imageMap.set(r, `assets/${rest}`);
      }
    }
  }
  const files: ExportResult['files'] = [];
  const ledger: ExportResult['ledger'] = [];
  for (const p of pages) {
    const res = normalize(p.content, profile, ctx, {
      path: p.path,
      ...(opts.frontmatter ? { frontmatter: opts.frontmatter } : {}),
      ...(opts.keepImageSize ? { keepImageSize: true } : {}),
      ...(opts.captions ? { captions: opts.captions } : {}),
      imageMap,
    });
    files.push({ path: p.path, content: res.src });
    ledger.push({ path: p.path, entries: res.ledger });
  }
  return { files, assets: [...imageMap.entries()].map(([from, to]) => ({ from, to })), ledger };
}
