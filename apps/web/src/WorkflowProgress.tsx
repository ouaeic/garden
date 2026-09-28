import type { WorkflowRun } from '@garden/contracts';
import { processDuration, processMemory } from './process-display';

export function WorkflowProgress({ run }: { run: WorkflowRun }) {
  const progress = run.progress;
  return (
    <section className="workflow-progress" aria-label="Workflow progress">
      <p className="workflow-summary">
        Attempt {run.attempt} ·{' '}
        {progress ? (
          <>
            {progress.completed} completed · {progress.cached} cached
            {progress.failed > 0 && <> · {progress.failed} failed</>}
            {progress.aborted > 0 && <> · {progress.aborted} stopped</>}
          </>
        ) : (
          'Stage progress unavailable'
        )}
      </p>
      {progress && (
        <p className="process-sample-age">
          Recorded stage outcomes; more tasks may be discovered as the workflow runs.
          {progress.catchingUp ? ' Reading earlier trace records…' : ''}
          {progress.pendingRecord ? ' A stage record is still being written.' : ''}
        </p>
      )}
      {run.note && <p className="process-sample-age">{run.note}</p>}
      <details className="process-details">
        <summary>Workflow stages & files</summary>
        {progress && progress.recent.length > 0 ? (
          <ol className="workflow-stages">
            {progress.recent.slice(-12).map((stage, index) => (
              <li key={`${stage.taskId}-${index}`}>
                <span className="workflow-stage-name">{stage.name}</span>
                <span>
                  {stage.status}
                  {stage.exitCode !== null && stage.exitCode !== 0
                    ? ` · exit ${stage.exitCode}`
                    : ''}
                </span>
                <span>
                  {stage.durationMs === null
                    ? 'Duration unavailable'
                    : processDuration(stage.durationMs)}{' '}
                  ·{' '}
                  {stage.peakMemoryBytes === null || stage.peakMemoryBytes === 0
                    ? 'Peak RAM not captured'
                    : processMemory(stage.peakMemoryBytes)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="process-sample-age">No completed stage records yet.</p>
        )}
        <dl className="workflow-files">
          <div>
            <dt>Pipeline</dt>
            <dd>{run.script}</dd>
          </div>
          <div>
            <dt>Trace</dt>
            <dd>{run.tracePath}</dd>
          </div>
          <div>
            <dt>Report</dt>
            <dd>{run.reportPath}</dd>
          </div>
        </dl>
        <p className="process-sample-age">
          Files appear as the engine writes them. Keep the run’s cache and work directories to
          resume eligible stages. Open project files to inspect or download them.
        </p>
      </details>
    </section>
  );
}
