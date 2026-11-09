// Conventions: the owner's house rules for the wiki, outside the page tree. It's an ordinary
// page underneath (the "guide_id" setting points to it), shown here in its own frame.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CONVENTIONS_ICON, CONVENTIONS_TEMPLATE, CONVENTIONS_TITLE } from '@shared/conventions';
import type { Page } from '@shared/types';
import { api, errorMessage } from '../lib/api';
import { keys, useSettings, useTree } from '../lib/queries';
import { Icon } from '../components/Icon';
import { InfoTip } from '../components/InfoTip';
import { PagePicker } from '../components/PagePicker';
import { useToast } from '../components/Toast';
import { PageView } from './PageView';

/** What conventions are, in a few lines (the ⓘ beside the heading). */
function About() {
  return (
    <InfoTip label="How conventions work">
      <p>
        Conventions are your house rules for the wiki: where things go, how pages are named, which
        tags to use, how to write.
      </p>
      <p>
        Every AI assistant you connect reads this page before anything else and follows it over its
        general habits. Assistants that are connected already pick up changes the next time they
        connect.
      </p>
      <p>
        Edit it like any page. Assistants can also read and change it with get_conventions and
        update_conventions, so you can say “add a rule that meeting notes go under their project”.
      </p>
    </InfoTip>
  );
}

export function Conventions() {
  const tree = useTree();
  const id = tree.data?.conventions_id ?? null;
  const header = (
    <div className="conv-head">
      <h1 className="conv-title">
        <Icon name="rules" size={20} /> Conventions <About />
      </h1>
      <p className="conv-sub">How assistants should organize and write in this wiki.</p>
    </div>
  );

  if (tree.isPending) return <div className="page-loading" aria-busy="true" />;
  if (id) return <PageView key={id} pageId={id} header={header} />;
  return (
    <div className="page conventions">
      {header}
      <Empty />
    </div>
  );
}

/** No conventions yet: start from a template, or use a page you already wrote. */
function Empty() {
  const tree = useTree();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const settings = useSettings();
  const choose = async (pageId: string | null) => {
    if (!pageId) return;
    await api.patch('/settings', { guide_id: pageId });
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.tree }),
      qc.invalidateQueries({ queryKey: keys.settings }),
    ]);
  };
  async function start() {
    setBusy(true);
    try {
      const p = await api.post<Page>('/pages', {
        title: CONVENTIONS_TITLE,
        parent_id: null,
        icon: CONVENTIONS_ICON,
        body: CONVENTIONS_TEMPLATE,
      });
      await choose(p.id);
      toast('Created. Assistants will read it first.');
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const sessionsId = tree.data?.sessions_id;
  const pages = (tree.data?.pages ?? []).filter(
    (p) => !sessionsId || (p.id !== sessionsId && p.parent_id !== sessionsId),
  );
  return (
    <div className="conv-empty">
      <p>No conventions yet. Start from a template and edit it to match how you work.</p>
      <button className="btn primary" disabled={busy} onClick={() => void start()}>
        <Icon name="plus" size={15} /> Start from a template
      </button>
      <div className="field">
        <span>Or use a page you already wrote</span>
        <PagePicker
          aria-label="Use an existing page as your conventions"
          pages={pages}
          value={settings.data?.guide_id ?? null}
          noneLabel="Choose a page"
          onChange={(p) => void choose(p).catch((e) => toast(errorMessage(e)))}
        />
      </div>
    </div>
  );
}
