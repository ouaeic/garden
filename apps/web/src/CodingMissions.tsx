import { lazy, Suspense, useEffect, useState } from 'react';
import type { CodingMission, CodingMissionReview } from '@garden/contracts';
import { get, post } from './client';
import { Button, Dialog, ErrorNotice } from './ui';
import { bytes, money } from './model';
const SourceInspector = lazy(() => import('./computer/SourceInspector'));

const labels: Record<CodingMission['state'], string> = {
  preparing: 'Preparing workspace',
  queued: 'Queued',
  running: 'Working',
  awaiting_approval: 'Needs approval',
  paused: 'Paused',
  ready: 'Ready to review',
  failed: 'Needs recovery',
  cancelled: 'Cancelled',
  conflicted: 'Conflicting changes',
  integrating: 'Applying reviewed changes',
  integrated: 'Changes applied'
};

export function MissionReviewChanges({
  review,
  onInspect,
  editing = false
}: {
  review: CodingMissionReview;
  onInspect?: (path: string) => void;
  editing?: boolean;
}) {
  return (
    <div className="garden-mission-changes stack">
      <p>{review.detail}</p>
      {review.changes.map((change) => (
        <details key={change.path}>
          <summary>
            <code>{change.path}</code> · {change.kind}
            {change.conflict ? ' · conflict' : ''}
            {!change.permitted ? ' · outside allowed paths' : ''}
          </summary>
          <p className="muted">
            {bytes(change.bytes)}
            {change.binary ? ' · binary file' : ''}
            {change.diffOmitted ? ' · full diff exceeds the preview limit' : ''}
          </p>
          {change.diff && <pre className="garden-mission-diff">{change.diff}</pre>}
          {change.kind !== 'deleted' && (
            <div className="row">
              {onInspect && (
                <Button disabled={editing} onClick={() => onInspect(change.path)}>
                  Inspect proposed file
                </Button>
              )}
              <a
                download={change.path.split('/').at(-1)}
                href={`/v1/workspaces/${review.mission.workspaceId}/download?path=${encodeURIComponent(change.path)}`}
              >
                Download proposed file
              </a>
            </div>
          )}
        </details>
      ))}
      {!review.changes.length && <p className="muted">No changed files were reported.</p>}
    </div>
  );
}

export default function CodingMissions({
  taskId,
  onOpenTask,
  onChange
}: {
  taskId: string;
  onOpenTask: (id: string) => void;
  onChange: () => void;
}) {
  const [missions, setMissions] = useState<CodingMission[]>([]);
  const [review, setReview] = useState<CodingMissionReview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const [reviewStale, setReviewStale] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await get<{ missions: CodingMission[] }>(
          `/v1/tasks/${taskId}/coding-missions`,
          { signal: controller.signal }
        );
        if (!controller.signal.aborted) {
          setMissions(result.missions);
          setLoadError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause);
      }
      if (!controller.signal.aborted)
        timer = setTimeout(
          () => void load(),
          document.visibilityState === 'visible' ? 10000 : 30000
        );
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskId, revision]);
  async function action(id: string, operation: 'review' | 'cancel' | 'integrate') {
    setBusy(id);
    setError(null);
    try {
      if (operation === 'review') {
        setReview(await post<CodingMissionReview>(`/v1/coding-missions/${id}/review`, {}));
        setReviewStale(false);
      } else {
        await post(
          `/v1/coding-missions/${id}/${operation}`,
          operation === 'integrate' && review
            ? { digest: review.digest, generation: review.mission.generation }
            : {}
        );
        setReview(null);
        setSource(null);
        setRevision((value) => value + 1);
        onChange();
      }
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }
  function closeReview() {
    if (sourceSaving) return;
    if (sourceDirty) {
      setError(new Error('Save or discard the file edits before closing this review.'));
      return;
    }
    setReview(null);
    setSource(null);
  }
  if (!missions.length && !error && !loadError) return null;
  return (
    <section className="garden-missions" aria-label="Coding specialists">
      <div className="eyebrow">Working together</div>
      <ErrorNotice error={error} />
      <ErrorNotice error={loadError} />
      {missions.map((mission) => (
        <article key={mission.id} className="garden-mission">
          <div className="row between">
            <strong>{mission.name}</strong>
            <span className="badge">{labels[mission.state]}</span>
          </div>
          <p className="muted">
            {mission.changedFiles !== null ? `${mission.changedFiles} changed files · ` : ''}
            {mission.usedCredits.toLocaleString()} of {mission.allocatedCredits.toLocaleString()}{' '}
            allocated credits
            {mission.reservedCredits > 0
              ? ` · ${mission.reservedCredits.toLocaleString()} reserved for pending calls`
              : ''}
          </p>
          {typeof mission.spentUsd === 'number' && (
            <p className="muted">
              {money(mission.spentUsd)} used from the parent budget
              {typeof mission.reservedUsd === 'number' && mission.reservedUsd > 0
                ? ` · ${money(mission.reservedUsd)} reserved`
                : ''}
            </p>
          )}
          {mission.detail && <p>{mission.detail}</p>}
          <details>
            <summary>Allowed output paths</summary>
            <ul>
              {mission.outputPaths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </details>
          <div className="row">
            <Button onClick={() => onOpenTask(mission.taskId)}>
              {mission.pendingApprovals > 0
                ? `Review ${mission.pendingApprovals} ${mission.pendingApprovals === 1 ? 'approval' : 'approvals'}`
                : 'Open work'}
            </Button>
            {['ready', 'conflicted'].includes(mission.state) && (
              <Button busy={busy === mission.id} onClick={() => void action(mission.id, 'review')}>
                Review changes
              </Button>
            )}
            {!['cancelled', 'integrated', 'integrating'].includes(mission.state) && (
              <Button busy={busy === mission.id} onClick={() => void action(mission.id, 'cancel')}>
                Stop work
              </Button>
            )}
          </div>
        </article>
      ))}
      {review && (
        <Dialog title={`Review ${review.mission.name}`} wide onClose={closeReview}>
          <ErrorNotice error={error} />
          <MissionReviewChanges
            review={review}
            onInspect={setSource}
            editing={sourceDirty || sourceSaving || busy !== null}
          />
          {source && (
            <Suspense fallback={<p role="status">Opening proposed source…</p>}>
              <SourceInspector
                key={`${review.mission.workspaceId}:${source}`}
                workspaceId={review.mission.workspaceId}
                path={source}
                expectedHash={review.changes.find((change) => change.path === source)?.resultHash}
                onDirtyChange={(dirty) => {
                  setSourceDirty(dirty);
                  if (dirty) setReviewStale(true);
                }}
                onSavingChange={setSourceSaving}
                onSaved={async () => {
                  setReviewStale(true);
                  try {
                    const next = await post<CodingMissionReview>(
                      `/v1/coding-missions/${review.mission.id}/review`,
                      {}
                    );
                    setReview(next);
                    setReviewStale(false);
                  } catch (cause) {
                    setError(cause);
                  }
                  onChange();
                }}
              />
            </Suspense>
          )}
          {reviewStale && (
            <p role="status">
              Refresh the review after saving or discarding edits before applying changes.
            </p>
          )}
          <div className="row">
            <Button disabled={sourceSaving} onClick={closeReview}>
              Close review
            </Button>
            {reviewStale && (
              <Button
                disabled={sourceDirty || sourceSaving}
                busy={busy === review.mission.id}
                onClick={() => void action(review.mission.id, 'review')}
              >
                Refresh review
              </Button>
            )}
            <Button
              busy={busy === review.mission.id}
              disabled={!review.canIntegrate || sourceDirty || sourceSaving || reviewStale}
              onClick={() => void action(review.mission.id, 'integrate')}
            >
              Apply reviewed changes
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
