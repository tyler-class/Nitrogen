import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EXAMPLE_PROMPTS } from '@shared/examples';
import { downloadAll } from '../lib/exportMarkdown';
import { pageHref } from '@shared/markdown';
import type { Backup, Page, SearchStatus } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys, useTree } from '../lib/queries';
import { AboutButton, AboutSheet } from '../components/AboutSheet';
import { PagePicker } from '../components/PagePicker';
import { useToast } from '../components/Toast';
import { useTheme, type Theme } from '../lib/theme';
import { Link } from 'react-router';
import { VERSION } from '@shared/version';
import { InfoTip, Switch } from '../components/InfoTip';
import { Icon } from '../components/Icon';
import {
  isNewer,
  isSourceRepo,
  runUrl,
  setupUrl,
  UPSTREAM,
  useLatestVersion,
} from '../lib/updates';

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
        updates_set_up: boolean;
        telemetry: boolean;
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
        <h3 className="try-h">Try asking</h3>
        <ul className="try-list">
          {EXAMPLE_PROMPTS.slice(0, 6).map((e) => (
            <li key={e.prompt}>
              <button
                type="button"
                title="Copy"
                onClick={() =>
                  void navigator.clipboard?.writeText(e.prompt).then(() => toast('Copied.'))
                }
              >
                “{e.prompt}”
              </button>
            </li>
          ))}
        </ul>
        <p className="muted">Claude also lists ready-made Nitrogen prompts in its + menu.</p>
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
          The backup keeps everything exactly as written and restores it. Markdown is for other apps
          and Google Docs: callouts and items become plain text, links point between files.
        </p>
        <div className="row">
          <button className="btn" onClick={download}>
            Download backup
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                downloadAll(await api.get<Backup>('/backup'));
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            Download as Markdown (.zip)
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

      <UpdatesSection
        setUp={settings.data?.updates_set_up ?? false}
        onSetUp={() =>
          void patch({ updates_set_up: true }, 'Finish on GitHub: click Commit changes.')
        }
        telemetry={settings.data?.telemetry ?? true}
        onTelemetry={(telemetry) =>
          void patch({ telemetry }, telemetry ? 'Sharing usage counts.' : 'Stopped sharing.')
        }
      />

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

/**
 * Updates: is a newer Nitrogen out, and links into this copy's own GitHub repo to add the
 * update workflow (once) or run it. Updates go Nitrogen → your repo → your Cloudflare.
 */
function UpdatesSection({
  setUp,
  onSetUp,
  telemetry,
  onTelemetry,
}: {
  setUp: boolean;
  onSetUp: () => void;
  telemetry: boolean;
  onTelemetry: (on: boolean) => void;
}) {
  const latest = useLatestVersion();
  const repo = __SOURCE_REPO__;
  const isSource = isSourceRepo(repo, UPSTREAM);
  const newer = latest.data && isNewer(latest.data, VERSION) ? latest.data : null;
  const status = newer
    ? `Nitrogen ${newer} is available. You have ${VERSION}.`
    : latest.isError
      ? `Nitrogen ${VERSION}. Couldn’t check for a newer version.`
      : latest.data
        ? `Nitrogen ${VERSION}, up to date.`
        : `Nitrogen ${VERSION}.`;
  return (
    <section>
      <h2>
        Updates{' '}
        {!isSource && (
          <InfoTip label="How updates work">
            <p>Updates take two steps, both in your own accounts:</p>
            <ul>
              <li>
                An update workflow in your GitHub copy brings in the latest Nitrogen every Monday.
                GitHub needs you to add it once: Set up opens it ready to commit.
              </li>
              <li>Cloudflare deploys your copy every time it changes. That part is already on.</li>
            </ul>
            <p>
              Your pages and files live in your database and storage, so updates don’t touch them.
              Changes you made to the code in your copy are replaced.
            </p>
          </InfoTip>
        )}
      </h2>
      <p className={newer ? '' : 'muted'}>{status}</p>
      {isSource ? null : !repo ? (
        <p className="muted">Deployed by hand: git pull, then npm run deploy.</p>
      ) : (
        <>
          <div className="updates-actions">
            {setUp ? (
              <a
                className={newer ? 'btn primary' : 'btn'}
                href={runUrl(repo)}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="history" size={14} /> Update now
              </a>
            ) : (
              <a
                className="btn primary"
                href={setupUrl(repo, __SOURCE_BRANCH__)}
                target="_blank"
                rel="noreferrer"
                onClick={onSetUp}
              >
                <Icon name="github" size={14} /> Set up automatic updates
              </a>
            )}
            <a
              className="muted"
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noreferrer"
            >
              {repo}
            </a>
          </div>
          <p className="muted">
            {setUp ? (
              <>
                Opens GitHub: click Run workflow.{' '}
                <a href={setupUrl(repo, __SOURCE_BRANCH__)} target="_blank" rel="noreferrer">
                  Set up again
                </a>
              </>
            ) : (
              'Opens GitHub: click Commit changes. It updates now, then every Monday.'
            )}
          </p>
        </>
      )}
      <div className="share-row">
        <span>
          Share anonymous usage counts
          <InfoTip label="What’s shared">
            <p>Once a day this copy sends Nitrogen’s developer:</p>
            <ul>
              <li>a random id this copy made for itself</li>
              <li>its version</li>
              <li>how many pages, revisions, tags, links and so on it has (counts only)</li>
              <li>how many files it stores (one total)</li>
              <li>whether automatic updates are on</li>
            </ul>
            <p>
              Never page titles, contents, file names or anything you write, and no IP address is
              kept. It shows how many copies are in use, to decide what to work on next.
            </p>
          </InfoTip>
        </span>
        <Switch on={telemetry} onChange={onTelemetry} label="Share anonymous usage counts" />
      </div>
    </section>
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
