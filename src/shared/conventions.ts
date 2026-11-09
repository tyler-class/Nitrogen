// Conventions: one page of the owner's house rules for the wiki (where things go, naming, tags,
// style). In the database it's an ordinary page, pointed to by the "guide_id" setting; the app
// shows it on its own (/conventions, outside the page tree), and assistants get it in their
// instructions when they connect and through get_conventions / update_conventions.

export const CONVENTIONS_TITLE = 'Conventions';
export const CONVENTIONS_ICON = '🧭';

/** A starter page to edit. */
export const CONVENTIONS_TEMPLATE = `Assistants read this page before working in the wiki. Edit it to match how you work.

## Where things go
- One top-level page per area of life or work; projects live under their area.
- Meeting notes go under the project, titled "YYYY-MM-DD · Topic".
- Assistants' sessions are recorded under AI Sessions automatically; add a summary with log_session.

## Before writing
- Search first and add to an existing page rather than creating a near-duplicate.
- Link related pages with [[Page title]] the first time they come up.

## Tags
- Reuse existing tags (list_tags). Common ones: #decision, #open-question, #idea, #reference.

## Style
- Short sections with "##" headings; lead with the conclusion.
- Mark anything uncertain with a > [!NOTE] callout.
`;
