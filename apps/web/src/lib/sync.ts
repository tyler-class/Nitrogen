/**
 * Local-first drafts and bundled commits (brief 9.5). Every dirty draft goes into one commit.
 * Triggers: Save, Cmd/Ctrl+S, 8 s idle, leaving the editor, app backgrounding, coming online.
 * Conflicts (409) are 3-way merged; clean merges resubmit automatically, overlaps wait for the
 * merge view. Nothing is ever silently discarded.
 */
import { db, type Draft } from './db.ts';
import { api, ApiError } from '../api/client.ts';
import { threeWay } from './merge.ts';
import { toast } from './toast.ts';
import { autofix, type VaultContext } from '@nitrogen/core';

let ctxProvider: () => VaultContext | null = () => null;
/** Commits run the CFM autofixer (wikilinks -> canonical links, image option order), like Save. */
export function setContextProvider(fn: () => VaultContext | null): void {
  ctxProvider = fn;
}

export interface SyncState {
  queued: number;
  conflicts: number;
  committing: boolean;
  offline: boolean;
  lastCommit: string | null;
  lastError: string | null;
}

let state: SyncState = { queued: 0, conflicts: 0, committing: false, offline: typeof navigator !== 'undefined' ? !navigator.onLine : false, lastCommit: null, lastError: null };
const listeners = new Set<(s: SyncState) => void>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let onCommitted: ((paths: string[], results: { path: string; sha: string | null }[]) => void) | null = null;

export const IDLE_MS = 8000;

function emit(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
}

export function subscribeSync(l: (s: SyncState) => void): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

export function getSyncState(): SyncState {
  return state;
}

export function setCommitListener(fn: typeof onCommitted): void {
  onCommitted = fn;
}

export async function refreshCounts(): Promise<void> {
  const all = await db.drafts.toArray();
  emit({ queued: all.filter((d) => d.status !== 'conflict').length, conflicts: all.filter((d) => d.status === 'conflict').length });
}

/** Save a draft locally (debounce the caller at ~300 ms). Schedules an idle commit. */
export async function saveDraft(d: Omit<Draft, 'updatedAt' | 'status'> & { status?: Draft['status'] }): Promise<void> {
  const existing = await db.drafts.get(d.path);
  await db.drafts.put({ ...existing, ...d, status: existing?.status === 'conflict' ? 'conflict' : 'dirty', updatedAt: Date.now() } as Draft);
  await refreshCounts();
  scheduleIdle();
}

export async function discardDraft(path: string): Promise<void> {
  await db.drafts.delete(path);
  await refreshCounts();
}

export function scheduleIdle(ms = IDLE_MS): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void flush(), ms);
}

let flushing: Promise<void> | null = null;

/** Commit every dirty draft in one bundled commit. */
export function flush(): Promise<void> {
  clearTimeout(idleTimer);
  flushing ??= doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(attempt = 0): Promise<void> {
  if (!navigator.onLine) {
    emit({ offline: true });
    return;
  }
  const drafts = (await db.drafts.toArray()).filter((d) => d.status === 'dirty');
  if (drafts.length === 0) return;
  emit({ committing: true, offline: false, lastError: null });
  try {
    const changes = drafts.slice(0, 30).map((d) =>
      d.op === 'delete'
        ? { path: d.path, op: 'delete', baseSha: d.baseSha }
        : d.op === 'move'
          ? { path: d.path, op: 'move', to: d.to }
          : { path: d.path, op: 'put', baseSha: d.baseSha, ...(d.contentB64 ? { contentB64: d.contentB64 } : { content: d.path.endsWith('.md') ? autofix(d.content, ctxProvider(), { path: d.path }).src : d.content }) },
    );
    const r = await api<{ commitSha: string; results: { path: string; sha: string | null }[] }>('/commit', { method: 'POST', json: { changes } });
    const sent = drafts.slice(0, 30);
    // Only remove drafts that did not change while the commit was in flight.
    for (const d of sent) {
      const cur = await db.drafts.get(d.path);
      if (cur && cur.updatedAt === d.updatedAt) await db.drafts.delete(d.path);
      else if (cur) {
        const res = r.results.find((x) => x.path === d.path);
        await db.drafts.put({ ...cur, baseSha: res?.sha ?? cur.baseSha, base: d.content });
      }
    }
    for (const res of r.results) {
      const d = sent.find((x) => x.path === res.path);
      if (res.sha && d && !d.contentB64) await db.pages.put({ path: res.path, sha: res.sha, content: d.content, fetchedAt: Date.now() }).catch(() => {});
    }
    emit({ committing: false, lastCommit: r.commitSha });
    await refreshCounts();
    toast(`Saved. ${sent.length} file${sent.length === 1 ? '' : 's'} committed.`);
    onCommitted?.(sent.map((d) => d.path), r.results);
    if (drafts.length > 30) await doFlush();
  } catch (e) {
    emit({ committing: false });
    if (e instanceof ApiError && e.status === 409) {
      const conflicts = (e.body as { conflicts: { path: string; theirs: string | null; theirsSha: string | null }[] }).conflicts;
      let autoMerged = 0;
      for (const c of conflicts) {
        const d = await db.drafts.get(c.path);
        if (!d) continue;
        if (c.theirs !== null && d.base !== null && !d.contentB64 && d.op === 'put') {
          const m = threeWay(d.base, d.content, c.theirs);
          if (m.clean) {
            await db.drafts.put({ ...d, content: m.merged!, base: c.theirs, baseSha: c.theirsSha, status: 'dirty' });
            autoMerged++;
            continue;
          }
        }
        await db.drafts.put({ ...d, status: 'conflict', theirs: c.theirs, theirsSha: c.theirsSha });
      }
      await refreshCounts();
      if (autoMerged && attempt < 2) {
        toast('Merged with a newer version.');
        return doFlush(attempt + 1);
      }
      if (state.conflicts) toast('Conflict: review the changes before saving.');
      return;
    }
    if (e instanceof TypeError || !navigator.onLine) {
      emit({ offline: true });
      return;
    }
    emit({ lastError: (e as Error).message });
    toast((e as Error).message);
  }
}

/** Resolve a conflict with merged text; the draft becomes dirty against the remote sha. */
export async function resolveConflict(path: string, content: string): Promise<void> {
  const d = await db.drafts.get(path);
  if (!d) return;
  await db.drafts.put({ ...d, content, base: d.theirs ?? d.base, baseSha: d.theirsSha ?? null, status: 'dirty', theirs: null, theirsSha: null, updatedAt: Date.now() });
  await refreshCounts();
  await flush();
}

let installed = false;

/** Wire the global triggers once. */
export function installSyncTriggers(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('online', () => {
    emit({ offline: false });
    void flush();
  });
  window.addEventListener('offline', () => emit({ offline: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
  window.addEventListener('pagehide', () => void flush());
  void refreshCounts().then(() => flush());
}
