import type { Task } from '@garden/contracts';
import { accept } from '../app/actions';
import { ago, beds, dayStamp, money, verdict } from '../app/derive';
import { Check, Sprout } from '../app/icons';
import { go, openGoal } from '../app/route';
import { primaryWorkspace, useGarden } from '../app/store';
import { toast } from '../app/toast';
import GoalRow from './GoalRow';
import Moves from './Moves';
import Plant from './Plant';
import Rhythms from './Rhythms';
import ServerPane from './ServerPane';
import { askExample } from '../ask/ask-bus';
import './today.css';

/**
 * The desk. What is growing, what is ready, what needs the owner, what runs on its own, and how
 * much room the computer has left - each answering one question, none of them a feed.
 */
export default function Today({ catchUp }: { catchUp: boolean }) {
  const { bootstrap, moves } = useGarden();
  if (!bootstrap) return <TodaySkeleton />;
  const tasks = bootstrap.tasks;
  const name = bootstrap.user.displayName?.split(' ')[0] || 'there';
  const { growing, ready } = beds(tasks, moves);
  const hero = verdict(name, tasks, moves);
  const [first, ...rest] = hero.greeting.split(', ');
  return (
    <div className="today">
      <div className="today-main scroll">
        <header className="hero rise">
          <div className="eyebrow">{dayStamp()}</div>
          <h1 className="display">
            {first}, <em>{rest.join(', ')}</em>
          </h1>
          <p>{hero.line}</p>
          {catchUp && (
            <div className="hero-acts">
              <button
                type="button"
                className="btn primary"
                onClick={() => go({ sheet: 'catchup' })}
              >
                See what changed since you last looked
              </button>
            </div>
          )}
        </header>

        <section aria-labelledby="growing-title" className="bed">
          <div className="section-head">
            <h2 id="growing-title">Growing</h2>
            <span className="count">{growing.length ? `${growing.length}` : ''}</span>
          </div>
          {growing.length ? (
            <ul className="goal-rows rise" style={{ '--i': 2 } as React.CSSProperties}>
              {growing.map((task) => (
                <GoalRow key={task.id} task={task} moves={moves} />
              ))}
            </ul>
          ) : (
            <div className="seedbed rise" style={{ '--i': 2 } as React.CSSProperties}>
              <Sprout />
              <div>
                <h3 className="display">Nothing planted yet.</h3>
                <p>
                  Say what you want in one sentence. For anything substantial garden comes back with
                  a deal: what it will make, how you will know it is done, and what it may do
                  without you. Then it goes quiet.
                </p>
              </div>
              <button type="button" className="btn" onClick={askExample}>
                Try an example
              </button>
            </div>
          )}
        </section>

        {ready.length > 0 && (
          <section aria-labelledby="ready-title" className="bed">
            <div className="section-head">
              <h2 id="ready-title">Ready for you</h2>
              <span className="count">{ready.length}</span>
            </div>
            <ul className="ready-list">
              {ready.slice(0, 8).map((task, index) => (
                <ReadyItem key={task.id} task={task} index={index} />
              ))}
            </ul>
          </section>
        )}
      </div>
      <aside className="today-side scroll" aria-label="What needs you, what runs, and the computer">
        <Moves moves={moves} />
        <Rhythms schedules={bootstrap.schedules} />
        <ServerPane
          bootstrap={bootstrap}
          workspaceId={primaryWorkspace(bootstrap)?.id ?? null}
          tasks={tasks}
        />
      </aside>
    </div>
  );
}

function ReadyItem({ task, index }: { task: Task; index: number }) {
  const verified = task.activity?.ending?.verification === 'verified';
  const steps = task.activity?.stepsTotal ?? 0;
  return (
    <li className="ready-item rise" style={{ '--i': index + 3 } as React.CSSProperties}>
      <button type="button" className="ready-open" onClick={() => openGoal(task.id, 'glance')}>
        <Plant
          className="ready-plant"
          seed={task.id}
          total={Math.max(3, Math.min(steps, 9))}
          done={Math.max(3, Math.min(steps, 9))}
          current={false}
          bloom
          needs={false}
        />
        <span className="ready-text">
          <span className="ready-title">{task.title}</span>
          <span className="ready-line">{task.activity?.latest || 'Finished.'}</span>
          <span className="ready-proofs">
            {verified && (
              <span className="proof">
                <Check /> Checked
              </span>
            )}
            <span className="faint mono">
              {ago(task.completedAt)} · {money(task.spentUsd)}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="btn ghost small"
        onClick={() =>
          void accept(task.id).then(() =>
            toast(`Accepted “${task.title}”.`, {
              action: { label: 'Undo', run: () => void accept(task.id, false) }
            })
          )
        }
      >
        Accept
      </button>
    </li>
  );
}

function TodaySkeleton() {
  return (
    <div className="today" aria-busy="true">
      <div className="today-main">
        <div className="hero">
          <div className="skeleton" style={{ width: 220, height: 12 }} />
          <div className="skeleton" style={{ width: '60%', height: 64, marginTop: 14 }} />
          <div className="skeleton" style={{ width: '40%', height: 16, marginTop: 14 }} />
        </div>
      </div>
      <aside className="today-side">
        <div className="pane skeleton" style={{ height: 180 }} />
        <div className="pane skeleton" style={{ height: 220 }} />
      </aside>
    </div>
  );
}
