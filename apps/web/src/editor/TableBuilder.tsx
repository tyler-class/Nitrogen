import { useState } from 'react';
import { Drawer } from '../components/Drawer.tsx';

type Align = 'left' | 'center' | 'right' | 'none';

export function buildTable(cells: string[][], aligns: Align[], opts: { style: string; header: string; caption: string; dense: boolean; widths: string }): string {
  const cols = cells[0]!.length;
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  const w = cells.reduce((acc, row) => row.map((c, i) => Math.max(acc[i] ?? 3, esc(c).length)), Array(cols).fill(3) as number[]);
  const row = (r: string[]) => `| ${r.map((c, i) => esc(c).padEnd(w[i]!)).join(' | ')} |`;
  const delim = `| ${aligns.map((a, i) => { const d = '-'.repeat(Math.max(3, w[i]! - (a === 'center' ? 2 : a === 'none' ? 0 : 1))); return a === 'left' ? `:${d}` : a === 'right' ? `${d}:` : a === 'center' ? `:${d}:` : d; }).join(' | ')} |`;
  const attrs = [opts.style !== 'plain' && `style=${opts.style}`, opts.header === 'sticky' && 'header=sticky', opts.widths && `widths=${opts.widths}`, opts.caption && `caption="${opts.caption.replace(/"/g, "'")}"`, opts.dense && 'dense=true'].filter(Boolean).join(' ');
  return `${attrs ? `<!--nitrogen:table ${attrs}-->\n` : ''}${[row(cells[0]!), delim, ...cells.slice(1).map(row)].join('\n')}`;
}

export function TableBuilder({ onInsert, onClose }: { onInsert: (md: string) => void; onClose: () => void }) {
  const [cells, setCells] = useState<string[][]>([['Column', 'Column'], ['', '']]);
  const [aligns, setAligns] = useState<Align[]>(['none', 'none']);
  const [style, setStyle] = useState('zebra');
  const [header, setHeader] = useState('normal');
  const [caption, setCaption] = useState('');
  const [dense, setDense] = useState(false);
  const [widths, setWidths] = useState('');
  const cols = cells[0]!.length;
  const widthsOk = !widths || (widths.split(',').length === cols && widths.split(',').map(Number).reduce((a, b) => a + b, 0) === 100);
  const set = (r: number, c: number, v: string) => setCells((cs) => cs.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  return (
    <Drawer title="Table builder" width="lg" onClose={onClose}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn" onClick={() => setCells((cs) => [...cs, Array(cols).fill('')])}>Add row</button>
        <button className="btn" onClick={() => { setCells((cs) => cs.map((r) => [...r, ''])); setAligns((a) => [...a, 'none']); }}>Add column</button>
        <button className="btn" disabled={cells.length <= 2} onClick={() => setCells((cs) => cs.slice(0, -1))}>Remove row</button>
        <button className="btn" disabled={cols <= 1} onClick={() => { setCells((cs) => cs.map((r) => r.slice(0, -1))); setAligns((a) => a.slice(0, -1)); }}>Remove column</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {aligns.map((a, c) => (
                <th key={c}>
                  <select className="input" aria-label={`Column ${c + 1} alignment`} value={a} onChange={(e) => setAligns((as) => as.map((x, i) => (i === c ? (e.target.value as Align) : x)))}>
                    <option value="none">default</option><option value="left">left</option><option value="center">center</option><option value="right">right</option>
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, r) => (
              <tr key={r}>
                {row.map((v, c) => (
                  <td key={c}><input className="input" aria-label={`${r === 0 ? 'Header' : `Row ${r}`} column ${c + 1}`} value={v} onChange={(e) => set(r, c, e.target.value)} style={{ fontWeight: r === 0 ? 600 : 400 }} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '12px 0', fontSize: 14 }}>
        <label>Style <select className="input" value={style} onChange={(e) => setStyle(e.target.value)}><option>plain</option><option>zebra</option><option>grid</option></select></label>
        <label>Header <select className="input" value={header} onChange={(e) => setHeader(e.target.value)}><option>normal</option><option>sticky</option></select></label>
        <label>Caption <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
        <label>Widths (sum 100) <input className="input" value={widths} placeholder={Array(cols).fill(Math.floor(100 / cols)).join(',')} onChange={(e) => setWidths(e.target.value)} aria-invalid={!widthsOk} /></label>
        <label><input type="checkbox" checked={dense} onChange={(e) => setDense(e.target.checked)} /> Dense</label>
      </div>
      <pre style={{ fontSize: 12 }}>{buildTable(cells, aligns, { style, header, caption, dense, widths: widthsOk ? widths : '' })}</pre>
      <button className="btn btn-primary" disabled={!widthsOk} onClick={() => onInsert(buildTable(cells, aligns, { style, header, caption, dense, widths }))}>Insert table</button>
    </Drawer>
  );
}
