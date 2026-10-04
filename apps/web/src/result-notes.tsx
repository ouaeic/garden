import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject
} from 'react';
import type { DirectionContext, ResultAnchor, ResultNote } from '@garden/contracts';
import { onCommentFocus } from './comment-focus';
import { MessageSquare } from './icons';
import { anchorAt, anchorForRange, forget, placeOf, shown } from './marks-bridge.js';
import { Button } from './ui';
import './result-view.css';

/** Adds a note to whatever the composer holds, keeping earlier comments. */
export const withNote = (
  context: DirectionContext | null,
  note: ResultNote
): Extract<DirectionContext, { kind: 'notes' }> => ({
  kind: 'notes',
  notes: [...(context?.kind === 'notes' ? context.notes : []), note].slice(-30)
});

interface Pin {
  n: number;
  anchor: ResultAnchor;
  text: string;
}

/** The pins on one result, numbered as the composer numbers its comments. */
const pinsFor = (notes: readonly ResultNote[], on: string): Pin[] =>
  notes.flatMap((note, index) =>
    note.on === on && note.anchor ? [{ n: index + 1, anchor: note.anchor, text: note.note }] : []
  );

const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.slice(0, limit) : '';
const fraction = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const count = (value: unknown, least: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(least, Math.round(value)) : least;

/** An anchor a frame reported, kept to the shape and sizes a comment may carry. */
const cleanAnchor = (value: unknown): ResultAnchor | null => {
  const raw = (value ?? {}) as Record<string, unknown>;
  const optional = (key: string, limit: number) => {
    const found = text(raw[key], limit);
    return found ? { [key]: found } : {};
  };
  if (raw.kind === 'text' && text(raw.quote, 4000))
    return {
      kind: 'text',
      quote: text(raw.quote, 4000),
      ...optional('before', 80),
      ...optional('after', 80)
    };
  if (raw.kind === 'point')
    return {
      kind: 'point',
      path: text(raw.path, 400),
      label: text(raw.label, 300),
      ...optional('context', 200),
      x: fraction(raw.x),
      y: fraction(raw.y)
    };
  if (raw.kind === 'cell')
    return {
      kind: 'cell',
      row: count(raw.row, 0),
      column: text(raw.column, 200),
      value: text(raw.value, 500)
    };
  if (raw.kind === 'page')
    return {
      kind: 'page',
      page: count(raw.page, 1),
      x: fraction(raw.x),
      y: fraction(raw.y),
      ...optional('text', 300)
    };
  if (raw.kind === 'spot')
    return { kind: 'spot', ...optional('path', 400), x: fraction(raw.x), y: fraction(raw.y) };
  return null;
};

/** Every surface's highlighted passages, painted as one set. */
const passages = new Map<object, Range[]>();
const paintPassages = () => {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined')
    return;
  CSS.highlights.set('garden-comments', new Highlight(...[...passages.values()].flat()));
};

/** Which comment the composer is pointing at, and a way to bring one on screen. */
function useFocus(reveal: (n: number) => void): number {
  const [focus, setFocus] = useState(0);
  const latest = useRef(reveal);
  latest.current = reveal;
  useEffect(
    () =>
      onCommentFocus((n, show) => {
        setFocus(n);
        if (show && n) latest.current(n);
      }),
    []
  );
  return focus;
}

/** A small form for one comment, beside what it is about. */
function NotePopover({
  at,
  n,
  onSave,
  onCancel
}: {
  at: { left: number; top: number };
  n: number;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  return (
    <form
      className="note-popover"
      data-garden-ui=""
      style={{ left: at.left, top: at.top }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value);
      }}
    >
      <textarea
        ref={field}
        rows={2}
        value={value}
        maxLength={4000}
        aria-label={`Comment ${n}`}
        placeholder={`Comment ${n}`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSave(value);
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

/** A comment on its way: where it points, and whether the owner is still only offered it. */
interface Draft {
  anchor: ResultAnchor;
  left: number;
  top: number;
  offer: boolean;
}

/** The offer beside a selection, the form once taken, and the pin it will become. */
function DraftComment({
  draft,
  n,
  width,
  onTake,
  onSave,
  onCancel
}: {
  draft: Draft;
  n: number;
  width: number;
  onTake: () => void;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const left = Math.max(0, Math.min(draft.left - 16, width - 288));
  if (draft.offer)
    return (
      <button
        type="button"
        className="button note-offer"
        data-garden-ui=""
        style={{ left: Math.max(0, Math.min(draft.left, width - 120)), top: draft.top + 6 }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onTake}
      >
        <MessageSquare size={14} /> Comment
      </button>
    );
  return (
    <>
      {draft.anchor.kind !== 'text' && (
        <b className="comment-pin is-draft" style={{ left: draft.left, top: draft.top }}>
          {n}
        </b>
      )}
      <NotePopover at={{ left, top: draft.top + 10 }} n={n} onSave={onSave} onCancel={onCancel} />
    </>
  );
}

/** The toggle that turns the pointer into a pin over a result. */
export function CommentButton({
  commenting,
  onToggle
}: {
  commenting: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-pressed={commenting}
      title="Pin a comment to any part of this result"
      onClick={onToggle}
    >
      <MessageSquare size={15} />
      {commenting ? 'Done' : 'Comment'}
    </Button>
  );
}

interface Placed {
  n: number;
  left: number;
  top: number;
  text: string;
}

interface Props {
  on: string;
  notes?: readonly ResultNote[] | undefined;
  onNote: (note: ResultNote) => void;
  /** Pressing anywhere places a pin; without it, only selected text takes a comment. */
  commenting?: boolean;
  onDone?: () => void;
  className?: string;
  children: ReactNode;
}

const useEscape = (active: boolean, onDone?: () => void) =>
  useEffect(() => {
    if (!active || !onDone) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [active, onDone]);

/**
 * Anything garden renders itself — the answer, a file, a table, a document's pages — taking
 * comments where they belong. Select words to highlight them; while commenting, press anything to
 * pin a comment to it. Each comment is anchored to the content, so its pin follows the content
 * through scrolling, resizing and re-rendering, and the model is told what it is on in words.
 */
export function CommentSurface({
  on,
  notes = [],
  onNote,
  commenting = false,
  onDone,
  className = '',
  children
}: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const pins = pinsFor(notes, on);
  const signature = JSON.stringify(pins);
  const owner = useRef({});

  const draw = useCallback(() => {
    const root = content.current;
    const box = surface.current?.getBoundingClientRect();
    if (!root || !box) return;
    const ranges: Range[] = [];
    const next: Placed[] = [];
    for (const pin of JSON.parse(signature) as Pin[]) {
      const place = placeOf(root, pin.anchor);
      if (!place || !shown(place.node, root, place.x, place.y)) continue;
      if (place.range) ranges.push(place.range);
      next.push({ n: pin.n, left: place.x - box.left, top: place.y - box.top, text: pin.text });
    }
    setPlaced((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    passages.set(owner.current, ranges);
    paintPassages();
  }, [signature]);

  useLayoutEffect(draw, [draw]);
  useEffect(() => {
    const root = content.current;
    const host = surface.current;
    if (!root || !host) return;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const changed = () => {
      forget();
      later();
    };
    const size = new ResizeObserver(later);
    size.observe(host);
    const edits = new MutationObserver(changed);
    edits.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener('scroll', later, true);
    root.addEventListener('load', changed, true);
    window.addEventListener('resize', later);
    const mine = owner.current;
    return () => {
      cancelAnimationFrame(frame);
      size.disconnect();
      edits.disconnect();
      root.removeEventListener('scroll', later, true);
      root.removeEventListener('load', changed, true);
      window.removeEventListener('resize', later);
      passages.delete(mine);
      paintPassages();
    };
  }, [draw]);

  // Selected words inside the surface are offered a comment, whether or not the pen is out.
  const writing = draft !== null && !draft.offer;
  useEffect(() => {
    if (writing) return;
    const update = () => {
      const root = content.current;
      const box = surface.current?.getBoundingClientRect();
      const selection = window.getSelection();
      if (!root || !box || !selection || selection.isCollapsed || !selection.rangeCount)
        return setDraft((current) => (current?.offer ? null : current));
      const range = selection.getRangeAt(0);
      const anchor = anchorForRange(root, range);
      if (!anchor) return setDraft((current) => (current?.offer ? null : current));
      const end = range.getBoundingClientRect();
      setDraft({ anchor, left: end.right - box.left, top: end.bottom - box.top, offer: true });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [writing]);

  useEscape(commenting && !writing, onDone);
  const focus = useFocus((n) => {
    const pin = pins.find((item) => item.n === n);
    const root = content.current;
    const place = pin && root ? placeOf(root, pin.anchor) : null;
    place?.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  const press = (event: MouseEvent) => {
    if (!commenting || writing) return;
    const root = content.current;
    const box = surface.current?.getBoundingClientRect();
    if (!root || !box || !window.getSelection()?.isCollapsed) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = anchorAt(root, event.clientX, event.clientY);
    if (anchor)
      setDraft({
        anchor,
        left: event.clientX - box.left,
        top: event.clientY - box.top,
        offer: false
      });
  };

  return (
    <div
      ref={surface}
      className={`comment-surface${commenting ? ' is-commenting' : ''} ${className}`}
    >
      <div ref={content} className="comment-content" onClickCapture={press}>
        {children}
      </div>
      {placed.map((pin) => (
        <b
          key={pin.n}
          className={`comment-pin${pin.n === focus ? ' is-focus' : ''}`}
          style={{ left: pin.left, top: pin.top }}
          title={pin.text || 'Look at this'}
        >
          {pin.n}
        </b>
      ))}
      {draft && (
        <DraftComment
          draft={draft}
          n={notes.length + 1}
          width={surface.current?.clientWidth ?? 320}
          onTake={() => setDraft({ ...draft, offer: false })}
          onCancel={() => setDraft(null)}
          onSave={(note) => {
            onNote({ on, anchor: draft.anchor, note });
            setDraft(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}

const themeInk = () => {
  const style = getComputedStyle(document.documentElement);
  return {
    ink: style.getPropertyValue('--text').trim(),
    paper: style.getPropertyValue('--bg').trim()
  };
};

/**
 * A frame — a drawn view or a live app — taking comments. The page inside runs the same anchoring
 * code and draws the pins itself, so they scroll with it. An app the bridge never reached takes
 * comments as places on the frame instead, which say less but still say where.
 */
export function FrameComments({
  frame,
  className = '',
  ...props
}: Omit<Props, 'children'> & {
  frame: RefObject<HTMLIFrameElement | null>;
  children: ReactNode;
}) {
  const { on, notes = [], onNote, commenting = false, onDone, children } = props;
  const surface = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const pins = pinsFor(notes, on);
  const signature = JSON.stringify(pins);
  const writing = draft !== null && !draft.offer;
  const focus = useFocus(() => undefined);
  const latest = useRef({ onDone });
  latest.current = { onDone };

  const offset = useCallback(() => {
    const host = surface.current?.getBoundingClientRect();
    const box = frame.current?.getBoundingClientRect();
    return host && box ? { left: box.left - host.left, top: box.top - host.top } : null;
  }, [frame]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (data.garden !== 1) return;
      if (data.type === 'ready') setReady((value) => value + 1);
      if (data.type === 'escape') latest.current.onDone?.();
      if (data.type === 'unselect') setDraft((current) => (current?.offer ? null : current));
      if (data.type !== 'point' && data.type !== 'select') return;
      const anchor = cleanAnchor(data.anchor);
      const { x, y } = (data.at ?? {}) as { x?: unknown; y?: unknown };
      const shift = offset();
      if (!anchor || !shift || typeof x !== 'number' || typeof y !== 'number') return;
      const offer = data.type === 'select';
      setDraft((current) =>
        current && !current.offer
          ? current
          : { anchor, left: shift.left + x, top: shift.top + y, offer }
      );
    };
    window.addEventListener('message', receive);
    // The page inside may have said it was ready before this listened; ask, now and on each load.
    const hello = () =>
      frame.current?.contentWindow?.postMessage({ garden: 1, type: 'hello' }, '*');
    const host = surface.current;
    host?.addEventListener('load', hello, true);
    hello();
    return () => {
      window.removeEventListener('message', receive);
      host?.removeEventListener('load', hello, true);
    };
  }, [frame, offset]);

  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage(
      {
        garden: 1,
        type: 'comments',
        commenting: commenting && !writing,
        pins: JSON.parse(signature) as Pin[],
        focus,
        ...themeInk()
      },
      '*'
    );
  }, [frame, ready, commenting, writing, signature, focus]);

  useEscape(commenting && !writing, onDone);

  // Without the bridge, a place on the frame is all that can be said, and all that can be drawn.
  const places = ready ? [] : pins.filter((pin) => pin.anchor.kind === 'spot');
  return (
    <div
      ref={surface}
      className={`comment-surface comment-frame${commenting ? ' is-commenting' : ''} ${className}`}
    >
      {children}
      {commenting && !ready && !writing && (
        <button
          type="button"
          className="comment-catch"
          aria-label="Place a comment here"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const host = surface.current!.getBoundingClientRect();
            setDraft({
              anchor: {
                kind: 'spot',
                x: Math.round(((event.clientX - box.left) / box.width) * 1000) / 1000,
                y: Math.round(((event.clientY - box.top) / box.height) * 1000) / 1000
              },
              left: event.clientX - host.left,
              top: event.clientY - host.top,
              offer: false
            });
          }}
        />
      )}
      {places.map((pin) =>
        pin.anchor.kind === 'spot' ? (
          <b
            key={pin.n}
            className={`comment-pin${pin.n === focus ? ' is-focus' : ''}`}
            style={{ left: `${pin.anchor.x * 100}%`, top: `${pin.anchor.y * 100}%` }}
            title={pin.text || 'Look at this'}
          >
            {pin.n}
          </b>
        ) : null
      )}
      {draft && (
        <DraftComment
          draft={draft}
          n={notes.length + 1}
          width={surface.current?.clientWidth ?? 320}
          onTake={() => setDraft({ ...draft, offer: false })}
          onCancel={() => setDraft(null)}
          onSave={(note) => {
            onNote({ on, anchor: draft.anchor, note });
            setDraft(null);
            frame.current?.contentWindow?.postMessage({ garden: 1, type: 'unselect' }, '*');
          }}
        />
      )}
    </div>
  );
}
