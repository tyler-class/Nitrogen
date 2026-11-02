import { useEffect, useState } from 'react';
import { subscribeSync, flush, type SyncState } from '../lib/sync.ts';
import { db, type Draft } from '../lib/db.ts';
import { Drawer } from './Drawer.tsx';
import { Link } from '@tanstack/react-router';

export function useSync(): SyncState {
  const [s, setS] = useState<SyncState | null>(null);
  useEffect(() => subscribeSync(setS), []);
  return s ?? { queued: 0, conflicts: 0, committing: false, offline: false, lastCommit: null, lastError: null };
}

export function SyncPill() {
  const s = useSync();
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    if (open) void db.drafts.toArray().then(setDrafts);
  }, [open, s]);
  const [label, st] = s.conflicts
    ? [`Conflict - resolve`, 'conflict']
    : s.offline
      ? [s.queued ? `Offline - ${s.queued} queued` : 'Offline', 'offline']
      : s.committing
        ? ['Saving…', 'queued']
        : s.queued
          ? [`${s.queued} change${s.queued === 1 ? '' : 's'} queued`, 'queued']
          : ['Synced', 'synced'];
  return (
    <>
      <button className="sync-pill" data-state={st} onClick={() => setOpen(true)} aria-live="polite">
        {label}
      </button>
      {open && (
        <Drawer title="Sync" width="sm" onClose={() => setOpen(false)}>
          <p style={{ fontSize: 14, color: 'var(--muted)' }}>Last commit: {s.lastCommit ? <code>{s.lastCommit.slice(0, 7)}</code> : 'none this session'}</p>
          {s.lastError && <p style={{ color: 'var(--danger)', fontSize: 14 }}>{s.lastError}</p>}
          <h3 style={{ fontSize: 14 }}>Outbox</h3>
          {drafts.length === 0 ? (
            <p className="empty">Nothing queued.</p>
          ) : (
            <ul className="list-plain">
              {drafts.map((d) => (
                <li key={d.path} style={{ fontSize: 14 }}>
                  <Link to="/edit/$" params={{ _splat: d.path }} onClick={() => setOpen(false)}>{d.path}</Link>{' '}
                  <span className="chip">{d.status === 'conflict' ? 'conflict' : d.op}</span>
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={() => void flush()} disabled={!drafts.some((d) => d.status === 'dirty')}>Retry now</button>
          </div>
        </Drawer>
      )}
    </>
  );
}

export function Toasts() {
  const [msgs, setMsgs] = useState<{ id: number; text: string }[]>([]);
  useEffect(() => {
    let unsub = () => {};
    void import('../lib/toast.ts').then((m) => (unsub = m.subscribeToasts(setMsgs)));
    return () => unsub();
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {msgs.map((m) => (
        <div className="toast" key={m.id}>{m.text}</div>
      ))}
    </div>
  );
}
