import type { OwnerMove, Task } from '@garden/contracts';
import { doingText } from '../app/activity';
import { GROWTH_WORD, goalLine, growth, leaves, money } from '../app/derive';
import { Download } from '../app/icons';
import { kindOf, sizeText } from '../app/kinds';
import { openGoal } from '../app/route';
import { openArtifact } from '../app/viewer';
import { modelLabel } from '../model-makers';
import { plain } from '../desk/faces';
import { FORM_WORD, type Form } from '../desk/forms';
import type { Outcome } from '../desk/outcomes';

const took = (task: Task) => {
  const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
  const minutes = Math.max(0, Math.round((end - Date.parse(task.createdAt)) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim();
};

/**
 * The cover note on a result: what it is in one line, what was checked and how, and what is the
 * owner's to decide - so judging the work takes a glance, and reading it is a choice.
 */
export default function Note({
  task,
  moves,
  outcome,
  form,
  working,
  doing,
  modelName,
  editions,
  onStory
}: {
  task: Task;
  moves: readonly OwnerMove[];
  outcome: Outcome | undefined;
  form: Form;
  working: boolean;
  doing: string | undefined;
  modelName: string | undefined;
  /** For an automation's run: its other runs, newest first, and what this one says that the last did not. */
  editions?: { runs: readonly Task[]; fresh: readonly string[] | null } | undefined;
  onStory: () => void;
}) {
  const state = growth(task, moves);
  const grown = leaves(task);
  const checked = outcome?.checked ?? [];
  const yours = [...(outcome?.yourCall ?? []), ...(outcome?.risks ?? [])];
  const headline = working
    ? doing
      ? doingText(doing)
      : goalLine(task, moves)
    : plain(outcome?.headline ?? goalLine(task, moves));
  const files = outcome?.files ?? [];
  return (
    <div className="note-card">
      <p className="note-kicker">
        <i aria-hidden="true" className={`note-dot is-${state}`} />
        {working ? GROWTH_WORD[state] : `${GROWTH_WORD[state]} · ${FORM_WORD[form]}`}
      </p>
      <h2 className={`note-headline ${working ? 'is-live' : ''}`}>{headline}</h2>
      {working && grown.total > 1 && (
        <span className="note-pips" aria-label={`${grown.done} of ${grown.total} steps done`}>
          {Array.from({ length: grown.total }, (_, index) => (
            <i
              key={index}
              className={index < grown.done ? 'is-done' : index === grown.done ? 'is-now' : ''}
            />
          ))}
        </span>
      )}

      {editions && editions.fresh && (
        <section className="note-list is-fresh" aria-label="New since the last edition">
          <h3>New since the last edition</h3>
          {editions.fresh.length ? (
            <ul>
              {editions.fresh.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="note-unchecked">Nothing new since the last edition.</p>
          )}
        </section>
      )}

      {checked.length > 0 ? (
        <section className="note-list is-checked" aria-label="Checked">
          <h3>Checked</h3>
          <ul>
            {checked.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : outcome?.verification === 'verified' ? (
        <section className="note-list is-checked" aria-label="Checked">
          <h3>Checked</h3>
          <ul>
            <li>Every check it set itself passed.</li>
          </ul>
        </section>
      ) : !working && outcome && (files.length > 0 || (outcome.answer?.length ?? 0) > 600) ? (
        <p className="note-unchecked">It did not say what it checked.</p>
      ) : null}

      {yours.length > 0 && (
        <section className="note-list is-yours" aria-label="Your call">
          <h3>Your call</h3>
          <ul>
            {yours.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {files.length > 0 && (
        <section className="note-files" aria-label="Files">
          {files.map((file) => {
            const kind = kindOf(file.name, file.mimeType);
            return (
              <button
                key={file.id}
                type="button"
                className="note-file"
                onClick={() => openArtifact({ ...file, taskId: task.id })}
              >
                <kind.icon aria-hidden="true" />
                <span className="note-file-name">{file.name}</span>
                <span className="note-file-size num">{sizeText(file.sizeBytes)}</span>
                <Download aria-hidden="true" className="note-file-get" />
              </button>
            );
          })}
        </section>
      )}

      <dl className="note-meta">
        <div>
          <dt>Spent</dt>
          <dd className="num">
            {money(task.spentUsd)}
            {task.maxSpendUsd ? ` of ${money(task.maxSpendUsd)}` : ''}
          </dd>
        </div>
        <div>
          <dt>{working ? 'Running' : 'Took'}</dt>
          <dd>{took(task)}</dd>
        </div>
        {modelName && (
          <div>
            <dt>Model</dt>
            <dd title={modelName}>{modelLabel(modelName)}</dd>
          </div>
        )}
      </dl>

      {editions && editions.runs.length > 1 && (
        <nav className="note-editions" aria-label="Editions">
          {editions.runs.slice(0, 10).map((run) => (
            <button
              key={run.id}
              type="button"
              aria-current={run.id === task.id ? 'page' : undefined}
              title={new Date(run.createdAt).toLocaleString()}
              onClick={() => openGoal(run.id)}
            >
              {new Date(run.createdAt).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short'
              })}
            </button>
          ))}
        </nav>
      )}

      <button type="button" className="note-how" onClick={onStory}>
        How it was made <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
