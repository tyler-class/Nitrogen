-- Who changed what, tags, pins, the inbox and insights.
-- Actors are stored as text: 'you' for the owner in the app, 'agent:<name>' for a connected
-- assistant (its OAuth client name). NULL means "from before Nitrogen recorded it".

ALTER TABLE pages ADD COLUMN created_by TEXT;
ALTER TABLE pages ADD COLUMN updated_by TEXT;
-- When the owner last opened the page in the app (drives the inbox).
ALTER TABLE pages ADD COLUMN viewed_at TEXT;
ALTER TABLE pages ADD COLUMN pinned_at TEXT;
-- Tags set on the page itself (JSON array). #tags written in the body are added in page_tags.
ALTER TABLE pages ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE pages ADD COLUMN words INTEGER NOT NULL DEFAULT 0;

-- Who wrote the version a history snapshot holds.
ALTER TABLE page_revisions ADD COLUMN actor TEXT;

-- Every tag on a page: its own tags plus #tags in the body.
CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (page_id, tag)
);
CREATE INDEX idx_page_tags_tag ON page_tags (tag);

-- The activity log. Bursts of edits by one actor (autosave) are merged into one event:
-- started_at is when the burst began, created_at when it last changed.
-- No foreign key: events outlive deleted pages so the log stays complete.
CREATE TABLE page_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  title TEXT NOT NULL,
  action TEXT NOT NULL, -- create | edit | move | delete | restore
  actor TEXT,
  words INTEGER,
  started_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_time ON page_events (created_at);
CREATE INDEX idx_events_page ON page_events (page_id, id DESC);
CREATE INDEX idx_events_actor ON page_events (actor, created_at);

-- Searches assistants ran, to show what the wiki could not answer.
CREATE TABLE search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  actor TEXT,
  hits INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_search_log_time ON search_log (created_at);

-- Existing pages: already seen (the inbox starts empty), a rough word count until the next save,
-- and a history entry for when they were created and last changed.
UPDATE pages SET
  viewed_at = updated_at,
  words = CASE WHEN length(trim(body)) = 0 THEN 0
    ELSE length(trim(body)) - length(replace(replace(trim(body), char(10), ''), ' ', '')) + 1 END;
INSERT INTO page_events (page_id, title, action, actor, words, started_at, created_at)
  SELECT id, title, 'create', NULL, NULL, created_at, created_at FROM pages;
INSERT INTO page_events (page_id, title, action, actor, words, started_at, created_at)
  SELECT id, title, 'edit', NULL, words, updated_at, updated_at FROM pages WHERE updated_at > created_at;
