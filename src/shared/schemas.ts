import { z } from 'zod';
import { MAX_TAG, normalizeTag } from './markdown';

export const MAX_BODY = 512 * 1024;
export const MAX_TITLE = 200;

const title = z.string().trim().min(1, 'Give the page a title.').max(MAX_TITLE);
const icon = z.string().trim().max(16).nullable();
const body = z.string().max(MAX_BODY, 'This page is too long (512 KB at most).');
/** Normalized, de-duplicated; empty ones dropped. */
const tags = z
  .array(z.string().max(MAX_TAG * 2))
  .max(30, 'At most 30 tags.')
  .transform((list) => [...new Set(list.map(normalizeTag).filter(Boolean))]);

export const loginInput = z.object({ password: z.string().min(1).max(500) });

export const createPageInput = z.object({
  title,
  parent_id: z.string().min(1).nullable().default(null),
  icon: icon.optional(),
  body: body.default(''),
  tags: tags.optional(),
  /** Index among the new siblings; defaults to the end. */
  position: z.number().int().min(0).optional(),
});

export const updatePageInput = z
  .object({
    title: title.optional(),
    icon: icon.optional(),
    body: body.optional(),
    tags: tags.optional(),
    /** The version the edit was based on. A mismatch is a 409 conflict. Omit to overwrite. */
    base_version: z.number().int().min(1).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined || v.icon !== undefined || v.body !== undefined || v.tags !== undefined,
    {
      message: 'Nothing to change.',
    },
  );

export const movePageInput = z.object({
  parent_id: z.string().min(1).nullable(),
  /** Index among the new siblings (after removal from the old position). Defaults to the end. */
  position: z.number().int().min(0).optional(),
});

export const panelLayoutInput = z
  .array(
    z.object({
      id: z.string().min(1).max(40),
      size: z.enum(['half', 'full']),
      hidden: z.boolean(),
    }),
  )
  .max(40)
  .refine((l) => new Set(l.map((s) => s.id)).size === l.length, 'Each panel once.');

export const settingsInput = z.object({
  /** A page to open at "/" instead of the dashboard. */
  home_id: z.string().min(1).nullable().optional(),
  /** The page assistants read first for your conventions. */
  guide_id: z.string().min(1).nullable().optional(),
  /** Panel order, width and visibility; unknown or missing panels use defaults. */
  dashboard_layout: panelLayoutInput.optional(),
  insights_layout: panelLayoutInput.optional(),
  /** Someone added the update workflow to this copy's GitHub repo (Settings → Updates). */
  updates_set_up: z.boolean().optional(),
  /** Send the anonymous daily check-in (counts only). */
  telemetry: z.boolean().optional(),
});

export const pinInput = z.object({ pinned: z.boolean() });

export const revertInput = z.object({
  actor: z.string().min(1).max(100),
  from: z.string().min(10).max(40),
  to: z.string().min(10).max(40),
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
        tags: tags.optional(),
        created_by: z.string().max(100).nullable().optional(),
        updated_by: z.string().max(100).nullable().optional(),
        pinned_at: z.string().max(40).nullable().optional(),
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
  tags?: string[];
  children?: PageTreeInput[];
}

export const pageTreeNode: z.ZodType<PageTreeInput> = z.lazy(() =>
  z.object({
    title,
    icon: icon.optional(),
    body: body.optional(),
    tags: tags.optional(),
    children: z.array(pageTreeNode).max(MAX_BULK_PAGES).optional(),
  }),
);

export const createTreeInput = z.object({
  parent_id: z.string().min(1).nullable().default(null),
  /** Index among the new siblings for the first top-level page; defaults to the end. */
  position: z.number().int().min(0).optional(),
  pages: z.array(pageTreeNode).min(1).max(MAX_BULK_PAGES),
});
