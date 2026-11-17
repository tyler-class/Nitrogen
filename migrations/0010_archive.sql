-- Archived pages (1.0.4): out of the tree, search, open items and assistants' view, but kept and
-- restorable. Archiving a page archives everything inside it with the same timestamp, so restoring
-- brings back exactly that branch.
ALTER TABLE pages ADD COLUMN archived_at TEXT;
CREATE INDEX idx_pages_archived ON pages (archived_at) WHERE archived_at IS NOT NULL;
