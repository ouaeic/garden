import { cloneElement, useEffect, useId, useRef } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { X, LoaderCircle } from './icons';

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
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  className = '',
  dismissOnBackdrop = false,
  open = true,
  modal = true
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
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const dialog = ref.current;
    if (modal) dialog?.showModal();
    else dialog?.show();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, modal]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !dismissOnBackdrop) return;
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
  }, [dismissOnBackdrop, onClose]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`dialog ${wide ? 'wide' : ''} ${className}`}
      onKeyDown={
        modal
          ? undefined
          : (event) => {
              if (event.key !== 'Escape' || event.defaultPrevented) return;
              event.preventDefault();
              onClose();
            }
      }
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <Button aria-label={`Close ${title}`} onClick={onClose}>
          <X size={18} />
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
