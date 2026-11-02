import { diff3Merge } from 'node-diff3';

export type Hunk = { kind: 'ok'; lines: string[] } | { kind: 'conflict'; mine: string[]; theirs: string[]; base: string[] };

/** Line-based 3-way merge. `clean` when no hunks overlap. */
export function threeWay(base: string, mine: string, theirs: string): { clean: boolean; hunks: Hunk[]; merged: string | null } {
  const split = (s: string) => s.split('\n');
  const regions = diff3Merge<string>(split(mine), split(base), split(theirs), { excludeFalseConflicts: true });
  const hunks: Hunk[] = regions.map((r) => (r.ok ? { kind: 'ok', lines: r.ok } : { kind: 'conflict', mine: r.conflict!.a, theirs: r.conflict!.b, base: r.conflict!.o }));
  const clean = hunks.every((h) => h.kind === 'ok');
  return { clean, hunks, merged: clean ? hunks.flatMap((h) => (h.kind === 'ok' ? h.lines : [])).join('\n') : null };
}

export type Choice = 'mine' | 'theirs' | 'both';

/** Resolve conflict hunks with one choice per conflict (in order). */
export function resolve(hunks: Hunk[], choices: Choice[]): string {
  let c = 0;
  return hunks
    .flatMap((h) => {
      if (h.kind === 'ok') return h.lines;
      const ch = choices[c++] ?? 'mine';
      return ch === 'mine' ? h.mine : ch === 'theirs' ? h.theirs : [...h.mine, ...h.theirs];
    })
    .join('\n');
}
