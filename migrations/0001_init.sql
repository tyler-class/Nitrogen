-- Nitrogen: D1 is the source of truth. Page bodies are markdown; images live in R2 (FILES).

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  -- NULL = top level. Deleting a page deletes its subtree.
  parent_id TEXT REFERENCES pages (id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  icon TEXT,
  body TEXT NOT NULL DEFAULT '',
  -- Bumped on every change; writers send the version they edited (optimistic concurrency).
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Semantic index bookkeeping (AI Search). indexed_version < version means "needs (re)indexing".
  search_item_id TEXT,
  indexed_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_pages_parent ON pages (parent_id, position);
CREATE INDEX idx_pages_title ON pages (title COLLATE NOCASE);

-- Snapshots taken before edits (at most one per page every few minutes).
CREATE TABLE page_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_revisions_page ON page_revisions (page_id, id DESC);

-- Outgoing links found in page bodies ([[Wikilinks]] and /p/<id> links), for backlinks.
CREATE TABLE links (
  src TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  dst TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  PRIMARY KEY (src, dst)
);
CREATE INDEX idx_links_dst ON links (dst);

-- Images stored in R2. Bodies reference them as /files/<key>.
CREATE TABLE files (
  key TEXT PRIMARY KEY,
  page_id TEXT REFERENCES pages (id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_files_page ON files (page_id);

-- Keyword search. Kept in sync by triggers; stores its own text so snippet() works.
CREATE VIRTUAL TABLE pages_fts USING fts5 (
  page_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts (page_id, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER pages_fts_update AFTER UPDATE OF title, body ON pages BEGIN
  DELETE FROM pages_fts WHERE page_id = old.id;
  INSERT INTO pages_fts (page_id, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER pages_fts_delete AFTER DELETE ON pages BEGIN
  DELETE FROM pages_fts WHERE page_id = old.id;
END;

-- Semantic index items whose page is gone but whose AI Search item still needs deleting.
CREATE TABLE search_tombstones (
  item_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, attempted_at);
