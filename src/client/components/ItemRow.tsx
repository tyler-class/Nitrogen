// One open item as a row you can act on: check off a to-do or question, answer a question, or edit
// (type, text, date, time) and delete it from the buttons at the end of its first row. Used on the
// Open Items page and in a page's own Open Items box; each change edits that item in its page.
import { useState } from 'react';
import { Link } from 'react-router';
import { ITEM_LABELS, dateWords, isOverdue, type ItemEdit } from '@shared/items';
import { pageHref, plainText } from '@shared/markdown';
import type { OpenItem } from '@shared/types';
import { formatDue } from './Markdown';
import { Icon } from './Icon';
import { AnswerBox, ItemActions, ItemEditor } from './ItemParts';

export function ItemRow({
  item: i,
  today,
  onDone,
  onAnswer,
  onEdit,
  onDelete,
  showPage = true,
}: {
  item: OpenItem;
  /** The page's name after the item (off inside the page's own Open Items box). */
  showPage?: boolean;
  today: string;
  onDone(done: boolean): void;
  onAnswer(text: string): Promise<void>;
  onEdit(edit: ItemEdit): Promise<void>;
  onDelete(): void;
}) {
  const [editing, setEditing] = useState(false);
  const late = isOverdue(i, today);
  const question = i.type === 'question';
  const reminder = i.type === 'reminder';
  const dated = !!i.due;

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
        {(dated || i.owner) && (
          <div className="item-row-meta">
            {dated && (
              // The date, and a shortcut to the editor (the pencil does the same).
              <button
                type="button"
                className={`item-due-btn${late && !i.done ? ' overdue' : ''}`}
                onClick={() => setEditing((e) => !e)}
                aria-expanded={editing}
              >
                <Icon name="calendar" size={13} />
                {`${dateWords(i, today).replace(' ·', '')} ${formatDue(i.due!, i.due_time)}`}
              </button>
            )}
            {i.owner && <span className="muted">@{i.owner}</span>}
          </div>
        )}
        {question && (
          <AnswerBox answer={i.answer} onAnswer={i.done && !i.answer ? undefined : onAnswer} />
        )}
      </div>
      <ItemActions onEdit={() => setEditing((e) => !e)} onDelete={onDelete} />
      {editing && (
        <ItemEditor
          item={i}
          onCancel={() => setEditing(false)}
          onSave={async (edit) => {
            await onEdit(edit);
            setEditing(false);
          }}
        />
      )}
    </li>
  );
}
