import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

/** Absolute path of the fixtures directory (Node only). */
export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const SPEC_VERSION = '0.1';

export interface FixtureVault {
  path: string;
  pages: { path: string; title: string; aliases: string[]; slugs: string[] }[];
  images: string[];
}

export interface Fixture {
  name: string;
  input: string;
  diagnostics: { code: string; line: number }[];
  file(ext: string): string | null;
  filePath(ext: string): string;
}

export function loadVault(): FixtureVault {
  return JSON.parse(readFileSync(join(fixturesDir, '_vault.json'), 'utf8')) as FixtureVault;
}

export function loadFixtures(): Fixture[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.in.md'))
    .sort()
    .map((f) => {
      const name = f.slice(0, -'.in.md'.length);
      const filePath = (ext: string) => join(fixturesDir, `${name}.${ext}`);
      const file = (ext: string) => (existsSync(filePath(ext)) ? readFileSync(filePath(ext), 'utf8') : null);
      const diag = file('diag.json');
      return {
        name,
        input: readFileSync(join(fixturesDir, f), 'utf8'),
        diagnostics: diag ? (JSON.parse(diag) as { diagnostics: { code: string; line: number }[] }).diagnostics : [],
        file,
        filePath,
      };
    });
}
