// Targeted edits to a markdown body, so assistants can change a page without rewriting it.
// All edits in a call apply in order; any failure rejects the whole call.

export type EditOp =
  | { type: 'replace'; find: string; replace: string; all?: boolean }
  | { type: 'delete'; find: string; all?: boolean }
  | { type: 'append'; text: string }
  | { type: 'prepend'; text: string }
  | { type: 'insert_after'; find: string; text: string }
  | { type: 'insert_before'; find: string; text: string }
  /** Adds text at the end of a heading's section (before the next heading of the same or higher level). */
  | { type: 'append_to_section'; heading: string; text: string }
  /** Adds text directly below a heading line, before the rest of its section. */
  | { type: 'insert_under_heading'; heading: string; text: string }
  /** Replaces everything under a heading, keeping the heading line. */
  | { type: 'replace_section'; heading: string; text: string }
  /** Adds a new section at the end of the page (or of a parent section). */
  | { type: 'add_section'; heading: string; level?: number; text: string; under?: string };

export class EditError extends Error {}

interface Heading {
  line: number;
  level: number;
  text: string;
}

export function headings(md: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  md.split('\n').forEach((line, i) => {
    const f = /^\s{0,3}(```|~~~)/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) out.push({ line: i, level: h[1]!.length, text: h[2]! });
  });
  return out;
}

const norm = (s: string) =>
  s
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase();

function findHeading(md: string, name: string): Heading {
  const all = headings(md);
  const hits = all.filter((h) => norm(h.text) === norm(name));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1)
    throw new EditError(
      `Several headings are named “${name}”. Make the edit with replace instead.`,
    );
  const list = all.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join(', ') || 'none';
  throw new EditError(`No heading named “${name}”. Headings on this page: ${list}.`);
}

/** [start, end) line range of a section's content (after its heading line). */
function sectionRange(lines: string[], md: string, h: Heading): [number, number] {
  const next = headings(md).find((o) => o.line > h.line && o.level <= h.level);
  let end = next ? next.line : lines.length;
  // Keep the blank line that separates this section from the next heading.
  while (end > h.line + 1 && lines[end - 1]!.trim() === '') end--;
  return [h.line + 1, end];
}

function countOf(md: string, find: string): number {
  if (!find) throw new EditError('find must not be empty.');
  return md.split(find).length - 1;
}

function requireOnce(md: string, find: string, allowMany = false): number {
  const n = countOf(md, find);
  if (n === 0)
    throw new EditError(
      `Could not find ${JSON.stringify(find.slice(0, 120))} in the page. Read the page again and copy the text exactly.`,
    );
  if (n > 1 && !allowMany)
    throw new EditError(
      `${JSON.stringify(find.slice(0, 120))} appears ${n} times. Include more surrounding text so it is unique, or set all: true.`,
    );
  return n;
}

/** Joins blocks with exactly one blank line between them. */
function joinBlocks(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.length)
    .join('\n\n');
}

function applyOne(md: string, op: EditOp): string {
  switch (op.type) {
    case 'replace':
    case 'delete': {
      const replacement = op.type === 'replace' ? op.replace : '';
      requireOnce(md, op.find, op.all);
      return op.all ? md.split(op.find).join(replacement) : md.replace(op.find, () => replacement);
    }
    case 'insert_after':
      requireOnce(md, op.find);
      return md.replace(op.find, () => op.find + op.text);
    case 'insert_before':
      requireOnce(md, op.find);
      return md.replace(op.find, () => op.text + op.find);
    case 'append':
      return joinBlocks(md, op.text) + '\n';
    case 'prepend':
      return joinBlocks(op.text, md) + '\n';
    case 'insert_under_heading': {
      const lines = md.split('\n');
      const h = findHeading(md, op.heading);
      const out = [
        ...lines.slice(0, h.line + 1),
        '',
        ...op.text.replace(/^\n+|\n+$/g, '').split('\n'),
        '',
        ...lines.slice(h.line + 1),
      ];
      return out.join('\n').replace(/\n{3,}/g, '\n\n');
    }
    case 'append_to_section':
    case 'replace_section': {
      const lines = md.split('\n');
      const h = findHeading(md, op.heading);
      const [start, end] = sectionRange(lines, md, h);
      const body = lines.slice(start, end).join('\n');
      const next = op.type === 'replace_section' ? op.text : joinBlocks(body, op.text);
      const out = [
        ...lines.slice(0, start),
        '',
        ...next.replace(/^\n+|\n+$/g, '').split('\n'),
        ...lines.slice(end),
      ];
      return out.join('\n').replace(/\n{3,}/g, '\n\n');
    }
    case 'add_section': {
      let level = op.level ?? 2;
      if (op.under) {
        const lines = md.split('\n');
        const parent = findHeading(md, op.under);
        level = op.level ?? Math.min(6, parent.level + 1);
        const [, end] = sectionRange(lines, md, parent);
        const block = `${'#'.repeat(level)} ${op.heading.trim()}\n\n${op.text.trim()}`;
        return [...lines.slice(0, end), '', ...block.split('\n'), ...lines.slice(end)]
          .join('\n')
          .replace(/\n{3,}/g, '\n\n');
      }
      level = Math.min(6, Math.max(1, level));
      return joinBlocks(md, `${'#'.repeat(level)} ${op.heading.trim()}`, op.text) + '\n';
    }
  }
}

export function applyEdits(md: string, ops: EditOp[]): string {
  return ops.reduce((acc, op, i) => {
    try {
      return applyOne(acc, op);
    } catch (e) {
      if (e instanceof EditError && ops.length > 1)
        throw new EditError(`Edit ${i + 1} (${op.type}): ${e.message} No edits were saved.`);
      throw e;
    }
  }, md);
}
