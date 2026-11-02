/** Lexical helpers shared by the full parser, the light scanner, lint and normalize. */

export const NATIVE_CALLOUTS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export const EXTENDED_CALLOUTS = [
  'info', 'question', 'success', 'danger', 'example', 'quote', 'decision', 'assumption',
] as const;
export const CALLOUT_TYPES: readonly string[] = [...NATIVE_CALLOUTS, ...EXTENDED_CALLOUTS];

/** `[!type]+ Title` at the start of a blockquote's first line. */
export const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-]?)(?:[ \t]+(.*))?$/;

export function parseCalloutMarker(firstLine: string): { type: string; fold: '' | '+' | '-'; title: string } | null {
  const m = CALLOUT_RE.exec(firstLine.trimEnd());
  if (!m) return null;
  return { type: m[1]!.toLowerCase(), fold: (m[2] ?? '') as '' | '+' | '-', title: (m[3] ?? '').trim() };
}

export function calloutLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
}

/** Closest known callout type, for lint suggestions. */
export function suggestCallout(type: string): string {
  let best = 'note';
  let bestD = Infinity;
  for (const t of CALLOUT_TYPES) {
    const d = levenshtein(type.toLowerCase(), t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

// ---------- wikilinks ----------

export const WIKILINK_RE = /\[\[([^[\]\n|#]*?)(?:#([^[\]\n|]*?))?(?:\|([^[\]\n]*?))?\]\]/g;

export function parseWikilink(raw: string): { target: string; anchor?: string; label?: string } | null {
  const re = new RegExp(WIKILINK_RE.source);
  const m = re.exec(raw);
  if (!m || m.index !== 0 || m[0].length !== raw.length) return null;
  const out: { target: string; anchor?: string; label?: string } = { target: m[1]!.trim() };
  if (m[2] !== undefined && m[2].trim()) out.anchor = m[2].trim();
  if (m[3] !== undefined && m[3].trim()) out.label = m[3].trim();
  if (!out.target && !out.anchor) return null;
  return out;
}

// ---------- link titles ----------

export function parseRel(title: string | undefined | null): { rel: string; explicit: boolean } {
  if (title) {
    const m = /^rel:\s*([A-Za-z][\w-]*)\s*$/.exec(title.trim());
    if (m) return { rel: m[1]!.toLowerCase(), explicit: true };
  }
  return { rel: 'related', explicit: false };
}

// ---------- image fragments ----------

export const IMAGE_KEYS = ['align', 'w', 'h', 'wrap', 'zoom', 'border'] as const;
export type ImageKey = (typeof IMAGE_KEYS)[number];

export interface ImageMeta {
  align: 'left' | 'center' | 'right' | 'full';
  w?: string;
  h?: string;
  wrap: boolean;
  zoom: boolean;
  border: boolean;
}

export function splitImageSrc(src: string): { path: string; fragment: string | null } {
  const i = src.indexOf('#');
  if (i < 0) return { path: src, fragment: null };
  return { path: src.slice(0, i), fragment: src.slice(i + 1) };
}

/** Parse and validate an image URL fragment. Errors are human-readable. */
export function parseImageFragment(fragment: string | null): { meta: ImageMeta; errors: string[]; known: boolean } {
  const meta: ImageMeta = { align: 'center', wrap: true, zoom: true, border: false };
  const errors: string[] = [];
  if (fragment === null || fragment === '') return { meta, errors, known: true };
  let known = true;
  const seen = new Set<string>();
  for (const part of fragment.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeURIComponentSafe(eq < 0 ? part : part.slice(0, eq));
    const val = decodeURIComponentSafe(eq < 0 ? '' : part.slice(eq + 1));
    if (!(IMAGE_KEYS as readonly string[]).includes(key)) {
      errors.push(`Unknown image key "${key}". Use ${IMAGE_KEYS.join(', ')}.`);
      known = false;
      continue;
    }
    if (seen.has(key)) errors.push(`Image key "${key}" is repeated.`);
    seen.add(key);
    switch (key as ImageKey) {
      case 'align':
        if (['left', 'center', 'right', 'full'].includes(val)) meta.align = val as ImageMeta['align'];
        else errors.push(`align must be left, center, right or full (got "${val}").`);
        break;
      case 'w':
        if (/^[1-9]\d{0,4}$/.test(val) || /^([1-9]\d?|100)%$/.test(val)) meta.w = val;
        else errors.push(`w must be pixels like 320 or a percentage like 60% (got "${val}").`);
        break;
      case 'h':
        if (/^[1-9]\d{0,4}$/.test(val)) meta.h = val;
        else errors.push(`h must be pixels like 240 (got "${val}").`);
        break;
      case 'wrap':
      case 'zoom':
      case 'border':
        if (val === 'true' || val === 'false') meta[key as 'wrap' | 'zoom' | 'border'] = val === 'true';
        else errors.push(`${key} must be true or false (got "${val}").`);
        break;
    }
  }
  return { meta, errors, known };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Canonical fragment ordering: keys in IMAGE_KEYS order, unknown keys kept at the end. */
export function canonicalImageFragment(fragment: string): string {
  const parts = fragment.split('&').filter(Boolean);
  const keyOf = (p: string) => p.split('=')[0]!;
  const rank = (p: string) => {
    const i = (IMAGE_KEYS as readonly string[]).indexOf(keyOf(p));
    return i < 0 ? IMAGE_KEYS.length : i;
  };
  return parts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p)
    .join('&');
}

export function formatImageFragment(meta: Partial<ImageMeta>): string {
  const parts: string[] = [];
  if (meta.align && meta.align !== 'center') parts.push(`align=${meta.align}`);
  if (meta.w) parts.push(`w=${meta.w}`);
  if (meta.h) parts.push(`h=${meta.h}`);
  if (meta.wrap === false) parts.push('wrap=false');
  if (meta.zoom === false) parts.push('zoom=false');
  if (meta.border === true) parts.push('border=true');
  return parts.join('&');
}

// ---------- attribute lists ----------

/** Parse `key="v" key='v' key=v #id .class flag` attribute strings (directive and table syntax). */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([#.]?)([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`}]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const [, sigil, name, dq, sq, bare] = m;
    if (sigil === '#') out.id = name!;
    else if (sigil === '.') out.class = out.class ? `${out.class} ${name}` : name!;
    else out[name!] = dq ?? sq ?? bare ?? '';
  }
  return out;
}

// ---------- table directive ----------

export const TABLE_DIRECTIVE_RE = /^<!--\s*nitrogen:table\b([\s\S]*?)-->\s*$/;

export function parseTableDirective(html: string): Record<string, string> | null {
  const m = TABLE_DIRECTIVE_RE.exec(html.trim());
  if (!m) return null;
  return parseAttributes(m[1] ?? '');
}

export function validateTableDirective(attrs: Record<string, string>, columns: number | null): string[] {
  const errs: string[] = [];
  if (columns === null) errs.push('The table directive must be directly above a pipe table (no blank line).');
  const known = ['style', 'header', 'widths', 'caption', 'dense', 'wrap'];
  for (const k of Object.keys(attrs)) if (!known.includes(k)) errs.push(`Unknown table key "${k}".`);
  if (attrs.style !== undefined && !['plain', 'zebra', 'grid'].includes(attrs.style))
    errs.push(`style must be plain, zebra or grid (got "${attrs.style}").`);
  if (attrs.header !== undefined && !['normal', 'sticky'].includes(attrs.header))
    errs.push(`header must be normal or sticky (got "${attrs.header}").`);
  for (const b of ['dense', 'wrap'])
    if (attrs[b] !== undefined && !['true', 'false'].includes(attrs[b]!))
      errs.push(`${b} must be true or false (got "${attrs[b]}").`);
  if (attrs.widths !== undefined) {
    const ws = attrs.widths.split(',').map((x) => x.trim());
    const nums = ws.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n <= 0)) errs.push('widths must be positive integers like 30,20,50.');
    else if (nums.reduce((a, b) => a + b, 0) !== 100) errs.push(`widths must sum to 100 (got ${nums.reduce((a, b) => a + b, 0)}).`);
    if (columns !== null && ws.length !== columns) errs.push(`widths lists ${ws.length} columns but the table has ${columns}.`);
  }
  return errs;
}

// ---------- HTML ----------

export const ALLOWED_HTML = new Set(['details', 'summary', 'br', 'kbd', 'sub', 'sup', '!--']);
export const DANGEROUS_HTML = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form']);

const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;

/** Find HTML tags in a raw HTML string. Offsets are relative to `s`. */
export function findTags(s: string): { tag: string; closing: boolean; index: number; attrs: string[] }[] {
  const out: { tag: string; closing: boolean; index: number; attrs: string[] }[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(s))) {
    if (m[0].startsWith('<!--')) {
      out.push({ tag: '!--', closing: false, index: m.index, attrs: [] });
      continue;
    }
    const attrs = [...(m[3] ?? '').matchAll(/\s+([^\s>/=]+)/g)].map((a) => a[1]!.toLowerCase());
    out.push({ tag: m[2]!.toLowerCase(), closing: m[1] === '/', index: m.index, attrs });
  }
  return out;
}

export function htmlProblem(tag: string, attrs: string[]): string | null {
  if (DANGEROUS_HTML.has(tag)) return `<${tag}> is not allowed.`;
  const on = attrs.find((a) => a.startsWith('on'));
  if (on) return `Event handler attribute "${on}" is not allowed.`;
  if (!ALLOWED_HTML.has(tag))
    return `<${tag}> is not allowed. Only details, summary, br, kbd, sub and sup are kept; use markdown instead.`;
  if (attrs.some((a) => a === 'style' || a === 'href' || a === 'src')) return `Attributes on <${tag}> are not allowed.`;
  return null;
}

/**
 * W110: toggle layout check, line-based so both parser modes share it.
 * Returns toggles with their summary text and whether blank lines are missing.
 */
export function scanToggleLayout(lines: string[], isCodeLine: (i: number) => boolean, stripPrefix: (l: string) => string = (l) => l): { line: number; missing: boolean; summary: string }[] {
  const out: { line: number; missing: boolean; summary: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCodeLine(i)) continue;
    const l = stripPrefix(lines[i]!);
    if (!/^\s{0,3}<details[\s>]/i.test(l)) continue;
    let missing = false;
    let summary = '';
    // Find the summary close.
    let j = i;
    while (j < lines.length && !/<\/summary>/i.test(lines[j]!) && j < i + 5) j++;
    if (j < lines.length && /<\/summary>/i.test(lines[j]!)) {
      const joined = lines.slice(i, j + 1).map(stripPrefix).join('\n');
      const sm = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(joined);
      summary = (sm?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
      const after = stripPrefix(lines[j]!).split(/<\/summary>/i)[1] ?? '';
      if (after.trim() !== '') missing = true;
      const next = lines[j + 1];
      if (next !== undefined && stripPrefix(next).trim() !== '') missing = true;
    } else missing = true;
    // Find the matching close.
    let depth = 0;
    for (let k = i; k < lines.length; k++) {
      if (isCodeLine(k)) continue;
      const lk = stripPrefix(lines[k]!);
      depth += (lk.match(/<details[\s>]/gi) ?? []).length;
      const closes = (lk.match(/<\/details>/gi) ?? []).length;
      if (closes > 0) {
        depth -= closes;
        if (depth <= 0) {
          const before = lk.split(/<\/details>/i)[0] ?? '';
          const prev = lines[k - 1] !== undefined ? stripPrefix(lines[k - 1]!) : '';
          if (before.trim() !== '') missing = true;
          else if (k - 1 > j && prev.trim() !== '' && !/^\s*<\/details>\s*$/i.test(prev)) missing = true;
          break;
        }
      }
    }
    out.push({ line: i + 1, missing, summary });
  }
  return out;
}
