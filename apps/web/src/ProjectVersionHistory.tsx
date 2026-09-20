import { useCallback, useEffect, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import type { PinnedProjectVersions, ProjectRevision } from '@athanor/contracts';
import { get, put } from './client';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import ProjectStorage from './ProjectStorage';

export default function ProjectVersionHistory({
  projectId,
  revisions,
  nextCursor,
  loading,
  onEarlier,
  onInspect,
  onChanged
}: {
  projectId: string;
  revisions: ProjectRevision[];
  nextCursor: string | null;
  loading: boolean;
  onEarlier: () => void;
  onInspect: (updateId: string) => void;
  onChanged: (revision: ProjectRevision) => void;
}) {
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [page, setPage] = useState<PinnedProjectVersions | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<ProjectRevision | null>(null);
  const [label, setLabel] = useState('');
  const request = useRef<AbortController | null>(null);
  const endpoint = `/v1/projects/${projectId}/pinned-versions`;
  const readPins = useCallback(
    async (before?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setReading(true);
      setError(null);
      try {
        const result = await get<PinnedProjectVersions>(
          endpoint + (before ? '?' + new URLSearchParams({ before }).toString() : ''),
          { signal: controller.signal }
        );
        if (controller.signal.aborted) return;
        setPage((previous) =>
          before && previous
            ? {
                ...result,
                revisions: [
                  ...previous.revisions,
                  ...result.revisions.filter(
                    (revision) => !previous.revisions.some((item) => item.id === revision.id)
                  )
                ]
              }
            : result
        );
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause);
      } finally {
        if (!controller.signal.aborted) setReading(false);
      }
    },
    [endpoint]
  );
  useEffect(() => {
    if (pinnedOnly) void readPins();
    return () => request.current?.abort();
  }, [pinnedOnly, readPins]);
  const save = async (revision: ProjectRevision, value: string | null) => {
    request.current?.abort();
    setReading(false);
    setBusy(revision.id);
    setError(null);
    try {
      const updated = await put<ProjectRevision>(
        `/v1/projects/${projectId}/versions/${revision.id}/pin`,
        { label: value }
      );
      onChanged(updated);
      setPage((previous) =>
        previous
          ? {
              ...previous,
              revisions: previous.revisions.flatMap((item) =>
                item.id !== updated.id ? [item] : updated.pin ? [updated] : []
              )
            }
          : previous
      );
      setEditing(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };
  const rows = pinnedOnly ? (page?.revisions ?? []) : revisions;
  return (
    <section className="project-version-history" aria-label="Published version history">
      <div className="row" role="group" aria-label="Version filter">
        <Button
          aria-pressed={!pinnedOnly}
          disabled={Boolean(busy)}
          onClick={() => setPinnedOnly(false)}
        >
          All versions
        </Button>
        <Button
          aria-pressed={pinnedOnly}
          disabled={Boolean(busy)}
          onClick={() => setPinnedOnly(true)}
        >
          Pinned versions
        </Button>
        {pinnedOnly && (
          <Button disabled={reading || Boolean(busy)} onClick={() => void readPins()}>
            Refresh pins
          </Button>
        )}
      </div>
      <p className="muted">
        Pin important versions to keep them easy to find. Unpinning keeps their files and history.
      </p>
      <ErrorNotice error={!editing ? error : null} />
      <ProjectStorage key={projectId} projectId={projectId} />
      {pinnedOnly && !reading && page && !rows.length && (
        <p className="muted">No pinned versions yet.</p>
      )}
      <ol className="project-version-history-list">
        {rows.map((revision) => (
          <li key={revision.id}>
            <div className="project-version-history-title">
              <Button onClick={() => onInspect(revision.updateId)}>
                Version {revision.number} · {revision.title}
              </Button>
              <small>{new Date(revision.createdAt).toLocaleString()}</small>
              {revision.pin && (
                <small className="project-version-pin-label">
                  <Pin size={12} aria-hidden="true" /> {revision.pin.label || 'Pinned'}
                </small>
              )}
            </div>
            <div className="row project-version-pin-actions">
              <Button
                aria-label={`${revision.pin ? 'Unpin' : 'Pin'} version ${revision.number}`}
                aria-pressed={Boolean(revision.pin)}
                disabled={Boolean(busy)}
                busy={busy === revision.id}
                onClick={() => void save(revision, revision.pin ? null : '')}
              >
                <Pin size={14} aria-hidden="true" /> {revision.pin ? 'Unpin' : 'Pin'}
              </Button>
              {revision.pin && (
                <Button
                  disabled={Boolean(busy)}
                  aria-label={`Label pinned version ${revision.number}`}
                  onClick={() => {
                    setError(null);
                    setLabel(revision.pin?.label ?? '');
                    setEditing(revision);
                  }}
                >
                  Label
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {pinnedOnly && reading && <Spinner label="Reading pinned versions…" />}
      {(pinnedOnly ? page?.nextCursor : nextCursor) && (
        <Button
          disabled={reading || loading || Boolean(busy)}
          onClick={() => (pinnedOnly ? void readPins(page!.nextCursor!) : onEarlier())}
        >
          Load earlier {pinnedOnly ? 'pinned ' : ''}versions
        </Button>
      )}
      {editing && (
        <Dialog title={`Label version ${editing.number}`} onClose={() => setEditing(null)}>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save(editing, label);
            }}
          >
            <Field label="Label (optional)" hint="A short name to recognize this saved version.">
              <input
                value={label}
                maxLength={120}
                disabled={Boolean(busy)}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <ErrorNotice error={error} />
            <Button type="submit" busy={Boolean(busy)} className="primary">
              Save label
            </Button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
