/** Section-aware patch operations for patch_page. Pure and atomic: any failing op throws. */
import { scanPage, splitFrontmatter, slugify } from '@nitrogen/core/light';

export type PatchOp =
  | { op: 'append'; content: string }
  | { op: 'prepend'; content: string }
  | { op: 'insert_after_heading'; heading: string; content: string }
  | { op: 'replace_section'; heading: string; content: string }
  | { op: 'replace_text'; find: string; content: string };

export class PatchError extends Error {}

function findHeading(src: string, heading: string): { line: number; level: number; end: number } {
  const scan = scanPage(src);
  const want = heading.replace(/^#+\s*/, '').trim();
  const matches = scan.headings.filter((h) => h.text === want || h.slug === want || h.slug === slugify(want) || h.text.toLowerCase() === want.toLowerCase());
  if (matches.length === 0) throw new PatchError(`Heading "${heading}" not found. Headings: ${scan.headings.map((h) => h.text).join(', ') || '(none)'}.`);
  if (matches.length > 1) throw new PatchError(`Heading "${heading}" is ambiguous (${matches.length} matches). Use its slug, e.g. "${matches[1]!.slug}".`);
  const h = matches[0]!;
  const lines = src.split('\n');
  const next = scan.headings.find((x) => x.line > h.line && x.level <= h.level);
  // Section ends before the next heading of the same or higher level (or EOF).
  let end = next ? next.line - 1 : lines.length;
  // Setext headings occupy two lines.
  const isSetext = /^\s{0,3}(=+|-+)\s*$/.test(lines[h.line] ?? '') && !/^\s{0,3}#/.test(lines[h.line - 1] ?? '');
  if (next && /^\s{0,3}(=+|-+)\s*$/.test(lines[next.line] ?? '') && !/^\s{0,3}#/.test(lines[next.line - 1] ?? '')) end = next.line - 1;
  return { line: h.line + (isSetext ? 1 : 0), level: h.level, end };
}

function block(content: string): string {
  return content.replace(/^\n+|\n+$/g, '');
}

export function applyPatch(src: string, ops: PatchOp[]): string {
  let out = src;
  for (const o of ops) {
    const lines = out.split('\n');
    switch (o.op) {
      case 'append': {
        out = `${out.replace(/\n*$/, '')}\n\n${block(o.content)}\n`;
        break;
      }
      case 'prepend': {
        const { raw, body } = splitFrontmatter(out);
        const b = body.replace(/^\n+/, '');
        // Keep the H1 first.
        const h1 = /^#\s.*\n/.exec(b);
        const head = h1 ? h1[0] : '';
        const rest = b.slice(head.length).replace(/^\n+/, '');
        out = `${raw ? `${raw}\n\n` : ''}${head ? `${head}\n` : ''}${block(o.content)}\n\n${rest}`;
        break;
      }
      case 'insert_after_heading': {
        const h = findHeading(out, o.heading);
        lines.splice(h.line, 0, '', block(o.content));
        out = lines.join('\n').replace(/\n{3,}/g, (m, off: number) => (off > 0 ? '\n\n' : m));
        break;
      }
      case 'replace_section': {
        const h = findHeading(out, o.heading);
        const tail = lines.slice(h.end);
        out = [...lines.slice(0, h.line), '', block(o.content), ...(tail.length ? [''] : []), ...tail].join('\n');
        break;
      }
      case 'replace_text': {
        if (!o.find) throw new PatchError('replace_text needs "find".');
        const first = out.indexOf(o.find);
        if (first < 0) throw new PatchError(`Text not found: "${o.find.slice(0, 80)}".`);
        if (out.indexOf(o.find, first + 1) >= 0) throw new PatchError(`Text occurs more than once: "${o.find.slice(0, 80)}". Include more context.`);
        out = out.slice(0, first) + o.content + out.slice(first + o.find.length);
        break;
      }
      default:
        throw new PatchError(`Unknown op ${(o as { op: string }).op}.`);
    }
  }
  return out.replace(/\n*$/, '\n');
}

/** The block of a section (heading line through the end of the section). */
export function readSection(src: string, heading: string): string {
  const h = findHeading(src, heading);
  const lines = src.split('\n');
  const headLine = h.line - 1 - (/^\s{0,3}(=+|-+)\s*$/.test(lines[h.line - 1] ?? '') ? 1 : 0);
  return lines.slice(headLine, h.end).join('\n').replace(/\n+$/, '\n');
}
