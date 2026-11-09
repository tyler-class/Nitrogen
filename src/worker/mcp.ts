// MCP server: lets any MCP-capable assistant read, search and edit the wiki.
// Tools call the same REST API the app uses (validation and history live there), marked internal
// because OAuthProvider has already checked the assistant's token.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { actorLabel, agent, type Actor } from '@shared/actor';
import { applyEdits, EditError, headings, type EditOp } from '@shared/edit';
import { CONVENTIONS_ICON, CONVENTIONS_TITLE } from '@shared/conventions';
import { EXAMPLE_PROMPTS, MCP_PROMPTS } from '@shared/examples';
import { pageHref } from '@shared/markdown';
import { describePlacement, placementSchema } from '@shared/placement';
import { type PageTreeInput, pageTreeNode } from '@shared/schemas';
import { ancestorsOf, buildTree, outline, type TreeNode } from '@shared/tree';
import { VERSION } from '@shared/version';
import type {
  Page,
  PageDetail,
  PageSummary,
  Dashboard,
  Revision,
  Session,
  RevisionDetail,
  SearchResponse,
  OpenItem,
  TagCount,
  TreeResponse,
  UploadedFile,
} from '@shared/types';
import { app } from './app';
import { ACTOR, INTERNAL } from './auth';
import { requestActorName } from './client-name';
import { getSetting } from './db';
import { getPage } from './pages';
import { touchSession } from './sessions';
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

function apiCaller(origin: string, env: Cloudflare.Env, ctx: ExecutionContext, actor: Actor): Call {
  const internalEnv = { ...env, [INTERNAL]: true, [ACTOR]: actor.name };
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
- Every assistant edit is saved in the page history under your app's name; list_revisions and restore_revision undo mistakes. The owner sees what you changed in their inbox and activity log, and can undo a whole session.
- Tag pages to group them across the tree: pass tags when creating, use tag_page later, or write #tag in the body. list_tags shows the tags in use; search can filter by tag. Reuse existing tags rather than inventing near-duplicates.
- Sessions: every change you make is recorded automatically in your entry under the read-only "Sessions" section (one entry per session, listing the pages you touched); you don't need to ask the user or do anything for that. At the end of a session that changed the wiki, call log_session once to give that entry a title and a short summary of what was decided, done and left open. You can't edit or delete session entries.
- Conventions: the owner keeps one page of house rules for the wiki (where things go, naming, tags, style). When there is one it's at the end of these instructions; follow it over the general advice here. get_conventions reads the current version; when the owner asks you to add or change a rule, use update_conventions.
- Open items: to-dos, questions and reminders are written inline on the page they belong to (see "Typed items" below), not in a separate list. open_items lists them across the wiki (filter by type, due date or section). When a session leaves something unresolved, write it as a question: or todo: item on the page it belongs to.

Markdown conventions:
- Link to another page with [[Page title]], [[Page title|label]] or [[Page title#Heading]]; these power backlinks.
- Callouts: "> [!NOTE]", "> [!TIP]", "> [!WARNING]" as the first line of a blockquote.
- Diagrams: Mermaid is supported. A fenced code block with the language "mermaid" renders as a diagram in the app. Use one when structure is clearer drawn than described: a process or decision flow (flowchart), who talks to whom over time (sequenceDiagram), states and transitions (stateDiagram-v2), a plan over time (gantt or timeline), data relationships (erDiagram), or a hierarchy (mindmap). Keep labels short, quote labels that contain punctuation, like A["Draft, review"], and put the diagram next to the text it illustrates. Example:
    \`\`\`mermaid
    flowchart LR
      A[Request] --> B{Approved?}
      B -->|Yes| C[Ship]
      B -->|No| D[Revise] --> A
    \`\`\`
  If a diagram has a syntax error the page shows the error, so check the syntax and fix it with edit_page.
- Typed items (to-dos, questions, reminders). One item per line, as a list item:
    - [ ] todo: <text> [@owner] [due:YYYY-MM-DD]
    - [ ] question: <text> [@owner]
    - [ ] reminder: <text> due:YYYY-MM-DD        (reminders must have a due date)
  Rules: the type word (todo, question or reminder, lowercase) followed by a colon comes right after the bullet and optional checkbox, at the start of the line. "@owner" is one word; "due:" takes an ISO date with no space after the colon. Done: change "[ ]" to "[x]". A question is resolved by checking it and ending the line with " answer: <the answer>". Items in code blocks are ignored. The app shows them as cards with a summary at the top of the page; open_items lists them.
  Examples: "- [ ] todo: Send the draft to legal @maria due:2026-11-20", "- [x] question: Which vendor? answer: Acme, cheaper at our volume.", "- [ ] reminder: Renew the domain due:2026-12-01".
- Images are stored in Nitrogen (R2) and shown with markdown like ![alt](/files/img/…). To add one: add_image with a public URL or base64 bytes, or, for an image the person has (e.g. attached in chat, which tools can't receive), request_image_upload and give them the link. Both place the image at a precise spot: under a heading, at the end of a section, before/after exact text, or in place of a placeholder like "[photo]". Don't hotlink external images.
- Headings: "#" (largest), "##" and "###" render at three distinct sizes. Don't repeat the page title as a heading at the top of the body; the title is shown separately. Use "##" for sections and "###" for subsections; "#" is for a page split into a few major parts.

When someone asks what you can do with Nitrogen (or seems unsure where to start), call get_started: it returns their wiki's current state and example requests to offer. Suggest two or three that fit what they're doing, phrased for their wiki, rather than listing tools. Examples:
${EXAMPLE_PROMPTS.map((e) => `- "${e.prompt}"`).join('\n')}`;

interface TreeCtx {
  pages: PageSummary[];
  byId: Map<string, PageSummary>;
  roots: TreeNode[];
  home: string | null;
}

/** The owner's conventions page (the app's Conventions view), if one is set. */
async function guideText(db: D1Database): Promise<string> {
  const id = await getSetting(db, 'guide_id');
  const page = id ? await getPage(db, id).catch(() => null) : null;
  if (!page?.body.trim()) return '';
  const body =
    page.body.length > 8000
      ? `${page.body.slice(0, 8000)}\n\n(…truncated; read_page "${page.id}" for the rest.)`
      : page.body;
  return `\n\n## The owner's conventions for this wiki\nFrom the page “${page.title}” (id ${page.id}). Follow these over the general advice above.\n\n${body}`;
}

function buildServer(
  call: Call,
  origin: string,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  actor: Actor,
  guide: string,
) {
  const instructions = INSTRUCTIONS + guide;
  const server = new McpServer({ name: 'nitrogen', version: VERSION }, { instructions });

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
        `id: ${p.id} · version: ${p.version} · updated: ${p.updated_at} by ${actorLabel(p.updated_by)} · created by ${actorLabel(p.created_by)}`,
        `tags: ${d.all_tags.length ? d.all_tags.map((g) => `#${g}`).join(' ') : 'none'}`,
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
        tag: z.string().optional().describe('Only return pages with this tag.'),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ query, mode, under, tag, limit }) => {
      const t = await loadTree();
      const scope = under ? resolve(under, t) : null;
      const want = limit ?? 10;
      const res = await call<SearchResponse>(
        'GET',
        `/search?${new URLSearchParams({ q: query, mode: mode ?? 'hybrid', limit: String(scope ? 50 : want), ...(tag ? { tag } : {}) })}`,
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
        body: z
          .string()
          .optional()
          .describe(
            'Markdown. Conventions (links, callouts, typed items like "- [ ] todo: … due:YYYY-MM-DD") are in the server instructions.',
          ),
        icon: z.string().max(16).optional().describe('An emoji, e.g. "📘".'),
        tags: z
          .array(z.string())
          .max(30)
          .optional()
          .describe('Tags, e.g. ["decision", "nitrogen"].'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Index among its siblings; omit to add at the end.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ title, parent, body, icon, tags, position }) => {
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
        tags,
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
        'Make targeted changes to a page body: replace/delete exact text, insert text before/after exact text, append/prepend, or edit a section by its heading. Edits apply in order and all-or-nothing. If the page changed meanwhile, the edits are re-applied to the latest version (unless base_version is given). Can also rename the page or change its icon. To check off a typed item, replace its "- [ ] " with "- [x] " (questions: also append " answer: …").',
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
        body: z
          .string()
          .optional()
          .describe(
            'Markdown. Conventions (links, callouts, typed items like "- [ ] todo: … due:YYYY-MM-DD") are in the server instructions.',
          ),
        title: z.string().min(1).max(200).optional(),
        icon: z.string().max(16).nullable().optional(),
        tags: z.array(z.string()).max(30).optional().describe('Replaces the page’s own tags.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ page, base_version, body, title, icon, tags }) => {
      const t = await loadTree();
      const id = resolve(page, t).id;
      const next = await call<Page>('PATCH', `/pages/${id}`, {
        ...(body !== undefined ? { body } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(tags !== undefined ? { tags } : {}),
        base_version,
      });
      return text(
        `Saved ${describe(next)}, now version ${next.version}. The previous text is in the page history.`,
      );
    }),
  );

  server.registerTool(
    'get_conventions',
    {
      title: 'Read the conventions',
      description:
        'The owner’s house rules for this wiki (where things go, naming, tags, style), as markdown with its id and version. They are also in your instructions when you connect; read them again here before changing them, or if they may have changed during this session.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const settings = await call<{ guide_id: string | null }>('GET', '/settings');
      if (!settings.guide_id)
        return text(
          'There are no conventions yet. If the owner wants some, write them with update_conventions (it creates the page).',
        );
      const d = await call<PageDetail>('GET', `/pages/${settings.guide_id}`);
      const p = d.page;
      return text(
        `# ${p.title}\nid: ${p.id} · version: ${p.version} · updated: ${p.updated_at} by ${actorLabel(p.updated_by)}\nurl: ${origin}/conventions\n\n---\n\n${p.body || '(empty)'}`,
      );
    }),
  );

  server.registerTool(
    'update_conventions',
    {
      title: 'Change the conventions',
      description:
        'Replace the whole conventions page with new markdown, for when the owner asks to add, change or remove a rule. Read it first with get_conventions and pass its version as base_version; keep the rules you weren’t asked to change. Creates the page if there isn’t one yet (then omit base_version). The previous text stays in the page history.',
      inputSchema: z.object({
        body: z.string().min(1).describe('The full conventions, as markdown.'),
        base_version: z
          .number()
          .int()
          .optional()
          .describe('The version from get_conventions. Required when the page exists.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ body, base_version }) => {
      const settings = await call<{ guide_id: string | null }>('GET', '/settings');
      if (!settings.guide_id) {
        const created = await call<Page>('POST', '/pages', {
          title: CONVENTIONS_TITLE,
          parent_id: null,
          icon: CONVENTIONS_ICON,
          body,
        });
        await call('PATCH', '/settings', { guide_id: created.id });
        return text(
          `Created the conventions (id ${created.id}). The owner sees them under Conventions; assistants get them when they connect.`,
        );
      }
      if (base_version === undefined)
        throw new Error(
          'Read the conventions with get_conventions first and pass its version as base_version.',
        );
      const next = await call<Page>('PATCH', `/pages/${settings.guide_id}`, { body, base_version });
      return text(
        `Saved the conventions, now version ${next.version}. The previous text is in the page history.`,
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
      const placed = await placeImage(env.DB, target.id, markdown, placement, actor);
      await touchSession(env.DB, actor).catch(() => undefined);
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

  // ---------------------------------------------------------------- orientation

  server.registerTool(
    'get_started',
    {
      title: 'What can I do here?',
      description:
        'Call when someone asks what you can do with Nitrogen or how to start. Returns the wiki’s current state (size, main areas, tags, inbox) and example requests that fit it, plus the ready-made prompts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const [t, tagRes, dash] = await Promise.all([
        loadTree(),
        call<{ tags: TagCount[] }>('GET', '/tags'),
        call<Dashboard>('GET', '/dashboard'),
      ]);
      const top = t.roots.map((n) => n.page.title);
      const state = t.pages.length
        ? [
            `The wiki has ${t.pages.length} pages and ${dash.stats.words.toLocaleString()} words.`,
            top.length ? `Top-level areas: ${top.slice(0, 12).join(', ')}.` : '',
            tagRes.tags.length
              ? `Most used tags: ${tagRes.tags
                  .slice(0, 8)
                  .map((g) => `#${g.tag}`)
                  .join(' ')}.`
              : 'No tags yet.',
            `${dash.stats.edits_week} edits this week (${dash.stats.agent_edits_week} by assistants).`,
            dash.inbox.length
              ? `${dash.inbox.length} page(s) changed by assistants that the owner hasn't opened yet.`
              : '',
            guide
              ? 'The owner has a conventions page; follow it (it is in your instructions).'
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : 'The wiki is empty. A good first step is setting up a structure for one area of their life or work.';
      const examples = EXAMPLE_PROMPTS.map((e) => `- "${e.prompt}" — ${e.why}`).join('\n');
      const prompts = MCP_PROMPTS.map((p) => `- ${p.title} (${p.name}): ${p.does}`).join('\n');
      return text(
        `${state}\n\nThings to offer (fill in <…> from the wiki above, and suggest the two or three that fit best):\n${examples}\n\nReady-made prompts the person can pick in their app's prompt menu:\n${prompts}`,
      );
    }),
  );

  server.registerTool(
    'recent_changes',
    {
      title: 'Recent changes',
      description:
        'What changed in the wiki recently, grouped into sessions by who made them (the owner or a named assistant). Use it to catch up, or to see what other assistants did before you continue their work.',
      inputSchema: z.object({
        days: z.number().min(0.1).max(90).optional().describe('How far back (default 7).'),
        who: z.enum(['all', 'owner', 'assistants']).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ days, who }) => {
      const since = new Date(Date.now() - (days ?? 7) * 86_400_000).toISOString();
      const { sessions } = await call<{ sessions: Session[] }>(
        'GET',
        `/activity?${new URLSearchParams({ since, limit: '400' })}`,
      );
      const picked = sessions.filter((x) =>
        who === 'owner'
          ? x.actor === 'you'
          : who === 'assistants'
            ? !!x.actor?.startsWith('agent:')
            : true,
      );
      if (!picked.length) return text(`No changes in the last ${days ?? 7} day(s).`);
      const lines = picked.map((x) => {
        const name = actorLabel(x.actor) === 'You' ? 'The owner' : actorLabel(x.actor);
        const items = x.events
          .map(
            (e) => `  - ${e.action} “${e.title}”${e.exists ? ` (${e.page_id})` : ' (now deleted)'}`,
          )
          .join('\n');
        return `${name}, ${x.start.slice(0, 16).replace('T', ' ')}–${x.end.slice(11, 16)} UTC:\n${items}`;
      });
      return text(lines.join('\n\n'));
    }),
  );

  // ---------------------------------------------------------------- tags

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'Every tag in use with how many pages have it; or, with "tag", the pages that have that tag.',
      inputSchema: z.object({ tag: z.string().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ tag }) => {
      if (tag) {
        const res = await call<SearchResponse>(
          'GET',
          `/search?${new URLSearchParams({ q: '', tag, limit: '50' })}`,
        );
        if (!res.hits.length) return text(`No pages are tagged #${tag}.`);
        return text(
          `Pages tagged #${tag}:\n${res.hits.map((h) => `- ${h.title} (${h.id})${h.path.length ? ` — in ${h.path.join(' / ')}` : ''}`).join('\n')}`,
        );
      }
      const { tags } = await call<{ tags: TagCount[] }>('GET', '/tags');
      if (!tags.length) return text('No tags yet.');
      return text(tags.map((t) => `#${t.tag} (${t.count})`).join('\n'));
    }),
  );

  server.registerTool(
    'tag_page',
    {
      title: 'Tag a page',
      description:
        'Add or remove tags on a page without touching its text. (#tags written in the body stay until the body changes.)',
      inputSchema: z.object({
        page: z.string(),
        add: z.array(z.string()).max(30).optional(),
        remove: z.array(z.string()).max(30).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ page, add, remove }) => {
      const t = await loadTree();
      const id = resolve(page, t).id;
      const { page: cur } = await call<PageDetail>('GET', `/pages/${id}`);
      const drop = new Set((remove ?? []).map((x) => x.replace(/^#/, '').toLowerCase()));
      const tags = [...cur.tags.filter((x) => !drop.has(x)), ...(add ?? [])];
      const next = await call<Page>('PATCH', `/pages/${id}`, { tags });
      return text(
        `${describe(next)} now has tags: ${next.tags.length ? next.tags.map((g) => `#${g}`).join(' ') : 'none'}.`,
      );
    }),
  );

  // ---------------------------------------------------------------- sessions

  server.registerTool(
    'log_session',
    {
      title: 'Log this session',
      description:
        'Give your current session entry under Sessions a title and summary. Your changes are already recorded there automatically (every page you create, edit, move or delete in this session); this adds what was decided, done and left open. Call it at the end of a session that changed the wiki, and again later in the same session to update it.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).describe('A few words, e.g. "Planned the Q3 roadmap".'),
        summary: z
          .string()
          .min(1)
          .describe(
            'Markdown: what was decided, done, and left open. Link pages with [[Title]]. Write anything unresolved as "- question: …" and follow-ups as "- [ ] todo: …" so they show up in open_items.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ title, summary }) => {
      const res = await call<{ id: string; title: string; open_items: number }>(
        'POST',
        '/sessions/log',
        { title, summary },
      );
      return text(
        `Logged as ${describe(res)}${res.open_items ? ` with ${res.open_items} open item(s)` : ''}.\nurl: ${urlOf(res)}`,
      );
    }),
  );

  server.registerTool(
    'open_items',
    {
      title: 'Open items',
      description:
        'To-dos, questions and reminders written anywhere in the wiki (as "- [ ] todo: …", "- question: …", "- [ ] reminder: … due:YYYY-MM-DD"), from an index kept up to date on every save. Use it for "what’s due", "what’s open on <project>", or a start-of-day list.',
      inputSchema: z.object({
        type: z.enum(['todo', 'question', 'reminder']).optional(),
        due_before: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            'Only items due on or before this date (YYYY-MM-DD). Today for "due or overdue".',
          ),
        include_done: z.boolean().optional(),
        under: z.string().optional().describe('Only items in this page’s subtree.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ type, due_before, include_done, under }) => {
      const t = under ? await loadTree() : null;
      const q = new URLSearchParams({
        ...(type ? { type } : {}),
        ...(due_before ? { due_before } : {}),
        ...(include_done ? { include_done: '1' } : {}),
        ...(under && t ? { under: resolve(under, t).id } : {}),
      });
      const { items } = await call<{ items: OpenItem[] }>('GET', `/items?${q}`);
      if (!items.length) return text('No matching items.');
      const today = new Date().toISOString().slice(0, 10);
      return text(
        items
          .map((i) => {
            const bits = [
              i.done ? '[done]' : i.due && i.due < today ? '[overdue]' : '',
              `${i.type}: ${i.text}`,
              i.owner ? `@${i.owner}` : '',
              i.due ? `due ${i.due}` : '',
              i.answer ? `answer: ${i.answer}` : '',
              `— ${[...i.path, i.page_title].join(' / ')} (${i.page_id}, line ${i.line})`,
            ];
            return `- ${bits.filter(Boolean).join(' ')}`;
          })
          .join('\n'),
      );
    }),
  );

  // ---------------------------------------------------------------- prompts

  server.registerPrompt(
    'review_page',
    {
      title: 'Check a page against newer pages',
      description:
        'Re-read a page, look for newer pages on the same topic, and list claims that are stale or contradicted.',
      argsSchema: z.object({
        page: z.string().describe('Page id, exact title, or path.'),
      }),
    },
    ({ page }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Review the Nitrogen wiki page "${page}" for claims that are out of date.

1. read_page it and note its updated date and each concrete claim (decisions, numbers, statuses, plans, names).
2. search (hybrid) for each main topic, and read the pages that were updated more recently than this one, plus the pages that link to it.
3. Report a short list: each claim that is contradicted or superseded, the newer page that says otherwise ([[Title]], with its date), and a suggested fix. Also list open questions you couldn't settle.
4. Don't change anything yet. Ask me which fixes to apply, then make them with edit_page so each one is in the history.`,
          },
        },
      ],
    }),
  );

  const ask = (t: string) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }],
  });

  server.registerPrompt(
    'capture_conversation',
    {
      title: 'Save this conversation to the wiki',
      description:
        'File the decisions, notes and open questions from this conversation into the right pages, then log the session.',
      argsSchema: z.object({
        focus: z.string().optional().describe('Optional: the project or topic to file it under.'),
      }),
    },
    ({ focus }) =>
      ask(`Save what we worked out in this conversation to my Nitrogen wiki${focus ? `, under "${focus}"` : ''}.

1. List the decisions, facts worth keeping, and open questions from our conversation. Leave out chit-chat and anything already superseded.
2. Search the wiki for the pages they belong on. Prefer adding to existing pages (edit_page) over creating new ones; create a page only when nothing fits, in the right place in the tree.
3. Link related pages with [[Title]] and tag decisions #decision. Write follow-ups and open questions as typed items on the page they belong to: "- [ ] todo: … @owner due:YYYY-MM-DD", "- [ ] question: …", "- [ ] reminder: … due:YYYY-MM-DD".
4. Finish with log_session, then tell me in a few lines what you changed, with links.`),
  );

  server.registerPrompt(
    'catch_up',
    {
      title: 'Catch up on recent changes',
      description: 'What changed in the wiki, who changed it, and what needs your attention.',
      argsSchema: z.object({
        days: z.string().optional().describe('How many days back (default 7).'),
      }),
    },
    ({ days }) =>
      ask(`Catch me up on my Nitrogen wiki for the last ${days || '7'} days.

1. Use recent_changes to see what changed and who changed it (me or which assistant).
2. Read the pages that changed the most and summarize what's new in each, in a sentence or two, grouped by area.
3. Call out decisions, new open questions, and anything that looks contradictory or half-finished.
4. End with the two or three things I should look at first, linked.`),
  );

  server.registerPrompt(
    'research_brief',
    {
      title: 'Brief from the wiki',
      description: 'Answer a question using only your pages, with links and a list of gaps.',
      argsSchema: z.object({ question: z.string().describe('What the brief should answer.') }),
    },
    ({ question }) =>
      ask(`Using only my Nitrogen wiki, write a one-page brief answering: ${question}

1. Search (hybrid) from a few angles and read the most relevant pages fully.
2. Write the brief: the answer first, then the supporting points. Cite pages inline as [[Title]]. Don't add outside knowledge; if you must, mark it clearly.
3. End with "Gaps": what the wiki doesn't say that the question needs.
4. Ask whether I want the brief saved as a page.`),
  );

  server.registerPrompt(
    'tidy_section',
    {
      title: 'Tidy up a section',
      description: 'Find duplicates, missing links and tags, and propose a cleaner structure.',
      argsSchema: z.object({ section: z.string().describe('Page id, title or path to tidy.') }),
    },
    ({ section }) =>
      ask(`Tidy up the "${section}" section of my Nitrogen wiki.

1. get_tree under it and read its pages.
2. Find: near-duplicate pages, pages in the wrong place, pages that mention each other without linking, missing or inconsistent tags (compare with list_tags), and empty or stub pages.
3. Propose a cleaner structure as a short before/after outline plus a numbered list of changes (moves, merges, links, tags).
4. Don't change anything until I say which changes to make. Then make them, and log_session at the end.`),
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
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: instructions }],
    }),
  );

  return server;
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    const origin = new URL(request.url).origin;
    // The OAuth provider puts the grant's props here: the connected app's name (see consent.ts).
    const c = ctx as ExecutionContext & {
      props?: { client?: string };
      auth?: { clientId?: string };
    };
    // Sign-ins made before names were read from Claude's metadata URL saved "An assistant";
    // resolve from the client id on each request instead of waiting for a token refresh.
    const actor = agent(await requestActorName(env, c.props?.client, c.auth?.clientId));
    const call = apiCaller(origin, env, ctx, actor);
    const guide = await guideText(env.DB).catch(() => '');
    const handler = createMcpHandler(() => buildServer(call, origin, env, ctx, actor, guide));
    return handler.fetch(request);
  },
};
