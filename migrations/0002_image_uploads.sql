-- One-time upload links: an assistant asks for one, the person opens it and drops an image, and
-- the image is stored in R2 and inserted into the page at `placement`.
CREATE TABLE image_uploads (
  token TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  placement TEXT NOT NULL DEFAULT '{}',
  alt TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set when claimed; key/markdown once the image is stored.
  used_at TEXT,
  file_key TEXT,
  markdown TEXT,
  note TEXT
);
CREATE INDEX idx_image_uploads_expires ON image_uploads (expires_at);
