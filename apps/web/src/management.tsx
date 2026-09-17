import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, get, responseError } from './client.js';
import { stepUp } from './auth.js';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui.js';
import { requireDownloadSupport } from './download-support.js';

export function useResource<T>(path: string | null) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError(null);
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void get<T>(path, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setValue(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { value, loading, error, refresh, setValue };
}

export function useAction(onChange?: () => void) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  const run = async (work: () => Promise<unknown>, success = 'Saved') => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await work();
      setMessage(success);
      onChange?.();
      return true;
    } catch (error) {
      setError(error);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const reset = () => {
    if (lock.current) return;
    setError(null);
    setMessage('');
  };
  return { busy, error, message, run, reset };
}

export function ActionFeedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      <ErrorNotice error={action.error} />
      {action.message && (
        <p className="management-feedback" role="status">
          {action.message}
        </p>
      )}
    </>
  );
}

export function ResourceState({
  resource
}: {
  resource: { loading: boolean; error: unknown; refresh: () => void };
}) {
  return (
    <>
      {resource.loading && <Spinner />}
      <ErrorNotice error={resource.error} onRetry={resource.refresh} />
    </>
  );
}

export function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel management-section">
      <header className="section-heading">
        <h3>{title}</h3>
        {description && <p className="muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function ConfirmButton({
  label,
  title = label,
  description,
  confirmText,
  action,
  disabled
}: {
  label: string;
  title?: string;
  description: string;
  confirmText?: string;
  action: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const operation = useAction();
  return (
    <>
      <Button
        disabled={disabled}
        className="danger-quiet"
        onClick={() => {
          setAnswer('');
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <Dialog
          title={title}
          onClose={() => {
            if (!operation.busy) setOpen(false);
          }}
        >
          <div className="stack">
            <p>{description}</p>
            {confirmText && (
              <Field label={`Type ${confirmText} to continue`}>
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            )}
            <ActionFeedback action={operation} />
            <div className="row">
              <Button disabled={operation.busy} onClick={() => setOpen(false)}>
                Keep it
              </Button>
              <Button
                className="primary"
                busy={operation.busy}
                disabled={Boolean(confirmText && answer !== confirmText)}
                onClick={() =>
                  void operation.run(action).then((ok) => {
                    if (ok) setOpen(false);
                  })
                }
              >
                {label}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

export async function sensitive<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'step_up_required') throw error;
    await stepUp();
    return work();
  }
}

export async function download(path: string, filename: string, needsStepUp = false): Promise<void> {
  await requireDownloadSupport();
  if (needsStepUp) await stepUp();
  const response = await fetch(path, { credentials: 'include' });
  if (!response.ok) throw await responseError(response);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function SecretResult({
  label,
  value,
  link
}: {
  label: string;
  value: string;
  link?: boolean;
}) {
  const operation = useAction();
  return (
    <div className="secret-result stack">
      <Field label={label}>
        <textarea readOnly value={value} rows={3} spellCheck={false} />
      </Field>
      <div className="row">
        <Button
          onClick={() => void operation.run(() => navigator.clipboard.writeText(value), 'Copied')}
        >
          Copy
        </Button>
        {link && (
          <a className="button" href={value} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
      </div>
      <ActionFeedback action={operation} />
    </div>
  );
}

export const numberOrNull = (value: FormDataEntryValue | null): number | null => {
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'string') throw new Error('Enter a finite number.');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Enter a finite number, or leave the field empty.');
  return number;
};
export const rawFieldValue = (form: FormData, name: string): string => {
  const value = form.get(name);
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error('This field must contain text.');
  return value;
};
export const fieldValue = (form: FormData, name: string): string =>
  rawFieldValue(form, name).trim();
