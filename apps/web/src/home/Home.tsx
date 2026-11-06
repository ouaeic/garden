import { useState } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import AskBar from '../ask/AskBar';
import { askWith } from '../ask/ask-bus';
import {
  GROWTH_COLOR,
  GROWTH_WORD,
  ago,
  beds,
  goalLine,
  growth,
  leaves,
  money,
  movesFor
} from '../app/derive';
import {
  Code,
  Doc,
  Globe,
  Image,
  Mail,
  Repeat,
  Search as Research,
  Slides,
  Table
} from '../app/icons';
import { go, openGoal } from '../app/route';
import { primaryWorkspace, useGarden } from '../app/store';
import { AcceptAction, RowAction } from '../today/GoalRow';
import { MoveCard, moveKey } from '../today/Moves';
import AnswerCard from './AnswerCard';
import { useAsked } from './recent';
import '../today/today.css';
import './home.css';

/**
 * The kinds of work people come for, each a sentence that starts the ask rather than a mode.
 *
 * Choosing one writes its opening into the input and leaves the cursor where the owner's own words
 * go, so a starter never commits anyone to a template.
 */
const STARTERS = [
  { label: 'Research', icon: Research, text: 'Research ' },
  { label: 'Write', icon: Doc, text: 'Write a ' },
  { label: 'Slides', icon: Slides, text: 'Make a slide deck about ' },
  { label: 'Site or app', icon: Globe, text: 'Build a website that ' },
  { label: 'Analyse data', icon: Table, text: 'Analyse ' },
  { label: 'Image', icon: Image, text: 'Create an image of ' },
  { label: 'Code', icon: Code, text: 'In my project, ' },
  { label: 'Email', icon: Mail, text: 'Go through my email and ' },
  { label: 'Automate', icon: Repeat, text: 'Every weekday at 8am, ' }
] as const;

const greetingFor = (hour: number) =>
  hour < 5
    ? 'Still up'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';

/**
 * Home. One input that takes any kind of ask, the answer to what was just asked, and three lanes:
 * what needs the owner, what is working, and what is ready - each answerable without leaving.
 */
export default function Home({ catchUp }: { catchUp: number }) {
  const { bootstrap, moves } = useGarden();
  const asked = useAsked();
  if (!bootstrap) return <div className="home" aria-busy="true" />;
  const workspace = primaryWorkspace(bootstrap);
  const tasks = bootstrap.tasks;
  const name = bootstrap.user.displayName?.split(' ')[0];
  const { growing, ready } = beds(tasks, moves);
  // What was just asked is shown in its card above; the lanes hold everything else.
  const shown = new Set(asked);
  const working = growing.filter((task) => !shown.has(task.id) && growth(task, moves) !== 'needs');
  const waiting = moves.filter((move) => !shown.has(move.taskId));
  return (
    <div className="home">
      <section className="home-ask" aria-label="Ask">
        <header className="home-hello">
          <h1>
            {greetingFor(new Date().getHours())}
            {name ? `, ${name}` : ''}.
          </h1>
          {catchUp > 0 && (
            <button type="button" className="catchup-pill" onClick={() => go({ sheet: 'catchup' })}>
              {catchUp} changed since you last looked · Catch up
            </button>
          )}
        </header>
        {workspace && (
          <AskBar
            bootstrap={bootstrap}
            workspace={workspace}
            goal={null}
            moves={moves}
            variant="hero"
          />
        )}
        {!asked.length && (
          <div className="starters" aria-label="Start with">
            {STARTERS.map((starter) => (
              <button
                key={starter.label}
                type="button"
                className="starter"
                onClick={() => askWith(starter.text)}
              >
                <starter.icon /> {starter.label}
              </button>
            ))}
          </div>
        )}
        {asked.length > 0 && (
          <div className="answers">
            {asked.map((id) => (
              <AnswerCard
                key={id}
                taskId={id}
                task={tasks.find((task) => task.id === id)}
                moves={moves}
              />
            ))}
          </div>
        )}
      </section>

      <div className="home-lanes">
        <Lane title="Needs you" count={waiting.length} tone="needs" empty="Nothing needs you.">
          <NeedsList moves={waiting} />
        </Lane>
        <Lane
          title="Working"
          count={working.length}
          tone="working"
          empty="Nothing is running. Ask for something above."
          more={() => go({ view: 'goals' })}
        >
          {working.length > 0 && (
            <ul className="lane-rows">
              {working.map((task) => (
                <LaneRow key={task.id} task={task} moves={moves} />
              ))}
            </ul>
          )}
        </Lane>
        <Lane
          title="Ready"
          count={ready.length}
          tone="ready"
          empty="Finished work waits here for you to look over."
          more={() => go({ view: 'library' })}
        >
          {ready.length > 0 && <ReadyList tasks={ready} moves={moves} />}
        </Lane>
      </div>
    </div>
  );
}

function Lane({
  title,
  count,
  tone,
  empty,
  more,
  children
}: {
  title: string;
  count: number;
  tone: 'needs' | 'working' | 'ready';
  empty: string;
  more?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`home-lane is-${tone}`} aria-label={title}>
      <header className="lane-head">
        <h2>{title}</h2>
        {count > 0 && <span className="lane-count">{count}</span>}
        {more && (
          <button type="button" className="link lane-more" onClick={more}>
            See all
          </button>
        )}
      </header>
      <div className="lane-body scroll">
        {count > 0 ? children : <p className="lane-empty">{empty}</p>}
      </div>
    </section>
  );
}

/** Every waiting move as its own card, answered in place; none of them hides behind another. */
function NeedsList({ moves }: { moves: readonly OwnerMove[] }) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const live = moves.filter((move) => !gone.has(moveKey(move)));
  if (!live.length) return <p className="lane-empty">Nothing needs you.</p>;
  return (
    <div className="needs-list">
      {live.map((move) => (
        <MoveCard
          key={moveKey(move)}
          move={move}
          top
          onDone={() => setGone((set) => new Set(set).add(moveKey(move)))}
        />
      ))}
    </div>
  );
}

function ReadyList({ tasks, moves }: { tasks: readonly Task[]; moves: readonly OwnerMove[] }) {
  return (
    <ul className="lane-rows">
      {tasks.slice(0, 20).map((task) => (
        <LaneRow key={task.id} task={task} moves={moves} />
      ))}
    </ul>
  );
}

/**
 * A goal in a lane: its name, what it is doing or ended with, how far it has come, and the one
 * thing it can be answered with from here.
 */
function LaneRow({ task, moves }: { task: Task; moves: readonly OwnerMove[] }) {
  const state = growth(task, moves);
  const ready = state === 'ready';
  const grown = leaves(task);
  const verified = task.activity?.ending?.verification === 'verified';
  const line = ready ? task.activity?.latest || goalLine(task, moves) : goalLine(task, moves);
  return (
    <li
      className="lane-row"
      data-state={state}
      data-goal-id={task.id}
      style={{ '--glow': GROWTH_COLOR[state] } as React.CSSProperties}
    >
      <button
        type="button"
        className="lane-row-open"
        onClick={() => openGoal(task.id)}
        aria-label={`${task.title}. ${GROWTH_WORD[state]}. ${line}`}
      >
        <span className="lane-row-title">{task.title}</span>
        <span className="lane-row-line">{line}</span>
        <span className="lane-row-meta num">
          {ready ? (
            <>
              {verified && <span className="lane-row-proof">Checked</span>}
              {ago(task.completedAt)} · {money(task.spentUsd)}
            </>
          ) : (
            <>
              <span className="lane-row-pips" aria-hidden="true">
                {Array.from({ length: grown.total }, (_, i) => (
                  <span
                    key={i}
                    className={`pip ${i < grown.done ? 'is-done' : i === grown.done && grown.current ? 'is-drafted' : ''}`}
                  />
                ))}
              </span>
              {money(task.spentUsd)}
              {task.maxSpendUsd ? ` of ${money(task.maxSpendUsd)}` : ''}
            </>
          )}
        </span>
      </button>
      <span className="lane-row-act">
        {ready ? (
          <AcceptAction task={task} />
        ) : movesFor(moves, task.id)[0] ? (
          <RowAction task={task} move={movesFor(moves, task.id)[0]} state={GROWTH_WORD[state]} />
        ) : null}
      </span>
    </li>
  );
}
