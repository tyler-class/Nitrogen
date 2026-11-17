// The pieces every open item shares, wherever it's shown (in the page, the page's Open items box,
// the Open items view): its edit and delete buttons, the editor behind the pencil, and a
// question's answer.
import { useLayoutEffect, useRef, useState } from 'react';
import { ITEM_LABELS, ITEM_TYPES, type ItemEdit, type ItemType } from '@shared/items';
import { useTitleIndex } from '../lib/titles';
import { DatePicker, TimePicker } from './DateTimePicker';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Edit and delete, at the end of the item's first row. */
export function ItemActions({ onEdit, onDelete }: { onEdit?(): void; onDelete?(): void }) {
  if (!onEdit && !onDelete) return null;
  return (
    <div className="item-acts">
      {onEdit && (
        <button
          type="button"
          className="item-act"
          aria-label="Edit item"
          title="Edit"
          onClick={onEdit}
        >
          <Icon name="edit" size={17} />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className="item-act item-act-delete"
          aria-label="Delete item"
          title="Delete"
          onClick={onDelete}
        >
          <Icon name="trash" size={17} />
        </button>
      )}
    </div>
  );
}

/**
 * Behind the pencil: change the item's type, its text, and its date and time. A to-do's or
 * question's date is optional (when it should be done or answered by); a reminder must have one.
 */
export function ItemEditor({
  item,
  onSave,
  onCancel,
}: {
  item: { type: ItemType; text: string; due: string | null; due_time: string | null };
  onSave(edit: ItemEdit): Promise<void>;
  onCancel(): void;
}) {
  const [type, setType] = useState<ItemType>(item.type);
  const [text, setText] = useState(item.text);
  const [due, setDue] = useState<string | null>(item.due);
  const [time, setTime] = useState(item.due_time ?? '');
  const [busy, setBusy] = useState(false);
  const textBox = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = textBox.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  // A reminder always has a date: switching to one starts it on today.
  const date = type === 'reminder' ? (due ?? today()) : due;
  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    await onSave({
      type,
      text,
      due: date,
      time: date && time ? time : null,
    });
    setBusy(false);
  };
  return (
    <form
      className="item-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <label className={`item-editor-type item-${type}`}>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as ItemType)}
          aria-label="Type"
        >
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {ITEM_LABELS[t]}
            </option>
          ))}
        </select>
        <Icon name="chevron" size={14} />
      </label>
      {/* One line in the page, but it wraps here so it's all in view; Enter saves. */}
      <textarea
        ref={textBox}
        className="item-editor-text"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
        enterKeyHint="done"
        aria-label="Text"
        placeholder="What is it?"
        autoFocus
      />
      <div className="item-editor-when">
        {date ? (
          <>
            <DatePicker
              value={date}
              onChange={setDue}
              label={type === 'reminder' ? 'Scheduled for' : 'Due date'}
            />
            <TimePicker value={time} onChange={setTime} label="Time (optional)" />
            {type !== 'reminder' && (
              <button type="button" className="btn small" onClick={() => setDue(null)}>
                No date
              </button>
            )}
          </>
        ) : (
          <button type="button" className="btn small" onClick={() => setDue(today())}>
            <Icon name="calendar" size={13} /> Add a date
          </button>
        )}
      </div>
      <div className="item-editor-foot">
        <button className="btn small primary" disabled={busy || !text.trim()}>
          Save
        </button>
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const touch = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Answers keep the line breaks they were typed with: a line followed by more text gets a hard
 * break (markdown would otherwise run them together). Lists, quotes, blank lines and code fences
 * are left alone.
 */
function keepBreaks(md: string): string {
  const lines = md.split('\n');
  let fence = false;
  const block = /^\s*([-*+]\s|\d+[.)]\s|>|#|\||```|~~~)/;
  return lines
    .map((l, k) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const next = lines[k + 1];
      if (fence || !l.trim() || next === undefined || !next.trim() || block.test(next)) return l;
      return `${l}\\`;
    })
    .join('\n');
}

/**
 * A question's answer. Unanswered: an Answer button. Answered: a small "ANSWER" label and the
 * answer (markdown) above a line; tap it to change it. Writing one: a box that grows with the
 * text, where Enter saves and Shift+Enter starts a new line (on phones, Return is a new line and
 * Save saves). Lists, quotes and other markdown work.
 */
export function AnswerBox({
  answer,
  onAnswer,
}: {
  answer: string | null;
  onAnswer?: (text: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(answer ?? '');
  const box = useRef<HTMLTextAreaElement>(null);
  const { index } = useTitleIndex();

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, editing]);

  const open = () => {
    if (!onAnswer) return;
    setValue(answer ?? '');
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (value.trim() !== (answer ?? '').trim()) void onAnswer?.(value);
  };
  const cancel = () => {
    setValue(answer ?? '');
    setEditing(false);
  };

  if (editing)
    return (
      <div className="qa qa-editing">
        <div className="qa-field">
          <span className="qa-label">Answer</span>
          <textarea
            ref={box}
            className="qa-input"
            rows={1}
            value={value}
            autoFocus
            aria-label="Answer"
            placeholder="Type the answer"
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              } else if (e.key === 'Enter' && !e.shiftKey && !touch()) {
                e.preventDefault();
                commit();
              }
            }}
          />
        </div>
        <div className="qa-foot">
          {/* Pressed without taking the focus, so the box's blur doesn't save first. */}
          <button
            type="button"
            className="btn small primary"
            onPointerDown={(e) => e.preventDefault()}
            onClick={commit}
          >
            Save
          </button>
          <button
            type="button"
            className="btn small"
            onPointerDown={(e) => e.preventDefault()}
            onClick={cancel}
          >
            Cancel
          </button>
          <span className="qa-hint muted">Shift+Enter for a new line. Markdown works.</span>
        </div>
      </div>
    );
  if (answer)
    return (
      <div
        className={`qa qa-done${onAnswer ? ' editable' : ''}`}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('a')) open();
        }}
        title={onAnswer ? 'Change the answer' : undefined}
      >
        <div className="qa-field">
          <span className="qa-label">Answer</span>
          <div className="qa-md">
            <Markdown source={keepBreaks(answer)} titles={index} noItems />
          </div>
        </div>
      </div>
    );
  if (!onAnswer) return null;
  return (
    <button type="button" className="item-due-btn qa-btn" onClick={open}>
      <Icon name="edit" size={13} /> Answer
    </button>
  );
}
