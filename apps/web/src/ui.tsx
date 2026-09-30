import { cloneElement, useEffect, useId, useRef } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { ArrowLeft, X, LoaderCircle } from './icons';

export function Button({
  children,
  className = '',
  busy,
  ...props
}: ComponentProps<'button'> & { busy?: boolean }) {
  return (
    <button
      type="button"
      className={`button ${className}`}
      {...props}
      disabled={props.disabled || busy}
      onClick={(event) => {
        // WebKit leaves pointer-activated buttons unfocused, which loses dialog return focus.
        event.currentTarget.focus({ preventScroll: true });
        props.onClick?.(event);
      }}
    >
      {busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
      {children}
    </button>
  );
}
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} aria-hidden="true" />
      {label}
    </div>
  );
}
export function ErrorNotice({
  error,
  onRetry,
  context
}: {
  error: unknown;
  onRetry?: () => void;
  context?: string;
}) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <span>
        {context && <strong>{context} </strong>}
        {error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'This action could not be completed.'}
      </span>
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}
export function Field({
  label,
  children,
  hint
}: {
  label: string;
  children: ReactElement<{ id?: string | undefined; 'aria-describedby'?: string | undefined }>;
  hint?: string;
}) {
  const generatedId = useId();
  const controlId = children.props.id ?? generatedId;
  const hintId = `${generatedId}-hint`;
  const describedBy = [children.props['aria-describedby'], hint ? hintId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={controlId}>{label}</label>
      {cloneElement(children, { id: controlId, 'aria-describedby': describedBy || undefined })}
      {hint && (
        <small id={hintId} className="muted">
          {hint}
        </small>
      )}
    </div>
  );
}
// Responsive navigation can leave and re-enter the browser's top layer while child workflows
// stay open. Preserve their opening order when a parent changes between a page and a modal.
const openDialogs = new Map<HTMLDialogElement, number>();
let dialogSequence = 0;
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  className = '',
  dismissOnBackdrop = false,
  open = true,
  modal = true,
  page = false,
  id
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  dismissOnBackdrop?: boolean;
  open?: boolean;
  /** A docked panel sits beside the work instead of blocking it. */
  modal?: boolean;
  /** Navigation occupies the content area on phones while the app's bars stay usable. */
  page?: boolean;
  id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const dialog = ref.current;
    if (!dialog) return;
    openDialogs.set(dialog, ++dialogSequence);
    return () => {
      openDialogs.delete(dialog);
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const focused = document.activeElement;
    const order = openDialogs.get(dialog) ?? 0;
    const above = [...openDialogs]
      .filter(
        ([other, sequence]) =>
          other !== dialog &&
          (sequence > order || dialog.contains(other)) &&
          other.matches(':modal')
      )
      .sort((left, right) => left[1] - right[1])
      .map(([other]) => other);
    if (modal && !page) dialog.showModal();
    else dialog.show();
    for (const other of above) {
      other.close();
      other.showModal();
    }
    if (above.length && focused instanceof HTMLElement && focused.isConnected) focused.focus();
    return () => dialog.close();
  }, [open, modal, page]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !dismissOnBackdrop || page) return;
    // The native backdrop has no DOM element; Escape and the close button share this action.
    const dismiss = (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        onClose();
    };
    dialog.addEventListener('click', dismiss);
    return () => dialog.removeEventListener('click', dismiss);
  }, [dismissOnBackdrop, onClose, page]);
  return (
    <dialog
      ref={ref}
      id={id}
      role={page ? 'region' : undefined}
      aria-labelledby={titleId}
      className={`dialog ${wide ? 'wide' : ''} ${page ? 'navigation-page' : ''} ${className}`}
      onKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('dialog') !== event.currentTarget
        )
          return;
        if (!modal || page) {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          onClose();
          return;
        }
        // Keep Tab cycling inside a modal instead of escaping to the page behind it.
        if (event.key !== 'Tab' || event.defaultPrevented) return;
        const focusable = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
          )
        ].filter((element) => element.getClientRects().length && !element.closest('[inert]'));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <Button aria-label={`${page ? 'Back from' : 'Close'} ${title}`} onClick={onClose}>
          {page ? <ArrowLeft size={18} /> : <X size={18} />}
        </Button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
