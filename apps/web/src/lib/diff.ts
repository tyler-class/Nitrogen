import { diffComm } from 'node-diff3';

/** Line diff for display. */
export function diffLines(a: string, b: string): { t: ' ' | '+' | '-'; s: string }[] {
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  for (const r of diffComm(a.split('\n'), b.split('\n'))) {
    if (r.common) r.common.forEach((s) => out.push({ t: ' ', s }));
    else {
      r.buffer1?.forEach((s) => out.push({ t: '-', s }));
      r.buffer2?.forEach((s) => out.push({ t: '+', s }));
    }
  }
  return out;
}
