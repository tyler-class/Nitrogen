import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixturesDir, SPEC_VERSION } from '../src/index.ts';

describe('spec', () => {
  it('has a version and SPEC.md with the lint catalog', () => {
    expect(SPEC_VERSION).toBe('0.1');
    const spec = readFileSync(join(fixturesDir, '..', 'SPEC.md'), 'utf8');
    for (const code of ['E001', 'E010', 'W101', 'W110']) expect(spec).toContain(code);
  });
});
