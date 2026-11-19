// How marked-up text looks in the editors (the page editor and the small answer editor).
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/** How marked-up text looks (bold, italic, code…), shared with the small answer editor. */
export const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700', color: 'var(--ink)' },
  { tag: tags.link, color: 'var(--accent-ink)' },
  { tag: tags.url, color: 'var(--faint)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: 'var(--faint)' },
  // Code inside fenced blocks.
  { tag: tags.keyword, color: 'var(--claude)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--info)' },
  { tag: tags.comment, color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--warn)' },
]);
