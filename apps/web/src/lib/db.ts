import type { Table } from 'dexie';

export interface CachedPage {
  path: string;
  sha: string;
  content: string;
  fetchedAt: number;
}

export interface Draft {
  path: string;
  /** Blob sha the draft is based on; null for a new page. */
  baseSha: string | null;
  /** Content at baseSha (for 3-way merges). */
  base: string | null;
  content: string;
  op: 'put' | 'delete' | 'move';
  to?: string;
  /** Base64 for binary uploads (images). */
  contentB64?: string;
  updatedAt: number;
  status: 'dirty' | 'committing' | 'conflict';
  theirs?: string | null;
  theirsSha?: string | null;
}

export interface KV {
  k: string;
  v: unknown;
}

interface Tables {
  pages: Table<CachedPage, string>;
  drafts: Table<Draft, string>;
  kv: Table<KV, string>;
}

let instance: Promise<Tables> | null = null;

/** Dexie loads lazily so it stays off the critical rendering path. */
function open(): Promise<Tables> {
  instance ??= import('dexie').then(({ default: Dexie }) => {
    const d = new Dexie("nitrogen") as InstanceType<typeof Dexie> & Tables;
    d.version(1).stores({ pages: 'path, sha', drafts: 'path, status, updatedAt', kv: 'k' });
    return d;
  });
  return instance;
}

function table<T, K extends keyof Tables>(name: K) {
  return {
    get: async (key: string): Promise<T | undefined> => (await open())[name].get(key) as unknown as Promise<T | undefined>,
    put: async (value: T): Promise<unknown> => (await open())[name].put(value as never),
    delete: async (key: string): Promise<void> => (await open())[name].delete(key),
    toArray: async (): Promise<T[]> => (await open())[name].toArray() as unknown as Promise<T[]>,
  };
}

export const db = { pages: table<CachedPage, 'pages'>('pages'), drafts: table<Draft, 'drafts'>('drafts'), kv: table<KV, 'kv'>('kv') };

export async function getKV<T>(k: string, fallback: T): Promise<T> {
  try {
    return ((await db.kv.get(k))?.v as T) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setKV(k: string, v: unknown): Promise<void> {
  try {
    await db.kv.put({ k, v });
  } catch {
    /* private mode */
  }
}
