import { loadVault } from '@nitrogen/spec';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { VaultContext } from '../src/types.ts';

export const vault = loadVault();
export const FIXTURE_PATH = vault.path;
export const ctx: VaultContext = { config: structuredClone(DEFAULT_CONFIG), pages: vault.pages, images: vault.images };
