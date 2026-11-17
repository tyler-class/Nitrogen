-- The in-app notifications list (the bell). The cron writes each notification here once, whether
-- or not any device gets it as a push; the app-icon badge is how many are unread.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- digest, overdue, timed, assistant, questions (shared/notify.ts).
  kind TEXT NOT NULL,
  -- kind:key:local date, so the same notification is never listed twice.
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_notifications_created ON notifications (created_at);
CREATE INDEX idx_notifications_unread ON notifications (read_at);
