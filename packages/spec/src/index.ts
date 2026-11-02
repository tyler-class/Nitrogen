import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Absolute path of the fixtures directory (Node only). */
export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const SPEC_VERSION = '0.1';
