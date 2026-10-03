import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { DirectionContext, ResultNote } from '@garden/contracts';
import { MessageSquare } from './icons';
import { Button } from './ui';
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

interface Circle {
  x: number;
  y: number;
  radius: number;
}

/** The toggle that turns the pointer into a pen over a result. */
export function MarkButton({ marking, onToggle }: { marking: boolean; onToggle: () => void }) {
  return (
    <Button aria-pressed={marking} title="Circle a place and comment on it" onClick={onToggle}>
      <MessageSquare size={15} />
      {marking ? 'Done marking' : 'Mark'}
    </Button>
  );
}

/**
 * Anything the owner can point at: an app, a page of a PDF, an image, a drawn view. While marking,
 * press to circle a place and say what is wrong or wanted there; the comment carries where it is,
 * and what is under it when the content can say.
 */
export function Markable({
  on,
  notes = [],
  onNote,
  marking,
  probe,
  className = '',
  children
}: {
  on: string;
  notes?: readonly ResultNote[];
  onNote: (note: ResultNote) => void;
  marking: boolean;
  /** Asks the content what lies under a circle, for content that can answer. */
  probe?: (circle: Circle) => Promise<string>;
  className?: string;
  children: ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState<Circle | null>(null);
  const [pending, setPending] = useState<Circle | null>(null);
  const mine = notes.filter((note) => note.on === on && note.region);
  const point = (event: PointerEvent) => {
    const box = layer.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      width: box.width,
      height: box.height
    };
  };
  const circles = [
    ...mine.map((note) => note.region!),
    ...(drawing ? [drawing] : []),
    ...(pending ? [pending] : [])
  ];
  return (
    <div className={`markable ${className}`}>
      {children}
      {(marking || circles.length > 0) && (
        <div
          ref={layer}
          className={`mark-layer${marking ? ' is-marking' : ''}`}
          onPointerDown={(event) => {
            if (!marking || pending) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const at = point(event);
            setDrawing({ x: at.x, y: at.y, radius: 0 });
          }}
          onPointerMove={(event) => {
            if (!drawing) return;
            const at = point(event);
            const dx = (at.x - drawing.x) * at.width;
            const dy = (at.y - drawing.y) * at.height;
            setDrawing({ ...drawing, radius: Math.hypot(dx, dy) / at.width });
          }}
          onPointerUp={(event) => {
            if (!drawing) return;
            const at = point(event);
            setPending({ ...drawing, radius: Math.max(drawing.radius, 18 / at.width) });
            setDrawing(null);
          }}
        >
          {circles.map((circle, index) => (
            <span
              key={index}
              className="mark-circle"
              style={{
                left: `${circle.x * 100}%`,
                top: `${circle.y * 100}%`,
                width: `${circle.radius * 200}%`,
                aspectRatio: '1'
              }}
            />
          ))}
          {pending && (
            <NotePopover
              at={{
                left: Math.min(
                  Math.max(0, pending.x * (layer.current?.clientWidth ?? 0) - 120),
                  Math.max(0, (layer.current?.clientWidth ?? 280) - 280)
                ),
                top: (pending.y + pending.radius) * (layer.current?.clientHeight ?? 0) + 8
              }}
              label="On the circled area"
              onCancel={() => setPending(null)}
              onSave={(note) => {
                const circle = pending;
                setPending(null);
                void (probe ? probe(circle) : Promise.resolve('')).then((text) =>
                  onNote({ on, region: { ...circle, ...(text ? { text } : {}) }, note })
                );
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
