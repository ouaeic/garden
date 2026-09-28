import type { TaskPresentation, WorkEvidence, WorkSurfaceView } from '@garden/contracts';
import { Button } from './ui';
import './presentation.css';

export default function WorkTrace({
  progress,
  surface,
  onEvidence,
  onResult
}: {
  progress: TaskPresentation['progress'];
  surface?: WorkSurfaceView;
  onEvidence: (id: string) => void;
  onResult?: (kind: 'artifact' | 'preview', id: string) => void;
}) {
  const report = surface?.report;
  function evidence(references: WorkEvidence[] | undefined) {
    if (!references?.length) return null;
    return (
      <div className="garden-block-evidence">
        {references.map((reference, index) => {
          const receipt = surface?.references.find(
            (entry) =>
              entry.toolCallId === reference.toolCallId && entry.pointer === reference.pointer
          );
          return receipt ? (
            <Button key={index} onClick={() => onEvidence(receipt.eventId)} title={receipt.label}>
              Evidence {index + 1}
            </Button>
          ) : (
            <small key={index}>Evidence unavailable</small>
          );
        })}
      </div>
    );
  }
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
  if (!report) {
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
  return (
    <section className="garden-work-surface" aria-label="Current work surface">
      <h2>{report.content.title}</h2>
      {report.content.blocks.map((block, index) => (
        <article className={`garden-work-block garden-block-${block.kind}`} key={index}>
          <h3>{block.title}</h3>
          {block.kind === 'sections' && (
            <div className={`garden-block-sections ${block.layout}`}>
              {block.items.map((item, itemIndex) => (
                <section key={itemIndex}>
                  {item.label && <small>{item.label}</small>}
                  <h4>{item.title}</h4>
                  {item.text && <p>{item.text}</p>}
                  {evidence(item.evidence)}
                </section>
              ))}
            </div>
          )}
          {block.kind === 'table' && (
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The horizontal scroll region must be keyboard reachable.
            <div className="garden-block-table" tabIndex={0} role="region" aria-label={block.title}>
              <table>
                <thead>
                  <tr>
                    {block.columns.map((column, columnIndex) => (
                      <th key={columnIndex}>{column}</th>
                    ))}
                    {block.rows.some((row) => row.evidence?.length) && <th>Evidence</th>}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.cells.map((cell, columnIndex) => (
                        <td key={columnIndex}>{cell}</td>
                      ))}
                      {block.rows.some((row) => row.evidence?.length) && (
                        <td>{evidence(row.evidence)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {block.kind === 'checklist' && (
            <ul className="garden-block-checklist">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <span className={`garden-check-state ${item.status}`}>{item.status}</span>
                  <div>
                    <strong>{item.title}</strong>
                    {item.text && <p>{item.text}</p>}
                    {evidence(item.evidence)}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {block.kind === 'chart' && (
            <div className="garden-block-chart" aria-label={`${block.title}, ${block.unit}`}>
              <small>{block.unit} · recorded values</small>
              {block.points.map((point, pointIndex) => {
                const value = surface.references.find(
                  (entry) =>
                    entry.toolCallId === point.value.toolCallId &&
                    entry.pointer === point.value.pointer
                )?.value;
                const max = Math.max(
                  ...block.points.map((entry) =>
                    Math.abs(
                      Number(
                        surface.references.find(
                          (ref) =>
                            ref.toolCallId === entry.value.toolCallId &&
                            ref.pointer === entry.value.pointer
                        )?.value
                      ) || 0
                    )
                  ),
                  1
                );
                return (
                  <div className="garden-chart-row" key={pointIndex}>
                    <span>{point.label}</span>
                    {typeof value === 'number' ? (
                      <>
                        <div className="garden-chart-bar-track">
                          <i
                            className={value < 0 ? 'negative' : ''}
                            style={{ width: `${(Math.abs(value) / max) * 100}%` }}
                          />
                        </div>
                        <strong>
                          {value.toLocaleString()} {block.unit}
                        </strong>
                      </>
                    ) : (
                      <span>Evidence unavailable</span>
                    )}
                    {evidence([point.value])}
                  </div>
                );
              })}
            </div>
          )}
          {block.kind === 'result' && (
            <div>
              {block.text && <p>{block.text}</p>}
              <Button onClick={() => onResult?.(block.result.kind, block.result.id)}>
                View result
              </Button>
            </div>
          )}
        </article>
      ))}
      {surface.unavailableReferences > 0 && (
        <p className="muted">
          Some evidence is outside this loaded history window. The recorded activity retains the
          original results.
        </p>
      )}
      {sources}
    </section>
  );
}
