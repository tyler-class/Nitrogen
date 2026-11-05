import { z } from 'zod';

export const MAX_BODY = 512 * 1024;
export const MAX_TITLE = 200;

const title = z.string().trim().min(1, 'Give the page a title.').max(MAX_TITLE);
const icon = z.string().trim().max(16).nullable();
const body = z.string().max(MAX_BODY, 'This page is too long (512 KB at most).');

export const loginInput = z.object({ password: z.string().min(1).max(500) });

export const createPageInput = z.object({
  title,
  parent_id: z.string().min(1).nullable().default(null),
  icon: icon.optional(),
  body: body.default(''),
  /** Index among the new siblings; defaults to the end. */
  position: z.number().int().min(0).optional(),
});

export const updatePageInput = z
  .object({
    title: title.optional(),
    icon: icon.optional(),
    body: body.optional(),
    /** The version the edit was based on. A mismatch is a 409 conflict. Omit to overwrite. */
    base_version: z.number().int().min(1).optional(),
  })
  .refine((v) => v.title !== undefined || v.icon !== undefined || v.body !== undefined, {
    message: 'Nothing to change.',
  });

export const movePageInput = z.object({
  parent_id: z.string().min(1).nullable(),
  /** Index among the new siblings (after removal from the old position). Defaults to the end. */
  position: z.number().int().min(0).optional(),
});

export const settingsInput = z.object({
  instance_name: z.string().trim().min(1).max(60).optional(),
  home_id: z.string().min(1).nullable().optional(),
});

export const restoreInput = z.object({
  format: z.literal('nitrogen-backup'),
  version: z.literal(1),
  pages: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        parent_id: z.string().min(1).max(64).nullable(),
        position: z.number().int(),
        title,
        icon: icon.default(null),
        body,
        created_at: z.string(),
        updated_at: z.string(),
      }),
    )
    .max(20_000),
});

export const MAX_BULK_PAGES = 200;

export interface PageTreeInput {
  title: string;
  icon?: string | null;
  body?: string;
  children?: PageTreeInput[];
}

export const pageTreeNode: z.ZodType<PageTreeInput> = z.lazy(() =>
  z.object({
    title,
    icon: icon.optional(),
    body: body.optional(),
    children: z.array(pageTreeNode).max(MAX_BULK_PAGES).optional(),
  }),
);

export const createTreeInput = z.object({
  parent_id: z.string().min(1).nullable().default(null),
  /** Index among the new siblings for the first top-level page; defaults to the end. */
  position: z.number().int().min(0).optional(),
  pages: z.array(pageTreeNode).min(1).max(MAX_BULK_PAGES),
});
