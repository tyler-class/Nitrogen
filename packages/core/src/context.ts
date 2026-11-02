import { parseConfig } from './config.ts';
import { deriveMeta } from './frontmatter.ts';
import { isIgnoredPath, stripSlashes } from './paths.ts';
import { scanPage } from './light/scan.ts';
import type { NitrogenConfig, PageScan, VaultContext, VaultPage } from './types.ts';

export interface RepoFile {
  path: string;
  /** UTF-8 text for markdown files; may be omitted for binary assets. */
  content?: string;
}

export function isPagePath(path: string, config: NitrogenConfig): boolean {
  return path.endsWith('.md') && !isIgnoredPath(path, config.ignore) && !['FORMAT.md', 'CLAUDE.md'].includes(path);
}

export function isAssetPath(path: string, config: NitrogenConfig): boolean {
  const dir = stripSlashes(config.assets_dir);
  return path.startsWith(`${dir}/`) && config.image_formats.some((f) => path.toLowerCase().endsWith(`.${f}`));
}

export function pageFromScan(path: string, scan: PageScan): VaultPage {
  const h1 = scan.headings.find((h) => h.level === 1)?.text;
  const meta = deriveMeta(scan.frontmatter, h1, path);
  return { path, title: meta.title, aliases: meta.aliases, slugs: scan.headings.map((h) => h.slug) };
}

/** Build a VaultContext from repo files (all paths root-relative, no leading slash). */
export function buildVaultContext(files: RepoFile[], configText?: string | null): VaultContext {
  const configFile = files.find((f) => f.path === '.nitrogen/config.yml');
  const { config } = parseConfig(configText ?? configFile?.content ?? null);
  const pages: VaultPage[] = [];
  const images: string[] = [];
  for (const f of files) {
    if (isPagePath(f.path, config) && f.content !== undefined) pages.push(pageFromScan(f.path, scanPage(f.content)));
    else if (isAssetPath(f.path, config)) images.push(f.path);
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  images.sort();
  return { config, pages, images };
}

export function emptyContext(config?: NitrogenConfig): VaultContext {
  return { config: config ?? parseConfig(null).config, pages: [], images: [] };
}
