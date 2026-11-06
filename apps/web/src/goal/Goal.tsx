import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ResultNote, Task } from '@garden/contracts';
import { get } from '../client';
import { useTaskRecord } from '../useTaskRecord';
import { setDirection, useDirection } from '../ask/direction';
import { withNote } from '../result-notes';
import AskBar from '../ask/AskBar';
import { accept, setTaskKeys, taskAction } from '../app/actions';
import { GROWTH_COLOR, growth } from '../app/derive';
import { Back, Check, Close, Eye, Mic, More, Pause, Play, Stop } from '../app/icons';
import { go, openGoal, type Zoom } from '../app/route';
import { primaryWorkspace, putTask, refreshSoon, useGarden } from '../app/store';
import { toast } from '../app/toast';
import { formInProgress, formOf } from '../desk/forms';
import { flyToLibrary, growFromOrigin } from '../desk/motion';
import { neighbours } from '../desk/order';
import { outcomeOf, useOutcomes } from '../desk/outcomes';
import Note from '../sheet/Note';
import Story from '../sheet/Story';
import Work from '../sheet/Work';
import { doneWhen, notesFrom } from './timeline';
import './goal.css';
import '../sheet/sheet.css';

const Inspect = lazy(() => import('./Inspect'));
const Watch = lazy(() => import('./Watch'));
const GoalMore = lazy(() => import('./GoalMore'));
const VoiceSession = lazy(() => import('../voice/VoiceSession'));

/**
 * One goal, opened: the work at full size in its own form, the cover note beside it, and a bar
 * beneath that changes it. Every step is one switch away for whoever wants it exactly.
 */
export default function Goal({ id, zoom }: { id: string; zoom: Zoom }) {
  const { bootstrap } = useGarden();
  const listed = bootstrap?.tasks.find((task) => task.id === id) ?? null;
  const [loaded, setLoaded] = useState<Task | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (listed) return;
    void get<Task>(`/v1/tasks/${id}`).then(setLoaded, () => setMissing(true));
  }, [id, listed]);
  const task = listed ?? loaded;
  if (missing)
    return (
      <div className="goal-missing">
        <h1 className="display">This goal is not here any more.</h1>
        <button type="button" className="btn" onClick={() => go({ view: 'today' })}>
          Back to the desk
        </button>
      </div>
    );
  if (!task) return <div className="view-loading" aria-busy="true" />;
  return <GoalSheet task={task} zoom={zoom} onTask={setLoaded} />;
}

function GoalSheet({
  task,
  zoom,
  onTask
}: {
  task: Task;
  zoom: Zoom;
  onTask: (task: Task) => void;
}) {
  const { moves, bootstrap } = useGarden();
  const workspace = primaryWorkspace(bootstrap);
  const model = bootstrap?.models.find((item) => item.id === task.modelId);
  const record = useTaskRecord({
    taskId: task.id,
    workspaceId: task.workspaceId,
    onTask: (next) => {
      onTask(next);
      putTask(next);
    },
    onRefresh: refreshSoon
  });
  useOutcomes([{ id: task.id, updatedAt: task.updatedAt }]);
  const outcome = outcomeOf(task.id);
  const [watching, setWatching] = useState(false);
  const [more, setMore] = useState(false);
  const [talking, setTalking] = useState(false);
  const [story, setStory] = useState(false);
  const state = growth(task, moves);
  const working = state === 'working' || state === 'resting';
  const form = working ? formInProgress(task, outcome) : formOf(task, outcome);
  const notes = useMemo(() => notesFrom(record.events), [record.events]);
  const agreed = useMemo(() => doneWhen(record.events), [record.events]);
  const finished = ['completed', 'failed', 'cancelled'].includes(task.status);
  const review = neighbours(task.id);
  const direction = useDirection(task.id);
  const comments = direction?.kind === 'notes' ? direction.notes : [];
  const addComment = (note: ResultNote) => {
    setDirection(task.id, withNote(direction, note));
    requestAnimationFrame(() =>
      document.getElementById('ask-input')?.focus({ preventScroll: true })
    );
  };
  const doing = [...record.events]
    .reverse()
    .find(
      (event) =>
        ['tool_started', 'plan', 'notice', 'subagent', 'status'].includes(event.kind) &&
        event.summary?.trim()
    )?.summary;

  const workRef = useRef<HTMLElement>(null);
  useEffect(() => growFromOrigin(task.id, workRef.current), [task.id]);

  const act = async (work: () => Promise<unknown>, said: string) => {
    try {
      await work();
      toast(said);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not go through.');
    }
  };
  // Keeping a result files it and moves on to the next one, so a morning's work is reviewed in a
  // run of single presses rather than a trip back to the desk each time.
  const keep = async () => {
    const next = review.next ?? review.previous;
    await flyToLibrary(workRef.current);
    await act(() => accept(task.id), `Kept “${task.title}” in the Library.`);
    if (next) openGoal(next);
    else go({ view: 'today' });
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'ArrowRight' && review.next) openGoal(review.next);
      else if (event.key === 'ArrowLeft' && review.previous) openGoal(review.previous);
      else if (event.key === 'Escape' && !story) go({ view: 'today' });
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, [review.next, review.previous, story]);

  return (
    <div className="sheetview" style={{ '--glow': GROWTH_COLOR[state] } as React.CSSProperties}>
      <header className="sv-head">
        <button
          type="button"
          className="sv-back"
          onClick={() => go({ view: 'today' })}
          aria-label="Back to the desk"
        >
          <Back /> <span>Desk</span>
        </button>
        <h1 className="sv-title">{task.title}</h1>
        {review.of > 1 && (
          <span className="sv-review" aria-label={`Result ${review.at} of ${review.of}`}>
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous result"
              disabled={!review.previous}
              onClick={() => review.previous && openGoal(review.previous)}
            >
              <Back />
            </button>
            <span className="num">
              {review.at} of {review.of}
            </span>
            <button
              type="button"
              className="icon-btn sv-next"
              aria-label="Next result"
              disabled={!review.next}
              onClick={() => review.next && openGoal(review.next)}
            >
              <Back />
            </button>
          </span>
        )}
        <div className="sv-tools">
          <span className="seg" role="group" aria-label="How close to look">
            <button
              type="button"
              aria-pressed={zoom !== 'inspect'}
              onClick={() => go({ zoom: 'look' }, { replace: true })}
            >
              The work
            </button>
            <button
              type="button"
              aria-pressed={zoom === 'inspect'}
              onClick={() => go({ zoom: 'inspect' }, { replace: true })}
            >
              Every step
            </button>
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Watch its computer"
            title="Watch its computer"
            aria-pressed={watching}
            onClick={() => setWatching((on) => !on)}
          >
            <Eye />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Talk it through"
            title="Talk it through"
            aria-pressed={talking}
            onClick={() => setTalking((on) => !on)}
          >
            <Mic />
          </button>
          {!finished &&
            (task.status === 'paused' ? (
              <button
                type="button"
                className="icon-btn"
                aria-label="Resume"
                title="Resume"
                onClick={() => void act(() => taskAction(task.id, 'resume'), 'Resumed.')}
              >
                <Play />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn"
                aria-label="Pause at the next safe point"
                title="Pause"
                onClick={() =>
                  void act(() => taskAction(task.id, 'pause'), 'Paused at the next safe point.')
                }
              >
                <Pause />
              </button>
            ))}
          {!finished && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Stop this goal"
              title="Stop"
              onClick={() =>
                void act(
                  () => taskAction(task.id, 'cancel'),
                  'Stopped. Everything it made is kept.'
                )
              }
            >
              <Stop />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="More about this goal"
            title="Name, sharing, delete"
            onClick={() => setMore(true)}
          >
            <More />
          </button>
        </div>
      </header>

      {zoom === 'inspect' ? (
        <div className="sv-inspect">
          <Suspense fallback={<div className="view-loading" />}>
            <Inspect
              task={task}
              events={record.events}
              onBranched={(next) => go({ view: 'goal', goal: next.id })}
            />
          </Suspense>
        </div>
      ) : (
        <div className="sv-body">
          <section className="sv-work scroll" ref={workRef} aria-label="The work">
            {record.error ? (
              <p className="work-fault" role="alert">
                {record.error instanceof Error
                  ? record.error.message
                  : 'Some of this goal could not be loaded.'}
                <button type="button" className="link" onClick={() => void record.reload()}>
                  Try again
                </button>
              </p>
            ) : null}
            <Work
              task={task}
              moves={moves}
              record={record}
              outcome={outcome}
              form={form}
              working={working}
              comments={comments}
              onNote={addComment}
            />
          </section>
          <aside className="sv-note scroll" aria-label={story ? 'How it was made' : 'The note'}>
            {story ? (
              <Story
                task={task}
                events={record.events}
                plan={record.plan}
                notes={notes}
                doneWhen={agreed}
                onActAsYou={(on) =>
                  void act(
                    () => setTaskKeys(task.id, on),
                    on ? 'It may act as you within this goal.' : 'It asks first again.'
                  )
                }
                onClose={() => setStory(false)}
              />
            ) : (
              <Note
                task={task}
                moves={moves}
                outcome={outcome}
                form={form}
                working={working}
                doing={doing}
                modelName={model?.displayName}
                onStory={() => setStory(true)}
              />
            )}
          </aside>
        </div>
      )}

      <footer className="sv-dock">
        {workspace && bootstrap && (
          <AskBar
            bootstrap={bootstrap}
            workspace={workspace}
            goal={task}
            moves={moves}
            freshable={false}
            placeholder={
              working
                ? 'Tell it something while it works'
                : 'Change something, or select part of the work first'
            }
          />
        )}
        {task.status === 'completed' && !task.archivedAt && (
          <button type="button" className="btn leaf sv-keep" onClick={() => void keep()}>
            <Check /> Keep
          </button>
        )}
      </footer>

      <Suspense fallback={null}>
        {more && (
          <GoalMore task={task} artifacts={record.artifacts} onClose={() => setMore(false)} />
        )}
        {talking && (
          <aside className="talk" aria-label="Talk it through">
            <VoiceSession
              task={task}
              onClose={() => setTalking(false)}
              onTaskChanged={refreshSoon}
            />
          </aside>
        )}
      </Suspense>
      {watching && (
        <aside className="watch" aria-label="The computer, live">
          <header>
            <span className="dot live" style={{ '--c': 'var(--rose)' } as React.CSSProperties} />
            <span>Live on your computer</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close the live view"
              onClick={() => setWatching(false)}
            >
              <Close />
            </button>
          </header>
          <Suspense fallback={<div className="watch-loading">Connecting…</div>}>
            <Watch workspaceId={task.workspaceId} taskId={task.id} />
          </Suspense>
        </aside>
      )}
    </div>
  );
}
