import { formatDiagnostic, lintPage, hasErrors, type Diagnostic } from '@nitrogen/core';
import { loadVault } from '../vault.ts';

export interface LintCmdOptions {
  root: string;
  format: 'text' | 'json';
  errorsOnly?: boolean;
}

export function runLint(paths: string[], opts: LintCmdOptions, out: { write(s: string): unknown } = process.stdout): number {
  const v = loadVault(opts.root);
  const wanted = paths.length ? v.pages.filter((p) => paths.some((q) => p.path === q || p.path.startsWith(q.replace(/\/?$/, '/')))) : v.pages;
  const results: { path: string; diagnostics: Diagnostic[] }[] = [];
  for (const p of wanted) {
    let diags = lintPage(p.content, v.ctx, { path: p.path });
    if (opts.errorsOnly) diags = diags.filter((d) => d.severity === 'error');
    results.push({ path: p.path, diagnostics: diags });
  }
  const all = results.flatMap((r) => r.diagnostics);
  if (opts.format === 'json') out.write(`${JSON.stringify(results.filter((r) => r.diagnostics.length), null, 2)}\n`);
  else {
    for (const r of results) for (const d of r.diagnostics) out.write(`${formatDiagnostic(d, r.path)}\n`);
    const e = all.filter((d) => d.severity === 'error').length;
    out.write(`${wanted.length} page(s), ${e} error(s), ${all.length - e} warning(s)\n`);
  }
  return hasErrors(all) ? 1 : 0;
}
