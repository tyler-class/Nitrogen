import type { Frontmatter, FrontmatterValue, PageMeta } from './types.ts';
import { basename, dirname, titleFromName } from './paths.ts';

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INT_RE = /^-?\d+$/;

/** Split a source into frontmatter block and body. Pure string work, no YAML library. */
export function splitFrontmatter(src: string): { raw: string; inner: string[]; body: string; lineCount: number } {
  if (!src.startsWith('---\n') && src !== '---' && !src.startsWith('---\r\n'))
    return { raw: '', inner: [], body: src, lineCount: 0 };
  const lines = src.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.replace(/\r$/, '') === '---') {
      const raw = lines.slice(0, i + 1).join('\n');
      return { raw, inner: lines.slice(1, i), body: lines.slice(i + 1).join('\n'), lineCount: i + 1 };
    }
  }
  // Unterminated: not frontmatter (CommonMark sees a thematic break).
  return { raw: '', inner: [], body: src, lineCount: 0 };
}

function stripComment(v: string): string {
  // Remove ` # comment` outside quotes.
  let q: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(v[i - 1]!))) return v.slice(0, i).trimEnd();
  }
  return v.trimEnd();
}

function unquote(v: string): string | null {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return null;
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return null;
}

function parseScalar(v: string): { ok: true; value: string | number | boolean | null } | { ok: false; message: string } {
  if (v === '' || v === '~' || v === 'null') return { ok: true, value: null };
  if (v === 'true') return { ok: true, value: true };
  if (v === 'false') return { ok: true, value: false };
  if (INT_RE.test(v)) return { ok: true, value: Number(v) };
  if (v.startsWith('"') || v.startsWith("'")) {
    const u = unquote(v);
    return u === null ? { ok: false, message: 'Unterminated quoted string.' } : { ok: true, value: u };
  }
  if (/^[{|>&*!%@`]/.test(v) || /^- /.test(v) || v === '-')
    return { ok: false, message: `Value "${v}" is outside the flat YAML subset (no maps, block scalars, anchors or tags).` };
  if (/:\s/.test(v)) return { ok: false, message: `Quote values containing ": " (got "${v}").` };
  return { ok: true, value: v };
}

function splitList(inner: string): string[] | null {
  const items: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const c of inner) {
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      items.push(cur.trim());
      cur = '';
    } else if (c === '[' || c === ']' || c === '{' || c === '}') return null;
    else cur += c;
  }
  if (q) return null;
  if (cur.trim() !== '' || items.length > 0) items.push(cur.trim());
  return items;
}

/** Parse the strict flat-YAML subset. Never throws; errors are reported per line. */
export function parseFrontmatter(src: string): Frontmatter {
  const { raw, inner, lineCount } = splitFrontmatter(src);
  const data: Record<string, FrontmatterValue> = {};
  const errors: { line: number; message: string }[] = [];
  if (!raw) return { raw, lineCount, data, errors };
  inner.forEach((rawLine, idx) => {
    const line = idx + 2;
    const l = rawLine.replace(/\r$/, '');
    if (l.trim() === '' || l.trimStart().startsWith('#')) return;
    if (/^\s/.test(l)) {
      errors.push({ line, message: 'Indented lines (nested maps or lists) are not allowed. Use flat `key: value` lines.' });
      return;
    }
    const m = KEY_RE.exec(l);
    if (!m) {
      errors.push({ line, message: `Expected \`key: value\`, got "${l}".` });
      return;
    }
    const key = m[1]!;
    const value = stripComment((m[2] ?? '').trim());
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      errors.push({ line, message: `Duplicate key "${key}".` });
      return;
    }
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) {
        errors.push({ line, message: `Inline list for "${key}" must close on the same line.` });
        return;
      }
      const parts = splitList(value.slice(1, -1));
      if (!parts) {
        errors.push({ line, message: `Inline list for "${key}" may only hold scalars.` });
        return;
      }
      const out: string[] = [];
      for (const p of parts) {
        const s = parseScalar(p);
        if (!s.ok || s.value === null) {
          errors.push({ line, message: s.ok ? `Empty item in list "${key}".` : s.message });
          return;
        }
        out.push(String(s.value));
      }
      data[key] = out;
      return;
    }
    const s = parseScalar(value);
    if (!s.ok) {
      errors.push({ line, message: s.message });
      return;
    }
    data[key] = s.value;
  });
  // Type checks for known keys.
  const lineOf = (key: string): number => {
    const i = inner.findIndex((l) => l.startsWith(`${key}:`));
    return i < 0 ? 1 : i + 2;
  };
  const expect = (key: string, ok: (v: FrontmatterValue) => boolean, what: string) => {
    if (key in data && data[key] !== null && !ok(data[key]!)) {
      errors.push({ line: lineOf(key), message: `"${key}" must be ${what}.` });
    }
  };
  expect('title', (v) => typeof v === 'string' || typeof v === 'number', 'a string');
  expect('icon', (v) => typeof v === 'string', 'a string');
  expect('status', (v) => typeof v === 'string', 'a string');
  expect('order', (v) => typeof v === 'number', 'an integer');
  expect('pinned', (v) => typeof v === 'boolean', 'true or false');
  expect('locked', (v) => typeof v === 'boolean', 'true or false');
  expect('updated', (v) => typeof v === 'string' && DATE_RE.test(v), 'a YYYY-MM-DD date');
  for (const k of ['tags', 'aliases']) {
    if (typeof data[k] === 'string') data[k] = [data[k] as string];
    expect(k, (v) => Array.isArray(v), 'an inline list like [a, b]');
  }
  return { raw, lineCount, data, errors };
}

function asList(v: FrontmatterValue | undefined): string[] {
  return Array.isArray(v) ? v : [];
}

/** Derive page metadata from frontmatter + first H1 + file name. */
export function deriveMeta(fm: Frontmatter, firstH1: string | undefined, path: string): PageMeta {
  const d = fm.data;
  let title: string;
  let titleSource: PageMeta['titleSource'];
  if ((typeof d.title === 'string' && d.title.trim()) || typeof d.title === 'number') {
    title = String(d.title).trim();
    titleSource = 'frontmatter';
  } else if (firstH1 && firstH1.trim()) {
    title = firstH1.trim();
    titleSource = 'h1';
  } else {
    const b = basename(path);
    title = titleFromName(b === 'index.md' ? basename(dirname(path)) || 'Home' : b);
    titleSource = 'filename';
  }
  const meta: PageMeta = {
    title,
    titleSource,
    tags: asList(d.tags),
    aliases: asList(d.aliases),
    pinned: d.pinned === true,
    locked: d.locked === true,
  };
  if (typeof d.icon === 'string') meta.icon = d.icon;
  if (typeof d.order === 'number') meta.order = d.order;
  if (typeof d.status === 'string') meta.status = d.status;
  if (typeof d.updated === 'string') meta.updated = d.updated;
  return meta;
}

/** Serialize a scalar for frontmatter, quoting when needed. */
export function formatFrontmatterValue(v: FrontmatterValue): string {
  if (v === null) return '';
  if (Array.isArray(v)) return `[${v.map((x) => formatScalar(x, true)).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return formatScalar(v, false);
}

function formatScalar(s: string, inList: boolean): string {
  const needs =
    s === '' ||
    /^[\s{[|>&*!%@`'"#-]/.test(s) ||
    /:\s|\s#|\s$/.test(s) ||
    /^(true|false|null|~|-?\d+)$/.test(s) ||
    (inList && /[,\]]/.test(s));
  return needs ? JSON.stringify(s) : s;
}

/**
 * Set (or remove with `null`/undefined) one frontmatter key, preserving the rest of the block.
 * Creates a frontmatter block if absent.
 */
export function setFrontmatterKey(src: string, key: string, value: FrontmatterValue | undefined): string {
  const { raw, inner, body } = splitFrontmatter(src);
  const lines = raw ? [...inner] : [];
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  const remove = value === undefined || value === null;
  if (idx >= 0) {
    if (remove) lines.splice(idx, 1);
    else lines[idx] = `${key}: ${formatFrontmatterValue(value)}`;
  } else if (!remove) lines.push(`${key}: ${formatFrontmatterValue(value)}`);
  if (lines.length === 0) return raw ? body.replace(/^\n/, '') : src;
  return `---\n${lines.join('\n')}\n---\n${raw ? body : src}`;
}
