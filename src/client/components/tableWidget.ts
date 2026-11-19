// A markdown table drawn as a grid you type into. Each cell is a small text box; every change
// writes the table back as markdown in place. Tab and Shift-Tab move between cells (Tab past the
// last adds a row), Enter goes down a row, and the arrow keys leave the table at its top and
// bottom. The buttons under it add and remove rows and columns.
import { EditorView, WidgetType } from '@codemirror/view';

type Align = 'left' | 'center' | 'right' | null;

interface Table {
  rows: string[][];
  align: Align[];
}

/** Splits a row on its unescaped pipes. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseTable(source: string): Table {
  const lines = source.split('\n').filter((l) => l.trim());
  const head = cells(lines[0] ?? '');
  const align: Align[] = cells(lines[1] ?? '').map((d) => {
    const l = d.startsWith(':');
    const r = d.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  const width = Math.max(head.length, 1);
  const rows = [head, ...lines.slice(2).map(cells)].map((r) =>
    Array.from({ length: width }, (_, i) => r[i] ?? ''),
  );
  return { rows, align: Array.from({ length: width }, (_, i) => align[i] ?? null) };
}

export function writeTable(t: Table): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const row = (r: string[]) => `| ${r.map(esc).join(' | ')} |`;
  const delim = t.align.map((a) =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---',
  );
  return [row(t.rows[0]!), `| ${delim.join(' | ')} |`, ...t.rows.slice(1).map(row)].join('\n');
}

type Wrap = HTMLDivElement & { _src: string; _focus?: [number, number]; _refocus?: boolean };

/** Puts the cursor in a table's first cell (just inserted from the "/" menu). */
export function focusTableAt(view: EditorView, pos: number) {
  requestAnimationFrame(() => {
    for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.cm-table')) {
      if (view.posAtDOM(el) !== pos) continue;
      const box = el.querySelector<HTMLTextAreaElement>('textarea');
      box?.focus();
      box?.select();
      return;
    }
  });
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div') as Wrap;
    wrap.className = 'cm-table';
    wrap._src = this.source;
    render(view, wrap, parseTable(this.source));
    return wrap;
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    const wrap = dom as Wrap;
    if (!wrap.classList.contains('cm-table')) return false;
    wrap._src = this.source;
    const t = parseTable(this.source);
    const boxes = [...wrap.querySelectorAll<HTMLTextAreaElement>('textarea')];
    const same =
      boxes.length === t.rows.length * t.rows[0]!.length &&
      wrap.querySelectorAll('tr').length === t.rows.length;
    if (!same) {
      render(view, wrap, t);
      return true;
    }
    // Same shape: refresh the cells you aren't typing in.
    boxes.forEach((b, i) => {
      const r = Math.floor(i / t.rows[0]!.length);
      const c = i % t.rows[0]!.length;
      const v = t.rows[r]![c]!;
      if (document.activeElement !== b && b.value !== v) {
        b.value = v;
        fit(b);
      }
    });
    return true;
  }
  get estimatedHeight() {
    return 40 * (this.source.split('\n').length - 1) + 40;
  }
  ignoreEvent() {
    return true;
  }
}

function fit(b: HTMLTextAreaElement) {
  b.style.height = '0px';
  b.style.height = `${b.scrollHeight}px`;
}

function read(wrap: Wrap): Table {
  const t = parseTable(wrap._src);
  const rows = [...wrap.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('textarea')].map((b) => b.value),
  );
  return { rows, align: t.align };
}

/** Writes the grid back into the page as markdown. */
function commit(view: EditorView, wrap: Wrap, t: Table) {
  const from = view.posAtDOM(wrap);
  const next = writeTable(t);
  if (next === wrap._src) return;
  const to = from + wrap._src.length;
  wrap._src = next;
  view.dispatch({ changes: { from, to, insert: next }, userEvent: 'input.table' });
}

/** Leaves the table for the line above or below it. */
function leave(view: EditorView, wrap: Wrap, down: boolean) {
  const from = view.posAtDOM(wrap);
  const to = from + wrap._src.length;
  const doc = view.state.doc;
  let pos: number;
  if (down) {
    if (to >= doc.length) {
      view.dispatch({ changes: { from: doc.length, insert: '\n' } });
      pos = view.state.doc.length;
    } else pos = to + 1;
  } else pos = from > 0 ? from - 1 : from;
  view.focus();
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
}

function render(view: EditorView, wrap: Wrap, t: Table) {
  const focus = wrap._focus;
  wrap.textContent = '';
  const scroller = document.createElement('div');
  scroller.className = 'table-wrap';
  const table = document.createElement('table');
  const width = t.rows[0]!.length;
  const at = (r: number, c: number) =>
    table.querySelectorAll('tr')[r]?.querySelectorAll('textarea')[c] ?? null;
  const go = (r: number, c: number) => {
    const b = at(r, c);
    if (!b) return;
    b.focus();
    b.setSelectionRange(b.value.length, b.value.length);
  };
  const change = (mut: (t: Table) => void, then?: [number, number]) => {
    const cur = read(wrap);
    mut(cur);
    if (then) wrap._focus = then;
    wrap._refocus = true;
    commit(view, wrap, cur);
    render(view, wrap, cur);
  };
  t.rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    row.forEach((value, c) => {
      const cell = document.createElement(r === 0 ? 'th' : 'td');
      if (t.align[c]) cell.style.textAlign = t.align[c]!;
      const b = document.createElement('textarea');
      b.className = 'cm-cell';
      b.rows = 1;
      b.value = value;
      b.spellcheck = true;
      b.setAttribute(
        'aria-label',
        r === 0 ? `Column ${c + 1} heading` : `Row ${r}, column ${c + 1}`,
      );
      b.addEventListener('focus', () => {
        wrap._focus = [r, c];
        wrap.classList.add('active');
      });
      b.addEventListener('blur', () => {
        setTimeout(() => {
          if (!wrap.contains(document.activeElement)) wrap.classList.remove('active');
        });
      });
      b.addEventListener('input', () => {
        b.value = b.value.replace(/\n/g, ' ');
        fit(b);
        commit(view, wrap, read(wrap));
      });
      b.addEventListener('keydown', (e) => {
        const rows = table.querySelectorAll('tr').length;
        if (e.key === 'Tab') {
          e.preventDefault();
          if (e.shiftKey) {
            if (c > 0) go(r, c - 1);
            else if (r > 0) go(r - 1, width - 1);
          } else if (c < width - 1) go(r, c + 1);
          else if (r < rows - 1) go(r + 1, 0);
          else change((x) => x.rows.push(Array(width).fill('')), [r + 1, 0]);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (r < rows - 1) go(r + 1, c);
          else change((x) => x.rows.push(Array(width).fill('')), [r + 1, c]);
        } else if (e.key === 'ArrowUp' && b.selectionStart === 0) {
          e.preventDefault();
          if (r > 0) go(r - 1, c);
          else leave(view, wrap, false);
        } else if (e.key === 'ArrowDown' && b.selectionEnd === b.value.length) {
          e.preventDefault();
          if (r < rows - 1) go(r + 1, c);
          else leave(view, wrap, true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          leave(view, wrap, true);
        }
      });
      cell.appendChild(b);
      tr.appendChild(cell);
    });
    table.appendChild(tr);
  });
  scroller.appendChild(table);
  wrap.appendChild(scroller);

  // Add and remove rows and columns, for the cell you're in.
  const tools = document.createElement('div');
  tools.className = 'cm-table-tools';
  const tool = (label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      run();
    });
    tools.appendChild(b);
  };
  const pos = () => wrap._focus ?? [t.rows.length - 1, width - 1];
  tool('+ Row', () => {
    const [r, c] = pos();
    change(
      (x) => x.rows.splice(Math.max(1, r + 1), 0, Array(width).fill('')),
      [Math.max(1, r + 1), c],
    );
  });
  tool('+ Column', () => {
    const [r, c] = pos();
    change(
      (x) => {
        x.rows.forEach((row) => row.splice(c + 1, 0, ''));
        x.align.splice(c + 1, 0, null);
      },
      [r, c + 1],
    );
  });
  tool('Delete row', () => {
    const [r, c] = pos();
    if (r === 0 || t.rows.length <= 2) return;
    change((x) => x.rows.splice(r, 1), [Math.min(r, t.rows.length - 2), c]);
  });
  tool('Delete column', () => {
    const [r, c] = pos();
    if (width <= 1) return;
    change(
      (x) => {
        x.rows.forEach((row) => row.splice(c, 1));
        x.align.splice(c, 1);
      },
      [r, Math.max(0, c - 1)],
    );
  });
  wrap.appendChild(tools);

  requestAnimationFrame(() => {
    table.querySelectorAll('textarea').forEach(fit);
    if (focus && wrap.isConnected && wrap._refocus) go(focus[0], focus[1]);
    wrap._refocus = false;
  });
}
