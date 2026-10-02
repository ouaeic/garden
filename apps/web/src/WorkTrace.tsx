import type { TaskPresentation, WorkSurfaceView } from '@garden/contracts';
import { Button } from './ui';
import './presentation.css';

export default function WorkTrace({
  progress,
  surface,
  onEvidence
}: {
  progress: TaskPresentation['progress'];
  surface?: WorkSurfaceView;
  onEvidence: (id: string) => void;
}) {
  const sources =
    surface && surface.sources.length > 0 ? (
      <details className="garden-surface-sources">
        <summary>
          Sources shown · {surface.sources.filter((source) => source.state === 'read').length} read
          · {surface.sources.filter((source) => source.state === 'discovered').length} discovered
        </summary>
        <p>
          Sources in the loaded activity window. A discovered page has not been recorded as read.
        </p>
        <ul>
          {surface.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>
              <span>{source.state}</span>
              <Button onClick={() => onEvidence(source.eventId)}>Inspect</Button>
            </li>
          ))}
        </ul>
      </details>
    ) : null;
  const milestones = progress.milestones.slice(-6);
  if (milestones.length < 2) return sources;
  return (
    <>
      <details className="garden-recorded-actions">
        <summary>Recorded activity · latest {milestones.length} actions</summary>
        {milestones.map((item) => (
          <div key={item.id}>
            <strong>{item.title}</strong>
            <Button onClick={() => onEvidence(item.id)}>Inspect</Button>
          </div>
        ))}
      </details>
      {sources}
    </>
  );
}
