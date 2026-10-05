import { lazy, Suspense } from 'react';
import type { ResultNote, Task } from '@garden/contracts';
import { currentWork } from '../current-work';
import { answerIsStreaming, surfaceAnswer } from '../model';
import type { useTaskRecord } from '../useTaskRecord';
import { CommentSurface, withNote } from '../result-notes';
import { TaskOutputs } from '../TaskCanvas';
import { setDirection, useDirection } from '../ask/direction';
import { raiseCapAndResume } from '../app/actions';
import { ago, money } from '../app/derive';
import { Check, Lock, Speak, Spend, Sprout } from '../app/icons';
import { go } from '../app/route';
import { toast } from '../app/toast';
import { NOTE_LABEL, type Note } from './timeline';
import './work.css';

const Markdown = lazy(() => import('../MarkdownBody'));
const CodingMissions = lazy(() => import('../CodingMissions'));
const MediaJobs = lazy(() => import('../MediaJobs'));
const SubagentLanes = lazy(() => import('../SubagentLanes'));

type Record = ReturnType<typeof useTaskRecord>;

/** The goal, looked at properly: what it is for and how far it has come, the work, and its notes. */
export default function Look({
  task,
  record,
  notes,
  doneWhen,
  onActAsYou
}: {
  task: Task;
  record: Record;
  notes: Note[];
  doneWhen: string | null;
  onActAsYou: (on: boolean) => void;
}) {
  const { events, plan, artifacts, storedPresentation } = record;
  const presentation = currentWork(storedPresentation, events);
  const direction = useDirection(task.id);
  const comments = direction?.kind === 'notes' ? direction.notes : [];
  const addComment = (note: ResultNote) => {
    setDirection(task.id, withNote(direction, note));
    requestAnimationFrame(() =>
      document.getElementById('ask-input')?.focus({ preventScroll: true })
    );
  };
  const since = presentation?.surface?.direction?.sequence ?? 0;
  const current = events.filter((event) => event.sequence >= since);
  const answer = surfaceAnswer(current);
  const writing = answer.partial && answerIsStreaming(current, task.status);
  const outcome = presentation?.outcome;
  const steps = plan?.steps.filter((step) => step.status !== 'skipped') ?? [];
  const verified = outcome?.verification === 'verified';

  const answerBlock = answer.markdown ? (
    <article className="answer">
      <Suspense fallback={<div className="skeleton" style={{ height: 80 }} />}>
        <CommentSurface on="the answer" notes={comments} onNote={addComment}>
          <Markdown
            artifacts={artifacts}
            onArtifact={() => go({ view: 'computer', tab: 'files' })}
            imageMode="links"
          >
            {answer.markdown}
          </Markdown>
        </CommentSurface>
      </Suspense>
      {writing && (
        <div className="writing" role="status">
          Writing…
        </div>
      )}
    </article>
  ) : null;

  return (
    <div className="look">
      <aside className="look-side scroll" aria-label="What it is for and how far it has come">
        <section>
          <h2 className="look-h">Done when</h2>
          <p className="done-line">
            {doneWhen ??
              (outcome?.summary
                ? 'It decided its own checks as it worked; they are below.'
                : 'It sets its own checks as it works. They will show here.')}
          </p>
          {outcome && (
            <p className={`proof ${verified ? '' : 'is-plain'}`}>
              {verified ? (
                <>
                  <Check /> Every check passed
                </>
              ) : outcome.verification === 'not_applicable' ? (
                'Nothing to check'
              ) : (
                'Not verified'
              )}
            </p>
          )}
        </section>
        <section>
          <h2 className="look-h">
            Deliverables{' '}
            <span className="faint">
              {steps.length
                ? `${steps.filter((s) => s.status === 'completed').length} of ${steps.length}`
                : ''}
            </span>
          </h2>
          {steps.length ? (
            <ol className="deliverables">
              {steps.map((step) => (
                <li key={step.id} className={`deliverable is-${step.status}`}>
                  <span className="mark" aria-hidden="true">
                    {step.status === 'completed' && <Check />}
                  </span>
                  <span className="deliverable-title">{step.title}</span>
                  <span className="deliverable-state">
                    {step.status === 'completed'
                      ? verified
                        ? 'Checked'
                        : 'Done'
                      : step.status === 'in_progress'
                        ? 'In hand'
                        : 'Next'}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="faint small">No plan yet. A quick answer needs none.</p>
          )}
        </section>
        <section>
          <h2 className="look-h">Keys in this goal</h2>
          <div className="held-keys">
            <div className="held is-lent">
              <span className="key-icon">
                <Spend />
              </span>
              <span>
                <b>Spend</b> · {money(task.spentUsd)}
                {task.maxSpendUsd ? ` of ${money(task.maxSpendUsd)}` : ''}
                {task.spendPausedAt && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      void raiseCapAndResume(
                        task.id,
                        Math.max(task.spentUsd * 1.5, (task.maxSpendUsd ?? 0) + 5)
                      ).then(
                        () => toast('Cap raised. Carrying on.'),
                        (cause: unknown) =>
                          toast(cause instanceof Error ? cause.message : 'That did not go through.')
                      )
                    }
                  >
                    Raise and resume
                  </button>
                )}
              </span>
            </div>
            <button
              type="button"
              className={`held ${task.securityMode === 'autonomous' ? 'is-lent' : ''}`}
              aria-pressed={task.securityMode === 'autonomous'}
              onClick={() => onActAsYou(task.securityMode !== 'autonomous')}
            >
              <span className="key-icon">
                <Speak />
              </span>
              <span>
                <b>Act as you</b> · {task.securityMode === 'autonomous' ? 'lent' : 'kept'}
                <small>
                  {task.securityMode === 'autonomous'
                    ? 'Sends, submits and books without asking'
                    : 'Asks before sending, submitting or booking'}
                </small>
              </span>
            </button>
            <div className="held">
              <span className="key-icon">
                <Lock />
              </span>
              <span>
                <b>Publish, remove, rules, accounts</b>
                <small>Always ask you</small>
              </span>
            </div>
          </div>
        </section>
      </aside>

      <main className="work scroll" aria-label="The work">
        {presentation && presentation.results.length > 0 ? (
          <TaskOutputs
            presentation={presentation}
            events={events}
            artifacts={artifacts}
            onArtifact={() => go({ view: 'computer', tab: 'files' })}
            notes={comments}
            onNote={addComment}
            afterPreview={answerBlock}
          />
        ) : null}
        {!presentation?.results.length && answerBlock}
        <Suspense fallback={null}>
          <CodingMissions
            taskId={task.id}
            onOpenTask={(id) => go({ view: 'goal', goal: id })}
            onChange={() => void record.reload()}
          />
          <MediaJobs taskId={task.id} onDelivered={() => void record.reload()} />
        </Suspense>
        {!answerBlock && !presentation?.results.length && (
          <div className="work-empty">
            <Sprout />
            <p className="display">The work will appear here as it grows.</p>
            {notes[0] && <p className="muted">Latest: {notes[0].title}</p>}
          </div>
        )}
      </main>

      <aside className="look-notes scroll" aria-label="Notes from the work">
        <Suspense fallback={null}>
          <SubagentLanes events={events} />
        </Suspense>
        <h2 className="look-h">Notes from the work</h2>
        {notes.length ? (
          <ol className="notes">
            {notes.slice(0, 60).map((note) => (
              <li key={note.id} className={`note is-${note.kind}`}>
                <div className="note-head">
                  <span>{NOTE_LABEL[note.kind]}</span>
                  <time dateTime={note.at}>{ago(note.at)}</time>
                </div>
                <p>{note.title}</p>
                {note.body && <p className="note-body">{note.body}</p>}
                {note.kind !== 'you' && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => go({ zoom: 'inspect' }, { replace: true })}
                  >
                    See exactly
                  </button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="faint small">Nothing to mention yet.</p>
        )}
      </aside>
    </div>
  );
}
