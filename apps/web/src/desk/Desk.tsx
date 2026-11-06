import { useEffect, useMemo } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import AskBar from '../ask/AskBar';
import { beds, growth } from '../app/derive';
import { go } from '../app/route';
import { primaryWorkspace, useGarden } from '../app/store';
import { useAsked } from '../home/recent';
import { moveKey } from '../today/Moves';
import Ghost from './Ghost';
import { DecisionTile, GoalTile } from './ObjectTile';
import { setReviewOrder } from './order';
import { useOutcomes } from './outcomes';
import '../today/today.css';
import './desk.css';

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
  const { decisions, following, working, results } = useMemo(
    () => arrange(tasks, moves, asked),
    [tasks, moves, asked]
  );
  const shown = useMemo(
    () =>
      [...following, ...working, ...results].map((task) => ({
        id: task.id,
        updatedAt: task.updatedAt
      })),
    [following, working, results]
  );
  useOutcomes(shown);
  useEffect(() => setReviewOrder(results.map((task) => task.id)), [results]);
  if (!bootstrap) return <div className="desk" aria-busy="true" />;
  const workspace = primaryWorkspace(bootstrap);
  const name = bootstrap.user.displayName?.split(' ')[0];
  const empty = !following.length && !decisions.length && !working.length && !results.length;
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
        {catchUp > 0 && (
          <button type="button" className="catchup-pill" onClick={() => go({ sheet: 'catchup' })}>
            {catchUp} changed since you last looked
          </button>
        )}
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
function arrange(tasks: readonly Task[], moves: readonly OwnerMove[], asked: readonly string[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const following = asked
    .map((id) => byId.get(id))
    .filter((task): task is Task => Boolean(task && !task.archivedAt));
  const followed = new Set(following.map((task) => task.id));
  const decisions = moves
    .filter((move) => !followed.has(move.taskId))
    .map((move) => ({ move, task: byId.get(move.taskId) }));
  const { growing, ready } = beds(tasks, moves);
  const working = growing.filter(
    (task) => !followed.has(task.id) && ['working', 'resting'].includes(growth(task, moves))
  );
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
  return { decisions, following, working, results };
}
