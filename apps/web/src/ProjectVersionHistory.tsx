import { useCallback, useEffect, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import type { PinnedProjectVersions, ProjectRevision } from '@garden/contracts';
import { get, post, put } from './client';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import ProjectStorage from './ProjectStorage';
import ProjectCleanup, { PendingCleanup, type CleanupRequest } from './ProjectCleanup';
import ProjectVersionArchive from './ProjectVersionArchive';

export default function ProjectVersionHistory({
  projectId,
  headId,
  revisions,
  nextCursor,
  loading,
  onEarlier,
  onInspect,
  onChanged
}: {
  projectId: string;
  headId: string | null;
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
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [archivePreview, setArchivePreview] = useState<string[] | null>(null);
  const [cleanup, setCleanup] = useState<CleanupRequest | null>(null);
  const [cleanupGeneration, setCleanupGeneration] = useState(0);
  const [cleanupMode, setCleanupMode] = useState(false);
  const [notice, setNotice] = useState('');
  const archiveTrigger = useRef<HTMLButtonElement>(null);
  const versionButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterChange = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (focusAfterChange.current?.isConnected && !busy && !archivePreview && !cleanup) {
      focusAfterChange.current.focus();
      focusAfterChange.current = null;
    }
  }, [busy, archivePreview, cleanup]);
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
  const restore = async (revision: ProjectRevision) => {
    if (!revision.archive) return;
    setBusy(revision.id);
    setError(null);
    setNotice('');
    try {
      const result = await post<{ revision: ProjectRevision }>(
        `/v1/projects/${projectId}/retention/restore`,
        {
          revisionId: revision.id,
          requestId: revision.archive.requestId
        }
      );
      focusAfterChange.current = versionButtons.current.get(revision.id) ?? null;
      onChanged(result.revision);
      setNotice(`Version ${revision.number} restored.`);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="project-version-history" aria-label="Published version history">
      <div className="row" role="group" aria-label="Version filter">
        <Button
          aria-pressed={!pinnedOnly}
          disabled={Boolean(busy) || selecting}
          onClick={() => setPinnedOnly(false)}
        >
          All versions
        </Button>
        <Button
          aria-pressed={pinnedOnly}
          disabled={Boolean(busy) || selecting}
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
      <PendingCleanup projectId={projectId} generation={cleanupGeneration} onOpen={setCleanup} />
      <p role="status" className="muted">
        {notice}
      </p>
      {!pinnedOnly && (
        <div className="row">
          <Button
            ref={archiveTrigger}
            disabled={Boolean(busy)}
            aria-pressed={selecting}
            onClick={() => {
              setCleanupMode(false);
              setSelecting((value) => cleanupMode || !value);
              setSelected(new Set());
            }}
          >
            {selecting && !cleanupMode ? 'Done selecting' : 'Archive versions…'}
          </Button>
          <Button
            disabled={Boolean(busy)}
            aria-pressed={selecting && cleanupMode}
            onClick={() => {
              setCleanupMode(true);
              setSelecting((value) => !cleanupMode || !value);
              setSelected(new Set());
            }}
          >
            {selecting && cleanupMode ? 'Done selecting' : 'Free storage…'}
          </Button>
          {selecting && (
            <Button
              className="primary"
              disabled={!selected.size || Boolean(busy)}
              onClick={() =>
                cleanupMode
                  ? setCleanup({ selection: { versions: [...selected], updates: [], checks: [] } })
                  : setArchivePreview([...selected])
              }
            >
              Review {selected.size} selected
            </Button>
          )}
        </div>
      )}
      {selecting && (
        <p className="muted">
          {cleanupMode
            ? 'Select archived versions to permanently remove their files. The preview retains anything needed elsewhere.'
            : 'Select up to 40 versions. Current and pinned versions stay available. The preview checks other references before anything moves.'}
        </p>
      )}
      {pinnedOnly && !reading && page && !rows.length && (
        <p className="muted">No pinned versions yet.</p>
      )}
      <ol className="project-version-history-list">
        {rows.map((revision) => (
          <li key={revision.id}>
            {selecting && (
              <input
                type="checkbox"
                className="project-version-select"
                aria-label={`Select version ${revision.number} to ${cleanupMode ? 'remove permanently' : 'archive'}`}
                checked={selected.has(revision.id)}
                disabled={
                  revision.id === headId ||
                  Boolean(revision.pin || revision.contentRemoval) ||
                  (cleanupMode
                    ? revision.archive?.state !== 'archived'
                    : Boolean(revision.archive)) ||
                  (!selected.has(revision.id) && selected.size >= 40)
                }
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (checked) next.add(revision.id);
                    else next.delete(revision.id);
                    return next;
                  });
                }}
              />
            )}
            <div className="project-version-history-title">
              <Button
                ref={(button) => {
                  if (button) versionButtons.current.set(revision.id, button);
                  else versionButtons.current.delete(revision.id);
                }}
                onClick={() => onInspect(revision.updateId)}
              >
                Version {revision.number} · {revision.title}
              </Button>
              <small>{new Date(revision.createdAt).toLocaleString()}</small>
              {revision.archive && !revision.contentRemoval && (
                <small>
                  {revision.archive.state === 'archived'
                    ? 'Archived · files can be restored'
                    : 'Archive operation needs recovery'}
                </small>
              )}
              {revision.contentRemoval && (
                <small>
                  {revision.contentRemoval.state === 'removed'
                    ? 'Files permanently removed · history retained'
                    : 'Saved cleanup is incomplete'}
                </small>
              )}
              {revision.pin && (
                <small className="project-version-pin-label">
                  <Pin size={12} aria-hidden="true" /> {revision.pin.label || 'Pinned'}
                </small>
              )}
            </div>
            <div className="row project-version-pin-actions">
              {revision.archive && !revision.contentRemoval && (
                <Button
                  disabled={Boolean(busy)}
                  busy={busy === revision.id}
                  aria-label={`Restore version ${revision.number}`}
                  onClick={() => void restore(revision)}
                >
                  Restore files
                </Button>
              )}
              {revision.contentRemoval?.state === 'removing' && (
                <Button
                  onClick={() =>
                    setCleanup({
                      selection: { versions: [revision.id], updates: [], checks: [] },
                      requestId: revision.contentRemoval!.requestId
                    })
                  }
                >
                  View cleanup
                </Button>
              )}
              <Button
                aria-label={`${revision.pin ? 'Unpin' : 'Pin'} version ${revision.number}`}
                aria-pressed={Boolean(revision.pin)}
                disabled={Boolean(busy) || Boolean(revision.archive || revision.contentRemoval)}
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
      {cleanup && (
        <ProjectCleanup
          projectId={projectId}
          request={cleanup}
          onChanged={(values) => {
            for (const revision of values) onChanged(revision);
            setNotice('Selected files permanently removed. History and check receipts remain.');
          }}
          onClose={() => {
            focusAfterChange.current = archiveTrigger.current;
            setCleanup(null);
            setSelected(new Set());
            setSelecting(false);
            setCleanupGeneration((value) => value + 1);
          }}
        />
      )}
      {archivePreview && (
        <ProjectVersionArchive
          projectId={projectId}
          versions={archivePreview}
          onChanged={(revision) => {
            onChanged(revision);
            setNotice('Selected versions archived. Their files remain recoverable.');
          }}
          onClose={() => {
            focusAfterChange.current = archiveTrigger.current;
            setArchivePreview(null);
            setSelected(new Set());
            setSelecting(false);
          }}
        />
      )}
    </section>
  );
}
