export { buildProgram, VERSION } from './program.ts';
export { loadVault, listFiles } from './vault.ts';
export { planMove } from './commands/fix-links.ts';
export { buildIndex, signIngest, type IngestBatch } from './commands/index-cmd.ts';
export { gitBlobSha } from './git.ts';
