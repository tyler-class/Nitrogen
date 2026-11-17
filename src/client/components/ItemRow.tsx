// One open item as a row you can act on: check off a to-do, resolve or answer a question, change
// a to-do's or reminder's date and time. Used on the Open items page and in a page's own Open
// items box; each change edits that one line of the page.
import { useState } from 'react';
import { Link } from 'react-router';
import { ITEM_LABELS, dateWords, isOverdue } from '@shared/items';
import { pageHref, plainText } from '@shared/markdown';
import type { OpenItem } from '@shared/types';
import { formatDue } from './Markdown';
import { Icon } from './Icon';
import { DatePicker, TimePicker } from './DateTimePicker';

/** One item: its checkbox, text and page, and inline controls for its date or answer. */
export function ItemRow({
  item: i,
  today,
  onDone,
  onAnswer,
  onDue,
  showPage = true,
}: {
  item: OpenItem;
  /** The page's name after the item (off inside the page's own Open items box). */
  showPage?: boolean;
  today: string;
  onDone(done: boolean): void;
  onAnswer(text: string): Promise<void>;
  onDue(due: string | null, time: string | null): Promise<void>;
}) {
  const [editing, setEditing] = useState<'due' | 'answer' | null>(null);
  const [date, setDate] = useState(i.due ?? today);
  const [time, setTime] = useState(i.due_time ?? '');
  const [text, setText] = useState(i.answer ?? '');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    await fn();
    setBusy(false);
    setEditing(null);
  };
  const late = isOverdue(i, today);
  const question = i.type === 'question';
  const reminder = i.type === 'reminder';

  return (
    <li className={`item-row item-${i.type}${i.done ? ' is-done' : ''}`}>
      {reminder ? (
        // A nudge, not a task: nothing to check off.
        <span className="item-bell" aria-hidden>
          <Icon name="bell" size={15} />
        </span>
      ) : (
        <button
          type="button"
          className="item-check"
          role="checkbox"
          aria-checked={i.done}
          aria-label={`${i.done ? 'Reopen' : question ? 'Resolve' : 'Complete'}: ${plainText(i.text)}`}
          title={question && !i.done ? 'Resolve without an answer' : undefined}
          onClick={() => onDone(!i.done)}
        />
      )}
      <div className="item-row-main">
        <div className="item-row-line">
          <span className={`item-chip item-${i.type}`}>{ITEM_LABELS[i.type]}</span>
          {showPage ? (
            <Link
              to={`${pageHref(i.page_id, i.page_title)}#item-${i.line}`}
              className="item-row-text"
            >
              {plainText(i.text)}
            </Link>
          ) : (
            // On its own page: scroll to the item where it's written.
            <a
              href={`#item-${i.line}`}
              className="item-row-text"
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(`item-${i.line}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
            >
              {plainText(i.text)}
            </a>
          )}
          {/* The page it's on, right after the item; the full path is in the tooltip. Only the
              page's title underlines on hover, not the dot or its emoji. */}
          {showPage && (
            <>
              <span className="item-row-sep" aria-hidden>
                ·
              </span>
              <Link
                to={pageHref(i.page_id, i.page_title)}
                className="item-row-page"
                title={[...i.path, i.page_title].join(' › ')}
              >
                {i.page_icon && <span className="item-row-page-icon">{i.page_icon}</span>}
                <span className="item-row-page-title">{i.page_title}</span>
              </Link>
            </>
          )}
        </div>
        <div className="item-row-meta">
          {!question && !i.done && (
            <button
              type="button"
              className={`item-due-btn${late ? ' overdue' : ''}`}
              onClick={() => setEditing(editing === 'due' ? null : 'due')}
              aria-expanded={editing === 'due'}
            >
              <Icon name="calendar" size={13} />
              {i.due
                ? `${dateWords(i, today).replace(' ·', '')} ${formatDue(i.due, i.due_time)}`
                : 'Add a date'}
            </button>
          )}
          {question && !i.done && (
            <button
              type="button"
              className="item-due-btn"
              onClick={() => setEditing(editing === 'answer' ? null : 'answer')}
              aria-expanded={editing === 'answer'}
            >
              <Icon name="edit" size={13} /> Answer
            </button>
          )}
          {i.done && i.answer && <span className="item-answer">Answer: {i.answer}</span>}
          {i.owner && <span className="muted">@{i.owner}</span>}
        </div>
        {editing === 'due' && (
          <form
            className="item-edit"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => onDue(date, time || null));
            }}
          >
            <DatePicker
              value={date}
              onChange={setDate}
              label={i.type === 'reminder' ? 'Scheduled for' : 'Due date'}
            />
            <TimePicker value={time} onChange={setTime} label="Time (optional)" />
            <button className="btn small primary" disabled={busy || !date}>
              Save
            </button>
            {i.type === 'todo' && i.due && (
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() => void run(() => onDue(null, null))}
              >
                Remove date
              </button>
            )}
            <button type="button" className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </form>
        )}
        {editing === 'answer' && (
          <form
            className="item-edit"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void run(() => onAnswer(text));
            }}
          >
            <input
              className="item-answer-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type the answer"
              aria-label="Answer"
              autoFocus
            />
            <button className="btn small primary" disabled={busy || !text.trim()}>
              Save
            </button>
            <button type="button" className="btn small" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </li>
  );
}
