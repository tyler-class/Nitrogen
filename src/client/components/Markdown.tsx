// Markdown → mdast (GFM) → wikilinks + callouts → hast → sanitized → React.
import {
  createContext,
  lazy,
  memo,
  Suspense,
  useContext,
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
  extractItems,
  ITEM_LABELS,
  ITEM_TYPES,
  isOverdue,
  nowMoment,
  parseItemLine,
  reminderPast,
  todayKey,
  type ItemEdit,
  type ItemType,
} from '@shared/items';

/** Every "due:…" (with its time) in a text node, to move it out of the item's text. */
const DUE_ALL = new RegExp(DUE_RE.source, 'gi');
import { pageHref, slugify, splitTags, WIKILINK_RE } from '@shared/markdown';
import { Icon } from './Icon';
import { AnswerBox, ItemActions, ItemEditor } from './ItemParts';

/** The three kinds of callout; others show as the nearest of them. */
const CALLOUTS = ['note', 'tip', 'warning'];
const CALLOUT_ALIAS: Record<string, string> = {
  important: 'tip',
  caution: 'warning',
  danger: 'warning',
  question: 'note',
  info: 'note',
};

/** Title (lowercased) → page, for resolving [[wikilinks]]. Archived pages still resolve. */
export type TitleIndex = Map<string, { id: string; title: string; archived?: boolean }>;

function headingText(node: { children?: unknown[] }): string {
  let out = '';
  visit(node as Root, 'text', (t: Text) => {
    out += t.value;
  });
  return out;
}

/**
 * Cut a paragraph at " answer:": the text node holding it ends there, and everything after it
 * (more text, bold, links, line breaks: the answer) goes.
 */
function cutAnswer(para: Paragraph) {
  let cut = false;
  const walk = (parent: { children: PhrasingContent[] }) => {
    for (let k = 0; k < parent.children.length; k++) {
      if (cut) {
        parent.children.length = k;
        return;
      }
      const c = parent.children[k]!;
      if (c.type === 'text') {
        const m = /\s+answer:(\s|$)/i.exec(c.value);
        if (m) {
          c.value = c.value.slice(0, m.index);
          cut = true;
        }
      } else if ('children' in c && c.type !== 'link') walk(c as { children: PhrasingContent[] });
    }
  };
  walk(para);
}

function transform(tree: Root, titles: TitleIndex, source: string, items = true) {
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
        data: {
          hProperties: {
            className: !page
              ? ['wikilink', 'missing']
              : page.archived
                ? ['wikilink', 'archived']
                : ['wikilink'],
          },
        },
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
  // The whole-page parse knows where each answer ends (it can go on over indented lines).
  const parsed = new Map(extractItems(source).map((i) => [i.line, i]));
  const markItem = (node: ListItem | Paragraph, para: Paragraph) => {
    const line = node.position?.start.line;
    if (!line) return false;
    const one = parseItemLine(lines[line - 1] ?? '', line);
    if (!one) return false;
    const item = parsed.get(line) ?? one;
    const lead = para.children[0];
    if (lead?.type !== 'text') return false;
    const re = new RegExp(`^\\s*(${ITEM_TYPES.join('|')}):\\s+`, 'i');
    if (!re.test(lead.value)) return false;
    lead.value = lead.value.replace(re, '');
    // Everything from " answer:" on is the answer, shown in its own box: cut it from the text.
    cutAnswer(para);
    visit(para, 'text', (t: Text) => {
      t.value = t.value
        .replace(DUE_ALL, (m) => (/^\s/.test(m) ? m[0]! : ''))
        .replace(/(^|\s)@[\p{L}\p{N}._-]+/gu, '$1');
    });
    // And the answer's lines below the item (a list, a quote…) aren't shown twice.
    if (node.type === 'listItem' && item.answer_lines) {
      const last = line + item.answer_lines;
      node.children = node.children.filter(
        (c, k) => k === 0 || (c.position?.start.line ?? 0) > last,
      );
    }
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
      dataText: item.text,
      ...(item.invalid ? { dataInvalid: item.invalid } : {}),
    };
    node.data = {
      ...node.data,
      ...(node.type === 'paragraph' ? { hName: 'div' } : {}),
      hProperties: props,
    };
    return true;
  };
  // Pages that can't hold items (AI session entries) show the lines as written.
  if (items) {
    visit(tree, 'listItem', (node: ListItem) => {
      const para = node.children[0];
      if (para?.type === 'paragraph') markItem(node, para);
    });
    visit(tree, 'paragraph', (node: Paragraph, _i, parent) => {
      if (parent?.type === 'listItem') return;
      markItem(node, node);
    });
  }

  // > [!NOTE] Optional title  →  <aside class="callout callout-note">
  visit(tree, 'blockquote', (node: Blockquote) => {
    const first = node.children[0];
    if (first?.type !== 'paragraph') return;
    const lead = first.children[0];
    if (lead?.type !== 'text') return;
    const m = /^\[!([A-Za-z]+)\][+-]?[ \t]*([^\n]*)\n?/.exec(lead.value);
    if (!m) return;
    const kind = m[1]!.toLowerCase();
    const type = CALLOUTS.includes(kind) ? kind : (CALLOUT_ALIAS[kind] ?? 'note');
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

  // ==Highlighted== text, as the editor shows it.
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index === undefined || !node.value.includes('==')) return;
    const parts: PhrasingContent[] = [];
    let last = 0;
    for (const m of node.value.matchAll(/==(?=[^\s=])(.*?[^\s=])==/g)) {
      if (m.index > last) parts.push({ type: 'text', value: node.value.slice(last, m.index) });
      parts.push({
        type: 'emphasis',
        children: [{ type: 'text', value: m[1]! }],
        data: { hName: 'mark' },
      });
      last = m.index + m[0].length;
    }
    if (!parts.length) return;
    if (last < node.value.length) parts.push({ type: 'text', value: node.value.slice(last) });
    parent.children.splice(index, 1, ...(parts as never[]));
    return [SKIP, index + parts.length];
  });

  // A single line break is a line break, as it is in the editor.
  visit(tree, 'text', (node: Text, index, parent) => {
    if (!parent || index === undefined || !node.value.includes('\n')) return;
    const parts: PhrasingContent[] = [];
    node.value.split('\n').forEach((piece, k) => {
      if (k) parts.push({ type: 'break' });
      if (piece) parts.push({ type: 'text', value: piece });
    });
    parent.children.splice(index, 1, ...(parts as never[]));
    return [SKIP, index + parts.length];
  });

  // Heading anchors (the sanitizer prefixes them with "h-").
  const seen = new Map<string, number>();
  visit(tree, 'heading', (node) => {
    const base = slugify(headingText(node));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    node.data = { hProperties: { id: n ? `${base}-${n}` : base } };
  });

  // Each block remembers the lines it came from, so a tap on it can open the editor right there.
  visit(tree, (node) => {
    if (!BLOCKS.has(node.type) || !node.position) return;
    const data = (node.data ??= {}) as { hProperties?: Record<string, unknown> };
    data.hProperties = {
      ...data.hProperties,
      dataSl: String(node.position.start.line),
      dataEl: String(node.position.end.line),
    };
  });
}

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'listItem',
  'code',
  'blockquote',
  'tableRow',
  'thematicBreak',
]);

const ITEM_CLASSES = ['item', 'done', ...ITEM_TYPES.map((t) => `item-${t}`)];
const ITEM_DATA = [
  'dataText',
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
  tagNames: [...(defaultSchema.tagNames ?? []), 'aside', 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    // The default allows only one class on links; the first className rule wins, so replace it.
    a: [
      ...(defaultSchema.attributes?.a ?? []).filter(
        (x) => !(Array.isArray(x) && x[0] === 'className'),
      ),
      ['className', 'wikilink', 'missing', 'archived', 'tag', 'data-footnote-backref'],
    ],
    // Source lines on every block (for tap-to-edit).
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'dataSl', 'dataEl'],
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

function Img({ src, alt: rawAlt, title }: ComponentProps<'img'>) {
  const [zoom, setZoom] = useState(false);
  // "![alt|320](…)": an image resized in the editor (width in pixels; the height follows).
  const sized = /^(.*)\|(\d{2,5})$/.exec(rawAlt ?? '');
  const alt = sized ? sized[1] : rawAlt;
  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        style={sized ? { width: `${sized[2]}px` } : undefined}
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

/** A typed item as a card: check it off (when the page allows), label, text, due date. */
type Handlers = {
  onToggle?: (line: number, done: boolean) => void;
  onAnswer?: (line: number, answer: string) => void;
  onEdit?: (line: number, edit: ItemEdit) => Promise<void>;
  onDelete?: (line: number) => void;
};

/**
 * The item handlers, passed by context rather than baked into the rendered tree: the tree's
 * components stay the same from render to render, so checking an item off updates it in place
 * instead of rebuilding the whole page (which reloaded images and diagrams and made it jump).
 */
const ItemHandlers = createContext<Handlers>({});

const ItemLi = (props: ItemProps) => <ItemOrPlain Tag="li" {...props} />;
const ItemDiv = (props: ItemProps) => <ItemOrPlain Tag="div" {...props} />;

function ItemOrPlain({ Tag, ...props }: ItemProps & { Tag: 'li' | 'div' }) {
  const { onToggle, onAnswer, onEdit, onDelete } = useContext(ItemHandlers);
  const [editing, setEditing] = useState(false);
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
  const dueTime = props['data-due-time'];
  const reminder = type === 'reminder';
  // Reminders are nudges: no checkbox, never overdue; once their moment passes they're "Past".
  const past = reminder && reminderPast({ type, due: due ?? null, due_time: dueTime }, nowMoment());
  const overdue = !done && isOverdue({ type, due: due ?? null }, todayKey());
  const label = ITEM_LABELS[type] ?? type;
  const words = reminder ? (past ? 'Past · ' : 'Scheduled for ') : overdue ? 'Overdue · ' : 'Due ';
  const dated = !!due;
  // While it's being edited, the editor takes the item's place.
  if (editing && onEdit)
    return (
      <Tag
        className={`${className} item-editing`}
        id={`item-${line}`}
        data-sl={props['data-sl']}
        data-el={props['data-el']}
      >
        <ItemEditor
          item={{
            type,
            text: props['data-text'] ?? '',
            due: due ?? null,
            due_time: dueTime ?? null,
          }}
          onCancel={() => setEditing(false)}
          onSave={async (edit) => {
            await onEdit(line, edit);
            setEditing(false);
          }}
        />
      </Tag>
    );
  return (
    <Tag
      className={`${className}${past ? ' item-past' : ''}`}
      id={`item-${line}`}
      data-sl={props['data-sl']}
      data-el={props['data-el']}
    >
      {reminder ? (
        <span className="item-bell" aria-hidden>
          <Icon name="bell" size={11} />
        </span>
      ) : (
        <button
          type="button"
          className="item-check"
          role="checkbox"
          aria-checked={done}
          aria-label={`${done ? 'Reopen' : type === 'question' ? 'Resolve' : 'Complete'}: ${label}`}
          disabled={!onToggle}
          onClick={() => onToggle?.(line, !done)}
        />
      )}
      <div className="item-main">
        <span className="item-label">{type}</span>
        <div className="item-text">{children}</div>
        {(dated || props['data-invalid']) && (
          <span className="item-meta">
            {dated &&
              (onEdit && !done ? (
                <button
                  type="button"
                  className={`item-due-btn${overdue ? ' overdue' : ''}`}
                  onClick={() => setEditing(true)}
                >
                  <Icon name="calendar" size={13} />
                  {words}
                  {formatDue(due!, dueTime)}
                </button>
              ) : (
                <span className={overdue ? 'overdue' : undefined}>
                  {words}
                  {formatDue(due!, dueTime)}
                </span>
              ))}
            {props['data-invalid'] && <span className="overdue">{props['data-invalid']}</span>}
          </span>
        )}
        {type === 'question' && (
          <AnswerBox
            answer={props['data-answer'] ?? null}
            onAnswer={
              onAnswer && !(done && !props['data-answer']) ? (t) => onAnswer(line, t) : undefined
            }
          />
        )}
      </div>
      <ItemActions
        onEdit={onEdit ? () => setEditing(true) : undefined}
        onDelete={onDelete ? () => onDelete(line) : undefined}
      />
    </Tag>
  );
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
  onEditItem,
  onDeleteItem,
  noItems = false,
}: {
  source: string;
  titles: TitleIndex;
  /** Show todo:/question:/reminder: lines as plain text (AI session entries can't hold items). */
  noItems?: boolean;
  /** Lets readers check items off; without it the checkboxes are shown but disabled. */
  onToggleItem?: (line: number, done: boolean) => void;
  /** Lets readers answer questions in place. */
  onAnswerItem?: (line: number, answer: string) => void;
  /** Lets readers edit an item (type, text, date, time) in place. */
  onEditItem?: (line: number, edit: ItemEdit) => Promise<void>;
  /** Lets readers delete an item. */
  onDeleteItem?: (line: number) => void;
}): ReactNode {
  const handlers = useMemo<Handlers>(
    () => ({
      onToggle: onToggleItem,
      onAnswer: onAnswerItem,
      onEdit: onEditItem,
      onDelete: onDeleteItem,
    }),
    [onToggleItem, onAnswerItem, onEditItem, onDeleteItem],
  );
  const rendered = useMemo(() => {
    const tree = fromMarkdown(source, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    transform(tree, titles, source, !noItems);
    const hast = sanitize(toHast(tree), schema);
    return toJsxRuntime(hast, { Fragment, jsx, jsxs, components: COMPONENTS });
  }, [source, titles, noItems]);
  return <ItemHandlers.Provider value={handlers}>{rendered}</ItemHandlers.Provider>;
});

const COMPONENTS = {
  a: Anchor,
  img: Img,
  table: TableWrap,
  pre: Pre,
  li: ItemLi,
  div: ItemDiv,
};
