// AI Instructions: the owner's house rules for assistants. It's an ordinary page marked with the
// role "ai_instructions" (pages.role, unique across the wiki), so it's found by that flag and never
// by its title: a page someone else calls "AI Instructions" is just a page. It always exists: the
// first time anything asks for it, it's made from the default template, and the owner edits it
// from there.
import { YOU } from '@shared/actor';
import {
  INSTRUCTIONS_ICON,
  INSTRUCTIONS_ROLE,
  INSTRUCTIONS_TEMPLATE,
  INSTRUCTIONS_TITLE,
} from '@shared/instructions';
import { first } from './db';
import { createPage } from './pages';

/** The AI Instructions page's id, or null if it hasn't been made yet. */
export async function instructionsId(db: D1Database): Promise<string | null> {
  return (
    (await first<{ id: string }>(db, 'SELECT id FROM pages WHERE role = ?', INSTRUCTIONS_ROLE))
      ?.id ?? null
  );
}

/** The AI Instructions page's id, making it from the template if there isn't one. */
export async function ensureInstructions(db: D1Database): Promise<string> {
  const id = await instructionsId(db);
  if (id) return id;
  const page = await createPage(
    db,
    {
      title: INSTRUCTIONS_TITLE,
      parent_id: null,
      icon: INSTRUCTIONS_ICON,
      body: INSTRUCTIONS_TEMPLATE,
    },
    YOU,
  );
  // The role is unique: if another request made the page first, this one's copy goes.
  try {
    await db
      .prepare('UPDATE pages SET role = ? WHERE id = ?')
      .bind(INSTRUCTIONS_ROLE, page.id)
      .run();
    return page.id;
  } catch {
    await db.prepare('DELETE FROM pages WHERE id = ?').bind(page.id).run();
    return (await instructionsId(db))!;
  }
}
