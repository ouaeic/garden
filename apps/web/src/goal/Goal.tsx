import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@garden/contracts';
import { get } from '../client';
import { useTaskRecord } from '../useTaskRecord';
import { accept, setTaskKeys, taskAction } from '../app/actions';
import { GROWTH_COLOR, GROWTH_WORD, goalLine, growth, leaves, money } from '../app/derive';
import { Back, Close, Eye, Mic, More, Pause, Play, Stop } from '../app/icons';
import { go, type Zoom } from '../app/route';
import { putTask, refreshSoon, useGarden } from '../app/store';
import { toast } from '../app/toast';
import Plant from '../today/Plant';
import Look from './Look';
import { doneWhen, notesFrom } from './timeline';
import './goal.css';

const Inspect = lazy(() => import('./Inspect'));
const Watch = lazy(() => import('./Watch'));
const GoalMore = lazy(() => import('./GoalMore'));
const VoiceSession = lazy(() => import('../voice/VoiceSession'));
const ZOOMS: { zoom: Zoom; label: string }[] = [
  { zoom: 'glance', label: 'Glance' },
  { zoom: 'look', label: 'Look' },
  { zoom: 'inspect', label: 'Inspect' }
];

/**
 * One goal, at three distances. Glance is a sentence and a plant; Look is the work itself with
 * what it is for, how far it has come and what it has noticed; Inspect is every action exactly.
 * The same record underneath all three, so zooming never changes the facts, only how many.
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
          Back to Today
        </button>
      </div>
    );
  if (!task) return <div className="view-loading" aria-busy="true" />;
  return <GoalRecord task={task} zoom={zoom} onTask={setLoaded} />;
}

function GoalRecord({
  task,
  zoom,
  onTask
}: {
  task: Task;
  zoom: Zoom;
  onTask: (task: Task) => void;
}) {
  const { moves } = useGarden();
  const record = useTaskRecord({
    taskId: task.id,
    workspaceId: task.workspaceId,
    onTask: (next) => {
      onTask(next);
      putTask(next);
    },
    onRefresh: refreshSoon
  });
  const [watching, setWatching] = useState(false);
  const [more, setMore] = useState(false);
  const [talking, setTalking] = useState(false);
  const state = growth(task, moves);
  const notes = useMemo(() => notesFrom(record.events), [record.events]);
  const agreed = useMemo(() => doneWhen(record.events), [record.events]);
  const finished = ['completed', 'failed', 'cancelled'].includes(task.status);

  const act = async (work: () => Promise<unknown>, said: string) => {
    try {
      await work();
      toast(said);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not go through.');
    }
  };

  return (
    <div className="goal" style={{ '--glow': GROWTH_COLOR[state] } as React.CSSProperties}>
      <header className="goal-head">
        <button type="button" className="btn ghost small" onClick={() => go({ view: 'today' })}>
          <Back /> Today
        </button>
        <div className="goal-title">
          <div className="eyebrow">
            {task.scheduleId ? 'Rhythm run' : 'Goal'} · planted{' '}
            {new Date(task.createdAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short'
            })}
            {task.securityMode === 'autonomous' ? ' · acts as you' : ''}
          </div>
          <h1 className="display">{task.title}</h1>
        </div>
        <span className="tag" style={{ '--c': GROWTH_COLOR[state] } as React.CSSProperties}>
          <span className={`dot ${state === 'working' ? 'live' : ''}`} />
          {GROWTH_WORD[state]}
        </span>
        <ZoomTabs zoom={zoom} />
        <div className="goal-acts">
          <button
            type="button"
            className="btn small"
            aria-pressed={watching}
            onClick={() => setWatching((on) => !on)}
          >
            <Eye /> <span>Watch the computer</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Talk it through"
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
                onClick={() => void act(() => taskAction(task.id, 'resume'), 'Resumed.')}
              >
                <Play />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn"
                aria-label="Pause at the next safe point"
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
            onClick={() => setMore(true)}
          >
            <More />
          </button>
          {task.status === 'completed' && (
            <button
              type="button"
              className="btn leaf small"
              onClick={() =>
                void act(
                  () => accept(task.id, !task.archivedAt),
                  task.archivedAt ? 'Back on the desk.' : 'Accepted and put away.'
                )
              }
            >
              {task.archivedAt ? 'Put back' : 'Accept'}
            </button>
          )}
        </div>
      </header>

      <div className="goal-body" data-zoom={zoom}>
        {zoom === 'glance' && (
          <section className="glance-view rise" aria-label="At a glance">
            <Plant
              className="glance-plant"
              seed={task.id}
              total={leaves(task).total}
              done={leaves(task).done}
              current={leaves(task).current && state === 'working'}
              bloom={state === 'ready' || state === 'done'}
              needs={state === 'needs'}
            />
            <h2 className="display">{goalLine(task, moves)}</h2>
            <dl className="glance-stats num">
              <div>
                <dt>steps done</dt>
                <dd>
                  {leaves(task).done} / {leaves(task).total}
                </dd>
              </div>
              <div>
                <dt>spent{task.maxSpendUsd ? ` of ${money(task.maxSpendUsd)}` : ''}</dt>
                <dd>{money(task.spentUsd)}</dd>
              </div>
              <div>
                <dt>{finished ? 'finished' : 'notes so far'}</dt>
                <dd>
                  {finished && task.completedAt
                    ? new Date(task.completedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit'
                      })
                    : notes.length}
                </dd>
              </div>
            </dl>
            <button type="button" className="btn" onClick={() => go({ zoom: 'look' })}>
              Look at the work
            </button>
          </section>
        )}
        {zoom === 'look' && (
          <Look
            task={task}
            record={record}
            notes={notes}
            doneWhen={agreed}
            onActAsYou={(on) =>
              void act(
                () => setTaskKeys(task.id, on),
                on ? 'Lent: it may act as you within this goal.' : 'Taken back: it will ask first.'
              )
            }
          />
        )}
        {zoom === 'inspect' && (
          <Suspense fallback={<div className="view-loading" />}>
            <Inspect
              task={task}
              events={record.events}
              onBranched={(next) => go({ view: 'goal', goal: next.id })}
            />
          </Suspense>
        )}
      </div>

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

function ZoomTabs({ zoom }: { zoom: Zoom }) {
  const tabs = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const active = tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (active) setThumb({ left: active.offsetLeft, width: active.offsetWidth });
  }, [zoom]);
  return (
    <div className="zoom" role="tablist" aria-label="How close to look" ref={tabs}>
      {thumb && <span className="zoom-thumb" style={{ left: thumb.left, width: thumb.width }} />}
      {ZOOMS.map((item) => (
        <button
          key={item.zoom}
          type="button"
          role="tab"
          aria-selected={zoom === item.zoom}
          onClick={() => go({ zoom: item.zoom }, { replace: true })}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
