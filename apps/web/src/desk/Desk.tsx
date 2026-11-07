import { lazy, Suspense, useEffect, useMemo } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import AskBar from '../ask/AskBar';
import { beds, growth } from '../app/derive';
import { go, openGoal } from '../app/route';
import { primaryWorkspace, useGarden } from '../app/store';
import { useAsked } from '../home/recent';
import { moveKey } from '../today/Moves';
import Ghost from './Ghost';
import { DecisionTile, GoalTile } from './ObjectTile';
import { setReviewOrder } from './order';
import type { WaitingItem } from './Waiting';
import { useOutcomes } from './outcomes';
import '../today/today.css';
import './desk.css';

// Only a desk with decisions days old shows this card, so its code waits until one does.
const Waiting = lazy(() => import('./Waiting'));

/** How long a decision waits before it stops being news. */
const WAITING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const greetingFor = (hour: number) =>
  hour < 5 ? 'Still up' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';

/**
 * The desk: the ask, and everything that has come back or is coming, laid out as the work itself.
 *
 * There is no conversation here. A result is a page, a site, a table or an answer; work under way
 * is that thing assembling; what needs the owner is a decision made on its card. A result the
 * owner keeps leaves for the Library, so the desk only ever holds what still wants a look.
 */
export default function Desk({ catchUp }: { catchUp: number }) {
  const { bootstrap, moves } = useGarden();
  const asked = useAsked();
  const tasks = useMemo(() => bootstrap?.tasks ?? [], [bootstrap]);
  const { decisions, waiting, following, working, results } = useMemo(
    () => arrange(tasks, moves, asked),
    [tasks, moves, asked]
  );
  const shown = useMemo(
    () =>
      [...following, ...working, ...results].map((task) => ({
        id: task.id,
        updatedAt: task.updatedAt,
        status: task.status
      })),
    [following, working, results]
  );
  useOutcomes(shown);
  useEffect(() => setReviewOrder(results.map((task) => task.id)), [results]);
  if (!bootstrap) return <div className="desk" aria-busy="true" />;
  const workspace = primaryWorkspace(bootstrap);
  const name = bootstrap.user.displayName?.split(' ')[0];
  const empty =
    !following.length && !decisions.length && !waiting.length && !working.length && !results.length;
  return (
    <div className="desk">
      <section className="desk-ask" aria-label="Ask">
        {workspace && (
          <AskBar
            bootstrap={bootstrap}
            workspace={workspace}
            goal={null}
            moves={moves}
            variant="hero"
            placeholder={`${greetingFor(new Date().getHours())}${name ? `, ${name}` : ''}. What do you need?`}
          />
        )}
        <Ghost />
        <div className="desk-pills">
          {results.length > 1 && (
            <button
              type="button"
              className="review-pill"
              onClick={() => {
                const first = results[0];
                if (first) openGoal(first.id);
              }}
            >
              Review {results.length} results <span aria-hidden="true">→</span>
            </button>
          )}
          {catchUp > 0 && (
            <button type="button" className="catchup-pill" onClick={() => go({ sheet: 'catchup' })}>
              {catchUp} changed since you last looked
            </button>
          )}
        </div>
      </section>
      <div className="desk-board scroll">
        {empty ? (
          <p className="desk-clear">Your desk is clear.</p>
        ) : (
          <div className="board">
            {following.map((task) => (
              <GoalTile key={task.id} task={task} moves={moves} spotlight follow />
            ))}
            {decisions.map(({ move, task }) => (
              <DecisionTile key={moveKey(move)} move={move} task={task} />
            ))}
            {waiting.length > 0 && (
              <Suspense fallback={null}>
                <Waiting items={waiting} />
              </Suspense>
            )}
            {working.map((task, index) => (
              <GoalTile key={task.id} task={task} moves={moves} follow={index < 2} />
            ))}
            {results.map((task) => (
              <GoalTile key={task.id} task={task} moves={moves} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** What goes on the desk, in the order it wants the owner: theirs to decide, under way, back. */
function arrange(
  tasks: readonly Task[],
  moves: readonly OwnerMove[],
  asked: readonly string[],
  now = Date.now()
) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const following = asked
    .map((id) => byId.get(id))
    .filter((task): task is Task => Boolean(task && !task.archivedAt));
  const followed = new Set(following.map((task) => task.id));
  const open = moves
    .filter((move) => !followed.has(move.taskId))
    .map((move) => ({ move, task: byId.get(move.taskId) }));
  // A decision that has waited for days, or a goal left paused as long, is still the owner's but
  // no longer news: those share one card, so they cannot fill the first screen.
  const old = (at: string) => now - Date.parse(at) > WAITING_AFTER_MS;
  const decisions = open.filter(({ move }) => !old(move.at));
  const { growing, ready } = beds(tasks, moves);
  const idle = (task: Task) => growth(task, moves) === 'resting' && old(task.updatedAt);
  const working = growing.filter(
    (task) =>
      !followed.has(task.id) && ['working', 'resting'].includes(growth(task, moves)) && !idle(task)
  );
  const waiting: WaitingItem[] = [
    ...open
      .filter(({ move }) => old(move.at))
      .map(({ move, task }) => ({ kind: 'decision' as const, move, task })),
    ...growing
      .filter((task) => !followed.has(task.id) && idle(task))
      .map((task) => ({ kind: 'idle' as const, task }))
  ];
  const stopped = growing.filter(
    (task) => !followed.has(task.id) && growth(task, moves) === 'failed'
  );
  // An automation's runs are editions of one result: only the newest is on the desk.
  const editions = new Set<string>();
  const latest = ready.filter((task) => {
    if (followed.has(task.id)) return false;
    if (!task.scheduleId) return true;
    if (editions.has(task.scheduleId)) return false;
    editions.add(task.scheduleId);
    return true;
  });
  const results = [...latest, ...stopped].slice(0, 30);
  return { decisions, waiting, following, working, results };
}
