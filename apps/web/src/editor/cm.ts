/** CodeMirror setup: markdown, wikilink autocomplete, slash menu, CFM lint, save keymap. */
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, placeholder } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { lintPage, autofix, type VaultContext } from '@nitrogen/core';
import { SNIPPETS } from './snippets.ts';

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600', color: 'var(--ink)' },
  { tag: tags.link, color: 'var(--accent-ink)' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'var(--claude)' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: tags.comment, color: 'var(--faint)' },
]);

export const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font, 14px)', background: 'var(--paper)', color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--ink)' },
  '.cm-gutters': { background: 'var(--sidebar)', color: 'var(--faint)', border: 'none' },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--accent-soft) 50%, transparent)' },
  '.cm-tooltip': { background: 'var(--paper)', border: '1px solid var(--hairline)', borderRadius: '8px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'color-mix(in srgb, var(--accent) 25%, transparent) !important' },
});

function wikilinkSource(getCtx: () => VaultContext | null) {
  return (c: CompletionContext): CompletionResult | null => {
    const m = c.matchBefore(/\[\[[^\]\n]*$/);
    if (!m) return null;
    const ctx = getCtx();
    if (!ctx) return null;
    return {
      from: m.from + 2,
      options: ctx.pages.flatMap((p) => [
        { label: p.title, detail: p.path, apply: `${p.title}]]`, type: 'text' },
        ...p.aliases.map((a) => ({ label: a, detail: `alias of ${p.title}`, apply: `${a}]]`, type: 'text' })),
      ]),
      validFor: /^[^\]\n]*$/,
    };
  };
}

function slashSource(c: CompletionContext): CompletionResult | null {
  const m = c.matchBefore(/(?:^|\s)\/[\w-]*$/);
  if (!m) return null;
  const from = m.text.startsWith('/') ? m.from : m.from + 1;
  return {
    from,
    options: SNIPPETS.map((s) => ({
      label: `/${s.label}`,
      type: 'keyword',
      apply: (view: EditorView, _c: unknown, f: number, to: number) => insertSnippet(view, s.text, f, to, s.block),
    })),
  };
}

export function insertSnippet(view: EditorView, text: string, from?: number, to?: number, block = false): void {
  const sel = view.state.selection.main;
  const f = from ?? sel.from;
  const t = to ?? sel.to;
  const line = view.state.doc.lineAt(f);
  const needsBreak = block && f !== line.from && line.text.slice(0, f - line.from).trim() !== '';
  const prefix = needsBreak ? '\n\n' : '';
  const cursor = text.indexOf('$|');
  const clean = text.replace('$|', '');
  view.dispatch({
    changes: { from: f, to: t, insert: prefix + clean },
    selection: { anchor: f + prefix.length + (cursor < 0 ? clean.length : cursor) },
    scrollIntoView: true,
  });
  view.focus();
}

export function cfmLinter(getCtx: () => VaultContext | null, path: string, onDiagnostics?: (d: ReturnType<typeof lintPage>) => void) {
  return linter(
    (view) => {
      const src = view.state.doc.toString();
      const diags = lintPage(src, getCtx(), { path });
      onDiagnostics?.(diags);
      const out: CmDiagnostic[] = [];
      for (const d of diags) {
        if (d.line < 1 || d.line > view.state.doc.lines) continue;
        const line = view.state.doc.line(d.line);
        const from = Math.min(line.from + Math.max(d.col - 1, 0), line.to);
        out.push({ from, to: line.to, severity: d.severity, message: `${d.code} ${d.message}${d.fix ? ` ${d.fix}` : ''}`, source: d.code });
      }
      return out;
    },
    { delay: 400 },
  );
}

export interface EditorConfig {
  doc: string;
  path: string;
  getCtx: () => VaultContext | null;
  onChange: (doc: string) => void;
  onSave: () => void;
  onScroll?: (ratio: number) => void;
  onDiagnostics?: (d: ReturnType<typeof lintPage>) => void;
}

export function createEditor(parent: HTMLElement, cfg: EditorConfig): EditorView {
  const extensions: Extension[] = [
    lineNumbers(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(highlight),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    autocompletion({ override: [wikilinkSource(cfg.getCtx), slashSource], icons: false }),
    lintGutter(),
    cfmLinter(cfg.getCtx, cfg.path, cfg.onDiagnostics),
    placeholder('Write markdown. Type / for blocks, [[ to link a page.'),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (cfg.onSave(), true) },
      { key: 'Mod-b', run: (v) => wrap(v, '**') },
      { key: 'Mod-i', run: (v) => wrap(v, '*') },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) cfg.onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      scroll: (_e, v) => {
        const s = v.scrollDOM;
        cfg.onScroll?.(s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight));
      },
    }),
    theme,
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown source', spellcheck: 'true', autocapitalize: 'sentences' }),
  ];
  return new EditorView({ state: EditorState.create({ doc: cfg.doc, extensions }), parent });
}

function wrap(view: EditorView, mark: string): boolean {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  view.dispatch({ changes: { from, to, insert: `${mark}${text}${mark}` }, selection: { anchor: from + mark.length, head: to + mark.length } });
  return true;
}

export function applyAutofix(view: EditorView, ctx: VaultContext | null, path: string): number {
  const src = view.state.doc.toString();
  const r = autofix(src, ctx, { path });
  if (r.src !== src) view.dispatch({ changes: { from: 0, to: src.length, insert: r.src } });
  return r.fixes.filter((f) => f.kind !== 'rename-suggestion').length;
}
