import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { buildVaultContext, isPagePath, type RepoFile, type VaultContext } from '@nitrogen/core';

const SKIP = new Set(['.git', 'node_modules']);

/** List every file under root (POSIX relative paths). */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export interface LoadedVault {
  root: string;
  files: RepoFile[];
  ctx: VaultContext;
  pages: { path: string; content: string }[];
}

export function loadVault(root: string): LoadedVault {
  const paths = listFiles(root);
  const files: RepoFile[] = paths.map((p) =>
    p.endsWith('.md') || p.endsWith('.yml') || p.endsWith('.yaml') ? { path: p, content: readFileSync(join(root, p), 'utf8') } : { path: p },
  );
  const ctx = buildVaultContext(files);
  const pages = files.filter((f) => f.content !== undefined && isPagePath(f.path, ctx.config)) as { path: string; content: string }[];
  return { root, files, ctx, pages };
}
