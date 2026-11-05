// MCP server: lets any MCP-capable assistant read, search and edit the wiki.
// Tools call the same REST API the app uses (validation and history live there), marked internal
// because OAuthProvider has already checked the assistant's token.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { applyEdits, EditError, headings, type EditOp } from '@shared/edit';
import { pageHref } from '@shared/markdown';
import { describePlacement, placementSchema } from '@shared/placement';
import { type PageTreeInput, pageTreeNode } from '@shared/schemas';
import { ancestorsOf, buildTree, outline, type TreeNode } from '@shared/tree';
import { VERSION } from '@shared/version';
import type {
  Page,
  PageDetail,
  PageSummary,
  Revision,
  RevisionDetail,
  SearchResponse,
  TreeResponse,
  UploadedFile,
} from '@shared/types';
import { app } from './app';
import { INTERNAL } from './auth';
import { createUploadLink, placeImage, UPLOAD_LINK_MINUTES, uploadStatus, withAlt } from './images';
import { MAX_IMAGE_BYTES, storeImage } from './routes/files';
import { indexSoon } from './search';

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

class ToolError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function apiCaller(origin: string, env: Cloudflare.Env, ctx: ExecutionContext): Call {
  const internalEnv = { ...env, [INTERNAL]: true };
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`${origin}/api${path}`, {
        method,
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      }),
      internalEnv,
      ctx,
    );
    const data = (await res.json().catch(() => null)) as T & { message?: string };
    if (!res.ok)
      throw new ToolError(data?.message ?? `Request failed (${res.status}).`, res.status);
    return data;
  };
}

const text = (v: string) => ({ content: [{ type: 'text' as const, text: v }] });
const fail = (e: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: e instanceof Error ? e.message : 'Something went wrong.',
    },
  ],
  isError: true,
});

/** Wraps a tool body so every failure comes back as a readable tool error. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

const INSTRUCTIONS = `Nitrogen is a personal wiki. Pages form a tree (each page can have child pages) and their bodies are GitHub-flavored markdown.

How to work with it:
- Find before you write: use search (hybrid semantic + keyword) or get_tree, and read_page before editing. Avoid creating duplicates of existing pages.
- Refer to a page by its id (best), its exact title, or its path from the top of the tree ("Projects / Nitrogen / Roadmap").
- For small changes use edit_page (find/replace, append, section edits). It keeps the rest of the page byte-for-byte and retries safely if the page changed. Use update_page with base_version only to rewrite a whole page.
- To build a structure (a project with sub-pages, meeting notes series), use create_pages to create the whole subtree in one call.
- Every assistant edit is saved in the page history; list_revisions and restore_revision undo mistakes.

Markdown conventions:
- Link to another page with [[Page title]], [[Page title|label]] or [[Page title#Heading]]; these power backlinks.
- Callouts: "> [!NOTE]", "> [!TIP]", "> [!WARNING]" as the first line of a blockquote.
- Images are stored in Nitrogen (R2) and shown with markdown like ![alt](/files/img/…). To add one: add_image with a public URL or base64 bytes, or, for an image the person has (e.g. attached in chat, which tools can't receive), request_image_upload and give them the link. Both place the image at a precise spot: under a heading, at the end of a section, before/after exact text, or in place of a placeholder like "[photo]". Don't hotlink external images.
- Don't repeat the page title as a "# Title" heading at the top of the body; the title is shown separately. Start sections at "##".`;

interface TreeCtx {
  pages: PageSummary[];
  byId: Map<string, PageSummary>;
  roots: TreeNode[];
  home: string | null;
}

function buildServer(call: Call, origin: string, env: Cloudflare.Env, ctx: ExecutionContext) {
  const server = new McpServer(
    { name: 'nitrogen', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  const loadTree = async (): Promise<TreeCtx> => {
    const t = await call<TreeResponse>('GET', '/tree');
    return {
      pages: t.pages,
      byId: new Map(t.pages.map((p) => [p.id, p])),
      roots: buildTree(t.pages),
      home: t.home_id,
    };
  };

  const pathOf = (id: string, t: TreeCtx) =>
    [...ancestorsOf(id, t.byId), t.byId.get(id)!].map((p) => p.title).join(' / ');

  const urlOf = (p: { id: string; title: string }) => `${origin}${pageHref(p.id, p.title)}`;

  /** Id, exact title, or "A / B / C" path. Explains ambiguity and suggests near misses. */
  function resolve(key: string, t: TreeCtx): PageSummary {
    const k = key.trim();
    const byId = t.byId.get(k);
    if (byId) return byId;
    const parts = k.split(/\s+[/>›]\s+/).map((s) => s.trim().toLowerCase());
    if (parts.length > 1) {
      let level: PageSummary[] = t.pages.filter((p) => !p.parent_id);
      let hit: PageSummary | undefined;
      for (const part of parts) {
        hit = level.find((p) => p.title.toLowerCase() === part);
        if (!hit) break;
        level = t.pages.filter((p) => p.parent_id === hit!.id);
      }
      if (hit) return hit;
    }
    const lower = k.toLowerCase();
    const exact = t.pages.filter((p) => p.title.toLowerCase() === lower);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1)
      throw new ToolError(
        `Several pages are titled “${k}”:\n${exact.map((p) => `- ${pathOf(p.id, t)} (${p.id})`).join('\n')}\nUse the id or the full path.`,
      );
    const near = t.pages.filter((p) => p.title.toLowerCase().includes(lower)).slice(0, 8);
    throw new ToolError(
      near.length
        ? `No page is titled “${k}”. Did you mean:\n${near.map((p) => `- ${pathOf(p.id, t)} (${p.id})`).join('\n')}`
        : `No page matches “${k}”. Use search or get_tree to find it.`,
      404,
    );
  }

  /** null/""/"top" means the top level of the tree. */
  const resolveParent = (key: string | null | undefined, t: TreeCtx) =>
    key === undefined || key === null || ['', 'top', 'root', '/'].includes(key.trim().toLowerCase())
      ? null
      : resolve(key, t).id;

  const describe = (p: { id: string; title: string }, t?: TreeCtx) =>
    `“${p.title}” (id ${p.id}${t?.byId.has(p.id) ? `, path ${pathOf(p.id, t)}` : ''})`;

  // ---------------------------------------------------------------- read

  server.registerTool(
    'get_tree',
    {
      title: 'Show the page tree',
      description:
        'The wiki’s page hierarchy as an indented outline with page ids. Optionally only the subtree under one page, and/or limited to a depth.',
      inputSchema: z.object({
        under: z.string().optional().describe('Page id, title or path. Omit for the whole wiki.'),
        depth: z.number().int().min(0).max(20).optional().describe('0 = only the top level.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ under, depth }) => {
      const t = await loadTree();
      if (!t.pages.length) return text('The wiki is empty. Use create_page or create_pages.');
      let roots = t.roots;
      let header = `${t.pages.length} pages.`;
      if (under) {
        const p = resolve(under, t);
        const find = (nodes: TreeNode[]): TreeNode | undefined =>
          nodes.map((n) => (n.page.id === p.id ? n : find(n.children))).find(Boolean);
        const node = find(t.roots)!;
        roots = node.children;
        header = `Pages under ${describe(p, t)}:`;
        if (!roots.length) return text(`${describe(p, t)} has no child pages.`);
      }
      const lines = outline(roots, 0, depth ?? Infinity);
      const home = t.home ? `\nHome page: ${describe(t.byId.get(t.home)!)}` : '';
      return text(`${header}${home}\n\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'read_page',
    {
      title: 'Read a page',
      description:
        'A page’s markdown body plus its id, version (needed for update_page), path in the tree, child pages and backlinks. Optionally include a table of contents only, for long pages.',
      inputSchema: z.object({
        page: z.string().describe('Page id, exact title, or path like "Projects / Nitrogen".'),
        outline_only: z
          .boolean()
          .optional()
          .describe('Return only the headings instead of the full body.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ page, outline_only }) => {
      const t = await loadTree();
      const d = await call<PageDetail>('GET', `/pages/${resolve(page, t).id}`);
      const p = d.page;
      const meta = [
        `# ${p.icon ? `${p.icon} ` : ''}${p.title}`,
        `id: ${p.id} · version: ${p.version} · updated: ${p.updated_at}`,
        `path: ${[...d.ancestors.map((a) => a.title), p.title].join(' / ')}`,
        `url: ${urlOf(p)}`,
        d.children.length
          ? `children: ${d.children.map((c) => `${c.title} (${c.id})`).join(', ')}`
          : 'children: none',
        d.backlinks.length
          ? `linked from: ${d.backlinks.map((c) => `${c.title} (${c.id})`).join(', ')}`
          : 'linked from: none',
      ].join('\n');
      if (outline_only) {
        const hs = headings(p.body);
        return text(
          `${meta}\n\n${hs.length ? hs.map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}`).join('\n') : '(no headings)'}\n\n(${p.body.length} characters)`,
        );
      }
      return text(`${meta}\n\n---\n\n${p.body || '(empty page)'}`);
    }),
  );

  server.registerTool(
    'search',
    {
      title: 'Search the wiki',
      description:
        'Find pages by meaning and by keywords. "hybrid" (default) combines semantic search with keyword matching; "keyword" matches words exactly (fast, good for names and codes); "semantic" matches by meaning only. Returns ids, paths and snippets.',
      inputSchema: z.object({
        query: z.string().min(1),
        mode: z.enum(['hybrid', 'semantic', 'keyword']).optional(),
        under: z.string().optional().describe('Only return pages inside this page’s subtree.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ query, mode, under, limit }) => {
      const t = await loadTree();
      const scope = under ? resolve(under, t) : null;
      const want = limit ?? 10;
      const res = await call<SearchResponse>(
        'GET',
        `/search?${new URLSearchParams({ q: query, mode: mode ?? 'hybrid', limit: String(scope ? 50 : want) })}`,
      );
      let hits = res.hits;
      if (scope)
        hits = hits.filter(
          (h) => h.id !== scope.id && ancestorsOf(h.id, t.byId).some((a) => a.id === scope.id),
        );
      hits = hits.slice(0, want);
      const note = res.semantic_unavailable ? `Note: ${res.semantic_unavailable}\n\n` : '';
      if (!hits.length) return text(`${note}No pages match “${query}”.`);
      return text(
        note +
          hits
            .map(
              (h, i) =>
                `${i + 1}. ${h.title} (${h.id})${h.path.length ? ` — in ${h.path.join(' / ')}` : ''} [${h.source}]\n   ${h.snippet.replaceAll('\u0001', '**').replaceAll('\u0002', '**')}`,
            )
            .join('\n'),
      );
    }),
  );

  // ---------------------------------------------------------------- write

  server.registerTool(
    'create_page',
    {
      title: 'Create a page',
      description:
        'Create one page, at the top level or under a parent page. The body is markdown. Returns the new page’s id.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        parent: z
          .string()
          .optional()
          .describe('Parent page id, title or path. Omit (or "top") for the top level.'),
        body: z.string().optional(),
        icon: z.string().max(16).optional().describe('An emoji, e.g. "📘".'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Index among its siblings; omit to add at the end.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ title, parent, body, icon, position }) => {
      const t = await loadTree();
      const parentId = resolveParent(parent, t);
      const dup = t.pages.find(
        (p) => p.parent_id === parentId && p.title.toLowerCase() === title.trim().toLowerCase(),
      );
      if (dup)
        throw new ToolError(
          `${describe(dup, t)} already exists in that place. Edit it instead, or pick a different title.`,
          409,
        );
      const page = await call<Page>('POST', '/pages', {
        title,
        parent_id: parentId,
        body: body ?? '',
        icon: icon ?? null,
        position,
      });
      return text(
        `Created ${describe(page)}${parentId ? ` under ${describe(t.byId.get(parentId)!)}` : ' at the top level'}.\nversion: ${page.version}\nurl: ${urlOf(page)}`,
      );
    }),
  );

  server.registerTool(
    'create_pages',
    {
      title: 'Create a tree of pages',
      description:
        'Create several pages at once, nested with "children", under one parent (or the top level). Use this to set up a structure in a single step. Up to 200 pages.',
      inputSchema: z.object({
        parent: z
          .string()
          .optional()
          .describe('Parent page id, title or path. Omit for the top level.'),
        pages: z.array(pageTreeNode).min(1).max(200),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ parent, pages }) => {
      const t = await loadTree();
      const parentId = resolveParent(parent, t);
      const { created } = await call<{
        created: { id: string; title: string; parent_id: string | null }[];
      }>('POST', '/pages/tree', { parent_id: parentId, pages: pages as PageTreeInput[] });
      const depthOf = new Map<string, number>();
      const lines = created.map((p) => {
        const d = p.parent_id && depthOf.has(p.parent_id) ? depthOf.get(p.parent_id)! + 1 : 0;
        depthOf.set(p.id, d);
        return `${'  '.repeat(d)}- ${p.title} (${p.id})`;
      });
      return text(
        `Created ${created.length} page(s)${parentId ? ` under ${describe(t.byId.get(parentId)!)}` : ''}:\n${lines.join('\n')}`,
      );
    }),
  );

  const editOp = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('replace'),
      find: z.string().min(1).describe('Exact text currently in the page.'),
      replace: z.string(),
      all: z.boolean().optional().describe('Replace every occurrence (default: must be unique).'),
    }),
    z.object({ type: z.literal('delete'), find: z.string().min(1), all: z.boolean().optional() }),
    z.object({ type: z.literal('append'), text: z.string().min(1) }),
    z.object({ type: z.literal('prepend'), text: z.string().min(1) }),
    z.object({ type: z.literal('insert_after'), find: z.string().min(1), text: z.string().min(1) }),
    z.object({
      type: z.literal('insert_before'),
      find: z.string().min(1),
      text: z.string().min(1),
    }),
    z.object({
      type: z.literal('append_to_section'),
      heading: z.string().min(1).describe('Heading text, without the #s.'),
      text: z.string().min(1),
    }),
    z.object({ type: z.literal('replace_section'), heading: z.string().min(1), text: z.string() }),
    z.object({
      type: z.literal('add_section'),
      heading: z.string().min(1),
      text: z.string(),
      level: z.number().int().min(1).max(6).optional(),
      under: z
        .string()
        .optional()
        .describe('Add as a subsection at the end of this heading’s section.'),
    }),
  ]);

  server.registerTool(
    'edit_page',
    {
      title: 'Edit part of a page',
      description:
        'Make targeted changes to a page body: replace/delete exact text, insert text before/after exact text, append/prepend, or edit a section by its heading. Edits apply in order and all-or-nothing. If the page changed meanwhile, the edits are re-applied to the latest version (unless base_version is given). Can also rename the page or change its icon.',
      inputSchema: z.object({
        page: z.string().describe('Page id, exact title, or path.'),
        edits: z.array(editOp).max(50).optional(),
        title: z.string().min(1).max(200).optional().describe('New title.'),
        icon: z
          .string()
          .max(16)
          .nullable()
          .optional()
          .describe('New emoji icon, or null to remove.'),
        base_version: z
          .number()
          .int()
          .optional()
          .describe('Fail instead of re-applying if the page is no longer at this version.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ page, edits, title, icon, base_version }) => {
      if (!edits?.length && title === undefined && icon === undefined)
        throw new ToolError('Nothing to change: give edits, title or icon.');
      const t = await loadTree();
      const id = resolve(page, t).id;
      for (let attempt = 0; ; attempt++) {
        const { page: cur } = await call<PageDetail>('GET', `/pages/${id}`);
        if (base_version !== undefined && base_version !== cur.version)
          throw new ToolError(
            `The page is at version ${cur.version}, not ${base_version}. Read it again before editing.`,
            409,
          );
        let body: string | undefined;
        try {
          body = edits?.length ? applyEdits(cur.body, edits as EditOp[]) : undefined;
        } catch (e) {
          if (e instanceof EditError) throw new ToolError(e.message);
          throw e;
        }
        try {
          const next = await call<Page>('PATCH', `/pages/${id}`, {
            ...(body !== undefined && body !== cur.body ? { body } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(icon !== undefined ? { icon } : {}),
            base_version: cur.version,
          });
          if (next.version === cur.version) return text('No change: the page already says that.');
          const delta =
            body !== undefined
              ? ` (${body.length - cur.body.length >= 0 ? '+' : ''}${body.length - cur.body.length} characters)`
              : '';
          return text(`Saved ${describe(next)}: version ${cur.version} → ${next.version}${delta}.`);
        } catch (e) {
          // Someone saved in between: re-read and re-apply once more.
          if (
            e instanceof ToolError &&
            e.status === 409 &&
            base_version === undefined &&
            attempt < 2
          )
            continue;
          throw e;
        }
      }
    }),
  );

  server.registerTool(
    'update_page',
    {
      title: 'Rewrite a page',
      description:
        'Replace a page’s whole body (and optionally its title/icon). Requires base_version from read_page so concurrent changes are never overwritten. Prefer edit_page for partial changes.',
      inputSchema: z.object({
        page: z.string(),
        base_version: z.number().int().describe('The version you read.'),
        body: z.string().optional(),
        title: z.string().min(1).max(200).optional(),
        icon: z.string().max(16).nullable().optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ page, base_version, body, title, icon }) => {
      const t = await loadTree();
      const id = resolve(page, t).id;
      const next = await call<Page>('PATCH', `/pages/${id}`, {
        ...(body !== undefined ? { body } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(icon !== undefined ? { icon } : {}),
        base_version,
      });
      return text(
        `Saved ${describe(next)}, now version ${next.version}. The previous text is in the page history.`,
      );
    }),
  );

  server.registerTool(
    'move_page',
    {
      title: 'Move a page',
      description:
        'Move a page (with all its children) under another parent or to the top level, and/or reorder it among its siblings.',
      inputSchema: z.object({
        page: z.string(),
        new_parent: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Parent id, title or path; null or "top" for the top level. Omit to keep the current parent.',
          ),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Index among the new siblings; omit for the end.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ page, new_parent, position }) => {
      const t = await loadTree();
      const p = resolve(page, t);
      const parentId = new_parent === undefined ? p.parent_id : resolveParent(new_parent, t);
      await call('POST', `/pages/${p.id}/move`, { parent_id: parentId, position });
      const t2 = await loadTree();
      return text(`Moved. ${p.title} is now at ${pathOf(p.id, t2)}.`);
    }),
  );

  server.registerTool(
    'delete_page',
    {
      title: 'Delete a page',
      description:
        'Permanently delete a page AND all pages under it (their history too). To confirm, pass the page’s exact title as confirm_title. Prefer move_page to archive instead.',
      inputSchema: z.object({
        page: z.string(),
        confirm_title: z.string().describe('The exact title of the page being deleted.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ page, confirm_title }) => {
      const t = await loadTree();
      const p = resolve(page, t);
      const count = (id: string): number =>
        1 + t.pages.filter((c) => c.parent_id === id).reduce((n, c) => n + count(c.id), 0);
      if (confirm_title.trim() !== p.title)
        throw new ToolError(
          `Not deleted. confirm_title must be exactly “${p.title}”. This would delete ${count(p.id)} page(s).`,
        );
      const res = await call<{ deleted: number; images_removed: number }>(
        'DELETE',
        `/pages/${p.id}`,
      );
      return text(
        `Deleted ${res.deleted} page(s) (${p.title} and everything under it)${res.images_removed ? ` and ${res.images_removed} unused image(s)` : ''}.`,
      );
    }),
  );

  // ---------------------------------------------------------------- history

  server.registerTool(
    'list_revisions',
    {
      title: 'Page history',
      description:
        'Earlier versions of a page, newest first. Use read_revision to see one and restore_revision to bring it back.',
      inputSchema: z.object({ page: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ page }) => {
      const t = await loadTree();
      const p = resolve(page, t);
      const { revisions } = await call<{ revisions: Revision[] }>(
        'GET',
        `/pages/${p.id}/revisions`,
      );
      if (!revisions.length) return text(`${describe(p)} has no earlier versions.`);
      return text(
        `History of ${describe(p)}:\n${revisions.map((r) => `- revision ${r.id}: version ${r.version} “${r.title}”, saved ${r.created_at}`).join('\n')}`,
      );
    }),
  );

  server.registerTool(
    'read_revision',
    {
      title: 'Read an old version',
      description: 'The full markdown of an earlier version of a page.',
      inputSchema: z.object({ page: z.string(), revision: z.number().int() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ page, revision }) => {
      const t = await loadTree();
      const p = resolve(page, t);
      const r = await call<RevisionDetail>('GET', `/pages/${p.id}/revisions/${revision}`);
      return text(
        `# ${r.title}\nrevision ${r.id} · version ${r.version} · ${r.created_at}\n\n---\n\n${r.body}`,
      );
    }),
  );

  server.registerTool(
    'restore_revision',
    {
      title: 'Restore an old version',
      description:
        'Bring back an earlier version of a page. The current text is kept in the history first.',
      inputSchema: z.object({ page: z.string(), revision: z.number().int() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ page, revision }) => {
      const t = await loadTree();
      const p = resolve(page, t);
      const next = await call<Page>('POST', `/pages/${p.id}/revisions/${revision}/restore`);
      return text(
        `Restored revision ${revision}. ${describe(next)} is now version ${next.version}.`,
      );
    }),
  );

  // ---------------------------------------------------------------- images

  const placementArg = placementSchema
    .optional()
    .describe('Where in the page the image goes. Default: the end of the page. Choose one key.');

  server.registerTool(
    'add_image',
    {
      title: 'Add an image',
      description:
        'Store an image in the wiki (R2) and optionally place it in a page at a precise spot. Give either url (a public https image) or data_base64 (the file’s bytes, for clients that can read files, like Claude Code). An image someone attached in this chat cannot be passed here: use request_image_upload instead.',
      inputSchema: z.object({
        url: z.string().url().optional(),
        data_base64: z
          .string()
          .optional()
          .describe('Base64 image bytes (a "data:image/…;base64," prefix is fine). Max 15 MB.'),
        filename: z.string().max(200).optional(),
        alt: z.string().max(200).optional().describe('Alt text describing the image.'),
        page: z.string().optional().describe('Page to put the image in. Omit to only store it.'),
        placement: placementArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ url, data_base64, filename, alt, page, placement }) => {
      if (!url === !data_base64) throw new ToolError('Give exactly one of url or data_base64.');
      const t = await loadTree();
      const target = page ? resolve(page, t) : null;
      if (placement && !target) throw new ToolError('Give page to place the image in.');

      let bytes: Uint8Array;
      let name = filename?.trim() || alt?.trim() || 'image';
      if (url) {
        const u = new URL(url);
        if (u.protocol !== 'https:') throw new ToolError('Use an https:// URL.');
        const res = await fetch(u, { headers: { Accept: 'image/*' }, redirect: 'follow' });
        if (!res.ok) throw new ToolError(`Could not download the image (HTTP ${res.status}).`);
        if (Number(res.headers.get('Content-Length') ?? 0) > MAX_IMAGE_BYTES)
          throw new ToolError('Images can be 15 MB at most.');
        bytes = new Uint8Array(await res.arrayBuffer());
        if (!filename && !alt) name = decodeURIComponent(u.pathname.split('/').pop() || 'image');
      } else {
        const b64 = data_base64!.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4)
          throw new ToolError('Images can be 15 MB at most.');
        try {
          bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        } catch {
          throw new ToolError('data_base64 is not valid base64.');
        }
      }
      const file: UploadedFile = await storeImage(env, bytes, name, target?.id ?? null).catch(
        (e: unknown) => {
          throw new ToolError(e instanceof Error ? e.message : 'Could not store the image.');
        },
      );
      const markdown = withAlt(file.markdown, file.url, alt);
      if (!target) return text(`Stored. Markdown:\n${markdown}`);
      const placed = await placeImage(env.DB, target.id, markdown, placement);
      indexSoon(env, ctx);
      return text(
        `${placed.fallback ? `Couldn’t find the requested spot (${placed.fallback}), so the image went at the end of the page. ` : ''}Added to ${describe(placed.page)} ${placed.fallback ? '' : describePlacement(placement)} (version ${placed.page.version}).\nMarkdown: ${markdown}`,
      );
    }),
  );

  server.registerTool(
    'request_image_upload',
    {
      title: 'Ask for an image upload',
      description: `Get a one-time upload link for a page. Use this when the person wants to add an image they have (for example one they attached in this chat, which tools can't receive). Give them the link: they open it on any device, pick or drop the image, and it is stored and placed in the page at the chosen spot. The link works once and expires after ${UPLOAD_LINK_MINUTES} minutes. Then check image_upload_status (or read_page). Agents with a shell can also POST the file to the link themselves.`,
      inputSchema: z.object({
        page: z.string().describe('Page id, title or path.'),
        placement: placementArg,
        alt: z.string().max(200).optional().describe('Alt text describing the expected image.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ page, placement, alt }) => {
      const t = await loadTree();
      const target = resolve(page, t);
      const link = await createUploadLink(env.DB, target.id, placement, alt);
      const url = `${origin}/u/${link.token}`;
      return text(
        [
          `Upload link for ${describe(target, t)}; the image will go ${describePlacement(placement)}:`,
          url,
          '',
          `Share it with the person. It works once and expires at ${link.expires_at}.`,
          `From a shell: curl -X POST --data-binary @photo.jpg -H 'Content-Type: image/jpeg' ${url}`,
          `Upload id for image_upload_status: ${link.token}`,
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'image_upload_status',
    {
      title: 'Check an image upload',
      description:
        'Whether an upload link from request_image_upload has been used yet, and the resulting markdown.',
      inputSchema: z.object({ upload_id: z.string().min(10) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ upload_id }) => {
      const s = await uploadStatus(env.DB, upload_id.trim().replace(/^.*\/u\//, ''));
      switch (s.state) {
        case 'done':
          return text(
            `Uploaded and placed${s.note ? ` (${s.note})` : ''}.\nMarkdown: ${s.markdown}`,
          );
        case 'waiting':
          return text(`Not uploaded yet. The link expires at ${s.expires_at}.`);
        case 'uploading':
          return text('Uploading right now; check again in a moment.');
        case 'expired':
          return text(
            'The link expired without an upload. Ask for a new one with request_image_upload.',
          );
        default:
          return text('No upload has that id.');
      }
    }),
  );

  // ---------------------------------------------------------------- resources

  server.registerResource(
    'guide',
    'nitrogen://guide',
    {
      title: 'How to write Nitrogen pages',
      description: 'Conventions for page structure, links, callouts and images.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: INSTRUCTIONS }],
    }),
  );

  return server;
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    const call = apiCaller(origin, env, ctx);
    const handler = createMcpHandler(() => buildServer(call, origin, env, ctx));
    return handler.fetch(request);
  },
};
