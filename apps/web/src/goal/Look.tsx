import { lazy, Suspense } from 'react';
import type { Artifact, ResultNote, Task } from '@garden/contracts';
import { currentWork } from '../current-work';
import { answerIsStreaming, surfaceAnswer } from '../model';
import type { useTaskRecord } from '../useTaskRecord';
import { CommentSurface, withNote } from '../result-notes';
import { TaskOutputs } from '../TaskCanvas';
import { setDirection, useDirection } from '../ask/direction';
import { raiseCapAndResume, setGoalKeys } from '../app/actions';
import { ago, goalLine, money, raisedCap } from '../app/derive';
import { Check } from '../app/icons';
import { kindOf, sizeText } from '../app/kinds';
import { go } from '../app/route';
import { useGarden } from '../app/store';
import { toast } from '../app/toast';
import { openArtifact } from '../app/viewer';
import { NOTE_LABEL, type Note } from './timeline';
import './work.css';

/** What a goal may do without asking, named the way the owner would say it. */
const GOAL_KEYS = [
  {
    id: 'publish',
    name: 'Publish',
    ask: 'publishing or sharing',
    may: 'Publishes and shares links'
  },
  { id: 'remove', name: 'Delete', ask: 'deleting for good', may: 'Deletes outside an undo point' },
  {
    id: 'rules',
    name: 'Standing rules',
    ask: 'changing standing rules',
    may: 'Sets schedules and memory'
  }
] as const;

const Markdown = lazy(() => import('../MarkdownBody'));
const CodingMissions = lazy(() => import('../CodingMissions'));
const MediaJobs = lazy(() => import('../MediaJobs'));
const SubagentLanes = lazy(() => import('../SubagentLanes'));

type Record = ReturnType<typeof useTaskRecord>;

/**
 * The goal, looked at properly. The work takes the room - the answer, the deliverables, the thing
 * itself - and a narrow column beside it tells the story: what it is doing now, what done means,
 * the steps, and what it noticed on the way. A quick answer has no story to tell, so it reads as an
 * answer and nothing else, with the record one click away.
 */
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
  const { moves, bootstrap } = useGarden();
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
  const working = ['queued', 'planning', 'running'].includes(task.status);
  const made = latestVersions(artifacts);
  const results = presentation?.results.length ?? 0;
  // A reply with no plan and nothing made is an answer, and is shown as one.
  const quick = !steps.length && !results && !made.length && Boolean(answer.markdown) && !working;
  const open = (id: string) => {
    const artifact = artifacts.find((item) => item.id === id);
    if (artifact) openArtifact(artifact);
    else go({ view: 'computer', tab: 'files' });
  };
  const model = bootstrap?.models.find((item) => item.id === task.modelId);

  const answerBlock = answer.markdown ? (
    <article className={`answer ${writing ? 'is-writing' : ''}`}>
      <Suspense fallback={<div className="skeleton" style={{ height: 80 }} />}>
        <CommentSurface on="the answer" notes={comments} onNote={addComment}>
          <Markdown artifacts={artifacts} onArtifact={open} imageMode="links">
            {answer.markdown}
          </Markdown>
        </CommentSurface>
      </Suspense>
    </article>
  ) : null;

  return (
    <div className={`look ${quick ? 'is-quick' : ''}`}>
      <main className="work scroll" aria-label="The work">
        {made.length > 0 && (
          <section className="made-strip" aria-label="What it made">
            {made.map((artifact) => {
              const kind = kindOf(artifact.name, artifact.mimeType);
              return (
                <button
                  key={artifact.id}
                  type="button"
                  className="made-chip"
                  onClick={() => openArtifact(artifact)}
                >
                  <kind.icon aria-hidden="true" />
                  <span className="made-chip-name">{artifact.name}</span>
                  <span className="made-chip-size num">{sizeText(artifact.sizeBytes)}</span>
                </button>
              );
            })}
          </section>
        )}
        {results > 0 && presentation ? (
          <TaskOutputs
            presentation={presentation}
            events={events}
            artifacts={artifacts}
            onArtifact={open}
            notes={comments}
            onNote={addComment}
            afterPreview={answerBlock}
          />
        ) : (
          answerBlock
        )}
        <Suspense fallback={null}>
          <CodingMissions
            taskId={task.id}
            onOpenTask={(id) => go({ view: 'goal', goal: id })}
            onChange={() => void record.reload()}
          />
          <MediaJobs taskId={task.id} onDelivered={() => void record.reload()} />
        </Suspense>
        {!answerBlock && !results && !made.length && (
          <div className="work-empty" aria-live="polite">
            {working && <span className="thinking-line" aria-hidden="true" />}
            <p className="work-empty-now">{goalLine(task, moves)}</p>
            <p className="muted">
              {working
                ? 'What it makes appears here as it comes together.'
                : 'Nothing was made in this goal.'}
            </p>
          </div>
        )}
        {quick && (
          <footer className="quick-foot">
            <span>
              {task.completedAt ? `Answered ${ago(task.completedAt)}` : 'Answered'} ·{' '}
              <span className="num">{money(task.spentUsd)}</span>
              {model ? ` · ${model.displayName}` : ''}
            </span>
            <button
              type="button"
              className="link"
              onClick={() => go({ zoom: 'inspect' }, { replace: true })}
            >
              How it got there
            </button>
          </footer>
        )}
      </main>

      {!quick && (
        <aside className="story scroll" aria-label="How it is going">
          <section className={`story-now ${working ? 'is-live' : ''}`}>
            <h2 className="story-h">{working ? 'Now' : 'Where it ended'}</h2>
            <p>{goalLine(task, moves)}</p>
            {working && <span className="thinking-line" aria-hidden="true" />}
            {task.spendPausedAt && (
              <button
                type="button"
                className="btn leaf small"
                onClick={() =>
                  void raiseCapAndResume(task.id, raisedCap(task.spentUsd, task.maxSpendUsd)).then(
                    () => toast('Cap raised. Carrying on.'),
                    (cause: unknown) =>
                      toast(cause instanceof Error ? cause.message : 'That did not go through.')
                  )
                }
              >
                Raise to {money(raisedCap(task.spentUsd, task.maxSpendUsd))} and carry on
              </button>
            )}
          </section>

          <section>
            <h2 className="story-h">Done when</h2>
            <p className="done-line">
              {doneWhen ??
                (outcome?.summary
                  ? 'It set its own checks as it worked.'
                  : 'It sets its own checks as it works.')}
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

          {steps.length > 0 && (
            <section>
              <h2 className="story-h">
                Steps
                <span className="count">
                  {steps.filter((step) => step.status === 'completed').length} of {steps.length}
                </span>
              </h2>
              <ol className="deliverables">
                {steps.map((step) => (
                  <li key={step.id} className={`deliverable is-${step.status}`}>
                    <span className="mark" aria-hidden="true">
                      {step.status === 'completed' && <Check />}
                    </span>
                    <span className="deliverable-title">{step.title}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <Suspense fallback={null}>
            <SubagentLanes events={events} />
          </Suspense>

          <section>
            <h2 className="story-h">
              Along the way
              <button
                type="button"
                className="count link"
                onClick={() => go({ zoom: 'inspect' }, { replace: true })}
              >
                Every step
              </button>
            </h2>
            {notes.length ? (
              <ol className="notes">
                {notes.slice(0, 40).map((note) => (
                  <li key={note.id} className={`note is-${note.kind}`}>
                    <div className="note-head">
                      <span>{NOTE_LABEL[note.kind]}</span>
                      <time dateTime={note.at}>{ago(note.at)}</time>
                    </div>
                    <p>{note.title}</p>
                    {note.body && <p className="note-body">{note.body}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="faint small">Nothing to mention yet.</p>
            )}
          </section>

          <Permissions task={task} onActAsYou={onActAsYou} />
        </aside>
      )}
    </div>
  );
}

/** What this goal may do without asking, said in one line and changed in place. */
function Permissions({ task, onActAsYou }: { task: Task; onActAsYou: (on: boolean) => void }) {
  const lent = task.lentKeys ?? [];
  const actsAsYou = task.securityMode === 'autonomous';
  const asks = [
    ...(actsAsYou ? [] : ['sending or booking as you']),
    ...GOAL_KEYS.filter((key) => !lent.includes(key.id)).map((key) => key.ask)
  ];
  const toggle = (id: (typeof GOAL_KEYS)[number]['id'], name: string) => {
    const on = lent.includes(id);
    void setGoalKeys(task.id, on ? lent.filter((item) => item !== id) : [...lent, id]).then(
      () => toast(on ? `${name}: asks first again.` : `${name}: allowed in this goal.`),
      (cause: unknown) => toast(cause instanceof Error ? cause.message : 'That did not change.')
    );
  };
  return (
    <details className="story-permissions">
      <summary>
        <h2 className="story-h">Asks before</h2>
        <span>{asks.length ? asks.join(', ') : 'Nothing: everything is allowed in this goal'}</span>
      </summary>
      <div className="permission-list">
        <button
          type="button"
          className="permission"
          aria-pressed={actsAsYou}
          onClick={() => onActAsYou(!actsAsYou)}
        >
          <span className="permission-name">Act as you</span>
          <span className="permission-state">{actsAsYou ? 'Allowed' : 'Asks first'}</span>
        </button>
        {GOAL_KEYS.map((key) => (
          <button
            key={key.id}
            type="button"
            className="permission"
            aria-pressed={lent.includes(key.id)}
            onClick={() => toggle(key.id, key.name)}
          >
            <span className="permission-name">{key.name}</span>
            <span className="permission-state">
              {lent.includes(key.id) ? 'Allowed' : 'Asks first'}
            </span>
          </button>
        ))}
        <p className="faint small">
          Spend: {money(task.spentUsd)}
          {task.maxSpendUsd ? ` of a ${money(task.maxSpendUsd)} cap` : ''}. Everything inside your
          computer can be undone; these are the things that reach outside it.
        </p>
      </div>
    </details>
  );
}

/** The newest version of every file a goal made, newest first. */
function latestVersions(artifacts: readonly Artifact[]): Artifact[] {
  const byName = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const held = byName.get(artifact.name);
    if (!held || artifact.version > held.version) byName.set(artifact.name, artifact);
  }
  return [...byName.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
