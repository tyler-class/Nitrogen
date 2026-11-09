// A line diff between two versions of a page, like a code diff: removed lines in red, added
// lines in green, and within a changed line the words that changed marked more strongly.
// Long runs of unchanged lines fold away, with a button to show them.
import { useState } from 'react';
import { diffRows, type Row } from '../lib/diff';

const CONTEXT = 3;

export function DiffView({
  older,
  newer,
  olderLabel,
  newerLabel,
}: {
  older: { title: string; body: string };
  newer: { title: string; body: string };
  olderLabel: string;
  newerLabel: string;
}) {
  const rows = diffRows(older.body, newer.body);
  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'del').length;
  const [open, setOpen] = useState<Set<number>>(new Set());

  // Unchanged runs longer than the context fold into one row.
  const shown: ({ row: Row; n: number } | { fold: number; start: number; count: number })[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== 'same') {
      shown.push({ row: rows[i]!, n: i });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j]!.kind === 'same') j++;
    const lead = i === 0 ? 0 : CONTEXT;
    const tail = j === rows.length ? 0 : CONTEXT;
    if (j - i > lead + tail + 1 && !open.has(i)) {
      for (let k = i; k < i + lead; k++) shown.push({ row: rows[k]!, n: k });
      shown.push({ fold: i, start: i + lead, count: j - i - lead - tail });
      for (let k = j - tail; k < j; k++) shown.push({ row: rows[k]!, n: k });
    } else for (let k = i; k < j; k++) shown.push({ row: rows[k]!, n: k });
    i = j;
  }

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-old">− {olderLabel}</span>
        <span className="diff-new">+ {newerLabel}</span>
        <span className="diff-count">
          <span className="diff-plus">+{added}</span> <span className="diff-minus">−{removed}</span>
        </span>
      </div>
      {older.title !== newer.title && (
        <div className="diff-title">
          Title: <del>{older.title}</del> → <ins>{newer.title}</ins>
        </div>
      )}
      {!added && !removed ? (
        <p className="muted">The text is the same in both versions.</p>
      ) : (
        <div className="diff-lines" role="table" aria-label="Changes">
          {shown.map((s) =>
            'fold' in s ? (
              <button
                key={`f${s.fold}`}
                className="diff-fold"
                onClick={() => setOpen((o) => new Set(o).add(s.fold))}
              >
                ⋯ {s.count} unchanged line{s.count === 1 ? '' : 's'}
              </button>
            ) : (
              <div key={s.n} className={`diff-line ${s.row.kind}`} role="row">
                <span className="diff-mark" aria-hidden>
                  {s.row.kind === 'add' ? '+' : s.row.kind === 'del' ? '−' : ''}
                </span>
                <span className="diff-text">
                  {s.row.kind !== 'same' && s.row.words
                    ? s.row.words.map((w, k) =>
                        w.changed ? (
                          <mark key={k} className="diff-word">
                            {w.text}
                          </mark>
                        ) : (
                          <span key={k}>{w.text}</span>
                        ),
                      )
                    : s.row.text || ' '}
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
