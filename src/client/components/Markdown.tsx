// Markdown → mdast (GFM) → wikilinks + callouts → hast → sanitized → React.
import {
  lazy,
  memo,
  Suspense,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { Link } from 'react-router';
import type {
  Blockquote,
  Link as MdLink,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  Text,
} from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { visit, SKIP } from 'unist-util-visit';
import {
  DUE_RE,
  ITEM_LABELS,
  ITEM_TYPES,
  parseItemLine,
  todayKey,
  type ItemType,
} from '@shared/items';

/** Every "due:…" (with its time) in a text node, to move it out of the item's text. */
const DUE_ALL = new RegExp(DUE_RE.source, 'gi');
import { pageHref, slugify, splitTags, WIKILINK_RE } from '@shared/markdown';

const CALLOUTS = ['note', 'tip', 'important', 'warning', 'caution', 'info', 'question'];

/** Title (lowercased) → page, for resolving [[wikilinks]]. */
export type TitleIndex = Map<string, { id: string; title: string }>;

function headingText(node: { children?: unknown[] }): string {
  let out = '';
  visit(node as Root, 'text', (t: Text) => {
    out += t.value;
  });
  return out;
}

function transform(tree: Root, titles: TitleIndex, source: string) {
  // [[Wikilinks]] inside text nodes become links (or "missing" markers).
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index === undefined || parent.type === 'link') return;
    const value = node.value;
    // Not WIKILINK_RE.test(): it moves the global regex's lastIndex, and matchAll below would
    // then start after the first link and find nothing.
    if (!value.includes('[[')) return;
    const parts: PhrasingContent[] = [];
    let last = 0;
    for (const m of value.matchAll(WIKILINK_RE)) {
      if (m.index > last) parts.push({ type: 'text', value: value.slice(last, m.index) });
      const target = m[1]!.trim();
      const page = titles.get(target.toLowerCase());
      const label = m[3]?.trim() || (m[2] ? `${target} › ${m[2].trim()}` : target);
      const link: MdLink = {
        type: 'link',
        url: page
          ? `${pageHref(page.id, page.title)}${m[2] ? `#h-${slugify(m[2])}` : ''}`
          : `#missing:${encodeURIComponent(target)}`,
        children: [{ type: 'text', value: label }],
        data: { hProperties: { className: page ? ['wikilink'] : ['wikilink', 'missing'] } },
      };
      parts.push(link);
      last = m.index + m[0].length;
    }
    if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
    parent.children.splice(index, 1, ...(parts as never[]));
    return [SKIP, index + parts.length];
  });

  // #tags become links to the tag's page.
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index === undefined || parent.type === 'link') return;
    if (!node.value.includes('#')) return;
    const split = splitTags(node.value);
    if (split.length === 1 && 'text' in split[0]!) return;
    const parts: PhrasingContent[] = split.map((p) =>
      'text' in p
        ? { type: 'text', value: p.text }
        : {
            type: 'link',
            url: `/tags/${encodeURIComponent(p.tag)}`,
            children: [{ type: 'text', value: p.raw }],
            data: { hProperties: { className: ['tag'] } },
          },
    );
    parent.children.splice(index, 1, ...(parts as never[]));
    return [SKIP, index + parts.length];
  });

  // todo: / question: / reminder: lines become item cards. The item is parsed from the source line
  // (so it matches the server's index); the marker, owner, due date and answer are moved out of the
  // text into data attributes, and the rest of the line keeps its inline markdown.
  const lines = source.split('\n');
  const markItem = (node: ListItem | Paragraph, para: Paragraph) => {
    const line = node.position?.start.line;
    if (!line) return false;
    const item = parseItemLine(lines[line - 1] ?? '', line);
    if (!item) return false;
    const lead = para.children[0];
    if (lead?.type !== 'text') return false;
    const re = new RegExp(`^\\s*(${ITEM_TYPES.join('|')}):\\s+`, 'i');
    if (!re.test(lead.value)) return false;
    lead.value = lead.value.replace(re, '');
    visit(para, 'text', (t: Text) => {
      t.value = t.value
        .replace(/\s+answer:\s+.*$/i, '')
        .replace(DUE_ALL, (m) => (/^\s/.test(m) ? m[0]! : ''))
        .replace(/(^|\s)@[\p{L}\p{N}._-]+/gu, '$1');
    });
    if (node.type === 'listItem') node.checked = null;
    const props = {
      className: ['item', `item-${item.type}`, ...(item.done ? ['done'] : [])],
      dataLine: String(line),
      dataType: item.type,
      dataDone: item.done ? '1' : '0',
      ...(item.due ? { dataDue: item.due } : {}),
      ...(item.due_time ? { dataDueTime: item.due_time } : {}),
      ...(item.owner ? { dataOwner: item.owner } : {}),
      ...(item.answer ? { dataAnswer: item.answer } : {}),
      ...(item.invalid ? { dataInvalid: item.invalid } : {}),
    };
    node.data = {
      ...node.data,
      ...(node.type === 'paragraph' ? { hName: 'div' } : {}),
      hProperties: props,
    };
    return true;
  };
  visit(tree, 'listItem', (node: ListItem) => {
    const para = node.children[0];
    if (para?.type === 'paragraph') markItem(node, para);
  });
  visit(tree, 'paragraph', (node: Paragraph, _i, parent) => {
    if (parent?.type === 'listItem') return;
    markItem(node, node);
  });

  // > [!NOTE] Optional title  →  <aside class="callout callout-note">
  visit(tree, 'blockquote', (node: Blockquote) => {
    const first = node.children[0];
    if (first?.type !== 'paragraph') return;
    const lead = first.children[0];
    if (lead?.type !== 'text') return;
    const m = /^\[!([A-Za-z]+)\][+-]?[ \t]*([^\n]*)\n?/.exec(lead.value);
    if (!m) return;
    const type = CALLOUTS.includes(m[1]!.toLowerCase()) ? m[1]!.toLowerCase() : 'note';
    lead.value = lead.value.slice(m[0].length);
    if (!lead.value) first.children.shift();
    // GFM alerts have no title; a bold-only first line is read as one.
    let title = m[2]!.trim();
    const bold = first.children[0];
    if (!title && bold?.type === 'strong') {
      title = headingText(bold);
      first.children.shift();
      const br = first.children[0];
      if (br?.type === 'break') first.children.shift();
      else if (br?.type === 'text') br.value = br.value.replace(/^\n/, '');
    }
    if (!first.children.length) node.children.shift();
    const titleNode: Paragraph = {
      type: 'paragraph',
      children: [{ type: 'text', value: title || type[0]!.toUpperCase() + type.slice(1) }],
      data: { hProperties: { className: ['callout-title'] } },
    };
    node.children.unshift(titleNode);
    node.data = { hName: 'aside', hProperties: { className: ['callout', `callout-${type}`] } };
  });

  // Heading anchors (the sanitizer prefixes them with "h-").
  const seen = new Map<string, number>();
  visit(tree, 'heading', (node) => {
    const base = slugify(headingText(node));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    node.data = { hProperties: { id: n ? `${base}-${n}` : base } };
  });
}

const ITEM_CLASSES = ['item', 'done', ...ITEM_TYPES.map((t) => `item-${t}`)];
const ITEM_DATA = [
  'dataLine',
  'dataType',
  'dataDone',
  'dataDue',
  'dataDueTime',
  'dataOwner',
  'dataAnswer',
  'dataInvalid',
];

const schema: Schema = {
  ...defaultSchema,
  clobberPrefix: 'h-',
  tagNames: [...(defaultSchema.tagNames ?? []), 'aside'],
  attributes: {
    ...defaultSchema.attributes,
    // The default allows only one class on links; the first className rule wins, so replace it.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter(
        (x) => !(Array.isArray(x) && x[0] === 'className'),
      ),
      ['className', 'wikilink', 'missing', 'tag', 'data-footnote-backref'],
    ],
    aside: [['className', 'callout', ...CALLOUTS.map((c) => `callout-${c}`)]],
    li: [['className', 'task-list-item', ...ITEM_CLASSES], ...ITEM_DATA],
    div: [['className', ...ITEM_CLASSES], ...ITEM_DATA],
    p: [['className', 'callout-title']],
    code: [['className', /^language-./]],
  },
};

function Anchor({ href, children, ...rest }: ComponentProps<'a'>) {
  if (href?.startsWith('#missing:'))
    return (
      <span className="wikilink missing" title="No page has this title yet">
        {children}
      </span>
    );
  if (href?.startsWith('/') && !href.startsWith('//') && !href.startsWith('/files/'))
    return (
      <Link to={href} {...rest}>
        {children}
      </Link>
    );
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

function Img({ src, alt, title }: ComponentProps<'img'>) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        onClick={() => setZoom(true)}
      />
      {zoom && (
        <button className="lightbox" onClick={() => setZoom(false)} aria-label="Close image">
          <img src={src} alt={alt ?? ''} />
        </button>
      )}
    </>
  );
}

/** ```mermaid blocks become diagrams; other code blocks render as usual. */
function Pre(props: ComponentProps<'pre'>) {
  const child = props.children as { props?: { className?: string; children?: unknown } } | null;
  const cls = child?.props?.className ?? '';
  if (/\blanguage-mermaid\b/.test(cls)) {
    const code = String(child?.props?.children ?? '').replace(/\n$/, '');
    return (
      <Suspense fallback={<div className="mermaid-box loading" aria-busy="true" />}>
        <Mermaid code={code} />
      </Suspense>
    );
  }
  return <pre {...props} />;
}

const Mermaid = lazy(() => import('./Mermaid').then((m) => ({ default: m.Mermaid })));

function TableWrap(props: ComponentProps<'table'>) {
  return (
    <div className="table-wrap">
      <table {...props} />
    </div>
  );
}

type ItemProps = { className?: string; children?: ReactNode } & Record<
  `data-${string}`,
  string | undefined
>;

/** A typed item as a card: check it off (when the page allows), label, text, owner, due date. */
type Handlers = {
  onToggle?: (line: number, done: boolean) => void;
  onAnswer?: (line: number, answer: string) => void;
};

/** A question's answer, typed in place: a small grey label and an underline to write on. */
function AnswerField({
  line,
  initial,
  onAnswer,
}: {
  line: number;
  initial: string;
  onAnswer?: (line: number, answer: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  if (saved !== initial) {
    // The page changed underneath (another device, an assistant): show the new answer.
    setSaved(initial);
    setValue(initial);
  }
  const commit = () => {
    if (value.trim() !== initial.trim()) onAnswer?.(line, value);
  };
  if (!onAnswer && !initial) return null;
  return (
    <label className="item-answer">
      <span className="item-answer-label">Answer</span>
      {onAnswer ? (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setValue(initial);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Answer"
          placeholder=" "
        />
      ) : (
        <span className="item-answer-text">{initial}</span>
      )}
    </label>
  );
}

function itemCard(Tag: 'li' | 'div', { onToggle, onAnswer }: Handlers) {
  return function ItemOrPlain(props: ItemProps) {
    const { className, children, ...rest } = props as ItemProps & Record<string, unknown>;
    if (!className?.split(' ').includes('item'))
      return (
        <Tag className={className} {...rest}>
          {children}
        </Tag>
      );
    const type = props['data-type'] as ItemType;
    const line = Number(props['data-line']);
    const done = props['data-done'] === '1';
    const due = props['data-due'];
    const overdue = !done && !!due && due < todayKey();
    const label = ITEM_LABELS[type] ?? type;
    return (
      <Tag className={className} id={`item-${line}`}>
        <button
          type="button"
          className="item-check"
          role="checkbox"
          aria-checked={done}
          aria-label={`${done ? 'Reopen' : type === 'question' ? 'Resolve' : 'Complete'}: ${label}`}
          disabled={!onToggle}
          onClick={() => onToggle?.(line, !done)}
        />
        <div className="item-main">
          <span className="item-label">{type}</span>
          <div className="item-text">{children}</div>
          {(props['data-owner'] || due || props['data-invalid']) && (
            <span className="item-meta">
              {props['data-owner'] && <span>@{props['data-owner']}</span>}
              {due && (
                <span className={overdue ? 'overdue' : undefined}>
                  {overdue ? 'Overdue · ' : 'Due '}
                  {formatDue(due, props['data-due-time'])}
                </span>
              )}
              {props['data-invalid'] && <span className="overdue">{props['data-invalid']}</span>}
            </span>
          )}
          {type === 'question' && (
            <AnswerField line={line} initial={props['data-answer'] ?? ''} onAnswer={onAnswer} />
          )}
        </div>
      </Tag>
    );
  };
}

/** "Nov 12", or "Nov 12, 2:00 PM" with a time (in this device's own format). */
export const formatDue = (d: string, time?: string | null) => {
  const day = new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : {}),
  });
  if (!time) return day;
  const at = new Date(`${d}T${time}:00`);
  return `${day}, ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

export const Markdown = memo(function Markdown({
  source,
  titles,
  onToggleItem,
  onAnswerItem,
}: {
  source: string;
  titles: TitleIndex;
  /** Lets readers check items off; without it the checkboxes are shown but disabled. */
  onToggleItem?: (line: number, done: boolean) => void;
  /** Lets readers answer questions in place. */
  onAnswerItem?: (line: number, answer: string) => void;
}): ReactNode {
  return useMemo(() => {
    const tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    transform(tree, titles, source);
    const hast = sanitize(toHast(tree), schema);
    return toJsxRuntime(hast, {
      Fragment,
      jsx,
      jsxs,
      components: {
        a: Anchor,
        img: Img,
        table: TableWrap,
        pre: Pre,
        li: itemCard('li', { onToggle: onToggleItem, onAnswer: onAnswerItem }),
        div: itemCard('div', { onToggle: onToggleItem, onAnswer: onAnswerItem }),
      },
    });
  }, [source, titles, onToggleItem, onAnswerItem]);
});
