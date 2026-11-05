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
