import { resolveLink, resolveWikilink } from './resolve.ts';
import { checkPagePath, isKebabFileName, kebabSuggestion, basename, splitHash, stripSlashes, isExternal } from './paths.ts';
import {
  CALLOUT_TYPES,
  htmlProblem,
  parseImageFragment,
  splitImageSrc,
  suggestCallout,
  validateTableDirective,
} from './syntax.ts';
import { slugify } from './slug.ts';
import type { Diagnostic, LintCode, PageScan, VaultContext } from './types.ts';

export interface LintOptions {
  /** Root-relative path of the page (enables W105 and relative link resolution). */
  path?: string;
}

const SEVERITY = (code: LintCode) => (code.startsWith('E') ? 'error' : 'warning') as Diagnostic['severity'];

function diag(code: LintCode, line: number, col: number, message: string, fix?: string): Diagnostic {
  const d: Diagnostic = { code, severity: SEVERITY(code), message, line, col };
  if (fix) d.fix = fix;
  return d;
}

/** Lint a scanned page. Pure: identical for the full parser and the light scanner. */
export function lintScan(scan: PageScan, src: string, ctx: VaultContext | null, opts: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const path = opts.path ?? 'untitled.md';
  const config = ctx?.config;

  for (const e of scan.frontmatter.errors)
    out.push(diag('E001', e.line, 1, `Frontmatter: ${e.message}`, 'Use flat `key: value` lines; lists as [a, b].'));

  for (const c of scan.callouts)
    if (!CALLOUT_TYPES.includes(c.type)) {
      const s = suggestCallout(c.type);
      out.push(diag('E002', c.line, 1, `Unknown callout type "${c.type}".`, `Use [!${s}] (closest match) or one of: ${CALLOUT_TYPES.join(', ')}.`));
    }

  for (const d of scan.drawers) {
    if (d.parent === 'drawer') out.push(diag('E003', d.line, 1, 'Drawers cannot nest.', 'Move this drawer out of the enclosing drawer.'));
    else if (!['root', 'callout', 'toggle'].includes(d.parent))
      out.push(diag('E003', d.line, 1, `Drawers are not allowed inside a ${d.parent === 'other' ? 'table, footnote or other container' : d.parent}.`, 'Place drawers at the top level, inside a callout, or inside a toggle.'));
    if (!d.attrs.title || !d.attrs.title.trim())
      out.push(diag('E004', d.line, 1, 'Drawer is missing a title.', 'Write :::drawer{title="Short label"}.'));
  }

  for (const img of scan.images) {
    if (!img.alt.trim())
      out.push(diag('E005', img.line, img.col, 'Image missing alt text.', 'Add alt text inside the brackets: ![What the image shows](...).'));
    const { path: p, fragment } = splitImageSrc(img.src);
    for (const err of parseImageFragment(fragment).errors) out.push(diag('E006', img.line, img.col, `Image fragment: ${err}`));
    if (isExternal(p)) {
      out.push(diag('W103', img.line, img.col, `External image "${p}" is blocked in v1.`, 'Upload the image to the repo instead.'));
      continue;
    }
    const r = resolveLink(p, path, ctx);
    if (r.kind === 'invalid') out.push(diag('W103', img.line, img.col, `Image path: ${r.reason}`));
    else if (r.kind === 'asset' || r.kind === 'page') {
      const dir = stripSlashes(config?.assets_dir ?? 'images');
      if (!r.path.startsWith(`${dir}/`))
        out.push(diag('W103', img.line, img.col, `Image "${p}" is outside /${dir}/.`, `Store images under /${dir}/.`));
      else if (ctx && !ctx.images.includes(r.path))
        out.push(diag('W103', img.line, img.col, `Image not found: /${r.path}.`, 'Check the path or upload the image.'));
    }
  }

  for (const t of scan.tableDirectives)
    for (const err of validateTableDirective(t.attrs, t.columns)) out.push(diag('E007', t.line, 1, `Table directive: ${err}`));

  for (const h of scan.html) {
    if (h.closing) continue;
    if (h.tag === '!--') continue;
    const problem = htmlProblem(h.tag, h.attrs);
    if (problem) out.push(diag('E008', h.line, h.col, problem));
  }

  const relations = config?.link_relations ?? null;
  const ownSlugs = new Set(scan.headings.map((h) => h.slug));
  for (const l of scan.links) {
    if (l.external) continue;
    if (l.relExplicit && relations && !relations.includes(l.rel))
      out.push(diag('W107', l.line, l.col, `Unknown link relation "rel:${l.rel}".`, `Use one of: ${relations.join(', ')}.`));
    const r = resolveLink(l.href, path, ctx);
    if (r.kind === 'invalid') {
      out.push(diag('W101', l.line, l.col, `Broken link "${l.href}": ${r.reason}`));
      continue;
    }
    if (r.kind === 'self') {
      if (!ownSlugs.has(r.anchor)) out.push(diag('W102', l.line, l.col, `Anchor #${r.anchor} not found on this page.`));
      continue;
    }
    if (!ctx) continue;
    if (r.kind === 'page') {
      if (!r.exists) {
        out.push(diag('W101', l.line, l.col, `Broken link: /${r.path} does not exist.`, 'Create the page or fix the path.'));
        continue;
      }
      if (r.anchor) {
        const target = r.path === path ? { slugs: [...ownSlugs] } : ctx.pages.find((p) => p.path === r.path);
        if (target?.slugs && !target.slugs.includes(r.anchor))
          out.push(diag('W102', l.line, l.col, `Anchor #${r.anchor} not found in /${r.path}.`));
      }
    } else if (r.kind === 'asset' && !r.exists) {
      out.push(diag('W101', l.line, l.col, `Broken link: /${r.path} does not exist.`));
    }
  }

  for (const w of scan.wikilinks) {
    if (!ctx) {
      out.push(diag('W104', w.line, w.col, `Wikilink ${w.raw} cannot be resolved without the vault.`));
      continue;
    }
    const r = resolveWikilink(w.target, ctx);
    if (r.status === 'missing')
      out.push(diag('W104', w.line, w.col, `Unresolved wikilink ${w.raw}.`, 'Create the page, or link with [Title](/path.md).'));
    else if (r.status === 'ambiguous')
      out.push(diag('W104', w.line, w.col, `Ambiguous wikilink ${w.raw}: matches ${r.candidates.map((c) => `/${c.path}`).join(', ')}.`, 'Use the path form [[folder/page]].'));
  }

  if (opts.path && !isKebabFileName(opts.path) && basename(opts.path) !== 'index.md')
    out.push(diag('W105', 0, 0, `File name "${basename(opts.path)}" is not kebab-case.`, `Rename to ${kebabSuggestion(opts.path)}.`));

  const seen = new Map<string, number>();
  for (const h of scan.headings) {
    const s = slugify(h.text);
    if (seen.has(s))
      out.push(diag('W106', h.line, 1, `Heading "${h.text}" repeats the slug #${s} (first used on line ${seen.get(s)}).`, 'Rename one of the headings so anchors stay stable.'));
    else seen.set(s, h.line);
  }

  const kb = config?.page_size_warn_kb ?? 200;
  const size = new TextEncoder().encode(src).length;
  if (size > kb * 1024) out.push(diag('W108', 0, 0, `Page is ${Math.round(size / 1024)} KB (warning above ${kb} KB).`, 'Split it into subpages.'));

  if (scan.headings.length > 0) {
    const first = scan.headings[0]!;
    if (first.level !== 1) out.push(diag('W109', first.line, 1, 'The first heading is not an H1.', 'Start the page with a single # Title.'));
    const h1s = scan.headings.filter((h) => h.level === 1);
    for (const h of h1s.slice(1)) out.push(diag('W109', h.line, 1, 'The page has more than one H1.', 'Use ## for sections.'));
  }

  for (const t of scan.toggles)
    if (t.missingBlankLines)
      out.push(diag('W110', t.line, 1, 'Toggle body needs blank lines after </summary> and before </details>.', 'Add an empty line around the toggle body so markdown inside renders.'));

  return out.sort((a, b) => a.line - b.line || a.col - b.col || a.code.localeCompare(b.code));
}

export function hasErrors(diags: Diagnostic[]): boolean {
  return diags.some((d) => d.severity === 'error');
}

/** Write-time checks: E009 (path) and E010 (locked). */
export function checkWrite(path: string, existing: PageScan | null, ctx: VaultContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const pc = checkPagePath(path, ctx.config.ignore);
  if (!pc.ok) out.push(diag('E009', 0, 0, `Cannot write ${path}: ${pc.reason}`));
  if (existing && existing.frontmatter.data.locked === true)
    out.push(diag('E010', 0, 0, `${path} is locked (locked: true).`, 'Ask the owner to unlock the page in the web app.'));
  return out;
}

export function formatDiagnostic(d: Diagnostic, file?: string): string {
  const loc = d.line > 0 ? `${d.line}:${d.col || 1}` : '';
  const where = [file, loc].filter(Boolean).join(':');
  return `${where ? `${where} ` : ''}${d.code} ${d.message}${d.fix ? ` ${d.fix}` : ''}`;
}

export { splitHash };
