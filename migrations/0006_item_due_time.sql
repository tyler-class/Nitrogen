-- Timed due dates: "due:2026-11-12 14:00" (or "due:2026-11-12T14:00") keeps the date in `due`, so
-- dated sorting, "due today" and the badge are unchanged, and the time in `due_time` (HH:MM,
-- 24-hour, read on each device's own clock) for timed reminder notifications.
ALTER TABLE page_items ADD COLUMN due_time TEXT;

-- Re-read every page once (sessions.ts: ensureItemsIndexed) so items written with a time before
-- this version get it.
DELETE FROM settings WHERE key = 'items_indexed';
