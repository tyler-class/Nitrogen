import { useMemo, useState } from 'react';
import { threeWay, resolve, type Choice } from '../lib/merge.ts';

/** Two-column per-hunk resolution: Keep mine / Keep theirs / Both. Never discards silently. */
export function MergeView({ base, mine, theirs, onResolve, onCancel }: { base: string; mine: string; theirs: string; onResolve: (merged: string) => void; onCancel: () => void }) {
  const m = useMemo(() => threeWay(base, mine, theirs), [base, mine, theirs]);
  const conflicts = m.hunks.filter((h) => h.kind === 'conflict');
  const [choices, setChoices] = useState<Choice[]>(conflicts.map(() => 'mine'));
  let ci = -1;
  return (
    <div className="page wide" style={{ maxWidth: 1100 }}>
      <h1 className="page-title">Resolve changes</h1>
      <p style={{ color: 'var(--muted)' }}>This page changed on the server while you were editing. Pick a side for each overlapping change. Nothing is saved until you click Save merge.</p>
      {m.hunks.map((h, i) => {
        if (h.kind === 'ok') return <pre key={i} style={{ fontSize: 13, color: 'var(--faint)', maxHeight: 120, overflow: 'hidden', margin: '0 0 8px' }}>{h.lines.slice(-3).join('\n')}</pre>;
        const idx = ++ci;
        return (
          <section key={i} style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: 12, marginBottom: 12 }} aria-label={`Conflict ${idx + 1} of ${conflicts.length}`}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
              <div><h3 style={{ fontSize: 13, margin: '0 0 4px' }}>Mine</h3><pre style={{ background: 'var(--accent-soft)', padding: 8, borderRadius: 6, fontSize: 13, whiteSpace: 'pre-wrap' }}>{h.mine.join('\n') || '(deleted)'}</pre></div>
              <div><h3 style={{ fontSize: 13, margin: '0 0 4px' }}>Theirs</h3><pre style={{ background: 'var(--claude-soft)', padding: 8, borderRadius: 6, fontSize: 13, whiteSpace: 'pre-wrap' }}>{h.theirs.join('\n') || '(deleted)'}</pre></div>
            </div>
            <div role="radiogroup" aria-label="Resolution" style={{ display: 'flex', gap: 6 }}>
              {(['mine', 'theirs', 'both'] as const).map((c) => (
                <button key={c} role="radio" aria-checked={choices[idx] === c} className="chip-toggle" aria-pressed={choices[idx] === c} onClick={() => setChoices((cs) => cs.map((x, j) => (j === idx ? c : x)))}>
                  {{ mine: 'Keep mine', theirs: 'Keep theirs', both: 'Both' }[c]}
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" onClick={() => onResolve(resolve(m.hunks, choices))}>Save merge</button>
        <button className="btn" onClick={onCancel}>Keep editing</button>
      </div>
    </div>
  );
}
