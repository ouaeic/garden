import type { OwnerMove, Task } from '@garden/contracts';
import { GROWTH_COLOR, GROWTH_WORD, goalLine, growth, leaves, money } from '../app/derive';
import { openGoal } from '../app/route';
import Plant from './Plant';

/** One goal in the bed: its plant, what it is doing, and how far it has come. */
export default function GoalCard({
  task,
  moves,
  index
}: {
  task: Task;
  moves: readonly OwnerMove[];
  index: number;
}) {
  const state = growth(task, moves);
  const grown = leaves(task);
  const line = goalLine(task, moves);
  return (
    <button
      type="button"
      className="goal-card rise"
      style={{ '--i': index, '--glow': GROWTH_COLOR[state] } as React.CSSProperties}
      data-state={state}
      data-goal-id={task.id}
      onClick={() => openGoal(task.id)}
      aria-label={`${task.title}. ${GROWTH_WORD[state]}. ${line}`}
    >
      <span className="tag goal-tag">{GROWTH_WORD[state]}</span>
      <div className="goal-plant">
        <Plant
          seed={task.id}
          total={grown.total}
          done={grown.done}
          current={grown.current && state === 'working'}
          bloom={state === 'ready'}
          needs={state === 'needs'}
        />
      </div>
      <div className="goal-body">
        <div className="eyebrow">{task.scheduleId ? 'Rhythm' : 'Goal'}</div>
        <h3>{task.title}</h3>
        <p className="goal-line">
          <span className={`dot ${state === 'working' ? 'live' : ''}`} />
          <span>{line}</span>
        </p>
        <div className="pips" aria-hidden="true">
          {Array.from({ length: grown.total }, (_, i) => (
            <span
              key={i}
              className={`pip ${i < grown.done ? 'is-done' : i === grown.done && grown.current ? 'is-drafted' : ''}`}
            />
          ))}
        </div>
        <div className="goal-meta num">
          <span>
            {grown.done} of {grown.total} done
          </span>
          <span>
            {money(task.spentUsd)}
            {task.maxSpendUsd ? ` / ${money(task.maxSpendUsd)}` : ''}
          </span>
        </div>
      </div>
    </button>
  );
}
