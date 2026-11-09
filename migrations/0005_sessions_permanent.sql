-- AI session entries can no longer be deleted (0.16.0). The AI Sessions page's description,
-- written once when the page was created, still told people how to purge one: say they're
-- permanent instead. Only that exact sentence changes; nothing else on the page is touched.
UPDATE pages
SET body = replace(
  body,
  'Entries are read-only. To remove a bad one, open it and choose **Purge entry**.',
  'Entries are read-only and permanent.'
)
WHERE body LIKE '%To remove a bad one, open it and choose **Purge entry**.%';
