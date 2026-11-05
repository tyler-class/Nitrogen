// Where an image (or any block) goes in a page body. Used by the MCP tools and upload links.
import { z } from 'zod';
import type { EditOp } from './edit';

export const placementSchema = z
  .object({
    at: z.enum(['start', 'end']).optional().describe('Top or bottom of the page.'),
    under_heading: z.string().min(1).optional().describe('Directly below this heading.'),
    end_of_section: z.string().min(1).optional().describe('At the end of this heading’s section.'),
    after_text: z.string().min(1).optional().describe('Right after this exact text.'),
    before_text: z.string().min(1).optional().describe('Right before this exact text.'),
    replace_text: z
      .string()
      .min(1)
      .optional()
      .describe('Replace this exact text, e.g. a placeholder like "[photo of the garden]".'),
  })
  .refine((p) => Object.values(p).filter((v) => v !== undefined).length <= 1, {
    message:
      'Choose one placement (at, under_heading, end_of_section, after_text, before_text or replace_text).',
  });

export type Placement = z.output<typeof placementSchema>;

/** The edit that puts `block` (e.g. image markdown) on its own lines at `p`. Default: end of page. */
export function placementOp(p: Placement | undefined, block: string): EditOp {
  if (p?.replace_text) return { type: 'replace', find: p.replace_text, replace: block };
  if (p?.after_text) return { type: 'insert_after', find: p.after_text, text: `\n\n${block}\n\n` };
  if (p?.before_text) return { type: 'insert_before', find: p.before_text, text: `${block}\n\n` };
  if (p?.under_heading)
    return { type: 'insert_under_heading', heading: p.under_heading, text: block };
  if (p?.end_of_section)
    return { type: 'append_to_section', heading: p.end_of_section, text: block };
  if (p?.at === 'start') return { type: 'prepend', text: block };
  return { type: 'append', text: block };
}

export function describePlacement(p: Placement | undefined): string {
  if (p?.replace_text) return `in place of “${p.replace_text}”`;
  if (p?.after_text) return `after “${p.after_text}”`;
  if (p?.before_text) return `before “${p.before_text}”`;
  if (p?.under_heading) return `under the heading “${p.under_heading}”`;
  if (p?.end_of_section) return `at the end of the “${p.end_of_section}” section`;
  if (p?.at === 'start') return 'at the top of the page';
  return 'at the end of the page';
}
