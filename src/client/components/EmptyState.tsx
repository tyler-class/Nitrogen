// A calm "nothing here": an icon in a circle, a headline and one line.
import { Icon } from './Icon';

export function EmptyState({
  icon,
  title,
  line,
  tone = 'ok',
}: {
  icon: string;
  title: string;
  line: string;
  /** "ok" (green: all done) or "plain" (blue: nothing yet). */
  tone?: 'ok' | 'plain';
}) {
  return (
    <div className={`items-empty-state${tone === 'plain' ? ' plain' : ''}`}>
      <span className="items-empty-icon" aria-hidden>
        <Icon name={icon} size={20} />
      </span>
      <div>
        <p className="items-empty-title">{title}</p>
        <p className="items-empty-line">{line}</p>
      </div>
    </div>
  );
}
