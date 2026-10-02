import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DirectionContext, ResultNote } from '@garden/contracts';
import { MessageSquare } from './icons';
import './result-view.css';

/** A small inline form for one comment, placed where the owner pointed. */
export function NotePopover({
  at,
  label,
  onSave,
  onCancel
}: {
  at: { left: number; top: number };
  label: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  return (
    <form
      className="note-popover"
      style={{ left: at.left, top: at.top }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text);
      }}
    >
      <span className="eyebrow">{label}</span>
      <textarea
        ref={field}
        rows={2}
        value={text}
        maxLength={4000}
        placeholder="Your comment (optional)"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSave(text);
          }
        }}
      />
      <div className="row">
        <button type="submit" className="button primary">
          Add
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Text the owner can comment on by selecting it. A selection inside the region offers a Comment
 * button beside it; the comment joins the next message with the quoted text attached.
 */
export function Commentable({
  on,
  onNote,
  children
}: {
  on: string;
  onNote: (note: ResultNote) => void;
  children: ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  const [offer, setOffer] = useState<{ quote: string; left: number; top: number } | null>(null);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    const update = () => {
      if (writing) return;
      const selection = window.getSelection();
      const quote = selection?.toString().trim() ?? '';
      const host = region.current;
      if (!selection || !quote || !host || selection.rangeCount === 0) return setOffer(null);
      const range = selection.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return setOffer(null);
      const box = range.getBoundingClientRect();
      const frame = host.getBoundingClientRect();
      setOffer({
        quote: quote.slice(0, 4000),
        left: Math.max(0, Math.min(box.right - frame.left, frame.width - 120)),
        top: box.bottom - frame.top + 4
      });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [writing]);
  return (
    <div className="commentable" ref={region}>
      {children}
      {offer && !writing && (
        <button
          type="button"
          className="button note-offer"
          style={{ left: offer.left, top: offer.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setWriting(true)}
        >
          <MessageSquare size={14} /> Comment
        </button>
      )}
      {offer && writing && (
        <NotePopover
          at={{ left: Math.max(0, offer.left - 160), top: offer.top }}
          label={`On “${offer.quote.slice(0, 40)}${offer.quote.length > 40 ? '…' : ''}”`}
          onCancel={() => {
            setWriting(false);
            setOffer(null);
          }}
          onSave={(note) => {
            onNote({ on, quote: offer.quote, note });
            setWriting(false);
            setOffer(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}

/** Adds a note to whatever the composer holds, keeping earlier comments. */
export const withNote = (
  context: DirectionContext | null,
  note: ResultNote
): Extract<DirectionContext, { kind: 'notes' }> => ({
  kind: 'notes',
  notes: [...(context?.kind === 'notes' ? context.notes : []), note].slice(-30)
});
