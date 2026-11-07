-- Typed items (todo:, question:, reminder: markers in page bodies) and protected Sessions.

-- Derived from page bodies on every save (shared/items.ts). Markdown stays the source of truth;
-- the table can be wiped and rebuilt from the pages at any time.
CREATE TABLE page_items (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  owner TEXT,
  due TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  answer TEXT,
  PRIMARY KEY (page_id, line)
);
CREATE INDEX idx_items_open ON page_items (done, type, due);

-- The assistant session each Sessions entry records. Writes by an assistant extend its current
-- entry (or start a new one after an hour of quiet); log_session sets the title and summary.
CREATE TABLE session_entries (
  page_id TEXT PRIMARY KEY REFERENCES pages (id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  title TEXT,
  summary TEXT
);
CREATE INDEX idx_session_entries_actor ON session_entries (actor, last_at);

-- An existing top-level "Sessions" page becomes the protected system section.
INSERT OR IGNORE INTO settings (key, value)
  SELECT 'sessions_id', id FROM pages
  WHERE parent_id IS NULL AND lower(title) = 'sessions'
  ORDER BY created_at LIMIT 1;
