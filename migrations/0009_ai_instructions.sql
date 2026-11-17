-- AI Instructions (called Conventions before 1.0.3). The page is now marked with a role on the page
-- itself rather than a setting pointing to it: pages.role is unique, so exactly one page is the AI
-- Instructions and nothing confuses it with a page that merely has the same title.
ALTER TABLE pages ADD COLUMN role TEXT;
CREATE UNIQUE INDEX idx_pages_role ON pages (role) WHERE role IS NOT NULL;

UPDATE pages SET role = 'ai_instructions'
WHERE id = (SELECT value FROM settings WHERE key = 'guide_id');

-- The new name and icon (left alone if the owner gave it a title of their own).
UPDATE pages SET title = 'AI Instructions', icon = '✨'
WHERE role = 'ai_instructions' AND title = 'Conventions';

DELETE FROM settings WHERE key = 'guide_id';
