import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, PASSWORD } from './helpers';

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
        'get_tree',
        'list_revisions',
        'move_page',
        'read_page',
        'read_revision',
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
});
