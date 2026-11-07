import { lazy, Suspense, useEffect, useRef } from 'react';
import { download } from '../management';
import { Close, Download, External } from './icons';
import { openGoal } from './route';
import { useGarden } from './store';
import { toast } from './toast';
import { closeArtifact, useViewed } from './viewer';
import { kindOf, sizeText } from './kinds';
import './viewer.css';

const ResultPreview = lazy(() =>
  import('../computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);

/** A deliverable, open as itself: read it, keep a copy, or go to the goal that made it. */
export default function ArtifactViewer() {
  const viewed = useViewed();
  const { bootstrap } = useGarden();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!viewed) return;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && closeArtifact();
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [viewed]);
  if (!viewed) return null;
  const goal = viewed.taskId ? bootstrap?.tasks.find((task) => task.id === viewed.taskId) : null;
  const kind = kindOf(viewed.name, viewed.mimeType);
  return (
    <div
      className="scrim"
      onPointerDown={(event) => event.target === event.currentTarget && closeArtifact()}
    >
      <section className="sheet viewer" role="dialog" aria-modal="true" aria-label={viewed.name}>
        <header className="viewer-head">
          <span className="viewer-kind" aria-hidden="true">
            <kind.icon />
          </span>
          <div className="viewer-title">
            <h2>{viewed.name}</h2>
            <p>
              {kind.label} · {sizeText(viewed.sizeBytes)}
              {viewed.version && viewed.version > 1 ? ` · version ${viewed.version}` : ''}
              {goal ? ` · from “${goal.title}”` : ''}
            </p>
          </div>
          <div className="viewer-acts">
            {viewed.taskId && (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const id = viewed.taskId!;
                  closeArtifact();
                  openGoal(id);
                }}
              >
                <External /> <span>Open the goal</span>
              </button>
            )}
            <button
              type="button"
              className="btn small"
              onClick={() =>
                void download(`/v1/artifacts/${viewed.id}/content`, viewed.name).catch(
                  (cause: unknown) =>
                    toast(cause instanceof Error ? cause.message : 'That did not download.')
                )
              }
            >
              <Download /> <span>Download</span>
            </button>
            <button
              ref={close}
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={closeArtifact}
            >
              <Close />
            </button>
          </div>
        </header>
        <div className="viewer-body scroll">
          <Suspense fallback={<div className="skeleton" style={{ height: 240 }} />}>
            <ResultPreview artifact={viewed} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
