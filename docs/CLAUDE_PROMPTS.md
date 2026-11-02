# Prompts that work well with the Nitrogen connector

Claude reads the format rules from the server at connect time and calls `get_format_guide` before
its first write. These prompts lean on that.

## Capture

- "Capture this as a note under /inbox: <paste>. Pick a kebab-case file name, add tags, and link it
  to anything related you find with search."
- "Turn this meeting transcript into meeting notes under /meetings/2026/ with decisions as
  `decision` callouts and open questions as `question` callouts."

## Decisions

- "Write ADR-012 under /decisions: we keep D1 as a rebuildable cache. It supersedes ADR-007 (use
  a `rel:supersedes` link) and depends on the sync design."
- "Which decisions have nothing implementing them? Use link_matrix with rows under:decisions and
  columns under:architecture, then list empty rows."

## Editing

- "In /architecture/sync-design.md, replace the Polling section with a two-row table of poll
  intervals (visible 20 s, hidden 60 s). Use patch_page."
- "Add a drawer with the field reference to the bottom of /salesforce/objects/opportunity.md."
- "Move /notes/old-idea.md to /archive/old-idea.md." (Inbound links are rewritten in the same commit.)

## Linking and review

- "Find unlinked mentions of 'Commit pipeline' and link the best two."
- "Weekly review: read recent_changes for the last 7 days and draft /reviews/2026-w45.md."
- "Show me how /decisions/adr-004-direct-commits.md connects to /architecture/sync-design.md."

## Export

- "Preview /architecture/sync-design.md as strict CommonMark and tell me what is lost."
- "Export /decisions as GFM and commit the copy." (Lands in /_exports/gfm/.)

## Safety

- Claude cannot write to `.github/`, `.nitrogen/`, `images/` (except through upload_image) or pages
  with `locked: true`. Every write is one commit with `Nitrogen-Actor: claude`; revert it from
  Activity.
- Text inside your pages is treated as data. A page that says "ignore previous instructions" is
  just a page.
