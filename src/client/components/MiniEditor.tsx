// A small editor for a short piece of markdown (a question's answer): the page editor's live
// preview, marks and keys, in a single field. Enter saves, Shift+Enter starts a new line (and
// carries a list on), Escape cancels.
import { useEffect, useRef } from 'react';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderText } from '@codemirror/view';
import { editorCommands, newLine } from './editorCommands';
import { BlockHost, livePreview } from './livePreview';
import { highlight } from './editorHighlight';

export default function MiniEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  onBlur,
  resolve,
  placeholder,
  label,
}: {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
  /** Leaving the field. */
  onBlur?(): void;
  /** A page title's address, for [[links]] in the text. */
  resolve(title: string): { href: string } | null;
  placeholder?: string;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ onChange, onSubmit, onCancel, onBlur, resolve });
  useEffect(() => {
    latest.current = { onChange, onSubmit, onCancel, onBlur, resolve };
  });

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        selection: { anchor: value.length },
        extensions: [
          history(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': label,
            autocorrect: 'on',
            autocapitalize: 'sentences',
            spellcheck: 'true',
          }),
          Prec.highest(
            keymap.of([
              {
                key: 'Enter',
                run: () => {
                  latest.current.onSubmit();
                  return true;
                },
                shift: newLine,
              },
              {
                key: 'Escape',
                run: () => {
                  latest.current.onCancel();
                  return true;
                },
              },
            ]),
          ),
          Prec.high(editorCommands()),
          markdown({ base: markdownLanguage, addKeymap: false }),
          syntaxHighlighting(highlight),
          livePreview({
            blocks: new BlockHost(),
            answers: new BlockHost(),
            resolve: (t) => latest.current.resolve(t),
            open: () => undefined,
            editDue: () => undefined,
          }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          EditorView.domEventHandlers({
            blur: () => {
              latest.current.onBlur?.();
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
    // Made once per opening; the text flows out through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="mini-editor qa-input" />;
}
