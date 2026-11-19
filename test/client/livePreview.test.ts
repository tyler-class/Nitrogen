// The editor's live preview: what's hidden and drawn, list lines, and tables.
import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import {
  BlockHost,
  livePreview,
  markerFor,
  parseListLine,
  setFocus,
} from '../../src/client/components/livePreview';
import { parseTable, writeTable } from '../../src/client/components/tableWidget';

function decos(doc: string, cursor?: number) {
  let state = EditorState.create({
    doc,
    selection: cursor === undefined ? undefined : EditorSelection.cursor(cursor),
    extensions: [
      markdown({ base: markdownLanguage }),
      livePreview({
        blocks: new BlockHost(),
        answers: new BlockHost(),
        resolve: (t) => (t.toLowerCase() === 'roadmap' ? { href: '/p/abc/roadmap' } : null),
        open: () => undefined,
        editDue: () => undefined,
      }),
    ],
  });
  if (cursor !== undefined) state = state.update({ effects: setFocus.of(true) }).state;
  const out: { from: number; to: number; text: string; kind: string; cls?: string }[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue;
    (set as DecorationSet).between(0, doc.length, (from, to, d) => {
      const spec = d.spec as {
        widget?: { constructor: { name: string } };
        class?: string;
        attributes?: { class?: string };
      };
      out.push({
        from,
        to,
        text: doc.slice(from, to),
        kind: spec.widget ? spec.widget.constructor.name : from === to ? 'line' : 'mark',
        cls: spec.class ?? spec.attributes?.class,
      });
    });
  }
  return out;
}

describe('live preview', () => {
  it('marks which hidden marks open and close a format', () => {
    const doc = 'Some **bold** text';
    const roles: string[] = [];
    let state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreview({
          blocks: new BlockHost(),
          answers: new BlockHost(),
          resolve: () => null,
          open: () => undefined,
          editDue: () => undefined,
        }),
      ],
    });
    state = state.update({ effects: setFocus.of(true) }).state;
    for (const set of state.facet(EditorView.decorations))
      if (typeof set !== 'function')
        (set as DecorationSet).between(0, doc.length, (f, t, d) => {
          const role = (d.spec as { role?: string }).role;
          if (role) roles.push(`${doc.slice(f, t)}:${role}`);
        });
    expect(roles).toEqual(['**:open', '**:close']);
  });

  it('hides marks, even on the line being edited', () => {
    const doc = '# Title\n\nSome **bold** text';
    for (const d of [decos(doc), decos(doc, 3), decos(doc, 15)]) {
      expect(d.find((x) => x.text === '# ')).toBeTruthy();
      expect(d.filter((x) => x.text === '**')).toHaveLength(2);
    }
  });

  it('draws list lines with a marker for their level', () => {
    const doc = '- one\n  - two\n    - three\n1. first\n   1. sub';
    const d = decos(doc);
    // Each line's start is kept in the text at no size, with its marker drawn beside it.
    expect(d.filter((x) => x.kind === 'PrefixWidget')).toHaveLength(5);
    expect(d.filter((x) => x.cls === 'cm-conceal').map((x) => x.text)).toEqual([
      '- ',
      '  - ',
      '    - ',
      '1. ',
      '   1. ',
    ]);
    expect(markerFor(1, null)).toBe('•');
    expect(markerFor(2, null)).toBe('◦');
    expect(markerFor(3, null)).toBe('▪');
    expect(markerFor(1, 3)).toBe('3.');
    expect(markerFor(2, 2)).toBe('b.');
    expect(markerFor(3, 4)).toBe('iv.');
  });

  it('draws callouts, items, due dates and page links', () => {
    const doc = [
      '> [!TIP]',
      '> Use it.',
      '',
      '- [ ] todo: Ship it due:2026-12-01',
      '- question: Why?',
      '',
      'See [[Roadmap]] and [[Nowhere]].',
    ].join('\n');
    const d = decos(doc);
    expect(d.some((x) => x.kind === 'CalloutLabel')).toBe(true);
    expect(d.some((x) => x.cls === 'cm-conceal' && x.text === '> [!TIP]')).toBe(true);
    expect(d.some((x) => x.cls === 'cm-conceal' && x.text === '- [ ] todo: ')).toBe(true);
    expect(d.some((x) => x.cls === 'cm-conceal' && x.text === '- question: ')).toBe(true);
    expect(d.some((x) => x.kind === 'DueWidget' && x.text === ' due:2026-12-01')).toBe(true);
    // Page links are one piece each.
    expect(d.some((x) => x.kind === 'PageLink' && x.text === '[[Roadmap]]')).toBe(true);
    expect(d.some((x) => x.kind === 'PageLink' && x.text === '[[Nowhere]]')).toBe(true);
    expect(d.some((x) => x.kind === 'line' && x.cls?.includes('cm-blank'))).toBe(true);
  });

  it('draws tables as a grid, and Mermaid as a diagram until the cursor goes in', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\nflowchart LR\n  A --> B\n```\n';
    const d = decos(doc);
    expect(d.filter((x) => x.kind === 'TableWidget')).toHaveLength(1);
    expect(d.filter((x) => x.kind === 'DiagramWidget')).toHaveLength(1);
    const editing = decos(doc, doc.indexOf('A -->'));
    expect(editing.some((x) => x.cls?.includes('cm-mermaid-src'))).toBe(true);
    // The table stays a grid with the cursor next to it.
    expect(decos(doc, 2).filter((x) => x.kind === 'TableWidget')).toHaveLength(1);
  });
});

describe('list lines', () => {
  it('reads bullets, numbers, checkboxes and item types', () => {
    expect(parseListLine('  - [x] todo: Ship due:2026-01-01')).toMatchObject({
      indent: 2,
      bullet: '-',
      box: 4,
      done: true,
      type: 'todo',
      content: 14,
    });
    expect(parseListLine('3) step')).toMatchObject({ num: 3, delim: ')', content: 3 });
    expect(parseListLine('question: why?')).toMatchObject({ type: 'question', content: 10 });
    expect(parseListLine('- [ ] todo: ')).toMatchObject({ type: 'todo', content: 12 });
    expect(parseListLine('plain text')).toBeNull();
    expect(parseListLine('---')).toBeNull();
  });
});

describe('tables', () => {
  it('round-trips, escaping pipes and keeping alignment', () => {
    const t = parseTable('| a | b \\| c |\n| :--- | ---: |\n| 1 |  |');
    expect(t.rows).toEqual([
      ['a', 'b | c'],
      ['1', ''],
    ]);
    expect(t.align).toEqual(['left', 'right']);
    expect(writeTable(t)).toBe('| a | b \\| c |\n| :--- | ---: |\n| 1 |  |');
  });
});
