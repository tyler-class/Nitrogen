// Plain-text helpers for page bodies, shared by the Worker (links, search) and the app (editor).

/** [[Target]], [[Target|label]], [[Target#Heading]]. Not inside code (callers strip code first). */
export const WIKILINK_RE = /\[\[([^[\]\n|#]+)(?:#([^[\]\n|]+))?(?:\|([^[\]\n]+))?\]\]/g;

/** Markdown links to other pages: ](/p/<id>) or ](/p/<id>/slug#anchor). */
const PAGE_LINK_RE = /\]\(\/p\/([A-Za-z0-9_-]+)(?:[/#?][^)\s]*)?\)/g;

/** Image keys referenced as ![...](/files/<key>). */
const FILE_REF_RE = /\/files\/([A-Za-z0-9/_.-]+)/g;

/** Blank out fenced and inline code so links inside code are ignored. Keeps offsets. */
export function stripCode(md: string): string {
  return md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]+`/g, (m) => ' '.repeat(m.length));
}

export interface ExtractedLinks {
  /** Lowercased wikilink targets. */
  titles: string[];
  ids: string[];
}

export function extractLinks(md: string): ExtractedLinks {
  const text = stripCode(md);
  const titles = new Set<string>();
  const ids = new Set<string>();
  for (const m of text.matchAll(WIKILINK_RE)) titles.add(m[1]!.trim().toLowerCase());
  for (const m of text.matchAll(PAGE_LINK_RE)) ids.add(m[1]!);
  return { titles: [...titles], ids: [...ids] };
}

export function extractFileKeys(md: string): string[] {
  return [...new Set([...md.matchAll(FILE_REF_RE)].map((m) => m[1]!))];
}

export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page'
  );
}

export function pageHref(id: string, title?: string): string {
  return title ? `/p/${id}/${slugify(title)}` : `/p/${id}`;
}

/** Markdown for an uploaded image. Alt text comes from the file name. */
export function imageMarkdown(url: string, name: string): string {
  const alt = name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[[\]\n]/g, ' ')
    .trim();
  return `![${alt || 'image'}](${url})`;
}

/** Strip markdown syntax for excerpts and semantic indexing context. */
export function plainText(md: string): string {
  return stripCode(md)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(WIKILINK_RE, (_m, target: string, _h, label?: string) => label ?? target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?(\[![A-Z]+\]\s*)?/gm, '')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Words as quoted FTS5 terms (no operator injection); the last one matches as a prefix. */
export function ftsQuery(q: string): string | null {
  const words = (q.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

// ------------------------------------------------------------------- tags

export const MAX_TAG = 40;

/** Lowercase, no leading #, spaces as dashes, letters/digits/_-/ only. "" if nothing is left. */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_\-/]/gu, '')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, MAX_TAG);
}

/** #tag in text: after the start or whitespace, starting with a letter. Not headings or anchors. */
const INLINE_TAG_RE = /(^|\s)#(\p{L}[\p{L}\p{N}_\-/]*)/gu;

/** Tags written in the body as #tag (outside code). Normalized and de-duplicated. */
export function extractTags(md: string): string[] {
  const text = stripCode(md).replace(WIKILINK_RE, ' ');
  const out = new Set<string>();
  for (const m of text.matchAll(INLINE_TAG_RE)) {
    const t = normalizeTag(m[2]!);
    if (t) out.add(t);
  }
  return [...out];
}

/** Splits text into plain parts and #tags, for rendering (same rule as extractTags). */
export function splitTags(text: string): ({ text: string } | { tag: string; raw: string })[] {
  const parts: ({ text: string } | { tag: string; raw: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_TAG_RE)) {
    const start = m.index + m[1]!.length;
    const tag = normalizeTag(m[2]!);
    if (!tag) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ tag, raw: `#${m[2]}` });
    last = start + 1 + m[2]!.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// -------------------------------------------------------- unlinked mentions

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Blank out code, wikilinks, markdown links/images and HTML so mentions are only found in prose. */
function prose(md: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return stripCode(md)
    .replace(WIKILINK_RE, blank)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/<[^>\n]+>/g, blank)
    .replace(/https?:\/\/\S+/g, blank);
}

function mentionRe(title: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(title.trim())}(?![\\p{L}\\p{N}_])`, 'giu');
}

/** Where `title` appears as plain text (not already linked, not in code). */
export function findMentions(md: string, title: string): { index: number; length: number }[] {
  if (title.trim().length < 3) return [];
  return [...prose(md).matchAll(mentionRe(title))].map((m) => ({
    index: m.index,
    length: m[0].length,
  }));
}

/** Turns the first plain-text mention of `title` into [[title]]. null if there is none. */
export function linkFirstMention(md: string, title: string): string | null {
  const hit = findMentions(md, title)[0];
  if (!hit) return null;
  const found = md.slice(hit.index, hit.index + hit.length);
  const link = found === title ? `[[${title}]]` : `[[${title}|${found}]]`;
  return md.slice(0, hit.index) + link + md.slice(hit.index + hit.length);
}

/** A short plain-text excerpt around the first mention, from the line it's on. */
export function mentionSnippet(md: string, title: string, radius = 70): string {
  const hit = findMentions(md, title)[0];
  if (!hit) return '';
  const ls = md.lastIndexOf('\n', hit.index) + 1;
  const le = md.indexOf('\n', hit.index);
  const line = plainText(md.slice(ls, le === -1 ? md.length : le)).replace(
    /^[-*+]\s+|^\d+\.\s+/,
    '',
  );
  const at = Math.max(0, line.toLowerCase().indexOf(title.trim().toLowerCase()));
  const from = Math.max(0, at - radius);
  const to = Math.min(line.length, at + title.length + radius);
  return `${from > 0 ? '…' : ''}${line.slice(from, to).trim()}${to < line.length ? '…' : ''}`;
}

/** Rough word count of the readable text. */
export function wordCount(md: string): number {
  const t = plainText(md);
  return t ? t.split(/\s+/).filter(Boolean).length : 0;
}
