import type { WorkSurfaceView } from '@garden/contracts';
import { Button } from './ui';
import './presentation.css';

/** The pages the work found and read, each one inspectable. */
export default function Sources({
  surface,
  onEvidence
}: {
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
  return sources;
}
