import type { TaskPresentation, TaskResult } from '@garden/contracts';

const phaseLabels = {
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'not started',
  skipped: 'skipped'
} as const;

function outputGroup(result: TaskResult): string {
  if (result.kind === 'preview') return 'Apps';
  const mime = result.mimeType ?? '';
  const name = result.path ?? result.title;
  if (mime.startsWith('image/') || /\.(png|jpe?g|svg|webp|gif|avif)$/i.test(name)) return 'Images';
  if (/^(audio|video)\//.test(mime) || /\.(mp[34]|wav|webm|mov|flac)$/i.test(name)) return 'Media';
  if (/\.(csv|tsv|json|parquet|xlsx?|ipynb)$/i.test(name)) return 'Data';
  if (/\.(pdf|docx?|pptx?|md|txt)$/i.test(name)) return 'Documents';
  return 'Files';
}

export default function WorkSummaryVisual({ presentation }: { presentation: TaskPresentation }) {
  const phases = presentation.progress.phases;
  const statuses = Object.entries(phaseLabels)
    .map(([status, label]) => ({
      status,
      label,
      count: phases.filter((phase) => phase.status === status).length
    }))
    .filter((item) => item.count > 0);
  const outputs = new Map<string, number>();
  const seen = new Set<string>();
  for (const result of presentation.results) {
    const identity = result.artifactId ?? result.path ?? result.id;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const group = outputGroup(result);
    outputs.set(group, (outputs.get(group) ?? 0) + 1);
  }
  if (!phases.length && !outputs.size) return null;
  const maximum = Math.max(1, ...outputs.values());
  return (
    <section className="work-summary-visual lcd-surface" aria-label="Work at a glance">
      <header>
        <h2>At a glance</h2>
        <span className="muted">This conversation</span>
      </header>
      <div className="work-summary-charts">
        {phases.length > 0 && (
          <figure>
            <figcaption>
              Recorded plan · {phases.length} {phases.length === 1 ? 'step' : 'steps'}
            </figcaption>
            <div className="work-summary-plan" aria-hidden="true">
              {statuses.map(({ status, count }) => (
                <span key={status} data-state={status} style={{ flexGrow: count }} />
              ))}
            </div>
            <ul className="work-summary-legend">
              {statuses.map(({ status, label, count }) => (
                <li key={status}>
                  <i data-state={status} aria-hidden="true" />
                  {count} {label}
                </li>
              ))}
            </ul>
          </figure>
        )}
        {outputs.size > 0 && (
          <figure>
            <figcaption>Recorded outputs · {seen.size}</figcaption>
            <dl className="work-summary-outputs">
              {[...outputs].map(([label, count]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <span className="work-summary-bar" aria-hidden="true">
                      <i style={{ width: `${(count / maximum) * 100}%` }} />
                    </span>
                    <span>{count}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </figure>
        )}
      </div>
      {presentation.coverage?.scope === 'recent' && (
        <p className="muted">Recent recorded work; earlier activity remains in Activity.</p>
      )}
    </section>
  );
}
