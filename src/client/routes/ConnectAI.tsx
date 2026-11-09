// Settings → "Connect an AI assistant", in the Selfhost Kit layout (src/client/kit/assistants.ts):
// the connector URL, the connected assistants, set-up steps behind one chip per assistant, and
// example prompts behind a toggle.
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EXAMPLE_PROMPTS } from '@shared/examples';
import { api, errorMessage } from '../lib/api';
import { useTree } from '../lib/queries';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import {
  ASSISTANT_INTRO,
  assistants,
  CONNECTED_TEXT,
  signInNote,
  type AssistantSetup,
} from '../kit/assistants';

interface Connection {
  id: string;
  name: string;
  created_at: string | null;
}

function CopyRow({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <div className="copy-row" aria-label={label}>
      <code>{text}</code>
      <button
        className="btn small"
        onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('Copied.'))}
      >
        Copy
      </button>
    </div>
  );
}

export function ConnectAISection() {
  const url = `${window.location.origin}/mcp`;
  const tree = useTree();
  const list = assistants('Nitrogen', 'nitrogen', url);
  const [open, setOpen] = useState<AssistantSetup['id'] | null>(null);
  const [examples, setExamples] = useState(false);
  const toast = useToast();
  const shown = list.find((a) => a.id === open);

  return (
    <section className="connect-ai">
      <h2>Connect an AI assistant</h2>
      <p>{ASSISTANT_INTRO('wiki')} Every edit an assistant makes is saved in the page history.</p>
      <span className="field-label">{CONNECTED_TEXT.urlLabel('wiki')}</span>
      <CopyRow text={url} label="Connector URL" />
      <p className="muted">{signInNote('Nitrogen')}</p>
      <p className="muted">
        Assistants read your <Link to="/conventions">Conventions</Link> before anything else
        {tree.data?.conventions_id ? '.' : ' (none yet).'}
      </p>

      <h3 className="ai-h">{CONNECTED_TEXT.heading}</h3>
      <Connected />

      <h3 className="ai-h">{CONNECTED_TEXT.setUp}</h3>
      <div className="ai-chips" role="group" aria-label="Set-up steps for">
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`ai-chip${open === a.id ? ' on' : ''}`}
            aria-pressed={open === a.id}
            aria-controls="ai-steps"
            onClick={() => setOpen((o) => (o === a.id ? null : a.id))}
          >
            {a.name}
          </button>
        ))}
      </div>
      {shown && (
        <div id="ai-steps" className="ai-steps">
          {shown.steps.length > 0 && (
            <ol className="steps">
              {shown.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {shown.command && <CopyRow text={shown.command} label={`${shown.name} command`} />}
          {shown.after && <p className="muted">{shown.after}</p>}
        </div>
      )}

      <button
        type="button"
        className="ai-toggle"
        aria-expanded={examples}
        aria-controls="ai-examples"
        onClick={() => setExamples((e) => !e)}
      >
        <span className={`ai-toggle-chev${examples ? ' turned' : ''}`} aria-hidden>
          <Icon name="chevron" size={12} />
        </span>
        {CONNECTED_TEXT.examples}
      </button>
      {examples && (
        <div id="ai-examples">
          <p className="muted">{CONNECTED_TEXT.examplesHint}</p>
          <ul className="try-list">
            {EXAMPLE_PROMPTS.map((e) => (
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
        </div>
      )}
    </section>
  );
}

/** Connected assistants, one row each, and Disconnect all (tap twice). */
function Connected() {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ connections: Connection[] }>('/connections'),
    retry: false,
  });
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) return <p className="muted">{errorMessage(q.error)}</p>;
  const list = q.data.connections;
  if (!list.length) return <p className="muted">{CONNECTED_TEXT.none}</p>;
  return (
    <>
      <ul className="ai-conns">
        {list.map((c) => (
          <li key={c.id}>
            <Icon name="sparkle" size={15} />
            <span className="ai-conn-name">{c.name}</span>
            {c.created_at && (
              <span className="muted">Connected {new Date(c.created_at).toLocaleDateString()}</span>
            )}
          </li>
        ))}
      </ul>
      <button
        className="btn danger small"
        onBlur={() => setConfirm(false)}
        onClick={async () => {
          if (!confirm) return setConfirm(true);
          setConfirm(false);
          try {
            await api.post('/connections/revoke-all');
          } catch (e) {
            toast(errorMessage(e));
          }
          void qc.invalidateQueries({ queryKey: ['connections'] });
        }}
      >
        {confirm ? CONNECTED_TEXT.confirm : CONNECTED_TEXT.disconnectAll}
      </button>
    </>
  );
}
