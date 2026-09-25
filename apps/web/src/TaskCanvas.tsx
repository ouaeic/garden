import ScrollRegion from './ScrollRegion';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, Download, FileText, Globe, Maximize2, X } from 'lucide-react';
import type { Artifact, TaskPresentation, TaskResult, TaskEvent } from '@athanor/contracts';
import { isNativeClient, post } from './client';
import { resultSnapshot } from './result-snapshot';
import { previewIsolated, previewUrl } from './preview-url';
import { useExpandedView } from './use-expanded-view';
import { Button, ErrorNotice, Spinner } from './ui';
import './presentation.css';
const ResultPreview = lazy(() =>
  import('./computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);

/** The clock-face time a step began, for a phase still running. */
const shortTime = (value: string): string =>
  new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function TaskOutputs({
  presentation,
  events = [],
  artifacts = [],
  onArtifact,
  onDiscuss,
  onRemember,
  autoPreview = true,
  compact = true,
  afterPreview
}: {
  presentation: TaskPresentation;
  events?: TaskEvent[];
  artifacts?: Artifact[];
  onArtifact: (id: string) => void;
  onDiscuss?: (result: TaskPresentation['results'][number]) => void;
  onRemember?: (result: TaskPresentation['results'][number]) => void;
  autoPreview?: boolean;
  compact?: boolean;
  afterPreview?: ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState<{ id: string; url: string } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<'loading' | 'loaded' | 'slow' | 'failed'>('loading');
  const grants = useRef(new Map<string, Promise<string>>());
  const {
    ref: stage,
    expanded,
    toggle: toggleExpanded,
    close: closeExpanded
  } = useExpandedView<HTMLElement>();
  const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sharedLink, setSharedLink] = useState<{
    id: string;
    url: string;
    copied: boolean;
  } | null>(null);
  const previews = presentation.results.filter((item) => item.kind === 'preview');
  const preview = previews.find((item) => item.id === selectedPreview) ?? previews[0];
  const files = presentation.results.filter((item) => item.kind !== 'preview');
  const captured = preview ? resultSnapshot(preview, events, presentation.taskId) : null;
  const featured = !preview
    ? artifacts.find((item) =>
        files.some((file) => file.artifactId === item.id && file.status === 'ready')
      )
    : undefined;
  useEffect(() => {
    grants.current.clear();
    setOpened(null);
    setDismissed(null);
  }, [presentation.taskId]);
  const previewKey = preview ? `${presentation.taskId}:${preview.id}` : null;
  const previewAccess = preview?.accessPath;
  const previewAddress = preview?.url;
  const previewStatus = preview?.status;
  const previewId = preview?.id;
  useEffect(() => {
    if (
      !autoPreview ||
      !previewKey ||
      !previewId ||
      previewStatus !== 'ready' ||
      dismissed === previewKey
    )
      return;
    let active = true;
    setOpened(null);
    setFrameState('loading');
    setError(null);
    const grantKey = `${previewKey}:${previewAccess ?? previewAddress}`;
    let grant = grants.current.get(grantKey);
    if (!grant) {
      grant = (
        previewAccess
          ? post<{ url: string }>(previewAccess, {}).then((result) => result.url)
          : Promise.resolve(previewAddress)
      ).then((url) => {
        if (!url) throw new Error('This result does not have an available preview.');
        return previewUrl(url);
      });
      grants.current.set(grantKey, grant);
    }
    void grant
      .then((url) => {
        if (active) setOpened({ id: previewId, url });
      })
      .catch((cause: unknown) => {
        grants.current.delete(grantKey);
        if (active) {
          setError(cause);
          setFrameState('failed');
        }
      });
    return () => {
      active = false;
    };
  }, [previewKey, previewId, previewAccess, previewAddress, previewStatus, dismissed, autoPreview]);
  useEffect(() => {
    if (!opened || frameState !== 'loading') return;
    const timer = setTimeout(() => setFrameState('slow'), 15_000);
    return () => clearTimeout(timer);
  }, [opened, frameState]);
  async function resultUrl(result: TaskResult) {
    const url = result.accessPath
      ? (await post<{ url: string }>(result.accessPath, {})).url
      : result.url;
    if (!url) throw new Error('This result does not have an available preview.');
    return previewUrl(url, false);
  }
  async function copyLink(result: TaskResult) {
    setBusy(result.id);
    setError(null);
    setSharedLink(null);
    try {
      const url = await resultUrl(result);
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch {
        // Clipboard permission and activation vary; the signed link remains available to select.
      }
      setSharedLink({ id: result.id, url, copied });
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }
  async function open(result: TaskResult, external = false) {
    // Open synchronously with the owner's click so privacy-token exchange is not a popup blocker.
    const nativeExternal = external && isNativeClient();
    const windowRef = external && !nativeExternal ? window.open('about:blank', '_blank') : null;
    if (windowRef) windowRef.opener = null;
    setBusy(result.id);
    setError(null);
    try {
      const url = await resultUrl(result);
      if (nativeExternal) {
        const { openPreviewBrowser } = await import('./native');
        await openPreviewBrowser(url);
      } else if (windowRef) windowRef.location.replace(previewUrl(url, false));
      else {
        setFrameState('loading');
        setOpened({ id: result.id, url: previewUrl(url) });
      }
    } catch (cause) {
      windowRef?.close();
      setError(cause);
    } finally {
      setBusy(null);
    }
  }
  const frame = opened && (
    <iframe
      title={preview?.title ?? 'Task preview'}
      src={opened.url}
      sandbox={`allow-scripts allow-forms allow-downloads allow-modals allow-pointer-lock${previewIsolated(opened.url) ? ' allow-same-origin' : ''}`}
      referrerPolicy="no-referrer"
      allow="fullscreen"
      className="garden-preview-frame"
      onLoad={() => setFrameState('loaded')}
      onError={() => setFrameState('failed')}
    />
  );
  return (
    <section className="garden-outputs" aria-label="Results and downloads">
      <ErrorNotice error={error} />
      {!presentation.results.length &&
        !presentation.delivery?.pendingJobs &&
        presentation.outputs?.some((output) => output.kind !== 'answer') && (
          <div className="garden-planned-outputs">
            {presentation.outputs
              .filter((output) => output.kind !== 'answer')
              .map((output, index) => (
                <div key={`${output.kind}-${index}`}>
                  {output.kind === 'app' ? <Globe size={22} /> : <FileText size={22} />}
                  <div>
                    <small>Planned {output.kind === 'app' ? 'app' : output.kind}</small>
                    <strong>{output.title}</strong>
                  </div>
                </div>
              ))}
          </div>
        )}
      {featured && (
        <article className="garden-output-primary">
          <header className="garden-output-header">
            <div>
              <span className="eyebrow">Made with this work</span>
              <h2>{featured.name}</h2>
            </div>
            <FileText size={22} />
          </header>
          <div className="garden-artifact-view">
            <Suspense fallback={<Spinner label="Opening your result…" />}>
              <ResultPreview artifact={featured} />
            </Suspense>
          </div>
        </article>
      )}
      {previews.length > 1 && (
        <nav className="garden-output-tabs" aria-label="Task previews">
          {previews.map((item) => (
            <Button
              key={item.id}
              aria-pressed={preview?.id === item.id}
              onClick={() => {
                setSelectedPreview(item.id);
                setOpened(null);
              }}
            >
              {item.title}
            </Button>
          ))}
        </nav>
      )}
      {preview && (
        <article
          className={`garden-output-primary ${expanded ? 'expanded' : ''}`}
          ref={stage}
          id={`preview-${preview.previewId ?? preview.id}`}
        >
          <header className="garden-output-header">
            <div>
              <span className="eyebrow">
                {preview.status === 'ready' ? 'Ready to open' : 'Preview'}
              </span>
              <h2>{preview.title}</h2>
            </div>
            <Globe size={22} />
          </header>
          {opened?.id === preview.id && preview.status === 'ready' ? (
            <div className="garden-preview-live">
              {frame}
              {frameState !== 'loaded' && (
                <div className="garden-preview-state" role="status">
                  {frameState === 'failed'
                    ? 'The embedded app could not load. Try Open app, or retry here.'
                    : frameState === 'slow'
                      ? 'The app is taking longer to load. You can open it separately or retry.'
                      : 'Loading the live app…'}
                  {(frameState === 'failed' || frameState === 'slow') && (
                    <Button onClick={() => void open(preview)}>Retry preview</Button>
                  )}
                </div>
              )}
            </div>
          ) : captured ? (
            <figure className="garden-captured-result">
              <img src={captured.src} alt={`Recorded view of ${preview.title}`} />
              <figcaption>
                Recorded view ·{' '}
                {new Date(captured.createdAt).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })}
                <span>Open for the live version</span>
              </figcaption>
            </figure>
          ) : (
            <div className="garden-preview-state" role="status">
              {preview.status !== 'ready'
                ? (preview.detail ?? 'The live app is not available right now.')
                : dismissed === previewKey
                  ? 'Embedded preview closed. Open the app or view it here when you are ready.'
                  : frameState === 'failed'
                    ? 'The app could not be opened. Use View here to retry.'
                    : 'Opening the live app…'}
            </div>
          )}
          <div className="garden-output-actions">
            {preview.status === 'ready' && (
              <>
                <Button
                  className="primary"
                  busy={busy === preview.id}
                  onClick={() => void open(preview, true)}
                >
                  Open app
                  <ArrowUpRight size={16} />
                </Button>
                <Button busy={busy === preview.id} onClick={() => void copyLink(preview)}>
                  Copy link
                </Button>
                {!opened ? (
                  <Button busy={busy === preview.id} onClick={() => void open(preview)}>
                    View here
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => void toggleExpanded().catch(setError)}>
                      <Maximize2 size={15} />
                      {expanded ? 'Exit full screen' : 'Expand'}
                    </Button>
                    <Button
                      aria-label="Close embedded preview"
                      onClick={() => {
                        void closeExpanded().catch(setError);
                        setDismissed(previewKey);
                        setOpened(null);
                      }}
                    >
                      <X size={16} />
                    </Button>
                  </>
                )}
              </>
            )}
            {files[0]?.downloadUrl && files[0].status !== 'unavailable' && (
              <a
                className="button garden-primary-download"
                href={files[0].downloadUrl}
                download={files[0].title}
              >
                <Download size={15} />
                Download {files.length === 1 ? 'source' : 'file'}
              </a>
            )}
            {preview.detail && <p className="muted">{preview.detail}</p>}
          </div>
          {sharedLink?.id === preview.id &&
            (sharedLink.copied ? (
              <p role="status">Link copied.</p>
            ) : (
              <label className="field">
                Copy this link
                <input
                  readOnly
                  value={sharedLink.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ))}
        </article>
      )}
      {afterPreview}
      {presentation.sourceBundle && presentation.results.length > 0 && (
        <div className="garden-source-bundle">
          <a className="button" href={presentation.sourceBundle.downloadUrl} download>
            <Download size={15} /> Download source bundle
          </a>
          <small>
            {presentation.sourceBundle.fileCount == null
              ? 'Project files'
              : `${presentation.sourceBundle.fileCount} recorded output files`}{' '}
            · ZIP
          </small>
        </div>
      )}
      {files.length > 0 && (
        <>
          <ScrollRegion label="Output files">
            <div className="garden-delivery-list">
              {(compact && !showAll ? files.slice(0, 3) : files).map((item) => (
                <article key={item.id} className="garden-delivery">
                  <FileText size={20} />
                  <div className="garden-delivery-details">
                    <strong>{item.title}</strong>
                    <small>
                      {item.path?.replace(/^workspace\//, '') ?? item.mimeType ?? 'Artifact'}
                      {item.sizeBytes !== undefined &&
                        ` · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(item.sizeBytes / 1024)} KB`}
                    </small>
                    {item.detail && <small>{item.detail}</small>}
                  </div>
                  <div className="garden-delivery-actions">
                    {onDiscuss && <Button onClick={() => onDiscuss(item)}>Discuss</Button>}
                    {onRemember && <Button onClick={() => onRemember(item)}>Keep a note</Button>}
                    {item.artifactId && (
                      <Button onClick={() => onArtifact(item.artifactId!)}>View</Button>
                    )}
                    {item.downloadUrl && item.status !== 'unavailable' && (
                      <a className="button" href={item.downloadUrl} download={item.title}>
                        <Download size={15} />
                        <span>Download</span>
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </ScrollRegion>
          {compact && files.length > 3 && (
            <Button
              className="quiet-button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? 'Show fewer outputs' : `All ${files.length} outputs`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One list of milestones, used for the direction being worked and for each earlier one.
 *
 * Extracted rather than duplicated because the retained trajectory has to read exactly like the
 * live list - same ticks, same durations, same expandable parts - or the two stop being comparable,
 * which is the whole point of keeping the earlier ones on screen.
 */
function PhaseList({
  phases,
  onPlan
}: {
  phases: TaskPresentation['progress']['phases'];
  onPlan?: () => void;
}) {
  return (
    <ol className="garden-phases">
      {phases.map((phase, index) => {
        const durationMs =
          phase.startedAt && phase.completedAt
            ? Date.parse(phase.completedAt) - Date.parse(phase.startedAt)
            : undefined;
        const durationText =
          durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
            ? durationMs < 60_000
              ? `${Math.floor(durationMs / 1000)}s`
              : `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1000)}s`
            : null;
        const substeps = phase.substeps ?? [];
        const counter =
          typeof phase.countTotal === 'number' && phase.countTotal > 0
            ? `${phase.countDone ?? 0}/${phase.countTotal}`
            : null;
        /*
         * The hover is the step's own account of itself, counted off what it recorded, with its
         * timing appended. A step nothing was recorded inside says only what it is, rather than
         * claiming an empty summary.
         */
        const hover = [phase.title, phase.detail, durationText && `took ${durationText}`]
          .filter(Boolean)
          .join(' — ');
        const row = (
          <span className="garden-phase-line" title={hover}>
            <span className="garden-phase-dot">
              {phase.status === 'completed' ? <Check size={12} /> : index + 1}
            </span>
            <span>{phase.title}</span>
            <span className="garden-phase-meta">
              {counter && <span className="badge">{counter}</span>}
              {phase.status !== 'completed' && phase.startedAt && !durationText && (
                <span className="muted">since {shortTime(phase.startedAt)}</span>
              )}
              {durationText && <span className="muted">{durationText}</span>}
            </span>
          </span>
        );
        return (
          <li key={phase.id} data-status={phase.status}>
            {substeps.length ? (
              /*
               * A milestone with parts expands to them. The counter sits on the closed row so a
               * collapsed "3/5" is readable at a glance, and the details carry each part's own
               * state.
               *
               * The way into the plan editor moves into the expanded list rather than staying on
               * the row: a `summary` is already the control that opens the disclosure, and a
               * button nested inside one is both ambiguous to click and wrong to a screen
               * reader. A milestone with no parts keeps the plain button it always had.
               */
              <details className="garden-phase-detail">
                <summary>{row}</summary>
                <ol className="garden-subphases">
                  {substeps.map((sub) => (
                    <li
                      key={sub.id}
                      data-status={sub.status}
                      title={[sub.title, sub.detail].filter(Boolean).join(' — ')}
                    >
                      <span className="garden-phase-dot">
                        {sub.status === 'completed' ? <Check size={10} /> : '·'}
                      </span>
                      <span>{sub.title}</span>
                    </li>
                  ))}
                </ol>
                <button className="text-button" onClick={onPlan}>
                  Open the plan
                </button>
              </details>
            ) : (
              <button onClick={onPlan}>{row}</button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How the run ended, in its own words, at the top of the panel rather than at the bottom of a
 * timeline.
 *
 * Every field here was already being recorded and none of it was ever shown as an ending: the
 * owner who came back to a finished run got a status line reading Complete and had to read the
 * trace backwards to find out what had been produced. Risks are not tucked into a disclosure -
 * a run that says something is still wrong has said the most important thing on the card.
 */
function Outcome({ outcome }: { outcome: NonNullable<TaskPresentation['outcome']> }) {
  const verification =
    outcome.verification === 'verified'
      ? `Evidence recorded · ${outcome.evidence} ${outcome.evidence === 1 ? 'item' : 'items'}`
      : outcome.verification === 'not_applicable'
        ? 'An answer, with nothing external to check'
        : 'Finished without a verification';
  return (
    <section className="garden-outcome" aria-label="How it finished">
      <header className="row between">
        <span className="eyebrow">How it finished</span>
        <span className="muted">{shortTime(outcome.at)}</span>
      </header>
      <p className="garden-outcome-summary">{outcome.summary}</p>
      <p className="muted">
        {verification}
        {outcome.openSteps > 0 &&
          ` · ${outcome.openSteps} plan ${outcome.openSteps === 1 ? 'step' : 'steps'} left open`}
      </p>
      {outcome.remainingRisks.length > 0 && (
        <>
          <span className="eyebrow">Still open</span>
          <ul className="garden-outcome-list garden-outcome-risks">
            {outcome.remainingRisks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function TaskProgress({
  presentation,
  onEvidence,
  onPlan,
  showOutcome = true
}: {
  showOutcome?: boolean;
  presentation: TaskPresentation;
  onEvidence: (id: string) => void;
  onPlan: () => void;
}) {
  const { progress } = presentation;
  const phases = progress.phases;
  const complete = phases.filter((phase) => phase.status === 'completed').length;
  const openCount = phases.filter(
    (phase) => phase.status !== 'completed' && phase.status !== 'skipped'
  ).length;
  const partial = presentation.taskStatus === 'completed' && openCount > 0;
  return (
    <aside className="garden-progress" aria-label="Recorded progress">
      <header>
        <span className="eyebrow">The work, as it happens</span>
        {phases.length > 0 && (
          <button
            className="garden-phase-count"
            onClick={onPlan}
            aria-label={`Plan: ${complete} of ${phases.length} steps completed`}
          >
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="24" r="20" />
              <circle
                className="garden-progress-arc"
                cx="24"
                cy="24"
                r="20"
                pathLength="100"
                strokeDasharray={`${(complete / phases.length) * 100} 100`}
              />
            </svg>
            <span>
              {complete}
              <small>/{phases.length}</small>
            </span>
          </button>
        )}
        {partial && (
          <p className="muted garden-phase-partial">
            Finished with {openCount} {openCount === 1 ? 'step' : 'steps'} open — {complete} of{' '}
            {phases.length} done
          </p>
        )}
      </header>
      {progress.current && (
        <div className="garden-now">
          <span className="eyebrow">Now</span>
          <p>{progress.current.title}</p>
        </div>
      )}
      {showOutcome && presentation.taskStatus === 'completed' && presentation.outcome && (
        <Outcome outcome={presentation.outcome} />
      )}
      {phases.length > 0 && <PhaseList phases={phases} onPlan={onPlan} />}
      {/*
       * Everything the project did before the direction it is working now.
       *
       * A follow-up starts a new plan, and until one is written `phases` is empty - so sending one
       * looked like it deleted the list the owner had been watching. These are the earlier lists,
       * kept and closed by default: the trajectory is there when it is wanted without competing
       * with what is happening this minute.
       */}
      {progress.history.length > 0 && (
        <details className="garden-phase-history">
          <summary>
            Earlier in this project
            <span className="badge">{progress.history.length}</span>
          </summary>
          {progress.history.map((entry) => (
            <PhaseList key={entry.directionEventId ?? entry.startedAt} phases={entry.phases} />
          ))}
        </details>
      )}
      <details className="garden-milestone-disclosure" open>
        <summary>
          Changes & evidence <span>{progress.milestones.length}</span>
        </summary>
        <ol className="garden-milestones">
          {progress.milestones
            .slice(-8)
            .reverse()
            .map((milestone) => (
              <li key={milestone.id} data-status={milestone.status}>
                <button onClick={() => onEvidence(milestone.id)}>
                  <span className="garden-milestone-kind">{milestone.kind}</span>
                  <strong>{milestone.title}</strong>
                  {milestone.detail && <small>{milestone.detail}</small>}
                </button>
              </li>
            ))}
        </ol>
        {!progress.milestones.length && (
          <p className="muted">Recorded changes and checks will appear here.</p>
        )}
      </details>
      {presentation.coverage?.scope === 'recent' && (
        <p className="garden-coverage">
          Showing recent activity. Earlier actions remain in Activity.
        </p>
      )}
    </aside>
  );
}
