import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyEdits } from '../../src/shared/edit';
import { placementOp, placementSchema } from '../../src/shared/placement';
import { VERSION } from '../../src/shared/version';

const doc = '# Garden\n\nIntro.\n\n## Tomatoes\n\nRoma.\n\n## Compost\n\nTurn weekly.\n';
const img = '![t](/files/img/x.png)';
const place = (p: Parameters<typeof placementOp>[0]) =>
  applyEdits(doc, [placementOp(p, img)]).replace(/\n{3,}/g, '\n\n');

describe('placement', () => {
  it('puts the image at each kind of spot, on its own lines', () => {
    expect(place({ under_heading: 'Tomatoes' })).toContain(`## Tomatoes\n\n${img}\n\nRoma.`);
    expect(place({ end_of_section: 'Tomatoes' })).toContain(`Roma.\n\n${img}\n\n## Compost`);
    expect(place({ after_text: 'Roma.' })).toContain(`Roma.\n\n${img}\n\n## Compost`);
    expect(place({ before_text: 'Turn weekly.' })).toContain(
      `## Compost\n\n${img}\n\nTurn weekly.`,
    );
    expect(place({ at: 'start' }).startsWith(img)).toBe(true);
    expect(place(undefined).trimEnd().endsWith(img)).toBe(true);
    expect(applyEdits('A [photo] B', [placementOp({ replace_text: '[photo]' }, img)])).toBe(
      `A ${img} B`,
    );
  });

  it('allows only one placement', () => {
    expect(placementSchema.safeParse({ at: 'end', after_text: 'x' }).success).toBe(false);
    expect(placementSchema.safeParse({ under_heading: 'x' }).success).toBe(true);
  });

  it('reports the same version as package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
