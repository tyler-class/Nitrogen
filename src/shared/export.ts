// Plain markdown export: Nitrogen's conventions downgraded to markdown any app (or Google Docs)
// reads well. The full archive (Settings → Download backup) keeps everything as is instead.
import { ITEM_LABELS, ITEM_LINE_RE, parseItemLine } from './items';
import { WIKILINK_RE } from './markdown';

export interface PlainOptions {
  /** Where [[Title]] should point (a relative .md path, or a URL); null leaves just the text. */
  link?: (title: string) => string | null;
  /** Makes /files/… image links absolute. */
  origin?: string;
}

const FENCE = /^(```|~~~)/;

export function toPlainMarkdown(md: string, opts: PlainOptions = {}): string {
  const out: string[] = [];
  let inFence = false;
  let lastWasItem = false;
  for (const line of md.split('\n')) {
    if (FENCE.test(line.trim())) inFence = !inFence;
    if (inFence || FENCE.test(line.trim())) {
      out.push(line);
      lastWasItem = false;
      continue;
    }
    const item = ITEM_LINE_RE.test(line) ? parseItemLine(line, 0) : null;
    if (item) {
      const meta = [item.owner && `@${item.owner}`, item.due && `due ${item.due}`]
        .filter(Boolean)
        .join(', ');
      const label = `${ITEM_LABELS[item.type]}${item.done ? ' (done)' : ''}`;
      if (lastWasItem) out.push('>');
      out.push(
        `> **${label}:** ${inline(item.text, opts)}${meta ? ` (${meta})` : ''}${item.answer ? ` **Answer:** ${inline(item.answer, opts)}` : ''}`,
      );
      lastWasItem = true;
      continue;
    }
    if (lastWasItem && line.trim()) out.push('');
    lastWasItem = false;
    const callout = /^(\s*>\s*)\[!([A-Za-z]+)\][+-]?\s*(.*)$/.exec(line);
    if (callout) {
      const kind = callout[2]!.charAt(0).toUpperCase() + callout[2]!.slice(1).toLowerCase();
      const title = callout[3]!.trim();
      out.push(`${callout[1]}**${kind}${title ? `: ${inline(title, opts)}` : ''}**`);
      continue;
    }
    out.push(inline(line, opts));
  }
  return out.join('\n');
}

function inline(text: string, opts: PlainOptions): string {
  let s = text.replace(
    WIKILINK_RE,
    (_m, target: string, heading: string | undefined, label: string | undefined) => {
      const shown =
        label?.trim() || (heading ? `${target.trim()} › ${heading.trim()}` : target.trim());
      const to = opts.link?.(target.trim());
      return to ? `[${shown}](${encodeURI(to)})` : shown;
    },
  );
  if (opts.origin) s = s.replace(/\]\((\/files\/[^)\s]+)\)/g, `](${opts.origin}$1)`);
  return s;
}

/** A safe file or folder name for a page title. */
export function fileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|#]/g, '-')
      // eslint-disable-next-line no-control-regex -- control characters aren't allowed in file names
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'Untitled'
  );
}
