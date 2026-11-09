// Line and word diffs between two versions of a page (the history's Compare view).
import { diffLines, diffWordsWithSpace } from 'diff';

export type Row =
  | { kind: 'same'; text: string }
  | { kind: 'del' | 'add'; text: string; words?: { text: string; changed: boolean }[] };

const linesOf = (s: string) => {
  const out = s.split('\n');
  if (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out;
};

type Word = { text: string; changed: boolean };

/** Neighbouring changed words, and the spaces between them, as one mark. */
function merge(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = out[out.length - 1];
    const bridge = !w.changed && /^\s+$/.test(w.text) && words[i + 1]?.changed && prev?.changed;
    if (prev && (w.changed || bridge) && prev.changed) prev.text += w.text;
    else out.push({ ...w, changed: w.changed });
  }
  return out;
}

/** The rows of a diff from `older` to `newer`. Exported for tests. */
export function diffRows(older: string, newer: string): Row[] {
  const rows: Row[] = [];
  const parts = diffLines(older, newer);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.added && !p.removed) {
      for (const text of linesOf(p.value)) rows.push({ kind: 'same', text });
      continue;
    }
    // A removal followed by an addition is a change: pair the lines and mark changed words.
    const next = parts[i + 1];
    if (p.removed && next?.added) {
      const del = linesOf(p.value);
      const add = linesOf(next.value);
      const n = Math.min(del.length, add.length);
      const dels: Row[] = [];
      const adds: Row[] = [];
      for (let k = 0; k < Math.max(del.length, add.length); k++) {
        if (k < n) {
          const w = diffWordsWithSpace(del[k]!, add[k]!);
          // Lines that share little are a replacement, not an edit: no word marks.
          const kept = w
            .filter((x) => !x.added && !x.removed)
            .reduce((n, x) => n + x.value.trim().length, 0);
          const shorter = Math.max(Math.min(del[k]!.trim().length, add[k]!.trim().length), 1);
          if (kept / shorter < 0.3) {
            dels.push({ kind: 'del', text: del[k]! });
            adds.push({ kind: 'add', text: add[k]! });
            continue;
          }
          dels.push({
            kind: 'del',
            text: del[k]!,
            words: merge(
              w.filter((x) => !x.added).map((x) => ({ text: x.value, changed: !!x.removed })),
            ),
          });
          adds.push({
            kind: 'add',
            text: add[k]!,
            words: merge(
              w.filter((x) => !x.removed).map((x) => ({ text: x.value, changed: !!x.added })),
            ),
          });
        } else if (k < del.length) dels.push({ kind: 'del', text: del[k]! });
        else adds.push({ kind: 'add', text: add[k]! });
      }
      rows.push(...dels, ...adds);
      i++;
      continue;
    }
    for (const text of linesOf(p.value)) rows.push({ kind: p.added ? 'add' : 'del', text });
  }
  return rows;
}
