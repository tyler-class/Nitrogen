// Markdown editor (CodeMirror 6). Images pasted, dropped or picked are uploaded to R2 and their
// markdown is put exactly where the cursor (or drop point) was.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { uploadImage, errorMessage } from '../lib/api';

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '650', color: 'var(--ink)' },
  { tag: tags.heading1, fontSize: '1.25em' },
  { tag: tags.heading2, fontSize: '1.12em' },
  { tag: tags.link, color: 'var(--accent-ink)' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--claude)' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--faint)' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '15px', color: 'var(--ink)', background: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', overflow: 'visible' },
  '.cm-content': { padding: '8px 0 40vh', caretColor: 'var(--ink)', maxWidth: '100%' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    background: 'color-mix(in srgb, var(--accent) 25%, transparent) !important',
  },
  '.cm-tooltip': {
    background: 'var(--paper)',
    border: '1px solid var(--hairline)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--accent-soft)',
    color: 'var(--ink)',
  },
});

export interface EditorHandle {
  focus(): void;
  /** Opens the file picker and inserts the chosen images at the cursor. */
  pickImages(): void;
  /** Wraps the selection (or inserts at the cursor). */
  wrap(before: string, after?: string): void;
}

interface Props {
  value: string;
  pageId: string;
  titles: string[];
  onChange(value: string): void;
  onSave(): void;
  onError(message: string): void;
}

function isImage(f: File) {
  return /^image\/(png|jpe?g|gif|webp|avif)$/.test(f.type);
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Latest props for long-lived CodeMirror callbacks.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  /** Inserts a placeholder at `pos`, uploads, then swaps the placeholder for the real markdown. */
  async function insertImages(files: File[], pos?: number) {
    const v = view.current;
    if (!v) return;
    for (const file of files.filter(isImage)) {
      const token = `uploading-${Math.random().toString(36).slice(2, 10)}`;
      const placeholderText = `![Uploading ${file.name.replace(/[[\]]/g, '')}…](${token})`;
      const at = pos ?? v.state.selection.main.head;
      const line = v.state.doc.lineAt(at);
      // Images go on their own line.
      const before = at > line.from && line.text.trim() ? '\n\n' : '';
      const after = '\n';
      v.dispatch({
        changes: { from: at, insert: `${before}${placeholderText}${after}` },
        selection: { anchor: at + before.length + placeholderText.length + after.length },
      });
      pos = undefined;
      const swap = (insert: string) => {
        const doc = v.state.doc.toString();
        const i = doc.indexOf(placeholderText);
        if (i >= 0) v.dispatch({ changes: { from: i, to: i + placeholderText.length, insert } });
      };
      try {
        const up = await uploadImage(file, latest.current.pageId);
        swap(up.markdown);
      } catch (e) {
        swap('');
        latest.current.onError(`${file.name}: ${errorMessage(e)}`);
      }
    }
  }
  const insertRef = useRef(insertImages);
  insertRef.current = insertImages;

  useEffect(() => {
    const wikilinks = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/\[\[[^\]\n]*$/);
      if (!m) return null;
      return {
        from: m.from + 2,
        options: latest.current.titles.map((t) => ({ label: t, apply: `${t}]]`, type: 'text' })),
        validFor: /^[^\]\n]*$/,
      };
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(highlight),
          theme,
          placeholder('Write in markdown. Type [[ to link a page. Paste or drop images.'),
          autocompletion({ override: [wikilinks], icons: false }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                latest.current.onSave();
                return true;
              },
            },
            { key: 'Mod-b', run: (ed) => (wrapSel(ed, '**'), true) },
            { key: 'Mod-i', run: (ed) => (wrapSel(ed, '_'), true) },
            { key: 'Mod-k', run: (ed) => (wrapSel(ed, '[', '](https://)'), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(e) {
              const files = [...(e.clipboardData?.files ?? [])].filter(isImage);
              if (!files.length) return false;
              e.preventDefault();
              void insertRef.current(files);
              return true;
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files ?? [])].filter(isImage);
              if (!files.length) return false;
              e.preventDefault();
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
              void insertRef.current(files, pos);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // The editor is created once per page; value changes flow out through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pageId]);

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    pickImages: () => fileInput.current?.click(),
    wrap: (before, after) => view.current && wrapSel(view.current, before, after),
  }));

  return (
    <>
      <div ref={host} className="editor" />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void insertImages(files);
          view.current?.focus();
        }}
      />
    </>
  );
});

function wrapSel(v: EditorView, before: string, after = before) {
  const { from, to } = v.state.selection.main;
  const text = v.state.sliceDoc(from, to);
  v.dispatch({
    changes: { from, to, insert: `${before}${text}${after}` },
    selection: text
      ? { anchor: from + before.length, head: to + before.length }
      : { anchor: from + before.length },
  });
  v.focus();
}
