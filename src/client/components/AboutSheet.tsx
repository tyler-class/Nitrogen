import { useState } from 'react';
import { VERSION } from '@shared/version';
import { checkForUpdate } from '../lib/pwa';
import { useToast } from './Toast';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

const LINKS = [
  { icon: 'github', label: 'Nitrogen on GitHub', href: 'https://github.com/tyler-class/Nitrogen' },
  {
    icon: 'mail',
    label: 'Questions or help? nitrogen@tylerclass.net',
    href: 'mailto:nitrogen@tylerclass.net',
  },
  {
    icon: 'dollar',
    label: 'Nitrogen is free, like 78% of the air. Buy me a coffee to keep it that way ☕',
    href: 'https://ko-fi.com/tylerclass',
  },
  { icon: 'link', label: 'tylerclass.net', href: 'https://tylerclass.net' },
];

export function AboutSheet({ onClose }: { onClose: () => void }) {
  const [checking, setChecking] = useState(false);
  const toast = useToast();
  return (
    <Sheet title="About Nitrogen" sub={`Version ${VERSION}`} onClose={onClose}>
      <div className="about">
        <p className="about-blurb">
          Nitrogen is a free, open-source wiki that you and your AI assistants write together: a
          page tree, markdown, search by meaning, and an MCP server. It runs on your own Cloudflare
          account, so your data stays yours.
        </p>
        <p className="about-by">Built by Tyler Class.</p>
        <button
          type="button"
          className="btn small about-update"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              if ((await checkForUpdate()) === 'latest') toast('You’re on the latest version.');
            } catch {
              toast('Couldn’t check. Are you online?');
            } finally {
              setChecking(false);
            }
          }}
        >
          <Icon name="history" size={14} /> {checking ? 'Checking…' : 'Check for updates'}
        </button>
        <div className="about-links">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="about-link">
              <span className="about-link-icon">
                <Icon name={l.icon} size={18} />
              </span>
              <span className="about-link-label">{l.label}</span>
              <span className="about-link-chev">
                <Icon name="chevron" size={14} />
              </span>
            </a>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** "About Nitrogen" button: sidebar on desktop, Settings heading on phones. */
export function AboutButton({ className, onClick }: { className: string; onClick: () => void }) {
  return (
    <button type="button" className={className} onClick={onClick}>
      <Icon name="info" size={15} /> About Nitrogen
    </button>
  );
}
