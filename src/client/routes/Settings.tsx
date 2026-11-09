import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { downloadAll } from '../lib/exportMarkdown';
import type { Backup } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys } from '../lib/queries';
import { AboutButton, AboutSheet } from '../components/AboutSheet';
import { useToast } from '../components/Toast';
import { useTheme, type Theme } from '../lib/theme';
import { ConnectAISection } from './ConnectAI';
import { VERSION } from '@shared/version';
import { InfoTip, Switch } from '../components/InfoTip';
import { Icon } from '../components/Icon';
import { isSourceRepo, runUrl, setupUrl, UPSTREAM, useLatestVersion } from '../lib/updates';
import { howUpdatesWork, UPDATE_TEXT, updateStatus, whatsShared } from '../kit/updates';

/** What the usage counts count, in words (matches USAGE_TABLES in the worker). */
const USAGE_COUNTED = 'pages, revisions, tags and links';

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({
    queryKey: keys.settings,
    queryFn: () =>
      api.get<{
        guide_id: string | null;
        updates_set_up: boolean;
        telemetry: boolean;
      }>('/settings'),
  });
  const [theme, setTheme] = useTheme();
  const restoreInput = useRef<HTMLInputElement>(null);

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

      <ConnectAISection />

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
  const status = updateStatus('Nitrogen', VERSION, latest.data, latest.isError);
  const how = howUpdatesWork('Nitrogen');
  const shared = whatsShared('Nitrogen', USAGE_COUNTED, true);
  return (
    <section>
      <h2>
        {UPDATE_TEXT.heading}{' '}
        {!isSource && (
          <InfoTip label={UPDATE_TEXT.howUpdatesWork}>
            <p>{how.intro}</p>
            <ul>
              {how.steps.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p>{how.outro}</p>
          </InfoTip>
        )}
      </h2>
      <p className={status.newer ? '' : 'muted'}>{status.text}</p>
      {isSource ? null : !repo ? (
        <p className="muted">{UPDATE_TEXT.byHand}</p>
      ) : (
        <>
          <div className="updates-actions">
            {setUp ? (
              <a
                className={status.newer ? 'btn primary' : 'btn'}
                href={runUrl(repo)}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="history" size={14} /> {UPDATE_TEXT.updateNow}
              </a>
            ) : (
              <a
                className="btn primary"
                href={setupUrl(repo, __SOURCE_BRANCH__)}
                target="_blank"
                rel="noreferrer"
                onClick={onSetUp}
              >
                <Icon name="github" size={14} /> {UPDATE_TEXT.setUp}
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
                {UPDATE_TEXT.updateNowHint}{' '}
                <a href={setupUrl(repo, __SOURCE_BRANCH__)} target="_blank" rel="noreferrer">
                  {UPDATE_TEXT.setUpAgain}
                </a>
              </>
            ) : (
              UPDATE_TEXT.setUpHint
            )}
          </p>
        </>
      )}
      <div className="share-row">
        <span>
          {UPDATE_TEXT.telemetry}
          <InfoTip label={UPDATE_TEXT.whatsShared}>
            <p>{shared.intro}</p>
            <ul>
              {shared.items.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p>{shared.outro}</p>
          </InfoTip>
        </span>
        <Switch on={telemetry} onChange={onTelemetry} label={UPDATE_TEXT.telemetry} />
      </div>
    </section>
  );
}
