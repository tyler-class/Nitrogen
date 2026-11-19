// The editor's two small pop-ups: a format bar over selected text (bold, italic, strikethrough,
// code, link), and a card for the link the cursor is in (open it, change the address, unlink).
import { StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view';
import {
  editLink,
  formatActive,
  linkCommand,
  pending,
  toggleFormat,
  type Format,
} from './editorCommands';
import { iconElement } from './Icon';
import { live, liveConfig, type LinkSpot } from './livePreview';

const coarse = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

function button(label: string, title: string, run: () => void, icon?: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  if (icon) b.appendChild(iconElement(icon, 15));
  else b.innerHTML = label;
  // Keep the editor's focus and selection.
  b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    run();
  });
  return b;
}

// -------------------------------------------------------------- format bar

const FORMATS: { f: Format; label: string; title: string }[] = [
  { f: 'bold', label: '<b>B</b>', title: 'Bold (⌘B)' },
  { f: 'italic', label: '<i>I</i>', title: 'Italic (⌘I)' },
  { f: 'strike', label: '<s>S</s>', title: 'Strikethrough (⌘⇧X)' },
  { f: 'code', label: '<code>&lt;/&gt;</code>', title: 'Code (⌘E)' },
  { f: 'highlight', label: '<span class="fb-mark">A</span>', title: 'Highlight (⌘⇧H)' },
];

function formatBar(state: EditorState): Tooltip | null {
  const sel = state.selection.main;
  const { focused, blocks } = state.field(live);
  // Phones have the format bar at the bottom instead.
  if (!focused || sel.empty || coarse()) return null;
  if (blocks.some(([a, b]) => sel.from >= a && sel.to <= b)) return null;
  return {
    pos: sel.from,
    end: sel.to,
    above: true,
    arrow: false,
    create(view) {
      const dom = document.createElement('div');
      dom.className = 'cm-format-bar';
      dom.setAttribute('role', 'toolbar');
      dom.setAttribute('aria-label', 'Format');
      const items = FORMATS.map(({ f, label, title }) => {
        const b = button(label, title, () => toggleFormat(view, f));
        dom.appendChild(b);
        return { f, b };
      });
      dom.appendChild(button('', 'Link (⌘K)', () => linkCommand(view), 'link'));
      const sync = (s: EditorState) =>
        items.forEach(({ f, b }) => b.classList.toggle('on', formatActive(s, f)));
      sync(view.state);
      return { dom, update: (u) => sync(u.state) };
    },
  };
}

// --------------------------------------------------------------- link card

interface Card {
  spot: LinkSpot;
  editing: boolean;
}

const card = StateField.define<Card | null>({
  create: () => null,
  update(value, tr) {
    const { links, focused } = tr.state.field(live);
    for (const e of tr.effects)
      if (e.is(editLink)) {
        if (e.value === null) return null;
        const spot = links.find((l) => l.from <= e.value! && l.to >= e.value!);
        return spot ? { spot, editing: true } : null;
      }
    if (value?.editing && !tr.docChanged) return value;
    const sel = tr.state.selection.main;
    if (!focused || !sel.empty) return value?.editing ? value : null;
    const spot = links.find((l) => sel.head > l.from && sel.head < l.to);
    if (!spot) return null;
    return { spot, editing: false };
  },
  provide: (f) =>
    showTooltip.compute([f], (state) => {
      const c = state.field(f);
      if (!c) return null;
      return {
        pos: c.spot.from,
        end: c.spot.to,
        above: false,
        arrow: false,
        create: (view) => linkCard(view, c),
      };
    }),
});

function linkCard(view: EditorView, c: Card) {
  const { spot } = c;
  const dom = document.createElement('div');
  dom.className = 'cm-link-card';
  const open = () => {
    if (spot.href) view.state.facet(liveConfig).open(spot.href);
  };
  if (c.editing && spot.kind === 'link') {
    const input = document.createElement('input');
    input.className = 'cm-link-input';
    input.type = 'url';
    input.placeholder = 'Paste or type a link';
    input.value = spot.href ?? '';
    input.setAttribute('aria-label', 'Link address');
    const done = (save: boolean) => {
      if (save) {
        let url = input.value.trim();
        if (url && !/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(url)) url = `https://${url}`;
        const fresh = view.state.field(live).links.find((l) => l.from === spot.from);
        if (fresh?.urlFrom !== undefined)
          view.dispatch({ changes: { from: fresh.urlFrom, to: fresh.urlTo!, insert: url } });
      }
      view.dispatch({ effects: editLink.of(null) });
      view.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    });
    input.addEventListener('blur', () => setTimeout(() => dom.isConnected && done(true)));
    dom.appendChild(input);
    requestAnimationFrame(() => input.focus());
    return { dom };
  }
  const where = document.createElement('span');
  where.className = 'cm-link-where';
  where.textContent =
    spot.kind === 'tag'
      ? 'Pages with this tag'
      : spot.kind === 'wiki'
        ? spot.href
          ? 'Page'
          : 'No page has this title yet'
        : (spot.href ?? '').replace(/^https?:\/\/(www\.)?/, '');
  dom.appendChild(where);
  if (spot.href) dom.appendChild(button('Open', 'Open the link (⌘-click)', open, 'expand'));
  if (spot.kind === 'link')
    dom.appendChild(
      button(
        '',
        'Change the address',
        () => view.dispatch({ effects: editLink.of(spot.from) }),
        'edit',
      ),
    );
  if (spot.kind === 'link' || spot.kind === 'wiki')
    dom.appendChild(
      button(
        '',
        'Remove the link',
        () => {
          const text =
            spot.kind === 'link'
              ? view.state.sliceDoc(spot.labelFrom!, spot.labelTo!)
              : (/\|([^\]]+)\]\]$/.exec(view.state.sliceDoc(spot.from, spot.to))?.[1] ??
                /^\[\[([^\]|#]+)/.exec(view.state.sliceDoc(spot.from, spot.to))?.[1] ??
                '');
          // A markdown link's source runs from its "[" to its ")".
          const from = spot.kind === 'link' ? spot.from - 1 : spot.from;
          const to =
            spot.kind === 'link'
              ? (view.state.field(live).links.find((l) => l.from === spot.from)?.urlTo ?? spot.to) +
                1
              : spot.to;
          view.dispatch({ changes: { from, to, insert: text } });
          view.focus();
        },
        'close',
      ),
    );
  return { dom };
}

export function editorTooltips(): Extension {
  return [card, showTooltip.compute(['selection', live, pending], formatBar)];
}
