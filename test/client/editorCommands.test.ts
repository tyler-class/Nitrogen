// The editor's commands: formats come off reliably, headings keep the selection, callouts are
// easy to take away and never land inside one another.
import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import {
  backspace,
  editorCommands,
  inLink,
  setLineKind,
  setLinkAddress,
  toggleFormat,
  unlink,
} from '../../src/client/components/editorCommands';
import {
  BlockHost,
  livePreview,
  NO_UNDERLINED_HEADINGS,
  setFocus,
} from '../../src/client/components/livePreview';
import { insertBlock } from '../../src/client/components/slashCommands';

/** Just enough of an EditorView for the commands: a state, and dispatch. */
function fake(doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [
      markdown({ base: markdownLanguage, extensions: NO_UNDERLINED_HEADINGS }),
      livePreview({
        blocks: new BlockHost(),
        answers: new BlockHost(),
        resolve: () => null,
        open: () => undefined,
        editDue: () => undefined,
      }),
      editorCommands(),
    ],
  });
  state = state.update({ effects: setFocus.of(true) }).state;
  ensureSyntaxTree(state, state.doc.length, 1000);
  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: TransactionSpec[]) {
      state = state.update(...specs).state;
      ensureSyntaxTree(state, state.doc.length, 1000);
    },
  };
  return view as unknown as EditorView;
}
const sel = (v: EditorView) => [v.state.selection.main.anchor, v.state.selection.main.head];

describe('formats', () => {
  it('takes inline code off the selected text again', () => {
    const v = fake('a word here', 2, 6);
    toggleFormat(v, 'code');
    expect(v.state.doc.toString()).toBe('a `word` here');
    toggleFormat(v, 'code');
    expect(v.state.doc.toString()).toBe('a word here');
    expect(sel(v)).toEqual([2, 6]);
  });

  it('takes a highlight off even when the selection only partly covers it', () => {
    const v = fake('a ==word== here', 5, 13);
    toggleFormat(v, 'highlight');
    expect(v.state.doc.toString()).toBe('a word here');
  });

  it('takes a highlight off when the selection takes in its marks', () => {
    const v = fake('a ==word== here', 2, 10);
    toggleFormat(v, 'highlight');
    expect(v.state.doc.toString()).toBe('a word here');
  });
});

describe('line kinds', () => {
  it('keeps selected text selected when the line becomes a heading', () => {
    const v = fake('Hello world', 6, 11);
    setLineKind(v, 'h2');
    expect(v.state.doc.toString()).toBe('## Hello world');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('world');
  });

  it('keeps the cursor where it was in the text', () => {
    const v = fake('Hello world', 3);
    setLineKind(v, 'h1');
    expect(sel(v)).toEqual([5, 5]);
  });
});

describe('callouts', () => {
  it('puts a blank line between a new callout and one right above it', () => {
    const doc = '> [!NOTE]\n> First\n';
    const v = fake(doc, doc.length);
    insertBlock(v, 'Tip', () => undefined);
    expect(v.state.doc.toString()).toBe('> [!NOTE]\n> First\n\n> [!TIP]\n> ');
  });

  it('takes away an empty callout with Backspace on its empty line', () => {
    const doc = 'Above\n> [!NOTE]\n> \nBelow';
    const v = fake(doc, doc.indexOf('\nBelow'));
    expect(backspace(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('Above\n\nBelow');
  });

  it('leaves the writing as text when Backspace is at the start of its first line', () => {
    const doc = '> [!TIP]\n> Keep this\n> And this';
    const v = fake(doc, doc.indexOf('Keep'));
    expect(backspace(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('Keep this\nAnd this');
  });

  it('joins a later line to the one above, inside the callout', () => {
    const doc = '> [!TIP]\n> One\n> ';
    const v = fake(doc, doc.length);
    expect(backspace(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('> [!TIP]\n> One');
  });
});

describe('the cursor on an empty heading or quote line', () => {
  it('has something to stand beside, so it shows', () => {
    for (const doc of ['# ', '> [!NOTE]\n> ', '> [!NOTE]\n> ## ', '> ### ']) {
      let state = EditorState.create({
        doc,
        selection: EditorSelection.cursor(doc.length),
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
      const classes: string[] = [];
      for (const set of state.facet(EditorView.decorations)) {
        if (typeof set === 'function') continue;
        (set as DecorationSet).between(0, doc.length, (_f, _t, d) => {
          const w = (d.spec as { widget?: { cls?: string } }).widget;
          if (w?.cls) classes.push(w.cls);
        });
      }
      expect(classes.some((c) => c.includes('cm-caret-anchor'))).toBe(true);
    }
  });
});

describe('inside a callout', () => {
  it('keeps a bullet, heading or quote inside the callout', () => {
    const doc = '> [!NOTE]\n> hello';
    for (const [kind, out] of [
      ['bullet', '> [!NOTE]\n> - hello'],
      ['h2', '> [!NOTE]\n> ## hello'],
      ['quote', '> [!NOTE]\n> > hello'],
    ] as const) {
      const v = fake(doc, doc.length);
      setLineKind(v, kind);
      expect(v.state.doc.toString()).toBe(out);
    }
  });

  it('takes the bullet off again, still inside the callout', () => {
    const doc = '> [!NOTE]\n> - hello';
    const v = fake(doc, doc.length);
    setLineKind(v, 'bullet');
    expect(v.state.doc.toString()).toBe('> [!NOTE]\n> hello');
  });

  it('makes no to-dos, questions or reminders there', () => {
    const doc = '> [!NOTE]\n> hello';
    const v = fake(doc, doc.length);
    expect(setLineKind(v, 'todo')).toBe(false);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('keeps a plain quote line in its quote when it becomes a list item', () => {
    const v = fake('> hello', 7);
    setLineKind(v, 'bullet');
    expect(v.state.doc.toString()).toBe('> - hello');
  });

  it('starts a new line inside the callout for a list from the menu', () => {
    const doc = '> [!NOTE]\n> hello ';
    const v = fake(doc, doc.length);
    insertBlock(v, 'Bulleted list', () => undefined);
    expect(v.state.doc.toString()).toBe('> [!NOTE]\n> hello \n> - ');
  });
});

describe('dividing lines', () => {
  it('goes with Backspace at the start of the line under it', () => {
    const doc = 'Above\n\n---\nBelow';
    const v = fake(doc, doc.indexOf('Below'));
    expect(backspace(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('Above\n\nBelow');
  });

  it('goes with Backspace on the empty line under it', () => {
    const doc = 'Above\n\n---\n\nBelow';
    const v = fake(doc, doc.indexOf('---') + 4);
    expect(backspace(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('Above\n\n\nBelow');
  });
});

describe('links', () => {
  it('knows a selection over a link, hidden marks and all', () => {
    const doc = 'See [the site](https://a.com) now';
    const v = fake(doc, 4, 29);
    expect(inLink(v.state)).toBe(true);
  });

  it('changes the address and takes the link off', () => {
    const doc = 'See [the site](https://a.com) now';
    const v = fake(doc, 8);
    setLinkAddress(v, 5, 'b.org');
    expect(v.state.doc.toString()).toBe('See [the site](https://b.org) now');
    expect(unlink(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('See the site now');
  });
});

describe("a callout's top line", () => {
  it("never holds the cursor: it goes into the callout's text", () => {
    const doc = 'Above\n> [!NOTE]\n> Body';
    const v = fake(doc, 0);
    v.dispatch({ selection: { anchor: doc.indexOf(']') + 1 } });
    expect(v.state.selection.main.head).toBe(doc.indexOf('Body'));
  });

  it('sends the cursor above the callout when it moves up into it', () => {
    const doc = 'Above\n> [!NOTE]\n> Body';
    const v = fake(doc, doc.indexOf('Body'));
    v.dispatch({ selection: { anchor: doc.indexOf(']') + 1 } });
    expect(v.state.selection.main.head).toBe(5);
  });
});

describe('typing "-" under a line', () => {
  it('starts a list item, not a heading made of the line above', () => {
    const doc = '> [!NOTE]\n> - ';
    const v = fake(doc, doc.length);
    const names: string[] = [];
    ensureSyntaxTree(v.state, doc.length, 1000)!.iterate({ enter: (n) => void names.push(n.name) });
    expect(names.some((n) => n.startsWith('SetextHeading'))).toBe(false);
    expect(names.filter((n) => n === 'QuoteMark')).toHaveLength(2);
  });
});

describe('adding a dividing line', () => {
  it('puts the cursor on the line right under it', () => {
    const doc = 'Above\n';
    const v = fake(doc, doc.length);
    insertBlock(v, 'Divider', () => undefined);
    expect(v.state.doc.toString()).toBe('Above\n\n---\n');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });
});
