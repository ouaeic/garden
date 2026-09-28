import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Copy, RefreshCw } from 'lucide-react';
import type {
  Artifact,
  CreateShareResponse,
  CreateShareRequest,
  ShareRecord,
  SharePreviewResponse,
  Task
} from '@garden/contracts';
import { ApiError, del, get, post } from './client';
import { stepUp } from './auth';
import { date } from './model';
import { Button, ErrorNotice, Field, Spinner } from './ui';
import {
  captureShareOptions,
  shareCreationOperation,
  shareOptionsSignature,
  type ReviewedShare
} from './sharing-operations';
const Markdown = lazy(() => import('./MarkdownBody'));
export default function Sharing({
  task,
  artifacts,
  onChange
}: {
  task: Task;
  artifacts: Artifact[];
  onChange: () => void;
}) {
  const [records, setRecords] = useState<ShareRecord[]>([]);
  const [title, setTitle] = useState(task.title);
  const [days, setDays] = useState('30');
  const [reasoning, setReasoning] = useState(false);
  const [toolResults, setToolResults] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<ReviewedShare | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);
  const creation = useRef(shareCreationOperation());
  async function refresh() {
    setRecords(await get<ShareRecord[]>(`/v1/tasks/${task.id}/shares`));
  }
  useEffect(() => {
    const controller = new AbortController();
    void get<ShareRecord[]>(`/v1/tasks/${task.id}/shares`, { signal: controller.signal })
      .then(setRecords)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [task.id]);
  const options: CreateShareRequest = {
    expiresInDays: days === 'never' ? null : (Number(days) as 1 | 7 | 30),
    includeReasoning: reasoning,
    includeToolResults: toolResults,
    artifactIds: selected,
    publicTitle: title
  };
  const signature = shareOptionsSignature(options);
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  const preview = review?.signature === signature ? review.snapshot : null;
  useEffect(() => {
    setReview(null);
  }, [signature]);
  async function inspect() {
    if (active.current) return;
    active.current = true;
    const requestGeneration = ++generation.current;
    const captured = captureShareOptions(options);
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      const snapshot = await post<SharePreviewResponse>(
        `/v1/tasks/${task.id}/shares/preview`,
        captured
      );
      if (requestGeneration === generation.current && currentSignature.current === signature)
        setReview({ snapshot, options: captured, signature });
    } catch (err) {
      setError(err);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function create(previous?: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      const operation = creation.current.prepare(review, options, previous);
      await stepUp();
      const result = await post<CreateShareResponse>(
        previous ? `/v1/shares/${previous}/refresh` : `/v1/tasks/${task.id}/shares`,
        operation.body,
        { idempotencyKey: operation.idempotencyKey, retry: 1 }
      );
      creation.current.complete();
      setReview(null);
      setUrl(new URL(result.url, location.origin).href);
      setCopied(false);
      await refresh();
      onChange();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'preview_changed') setReview(null);
      setError(err);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await del(`/v1/shares/${id}`);
      await refresh();
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <p className="muted">
        A snapshot opens with its private key in the link. Anyone with the complete link can read
        the selected content. Future work stays separate.
      </p>
      <div className="row">
        <Field label="Snapshot title">
          <input
            disabled={busy}
            value={title}
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Link expires">
          <select disabled={busy} value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="1">After one day</option>
            <option value="7">After one week</option>
            <option value="30">After 30 days</option>
            <option value="never">No expiry</option>
          </select>
        </Field>
      </div>
      <details className="settings-disclosure">
        <summary>Advanced inclusions</summary>{' '}
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={reasoning}
            onChange={(event) => setReasoning(event.target.checked)}
          />
          Include model reasoning
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={busy}
            checked={toolResults}
            onChange={(event) => setToolResults(event.target.checked)}
          />
          Include raw tool results
        </label>
      </details>{' '}
      {artifacts.length > 0 && (
        <fieldset disabled={busy}>
          <legend>Files to include</legend>
          {artifacts.map((artifact) => (
            <label key={artifact.id} className="check">
              <input
                type="checkbox"
                checked={selected.includes(artifact.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, artifact.id]
                      : current.filter((id) => id !== artifact.id)
                  )
                }
              />
              {artifact.name} · version {artifact.version}
            </label>
          ))}
        </fieldset>
      )}
      <Button busy={busy} disabled={!title.trim()} onClick={inspect}>
        Review the snapshot
        <ArrowUpRight size={16} />
      </Button>
      {preview && (
        <section className="panel stack">
          <h3>{preview.title}</h3>
          <p className="muted">These are the messages and files that will be included.</p>
          <details open>
            <summary>Read included content</summary>
            {preview.events.map((event, index) => (
              <article key={index}>
                <small>
                  {event.kind.replaceAll('_', ' ')} · {date(event.at)}
                </small>
                <Suspense fallback={<Spinner />}>
                  <Markdown>{event.text}</Markdown>
                </Suspense>
              </article>
            ))}
          </details>
          {preview.artifacts.map((artifact) => (
            <p key={artifact.n}>{artifact.name}</p>
          ))}
          <Button className="primary" busy={busy} onClick={() => create()}>
            Create this share link
          </Button>
        </section>
      )}
      {url && (
        <section className="panel stack">
          <h3>Your link is ready.</h3>
          <p className="muted">Copy it now. Its key is shown only here.</p>
          <input aria-label="New share link" readOnly value={url} />
          <div className="row">
            <Button
              className="primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                } catch (err) {
                  setError(err);
                }
              }}
            >
              <Copy size={15} />
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <a className="button" href={url} target="_blank" rel="noopener noreferrer">
              Open snapshot
              <ArrowUpRight size={15} />
            </a>
          </div>
        </section>
      )}
      <ErrorNotice error={error} />
      {records.length > 0 && (
        <section>
          <h3>Existing links</h3>
          <div className="stack">
            {records.map((record) => (
              <article key={record.id} className="panel">
                <div className="row between">
                  <div>
                    Snapshot v{record.version}
                    <small className="muted"> · {date(record.createdAt)}</small>
                  </div>
                  <span className="badge">
                    {record.revokedAt
                      ? 'Revoked'
                      : record.expiresAt && Date.parse(record.expiresAt) < Date.now()
                        ? 'Expired'
                        : 'Active'}
                  </span>
                </div>
                <p className="muted">
                  {record.viewCount} views
                  {record.expiresAt ? ` · Expires ${date(record.expiresAt)}` : ' · No expiry'}
                </p>
                {!record.revokedAt && (
                  <div className="row">
                    <Button disabled={busy} onClick={() => revoke(record.id)}>
                      Revoke link
                    </Button>
                    <Button disabled={busy || !preview} onClick={() => create(record.id)}>
                      <RefreshCw size={14} />
                      Replace with reviewed snapshot
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
