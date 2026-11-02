-- Nitrogen index. D1 is a cache of the repo: everything here is rebuildable from git.
CREATE TABLE pages (
  path TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  title TEXT NOT NULL,
  icon TEXT,
  ord INTEGER,
  status TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  aliases TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  excerpt TEXT,
  size INTEGER,
  updated_at TEXT,
  last_actor TEXT
);

CREATE TABLE links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  frag TEXT,
  rel TEXT NOT NULL DEFAULT 'related',
  text TEXT,
  ctx TEXT,
  line INTEGER
);
CREATE INDEX links_dst ON links(dst);
CREATE INDEX links_src ON links(src);

CREATE TABLE images (src TEXT NOT NULL, path TEXT NOT NULL);
CREATE INDEX images_src ON images(src);

CREATE TABLE headings (path TEXT NOT NULL, slug TEXT NOT NULL, text TEXT, level INTEGER);
CREATE INDEX headings_path ON headings(path);

-- Repo assets (images) known from the tree, for lint W103 and the image picker.
CREATE TABLE assets (path TEXT PRIMARY KEY, sha TEXT NOT NULL, size INTEGER);

-- Full-text search. Stores its own copy of the text so snippet() works (see DECISIONS ADR-014).
CREATE VIRTUAL TABLE pages_fts USING fts5(path UNINDEXED, title, headings, body, tags, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha TEXT,
  actor TEXT,
  client TEXT,
  tool TEXT,
  op TEXT,
  path TEXT,
  message TEXT,
  files INTEGER,
  at TEXT
);
CREATE INDEX activity_at ON activity(at);
CREATE INDEX activity_sha ON activity(sha);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);

-- Paths waiting to be (re)indexed after a webhook push.
CREATE TABLE reindex_queue (path TEXT PRIMARY KEY, head TEXT NOT NULL, enqueued_at TEXT NOT NULL);

-- Fixed-window rate limit counters (D1 instead of KV: KV free writes are 1k/day).
CREATE TABLE rate (k TEXT PRIMARY KEY, window INTEGER NOT NULL, n INTEGER NOT NULL);
