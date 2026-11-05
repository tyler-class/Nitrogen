import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Backup, SearchStatus } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys, useTree } from '../lib/queries';
import { useToast } from '../components/Toast';

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const tree = useTree();
  const settings = useQuery({
    queryKey: keys.settings,
    queryFn: () => api.get<{ instance_name: string; home_id: string | null }>('/settings'),
  });
  const search = useQuery({
    queryKey: ['search-status'],
    queryFn: () => api.get<SearchStatus>('/search/status'),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () =>
      api.get<{ connections: { id: string; name: string; created_at: string | null }[] }>(
        '/connections',
      ),
    retry: false,
  });
  const unused = useQuery({
    queryKey: ['unused-files'],
    queryFn: () => api.get<{ count: number; bytes: number }>('/files/unused'),
  });
  const [name, setName] = useState<string | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  async function patch(body: Record<string, unknown>, done: string) {
    try {
      await api.patch('/settings', body);
      await qc.invalidateQueries({ queryKey: keys.settings });
      await qc.invalidateQueries({ queryKey: ['session'] });
      await qc.invalidateQueries({ queryKey: keys.tree });
      toast(done);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function download() {
    try {
      const data = await api.get<Backup>('/backup');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = Object.assign(document.createElement('a'), {
        href: url,
        download: `nitrogen-${data.exported_at.slice(0, 10)}.json`,
      });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function restore(file: File) {
    try {
      const data = JSON.parse(await file.text()) as Backup;
      if (
        !window.confirm(
          `Replace every page with the ${data.pages?.length ?? 0} pages in this backup? This can’t be undone.`,
        )
      )
        return;
      await api.post('/restore', data);
      await qc.invalidateQueries();
      toast('Restored.');
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file is not a Nitrogen backup.' : errorMessage(e));
    }
  }

  const pages = tree.data?.pages ?? [];
  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>

      <section>
        <h2>Wiki</h2>
        <label className="field">
          <span>Name</span>
          <div className="row">
            <input
              value={name ?? settings.data?.instance_name ?? ''}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
            />
            <button
              className="btn"
              disabled={!name?.trim()}
              onClick={() =>
                name && patch({ instance_name: name.trim() }, 'Saved.').then(() => setName(null))
              }
            >
              Save
            </button>
          </div>
        </label>
        <label className="field">
          <span>Home page</span>
          <select
            value={settings.data?.home_id ?? ''}
            onChange={(e) => patch({ home_id: e.target.value || null }, 'Home page updated.')}
          >
            <option value="">The first page in the tree</option>
            {[...pages]
              .sort((a, b) => a.title.localeCompare(b.title))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
        </label>
      </section>

      <section>
        <h2>Connect an AI assistant</h2>
        <p>
          Nitrogen has an MCP server, so Claude (or any MCP client) can search, read, create and
          edit pages. Every edit an assistant makes is saved in the page history.
        </p>
        <div className="copy-row">
          <code>{mcpUrl}</code>
          <button
            className="btn small"
            onClick={() => navigator.clipboard?.writeText(mcpUrl).then(() => toast('Copied.'))}
          >
            Copy
          </button>
        </div>
        <ul className="steps">
          <li>
            <strong>Claude (web, desktop, mobile):</strong> Settings → Connectors → Add custom
            connector → paste the URL. Approve with your wiki password.
          </li>
          <li>
            <strong>Claude Code:</strong>{' '}
            <code>claude mcp add --transport http nitrogen {mcpUrl}</code>
          </li>
        </ul>
        {connections.data && (
          <>
            <p className="muted">
              {connections.data.connections.length
                ? `Connected: ${connections.data.connections.map((c) => c.name).join(', ')}`
                : 'No assistants connected.'}
            </p>
            {connections.data.connections.length > 0 && (
              <button
                className="btn danger"
                onClick={async () => {
                  if (
                    !window.confirm('Disconnect every assistant? They will need to sign in again.')
                  )
                    return;
                  await api.post('/connections/revoke-all').catch((e) => toast(errorMessage(e)));
                  void qc.invalidateQueries({ queryKey: ['connections'] });
                }}
              >
                Disconnect all
              </button>
            )}
          </>
        )}
      </section>

      <section>
        <h2>Search</h2>
        {search.data ? (
          <p>
            {search.data.available
              ? `Semantic search is on (AI Search instance “${search.data.instance}”).`
              : search.data.message}{' '}
            {search.data.pending > 0 && `${search.data.pending} page(s) waiting to be indexed.`}
          </p>
        ) : (
          <p className="muted">Checking…</p>
        )}
        <button
          className="btn"
          onClick={async () => {
            await api.post('/search/reindex').catch((e) => toast(errorMessage(e)));
            void qc.invalidateQueries({ queryKey: ['search-status'] });
            toast('Re-indexing. Large wikis finish over the next few minutes.');
          }}
        >
          Rebuild semantic index
        </button>
      </section>

      <section>
        <h2>Backup</h2>
        <p>
          Download every page as one JSON file, or replace everything with a backup. Images stay in
          storage.
        </p>
        <div className="row">
          <button className="btn" onClick={download}>
            Download backup
          </button>
          <button className="btn" onClick={() => restoreInput.current?.click()}>
            Restore from backup…
          </button>
          <input
            ref={restoreInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void restore(f);
            }}
          />
        </div>
        {unused.data && unused.data.count > 0 && (
          <p>
            {unused.data.count} image(s) ({(unused.data.bytes / 1_048_576).toFixed(1)} MB) are not
            used on any page.{' '}
            <button
              className="link"
              onClick={async () => {
                await api.post('/files/cleanup').catch((e) => toast(errorMessage(e)));
                void qc.invalidateQueries({ queryKey: ['unused-files'] });
              }}
            >
              Delete them
            </button>
          </p>
        )}
      </section>

      <section>
        <h2>Account</h2>
        <button
          className="btn"
          onClick={async () => {
            await api.post('/logout');
            qc.setQueryData(['session'], null);
            window.location.assign('/');
          }}
        >
          Sign out
        </button>
        <p className="muted">
          To change the password, set a new APP_PASSWORD secret in Cloudflare. Everyone is signed
          out.
        </p>
      </section>
    </div>
  );
}
