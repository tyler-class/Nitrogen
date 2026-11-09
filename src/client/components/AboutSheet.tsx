import { VERSION } from '@shared/version';
import { aboutLinks, BUILT_BY, type AboutLinkKind } from '../kit/about';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

const LINKS = aboutLinks({
  title: 'Nitrogen',
  repo: 'tyler-class/Nitrogen',
  email: 'nitrogen@tylerclass.net',
  coffee: 'Free like 78% of the air. Buy me a coffee ☕',
});
const ICONS: Record<AboutLinkKind, string> = {
  github: 'github',
  email: 'mail',
  coffee: 'coffee',
  site: 'link',
};

/** About Nitrogen: version, what it is, who built it, and links (Selfhost Kit layout). */
export function AboutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="About Nitrogen" sub={`Version ${VERSION}`} onClose={onClose}>
      <div className="about">
        <p className="about-blurb">
          Nitrogen is a free, open-source wiki that you and your AI assistants write together: a
          page tree, markdown, search by meaning, and an MCP server. It runs on your own Cloudflare
          account, so your data stays yours.
        </p>
        <p className="about-by">{BUILT_BY}</p>
        <div className="about-links">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              {...(l.external ? { target: '_blank', rel: 'noreferrer' } : {})}
              className="about-link"
            >
              <span className="about-link-icon">
                <Icon name={ICONS[l.kind]} size={18} />
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
