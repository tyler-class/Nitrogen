// The bell: notifications in the app, newest first. Opening one marks it read and goes to its
// page; each can be marked read or unread, or all at once. The app-icon badge is the unread
// count, so clearing them here clears the badge.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboxNotice } from '@shared/types';
import { api } from '../lib/api';
import { syncBadge } from '../kit/push';
import { Icon } from './Icon';

interface Inbox {
  items: InboxNotice[];
  unread: number;
}

const inboxKey = ['notifications'] as const;

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
};

function useInbox() {
  return useQuery({
    queryKey: inboxKey,
    queryFn: () => api.get<Inbox>(`/notifications?tz=${encodeURIComponent(zone())}`),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

/** "now", "5m", "3h", "2d", then "Nov 12". */
function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Bell({ className = '', size = 17 }: { className?: string; size?: number }) {
  const inbox = useInbox();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const unread = inbox.data?.unread ?? 0;

  // Changes show at once (before the server answers): any refresh in flight is cancelled so it
  // can't paint the old state back, and the list is fetched again once the change is saved.
  const apply = async (change: (i: InboxNotice) => InboxNotice) => {
    await qc.cancelQueries({ queryKey: inboxKey });
    const before = qc.getQueryData<Inbox>(inboxKey);
    qc.setQueryData<Inbox>(inboxKey, (d) => {
      if (!d) return d;
      const items = d.items.map(change);
      const shownUnread = (l: InboxNotice[]) => l.filter((i) => !i.read).length;
      return { items, unread: Math.max(0, d.unread + shownUnread(items) - shownUnread(d.items)) };
    });
    return { before };
  };
  const settle = () => {
    void qc.invalidateQueries({ queryKey: inboxKey });
    void syncBadge();
  };
  const mark = useMutation({
    mutationFn: ({ id, read }: { id: number; read: boolean }) =>
      api.post<{ unread: number }>(`/notifications/${id}/read`, { read }),
    onMutate: (v) => apply((i) => (i.id === v.id ? { ...i, read: v.read } : i)),
    onError: (_e, _v, ctx) => ctx?.before && qc.setQueryData(inboxKey, ctx.before),
    onSettled: settle,
  });
  const readAll = useMutation({
    mutationFn: () => api.post<{ unread: number }>('/notifications/read-all', {}),
    onMutate: () => apply((i) => ({ ...i, read: true })),
    onError: (_e, _v, ctx) => ctx?.before && qc.setQueryData(inboxKey, ctx.before),
    onSettled: settle,
  });

  // Fixed to the window, so the sidebar's scrolling can't clip it.
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(360, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - width));
    setPos({ top: r.bottom + 6, left, width });
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const follow = () => place();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', follow);
    };
  }, [open]);

  const go = (n: InboxNotice) => {
    if (!n.read) mark.mutate({ id: n.id, read: true });
    setOpen(false);
    nav(n.url);
  };

  return (
    <>
      <button
        ref={btn}
        className={`bell ${className}`}
        onClick={() => {
          place();
          setOpen((o) => !o);
          if (!open) void inbox.refetch();
        }}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Notifications"
      >
        <Icon name="bell" size={size} />
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div
          ref={pop}
          className="bell-pop"
          role="dialog"
          aria-label="Notifications"
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : undefined}
        >
          <div className="bell-head">
            <h2>
              <Icon name="bell" size={16} /> Notifications
            </h2>
            {unread > 0 && (
              <button className="bell-all" onClick={() => readAll.mutate()}>
                Mark all read
              </button>
            )}
          </div>
          {inbox.data?.items.length ? (
            <ul className="bell-list">
              {inbox.data.items.map((n) => (
                <li key={n.id} className={n.read ? 'read' : 'unread'}>
                  <button className="bell-item" onClick={() => go(n)}>
                    <span className="bell-title">
                      {n.title}
                      <span className="bell-when">{ago(n.created_at)}</span>
                    </span>
                    <span className="bell-body">{n.body}</span>
                  </button>
                  <button
                    className="bell-dot"
                    onClick={() => mark.mutate({ id: n.id, read: !n.read })}
                    aria-label={n.read ? 'Mark as unread' : 'Mark as read'}
                    title={n.read ? 'Mark as unread' : 'Mark as read'}
                  >
                    <span aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="bell-empty">
              {inbox.isError ? 'Couldn’t load notifications.' : 'No notifications yet.'}
            </p>
          )}
        </div>
      )}
    </>
  );
}
