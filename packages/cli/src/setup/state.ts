import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Non-secret setup progress. Never put secrets here. */
export interface SetupState {
  version: 1;
  githubLogin?: string;
  githubId?: number;
  repo?: string; // owner/name
  workerName?: string;
  d1Id?: string;
  d1Name?: string;
  kvId?: string;
  workerUrl?: string;
  appId?: number;
  appSlug?: string;
  installationId?: number;
  completed: string[];
}

export function statePath(): string {
  return process.env.NITROGEN_STATE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'nitrogen', 'setup.json');
}

export function loadState(path = statePath()): SetupState {
  if (!existsSync(path)) return { version: 1, completed: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as SetupState;
}

const FORBIDDEN = /secret|pem|token|private|password/i;

export function saveState(s: SetupState, path = statePath()): void {
  for (const k of Object.keys(s)) if (FORBIDDEN.test(k)) throw new Error(`Refusing to persist "${k}" in setup state.`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}
