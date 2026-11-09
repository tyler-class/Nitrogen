// Notifications on this device (Selfhost Kit: src/client/kit/push.ts): taps on a notification
// route in-app, and the app-icon badge follows the open to-dos and reminders.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { onPushOpen, syncBadge } from '../kit/push';

/** Queries whose data can change what's due: a page's body (its items) and the items index. */
const WATCHED = new Set(['page', 'items']);

/** Mount once inside the router. */
export function useNotifications() {
  const nav = useNavigate();
  const qc = useQueryClient();
  useEffect(() => onPushOpen((url) => nav(url)), [nav]);
  useEffect(() => {
    void syncBadge();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void syncBadge(), 800);
    };
    // Refetches that return the same data keep the same object (structural sharing), so only a
    // real change (an item ticked, added or re-dated) asks the server for the count again.
    const seen = new Map<string, unknown>();
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type !== 'updated' || e.action.type !== 'success') return;
      if (!WATCHED.has(String(e.query.queryKey[0]))) return;
      const data = e.query.state.data;
      const had = seen.has(e.query.queryHash);
      if (had && seen.get(e.query.queryHash) === data) return;
      seen.set(e.query.queryHash, data);
      if (had) soon();
    });
    const onShow = () => document.visibilityState === 'visible' && soon();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearTimeout(timer);
      unsub();
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [qc]);
}
