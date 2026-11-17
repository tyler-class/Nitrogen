// Settings → Install on your phone: the browser's own Install button when it offers one, and the
// steps for iPhone and Android (the same words as Duffel, HSA Locker and Ratio).
import { useEffect, useState } from 'react';
import { isIOS } from '../kit/push';
import { Icon } from './Icon';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

export function InstallHint() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return (
    <>
      {prompt && (
        <div className="row">
          <button className="btn small" onClick={() => void prompt.prompt()}>
            <Icon name="download" size={14} /> Install Nitrogen
          </button>
        </div>
      )}
      <p>
        Open <span className="install-url">{window.location.host}</span> in your phone’s browser,
        tap Share, then “Add to Home Screen”.
        {!isIOS() && ' On Android, open the browser menu and tap “Install app”.'}
      </p>
    </>
  );
}
