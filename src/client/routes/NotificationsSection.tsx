// Settings → Notifications: this device's own choices (Selfhost Kit layout and words).
import { useEffect, useState } from 'react';
import { BADGE_MEANS, NOTIFY_KINDS } from '@shared/notify';
import {
  disablePush,
  enablePush,
  getState,
  installSteps,
  pushBlocker,
  pushInfo,
  PUSH_TEXT,
  sendTest,
  setPrefs,
  type PushState,
} from '../kit/push';
import { Icon } from '../components/Icon';
import { InfoTip, Switch } from '../components/InfoTip';
import { useToast } from '../components/Toast';
import { errorMessage } from '../lib/api';

const KINDS = NOTIFY_KINDS.map((k) => k.id);

export function NotificationsSection() {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    getState()
      .then((s) => live && setState(s))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);

  async function act(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const info = pushInfo({ badge: BADGE_MEANS });
  const blocker = state && pushBlocker(state, 'Nitrogen');
  const on = !!state?.on;

  return (
    <section className="notify">
      <h2>
        {PUSH_TEXT.heading}{' '}
        <InfoTip label={PUSH_TEXT.about}>
          <ul>
            {info.lines.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </InfoTip>
      </h2>
      {!state ? (
        !error && <p className="notify-wait" aria-busy="true" />
      ) : blocker ? (
        <>
          <div className="notify-line">
            {blocker.text}{' '}
            {blocker.install && (
              <InfoTip label={PUSH_TEXT.howToInstall}>
                {installSteps('Nitrogen').map((g) => (
                  <span key={g.label} className="notify-steps">
                    <strong>{g.label}</strong>
                    <ol>
                      {g.steps.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ol>
                  </span>
                ))}
              </InfoTip>
            )}
          </div>
          {blocker.install && !state.standalone && (
            <button
              className="btn small"
              onClick={() =>
                document
                  .getElementById('install')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              <Icon name="phone" size={14} /> {PUSH_TEXT.installLink}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="share-row notify-master">
            <span>
              {PUSH_TEXT.master}
              {state.standalone && (
                <InfoTip label={PUSH_TEXT.whyItWorks}>
                  <p>{PUSH_TEXT.installed('Nitrogen')}</p>
                </InfoTip>
              )}
            </span>
            <Switch
              on={on}
              label={PUSH_TEXT.master}
              // Straight from the tap: the permission prompt needs it.
              onChange={(v) =>
                !busy && act(async () => setState(await (v ? enablePush(KINDS) : disablePush())))
              }
            />
          </div>
          {on &&
            NOTIFY_KINDS.map((k) => (
              <div key={k.id} className="share-row">
                <span className="notify-kind">
                  <span>
                    {k.label}
                    <InfoTip label={`About ${k.label.toLowerCase()}`}>
                      <p>{k.detail}</p>
                    </InfoTip>
                  </span>
                  <span className="muted">{k.description}</span>
                </span>
                <Switch
                  on={state.device?.prefs[k.id] !== false}
                  label={k.label}
                  onChange={(v) =>
                    act(async () => {
                      // Show it now; the server agrees or the error says why.
                      setState((s) =>
                        s?.device
                          ? {
                              ...s,
                              device: { ...s.device, prefs: { ...s.device.prefs, [k.id]: v } },
                            }
                          : s,
                      );
                      const device = await setPrefs({ [k.id]: v });
                      if (device) setState((s) => s && { ...s, device });
                    })
                  }
                />
              </div>
            ))}
          {on && (
            <div className="row notify-test">
              <button
                className="btn small"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await sendTest();
                    toast(PUSH_TEXT.testSent);
                  })
                }
              >
                <Icon name="bell" size={14} /> {PUSH_TEXT.test}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="notify-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
