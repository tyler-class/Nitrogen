-- AI Sessions entries hold no to-dos, questions or reminders: they're read-only, so nothing on
-- them could be checked off or answered. Drop any the index kept for them (or for the Sessions
-- page itself); from now on they're never indexed.
DELETE FROM page_items
WHERE page_id IN (SELECT page_id FROM session_entries)
   OR page_id = (SELECT value FROM settings WHERE key = 'sessions_id')
   OR page_id IN (
     SELECT id FROM pages WHERE parent_id = (SELECT value FROM settings WHERE key = 'sessions_id')
   );
