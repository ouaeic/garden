import { useState } from 'react';
import type { WorkSurfaceView } from '@garden/contracts';
import { Button } from './ui';

export function WorkDirections({
  surface,
  onDiscuss,
  onRevisit
}: {
  surface: WorkSurfaceView;
  onDiscuss?: (eventId: string) => void;
  onRevisit: (eventId: string, sequence: number) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const current = surface.direction;
  if (!current) return null;
  const expanded = expandedId === current.eventId;
  return (
    <section className="garden-directions" aria-label="Your directions">
      <article className="garden-direction">
        <header>
          <strong>{current.queued ? 'Next direction · queued' : 'Your direction'}</strong>
          <Button
            className="quiet-button"
            onClick={() => onRevisit(current.eventId, current.sequence)}
          >
            Edit / revisit
          </Button>
          {onDiscuss && (
            <Button onClick={() => onDiscuss(current.eventId)}>Discuss separately</Button>
          )}
        </header>
        <p>
          {expanded ? current.text : current.text.slice(0, 400)}
          {!expanded && current.text.length > 400 ? '…' : ''}
        </p>
        {current.text.length > 400 && (
          <Button onClick={() => setExpandedId(expanded ? null : current.eventId)}>
            {expanded ? 'Show less' : 'Read direction'}
          </Button>
        )}
        {expanded && current.truncated && (
          <Button onClick={() => onRevisit(current.eventId, current.sequence)}>
            Read full original
          </Button>
        )}
        <p className="garden-acknowledgment">
          <small>garden</small>{' '}
          {surface.report?.content.acknowledgment ??
            current.acknowledgment ??
            (current.queued ? 'Queued for the next turn.' : 'Waiting for the next update.')}
        </p>
      </article>
      {surface.directions.length > 1 && (
        <details className="garden-direction-history">
          <summary>Earlier directions · {surface.directions.length - 1}</summary>
          {surface.directions
            .filter((direction) => direction.eventId !== current.eventId)
            .map((direction) => (
              <div className="garden-prior-direction" key={direction.eventId}>
                <div>
                  <span title={direction.text}>{direction.text || 'Earlier direction'}</span>
                  {direction.acknowledgment && <p>{direction.acknowledgment}</p>}
                </div>
                {onDiscuss && (
                  <Button onClick={() => onDiscuss(direction.eventId)}>Discuss separately</Button>
                )}
                <Button onClick={() => onRevisit(direction.eventId, direction.sequence)}>
                  Revisit
                </Button>
              </div>
            ))}{' '}
        </details>
      )}
    </section>
  );
}
