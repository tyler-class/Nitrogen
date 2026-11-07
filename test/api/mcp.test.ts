import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type {
  Dashboard,
  Insights,
  PageDetail,
  RevertResult,
  Session,
  SessionEntry,
  TreeResponse,
} from '@shared/types';
import { ORIGIN, PASSWORD, session } from './helpers';

const REDIRECT = 'https://client.example/callback';
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(
    /[+/=]/g,
    '',
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

async function connect(): Promise<string> {
  const reg = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Assistant',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'wiki',
    resource: `${ORIGIN}/mcp`,
  });
  const page = await SELF.fetch(`${ORIGIN}/authorize?${q}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Let Test Assistant use your wiki?');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
  const post = (pw: string) =>
    SELF.fetch(`${ORIGIN}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookies(page),
        'CF-Connecting-IP': '198.18.0.9',
      },
      body: new URLSearchParams({
        handle,
        decision: 'approve',
        password: pw,
        client_name: 'Test Assistant',
        redirect_host: 'client.example',
      }),
    });
  expect((await post('nope')).status).toBe(401);
  const ok = await post(PASSWORD);
  expect(ok.status).toBe(302);
  const loc = new URL(ok.headers.get('Location')!);
  const tok = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: loc.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(tok.status).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

let rpcId = 0;
async function rpc(token: string, method: string, params: unknown = {}) {
  const res = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = await res.text();
  const json = body.startsWith('{') ? body : (/^data: (.*)$/m.exec(body)?.[1] ?? body);
  return JSON.parse(json) as {
    result?: {
      content?: { text: string }[];
      tools?: { name: string; annotations?: Record<string, boolean> }[];
      isError?: boolean;
      instructions?: string;
    };
    error?: unknown;
  };
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  return {
    text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error),
    isError: !!r.result?.isError,
  };
}

describe('MCP', () => {
  it('rejects requests without a token', async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toMatch(/resource_metadata=/);
  });

  it('builds, reads, edits, searches and cleans up the wiki', async () => {
    const token = await connect();
    const init = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.result?.instructions).toContain('[[Page title]]');
    expect(init.result?.instructions).toContain('call get_started');
    expect(init.result?.instructions).toContain('- [ ] todo: <text> [@owner] [due:YYYY-MM-DD]');
    expect(init.result?.instructions).toContain('answer: <the answer>');
    expect(init.result?.instructions).toContain('```mermaid');

    const tools = (await rpc(token, 'tools/list')).result!.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_image',
        'image_upload_status',
        'request_image_upload',
        'create_page',
        'create_pages',
        'delete_page',
        'edit_page',
        'get_started',
        'get_tree',
        'list_revisions',
        'list_tags',
        'log_session',
        'tag_page',
        'move_page',
        'open_items',
        'read_page',
        'read_revision',
        'recent_changes',
        'restore_revision',
        'search',
        'update_page',
      ].sort(),
    );
    expect(tools.find((t) => t.name === 'delete_page')!.annotations).toMatchObject({
      destructiveHint: true,
    });
    expect(tools.find((t) => t.name === 'search')!.annotations).toMatchObject({
      readOnlyHint: true,
    });

    // A structure in one call.
    const made = await tool(token, 'create_pages', {
      pages: [
        {
          title: 'MCP Garden',
          icon: '🌱',
          body: 'Overview of the garden.',
          children: [
            { title: 'Tomatoes', body: '## Varieties\n\n- Roma\n\n## Care\n\nWater daily.\n' },
            { title: 'Compost', body: 'Feeds the [[Tomatoes]].' },
          ],
        },
      ],
    });
    expect(made.isError).toBe(false);
    expect(made.text).toContain('Created 3 page(s)');

    const tree = await tool(token, 'get_tree', { under: 'MCP Garden' });
    expect(tree.text).toContain('- Tomatoes (');

    // Read by path; backlinks and children show up.
    const read = await tool(token, 'read_page', { page: 'MCP Garden / Tomatoes' });
    expect(read.text).toContain('path: MCP Garden / Tomatoes');
    expect(read.text).toContain('linked from: Compost');
    expect(read.text).toContain('version: 1');
    const outline = await tool(token, 'read_page', { page: 'Tomatoes', outline_only: true });
    expect(outline.text).toContain('- Varieties');

    // Targeted edits.
    const edit = await tool(token, 'edit_page', {
      page: 'Tomatoes',
      edits: [
        { type: 'append_to_section', heading: 'Varieties', text: '- Cherry' },
        { type: 'replace', find: 'Water daily.', replace: 'Water every morning.' },
        { type: 'add_section', heading: 'Harvest', text: 'August.' },
      ],
    });
    expect(edit.isError).toBe(false);
    expect(edit.text).toContain('version 1 → 2');
    const after = await tool(token, 'read_page', { page: 'Tomatoes' });
    expect(after.text).toContain('- Roma\n\n- Cherry');
    expect(after.text).toContain('Water every morning.');
    expect(after.text).toContain('## Harvest\n\nAugust.');

    // Failed edits change nothing and explain why.
    const bad = await tool(token, 'edit_page', {
      page: 'Tomatoes',
      edits: [
        { type: 'append', text: 'should not land' },
        { type: 'replace', find: 'Not in the page', replace: 'x' },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Edit 2');
    expect((await tool(token, 'read_page', { page: 'Tomatoes' })).text).not.toContain(
      'should not land',
    );

    // Stale full rewrites are refused.
    const stale = await tool(token, 'update_page', {
      page: 'Tomatoes',
      base_version: 1,
      body: 'x',
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('changed since you opened it');

    // Every assistant edit is in the history and can be restored.
    const hist = await tool(token, 'list_revisions', { page: 'Tomatoes' });
    const revId = Number(/revision (\d+): version 1/.exec(hist.text)?.[1]);
    expect(revId).toBeGreaterThan(0);
    const restored = await tool(token, 'restore_revision', { page: 'Tomatoes', revision: revId });
    expect(restored.text).toContain('version 3');
    expect((await tool(token, 'read_page', { page: 'Tomatoes' })).text).toContain('Water daily.');

    // Search (keyword fallback in tests) scoped to a subtree.
    const found = await tool(token, 'search', { query: 'compost', under: 'MCP Garden' });
    expect(found.text).toContain('Compost (');

    // Duplicates and ambiguity are explained.
    const dup = await tool(token, 'create_page', { title: 'Tomatoes', parent: 'MCP Garden' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('already exists');
    const missing = await tool(token, 'read_page', { page: 'Tomatos' });
    expect(missing.isError).toBe(true);

    // Images from bytes, placed at a placeholder.
    await tool(token, 'edit_page', {
      page: 'Tomatoes',
      edits: [{ type: 'append_to_section', heading: 'Varieties', text: '[photo of roma]' }],
    });
    const added = await tool(token, 'add_image', {
      data_base64: `data:image/png;base64,${PNG_B64}`,
      alt: 'Roma tomatoes',
      page: 'Tomatoes',
      placement: { replace_text: '[photo of roma]' },
    });
    expect(added.isError).toBe(false);
    const withImg = (await tool(token, 'read_page', { page: 'Tomatoes' })).text;
    expect(withImg).toMatch(/!\[Roma tomatoes\]\(\/files\/img\/[a-z0-9]+\.png\)/);
    expect(withImg).not.toContain('[photo of roma]');
    const both = await tool(token, 'add_image', { page: 'Tomatoes' });
    expect(both.isError).toBe(true);

    // Images the person has: a one-time upload link, placed under a heading.
    const req = await tool(token, 'request_image_upload', {
      page: 'Tomatoes',
      placement: { under_heading: 'Care' },
      alt: 'Harvest basket',
    });
    const link = /(https:\/\/\S+\/u\/[A-Za-z0-9_-]+)/.exec(req.text)![1]!;
    const uploadId = link.split('/u/')[1]!;
    expect((await tool(token, 'image_upload_status', { upload_id: uploadId })).text).toContain(
      'Not uploaded yet',
    );
    const form = await SELF.fetch(link);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('under the heading “Care”');
    const post = () =>
      SELF.fetch(link, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG });
    const up = await post();
    expect(up.status).toBe(201);
    expect((await post()).status).toBe(410);
    expect((await tool(token, 'image_upload_status', { upload_id: uploadId })).text).toContain(
      'Uploaded and placed',
    );
    expect((await tool(token, 'read_page', { page: 'Tomatoes' })).text).toMatch(
      /## Care\n\n!\[Harvest basket\]\(\/files\/img\/[a-z0-9]+\.png\)\n\nWater daily\./,
    );
    expect((await SELF.fetch(`${ORIGIN}/u/not-a-real-token-at-all-xx`)).status).toBe(404);

    // Moving and guarded deletion.
    const moved = await tool(token, 'move_page', { page: 'Compost', new_parent: 'top' });
    expect(moved.text).toContain('now at Compost');
    const refused = await tool(token, 'delete_page', {
      page: 'MCP Garden',
      confirm_title: 'garden',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('would delete 2 page(s)');
    const gone = await tool(token, 'delete_page', {
      page: 'MCP Garden',
      confirm_title: 'MCP Garden',
    });
    expect(gone.text).toContain('Deleted 2 page(s)');
  });

  it('records who changed what, tags, logs sessions and undoes them', async () => {
    const token = await connect();
    const api = await session();

    const made = await tool(token, 'create_page', {
      title: 'Agent Notes',
      body: 'Started by the assistant. #research',
      tags: ['Planning'],
    });
    expect(made.isError).toBe(false);
    const id = /id ([a-z0-9]+)/.exec(made.text)![1]!;

    // Attributed to the connected app, shown in the owner's inbox until opened.
    let dash = (await api.get<Dashboard>('/dashboard')).data;
    const item = dash.inbox.find((p) => p.id === id)!;
    expect(item.updated_by).toBe('agent:Test Assistant');
    expect(item.is_new).toBe(true);
    const detail = (await api.get<PageDetail>(`/pages/${id}`)).data;
    expect(detail.page.created_by).toBe('agent:Test Assistant');
    expect(detail.all_tags).toEqual(['planning', 'research']);
    dash = (await api.get<Dashboard>('/dashboard')).data;
    expect(dash.inbox.some((p) => p.id === id)).toBe(false);

    // Tags from tools.
    const tagged = await tool(token, 'tag_page', { page: id, add: ['ops'], remove: ['planning'] });
    expect(tagged.text).toContain('#ops');
    expect((await tool(token, 'list_tags', {})).text).toContain('#research (1)');
    expect((await tool(token, 'list_tags', { tag: 'ops' })).text).toContain('Agent Notes');
    expect((await tool(token, 'read_page', { page: id })).text).toContain('by Test Assistant');

    // An edit, then a session log listing what was touched.
    const edit = await tool(token, 'edit_page', {
      page: id,
      edits: [{ type: 'append', text: 'A second paragraph.' }],
    });
    expect(edit.isError).toBe(false);
    const logged = await tool(token, 'log_session', {
      title: 'Research kickoff',
      summary: 'Set up [[Agent Notes]].',
    });
    expect(logged.isError).toBe(false);
    const tree = await tool(token, 'get_tree', { under: 'Sessions' });
    expect(tree.text).toContain('Research kickoff');

    // Searches that find nothing show up in insights.
    await tool(token, 'search', { query: 'zzqx nothing here', mode: 'keyword' });
    const insights = (await api.get<Insights>('/insights')).data;
    expect(insights.misses.some((m) => m.query === 'zzqx nothing here')).toBe(true);
    expect(insights.authors.some((a) => a.actor === 'agent:Test Assistant')).toBe(true);

    // The owner's edit in the middle is kept; the assistant's session is undone.
    const { sessions } = (await api.get<{ sessions: Session[] }>('/activity?limit=50')).data;
    const mine = sessions.find((x) => x.actor === 'agent:Test Assistant')!;
    expect(mine.events.length).toBeGreaterThan(1);
    const undo = (
      await api.post<RevertResult>('/activity/revert', {
        actor: mine.actor,
        from: mine.start,
        to: mine.end,
      })
    ).data;
    expect(undo.deleted).toContain('Agent Notes');
    expect((await api.get(`/pages/${id}`)).status).toBe(404);

    // The review prompt is offered.
    const prompts = (await rpc(token, 'prompts/list')).result as unknown as {
      prompts: { name: string }[];
    };
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(
      ['capture_conversation', 'catch_up', 'research_brief', 'review_page', 'tidy_section'].sort(),
    );
    const got = await rpc(token, 'prompts/get', {
      name: 'research_brief',
      arguments: { question: 'What is our plan?' },
    });
    expect(JSON.stringify(got.result)).toContain('What is our plan?');

    // Orientation: state plus examples, and recent changes by actor.
    const start = await tool(token, 'get_started', {});
    expect(start.text).toContain('pages');
    expect(start.text).toContain('Save the decisions');
    expect(start.text).toContain('capture_conversation');
    const recent = await tool(token, 'recent_changes', { days: 1, who: 'assistants' });
    expect(recent.text).toContain('Test Assistant');
  });

  it('records sessions automatically, protects them, and indexes open items', async () => {
    const token = await connect();
    const api = await session();

    const made = await tool(token, 'create_page', {
      title: 'Session Proof',
      body: '- [ ] todo: Ship it @sam due:2026-01-02\n- question: Which colour?',
    });
    expect(made.isError).toBe(false);
    const id = /id ([a-z0-9]+)/.exec(made.text)![1]!;
    await tool(token, 'edit_page', { page: id, edits: [{ type: 'append', text: 'More.' }] });

    // One entry for this session, written without log_session, listing the page.
    const tree = (await api.get<TreeResponse>('/tree')).data;
    const root = tree.sessions_id!;
    expect(root).toBeTruthy();
    // Same assistant within the hour: earlier writes in this file share the entry.
    const mine = tree.pages
      .filter((p) => p.parent_id === root && p.updated_by === 'agent:Test Assistant')
      .sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0]!;
    const entry = (await api.get<PageDetail>(`/pages/${mine.id}`)).data;
    expect(entry.page.body).toContain('[[Session Proof]] — created');

    // log_session titles the same entry instead of making another.
    const logged = await tool(token, 'log_session', {
      title: 'Proved sessions',
      summary: 'Checked auto logging.\n- question: Keep the gap at an hour?',
    });
    expect(logged.text).toContain('1 open item');
    const after = (await api.get<PageDetail>(`/pages/${mine.id}`)).data.page;
    expect(after.title).toMatch(/· Proved sessions$/);
    expect(after.body).toContain('[[Session Proof]]');
    expect(
      (await api.get<TreeResponse>('/tree')).data.pages.filter((p) => p.parent_id === root).length,
    ).toBe(tree.pages.filter((p) => p.parent_id === root).length);

    // Nobody edits, moves or deletes Sessions or its entries; the owner can purge an entry.
    expect((await api.patch(`/pages/${mine.id}`, { body: 'x' })).status).toBe(403);
    expect((await api.del(`/pages/${mine.id}`)).status).toBe(403);
    expect((await api.patch(`/pages/${root}`, { title: 'Logs' })).status).toBe(403);
    expect((await api.post(`/pages/${root}/move`, { parent_id: id })).status).toBe(403);
    expect((await api.post('/pages', { title: 'Sneaky', parent_id: root })).status).toBe(403);
    const agentEdit = await tool(token, 'update_page', {
      page: mine.id,
      base_version: after.version,
      body: 'rewritten',
    });
    expect(agentEdit.isError).toBe(true);
    expect((await api.post('/sessions/log', { title: 'x', summary: 'y' })).status).toBe(403);

    // Open items from page bodies and session summaries; check one off in place.
    const items = await tool(token, 'open_items', { type: 'todo' });
    expect(items.text).toContain('todo: Ship it @sam due 2026-01-02');
    expect(items.text).toContain('[overdue]');
    expect((await tool(token, 'open_items', { type: 'question' })).text).toContain(
      'Keep the gap at an hour?',
    );
    const toggled = await api.post<{ body: string }>(`/pages/${id}/items/toggle`, {
      line: 1,
      done: true,
    });
    expect(toggled.data.body.startsWith('- [x] todo: Ship it')).toBe(true);
    expect((await tool(token, 'open_items', { type: 'todo' })).text).not.toContain('Ship it');
    const answered = await api.post<{ body: string }>(`/pages/${id}/items/answer`, {
      line: 2,
      answer: 'Green.',
    });
    expect(answered.data.body).toContain('- [x] question: Which colour? answer: Green.');
    expect((await tool(token, 'open_items', { type: 'question' })).text).not.toContain(
      'Which colour?',
    );

    const log = (await api.get<{ entries: SessionEntry[] }>('/sessions')).data.entries;
    const listed = log.find((e) => e.id === mine.id)!;
    expect(listed).toMatchObject({ title: 'Proved sessions', actor: 'agent:Test Assistant' });
    expect(listed.summary).toContain('Checked auto logging.');
    expect(listed.pages).toBeGreaterThan(0);
    expect(listed.open_items).toBe(1);

    expect((await api.del(`/sessions/${mine.id}`)).status).toBe(200);
    expect((await api.get(`/pages/${mine.id}`)).status).toBe(404);
  });
});
