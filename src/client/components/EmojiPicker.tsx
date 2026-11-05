// The page icon: a button that opens a searchable emoji picker (frimousse, emojibase data
// served from our own origin; see vite.config.ts).
import { useEffect, useRef, useState } from 'react';
import { EmojiPicker } from 'frimousse';

export function EmojiButton(props: { value: string; onChange: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(emoji: string) {
    props.onChange(emoji);
    setOpen(false);
    button.current?.focus();
  }

  return (
    <div className="emoji" ref={root}>
      <button
        ref={button}
        type="button"
        className={`emoji-button${props.value ? '' : ' empty'}`}
        aria-label={props.value ? `Page icon ${props.value}. Change` : 'Add a page icon'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={props.value ? 'Change icon' : 'Add icon'}
        onClick={() => setOpen((o) => !o)}
      >
        {props.value || '☺'}
      </button>
      {open && (
        <div className="emoji-pop" role="dialog" aria-label="Choose a page icon">
          <EmojiPicker.Root
            className="emoji-picker"
            emojibaseUrl="/emojibase/16"
            locale="en"
            columns={8}
            onEmojiSelect={(e) => pick(e.emoji)}
          >
            <div className="emoji-top">
              <EmojiPicker.Search className="emoji-search" placeholder="Search emoji" autoFocus />
              <EmojiPicker.SkinToneSelector className="emoji-skin" title="Skin tone" />
            </div>
            <EmojiPicker.Viewport className="emoji-viewport">
              <EmojiPicker.Loading className="emoji-note">Loading…</EmojiPicker.Loading>
              <EmojiPicker.Empty className="emoji-note">No emoji found.</EmojiPicker.Empty>
              <EmojiPicker.List
                className="emoji-list"
                components={{
                  CategoryHeader: ({ category, ...rest }) => (
                    <div className="emoji-cat" {...rest}>
                      {category.label}
                    </div>
                  ),
                  Row: ({ children, ...rest }) => (
                    <div className="emoji-row" {...rest}>
                      {children}
                    </div>
                  ),
                  Emoji: ({ emoji, ...rest }) => (
                    <button
                      className={`emoji-cell${emoji.isActive ? ' active' : ''}`}
                      title={emoji.label}
                      {...rest}
                    >
                      {emoji.emoji}
                    </button>
                  ),
                }}
              />
            </EmojiPicker.Viewport>
            <div className="emoji-foot">
              <EmojiPicker.ActiveEmoji>
                {({ emoji }) => (
                  <span className="emoji-active">
                    {emoji ? (
                      <>
                        <span className="emoji-active-glyph">{emoji.emoji}</span>
                        {emoji.label}
                      </>
                    ) : (
                      'Pick an emoji'
                    )}
                  </span>
                )}
              </EmojiPicker.ActiveEmoji>
              {props.value && (
                <button type="button" className="btn small" onClick={() => pick('')}>
                  Remove
                </button>
              )}
            </div>
          </EmojiPicker.Root>
        </div>
      )}
    </div>
  );
}
