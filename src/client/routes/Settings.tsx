import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pageHref } from '@shared/markdown';
import type { Backup, DashboardSection, Page, SearchStatus } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys, useTree } from '../lib/queries';
import { AboutButton, AboutSheet } from '../components/AboutSheet';
import { Icon } from '../components/Icon';
import { PagePicker } from '../components/PagePicker';
import { useToast } from '../components/Toast';
import { useTheme, type Theme } from '../lib/theme';
import { SECTION_LABELS } from './Dashboard';
import { Link } from 'react-router';

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const tree = useTree();
  const settings = useQuery({
    queryKey: keys.settings,
    queryFn: () =>
      api.get<{
        home_id: string | null;
        guide_id: string | null;
        dashboard: DashboardSection[];
      }>('/settings'),
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
  const [theme, setTheme] = useTheme();
  const restoreInput = useRef<HTMLInputElement>(null);
  const mcpUrl = `${window.location.origin}/mcp`;

  async function patch(body: Record<string, unknown>, done: string) {
    try {
      await api.patch('/settings', body);
      await qc.invalidateQueries({ queryKey: keys.settings });
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

  const [about, setAbout] = useState(false);
  // /settings#dashboard (from the dashboard's Customize link) scrolls to that section.
  useEffect(() => {
    if (location.hash && settings.data)
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [settings.data]);

  const sections = settings.data?.dashboard ?? [];
  function saveSections(next: DashboardSection[]) {
    qc.setQueryData(keys.settings, { ...settings.data!, dashboard: next });
    void patch({ dashboard: next }, 'Dashboard updated.');
  }
  function moveSection(i: number, by: -1 | 1) {
    const next = [...sections];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    saveSections(next);
  }

  async function createGuide() {
    try {
      const p = await api.post<Page>('/pages', {
        title: 'How to use this wiki',
        parent_id: null,
        icon: '🧭',
        body: GUIDE_TEMPLATE,
      });
      await patch({ guide_id: p.id }, 'Created. Assistants will read it first.');
      void qc.invalidateQueries({ queryKey: keys.tree });
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const pages = tree.data?.pages ?? [];
  const guide = pages.find((p) => p.id === settings.data?.guide_id);
  return (
    <div className="page settings">
      <div className="settings-top">
        <h1 className="page-title">Settings</h1>
        <AboutButton className="btn small about-mobile" onClick={() => setAbout(true)} />
      </div>
      {about && <AboutSheet onClose={() => setAbout(false)} />}

      <section>
        <h2>Appearance</h2>
        <div className="seg" role="radiogroup" aria-label="Appearance">
          {(
            [
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['system', 'System'],
            ] as const satisfies readonly (readonly [Theme, string])[]
          ).map(([t, label]) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              className={theme === t ? 'on' : ''}
              onClick={() => setTheme(t)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>Home page</h2>
        <div className="field">
          <PagePicker
            aria-label="Home page"
            pages={pages}
            value={settings.data?.home_id ?? null}
            noneLabel="Dashboard"
            onChange={(id) => void patch({ home_id: id }, 'Home page updated.')}
          />
        </div>
      </section>

      <section id="dashboard">
        <h2>Dashboard</h2>
        <ul className="section-list">
          {sections.map((sec, i) => (
            <li key={sec.id}>
              <label>
                <input
                  type="checkbox"
                  checked={sec.on}
                  onChange={(e) =>
                    saveSections(
                      sections.map((x) => (x.id === sec.id ? { ...x, on: e.target.checked } : x)),
                    )
                  }
                />
                {SECTION_LABELS[sec.id]}
              </label>
              <button
                className="btn small icon-only"
                aria-label={`Move ${SECTION_LABELS[sec.id]} up`}
                disabled={i === 0}
                onClick={() => moveSection(i, -1)}
              >
                <Icon name="chevron" size={13} />
              </button>
              <button
                className="btn small icon-only down"
                aria-label={`Move ${SECTION_LABELS[sec.id]} down`}
                disabled={i === sections.length - 1}
                onClick={() => moveSection(i, 1)}
              >
                <Icon name="chevron" size={13} />
              </button>
            </li>
          ))}
        </ul>
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
        <div className="field">
          <span>Conventions page</span>
          <PagePicker
            aria-label="Conventions page"
            pages={pages}
            value={settings.data?.guide_id ?? null}
            noneLabel="None"
            onChange={(id) => void patch({ guide_id: id }, 'Saved.')}
          />
        </div>
        <p className="muted">
          {guide ? (
            <>
              Assistants read <Link to={pageHref(guide.id, guide.title)}>{guide.title}</Link> before
              anything else.
            </>
          ) : (
            <>
              Tell assistants how you like the wiki organized.{' '}
              <button className="link" onClick={() => void createGuide()}>
                Create a starter page
              </button>
            </>
          )}
        </p>
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
      </section>
    </div>
  );
}

const GUIDE_TEMPLATE = `Assistants read this page before working in the wiki. Edit it to match how you work.

## Where things go
- One top-level page per area of life or work; projects live under their area.
- Meeting notes go under the project, titled "YYYY-MM-DD · Topic".
- Session notes are filed under [[Sessions]] with log_session.

## Before writing
- Search first and add to an existing page rather than creating a near-duplicate.
- Link related pages with [[Page title]] the first time they come up.

## Tags
- Reuse existing tags (list_tags). Common ones: #decision, #open-question, #idea, #reference.

## Style
- Short sections with "##" headings; lead with the conclusion.
- Mark anything uncertain with a > [!NOTE] callout.
`;
