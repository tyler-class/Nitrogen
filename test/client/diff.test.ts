import { describe, expect, it } from 'vitest';
import { diffRows } from '../../src/client/lib/diff';

describe('version diff', () => {
  it('marks added, removed and changed lines, with the changed words', () => {
    const rows = diffRows('one\ntwo apples\nthree\n', 'one\ntwo pears\nthree\nfour\n');
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ['same', 'one'],
      ['del', 'two apples'],
      ['add', 'two pears'],
      ['same', 'three'],
      ['add', 'four'],
    ]);
    const del = rows[1]!;
    const add = rows[2]!;
    expect(del.kind === 'del' && del.words?.filter((w) => w.changed).map((w) => w.text)).toEqual([
      'apples',
    ]);
    expect(add.kind === 'add' && add.words?.filter((w) => w.changed).map((w) => w.text)).toEqual([
      'pears',
    ]);
  });

  it('marks a whole changed phrase once, and skips word marks for unrelated lines', () => {
    const rows = diffRows(
      'The soil is dry by noon.\nCheck the basil.\n',
      'The soil stays damp with mulch.\nMulch the beds.\n',
    );
    const first = rows.find((r) => r.kind === 'add' && r.text.startsWith('The soil'))!;
    expect(
      first.kind === 'add' && first.words?.filter((w) => w.changed).map((w) => w.text),
    ).toEqual(['stays damp with mulch']);
    const swap = rows.find((r) => r.kind === 'add' && r.text.startsWith('Mulch'))!;
    expect(swap.kind === 'add' && swap.words).toBeUndefined();
  });

  it('has nothing to mark when the text is the same', () => {
    expect(diffRows('a\nb', 'a\nb').every((r) => r.kind === 'same')).toBe(true);
  });
});
