import { useState } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { accept, approve, raiseCapAndResume } from '../app/actions';
import {
  GROWTH_COLOR,
  GROWTH_WORD,
  ago,
  goalLine,
  growth,
  leaves,
  money,
  movesFor,
  raisedCap
} from '../app/derive';
import { Bloom, Check, Sprout } from '../app/icons';
import { openDeal, openGoal } from '../app/route';
import { toast } from '../app/toast';

/**
 * One goal on one line: what it is doing or needs, how far it has come, what it has spent, and the
 * one thing it is waiting on the owner for, answerable without opening it.
 */
export default function GoalRow({ task, moves }: { task: Task; moves: readonly OwnerMove[] }) {
  const state = growth(task, moves);
  const grown = leaves(task);
  const ready = state === 'ready';
  // A finished goal is described by what it ended with; one still growing, by what it needs or does.
  const line = ready ? task.activity?.latest || goalLine(task, moves) : goalLine(task, moves);
  const verified = task.activity?.ending?.verification === 'verified';
  return (
    <li
      className="goal-row"
      data-state={state}
      data-goal-id={task.id}
      style={{ '--glow': GROWTH_COLOR[state] } as React.CSSProperties}
    >
      <button
        type="button"
        className="goal-row-open"
        onClick={() => openGoal(task.id, ready ? 'glance' : 'look')}
        aria-label={`${task.title}. ${GROWTH_WORD[state]}. ${line}`}
      >
        {ready ? <Bloom className="goal-row-mark" /> : <Sprout className="goal-row-mark" />}
        <span className="goal-row-title">{task.title}</span>
        <span className="goal-row-line">{line}</span>
        {ready ? (
          <span className="goal-row-proof">
            {verified && (
              <span className="proof">
                <Check /> Checked
              </span>
            )}
          </span>
        ) : (
          <span className="goal-row-pips" aria-hidden="true">
            {Array.from({ length: grown.total }, (_, i) => (
              <span
                key={i}
                className={`pip ${i < grown.done ? 'is-done' : i === grown.done && grown.current ? 'is-drafted' : ''}`}
              />
            ))}
          </span>
        )}
        <span className="goal-row-spend num">
          {ready
            ? `${ago(task.completedAt)} · ${money(task.spentUsd)}`
            : `${money(task.spentUsd)}${task.maxSpendUsd ? ` of ${money(task.maxSpendUsd)}` : ''}`}
        </span>
      </button>
      <span className="goal-row-act">
        {ready ? (
          <AcceptAction task={task} />
        ) : (
          <RowAction task={task} move={movesFor(moves, task.id)[0]} state={GROWTH_WORD[state]} />
        )}
      </span>
    </li>
  );
}

/** Accepting files a finished goal away; the toast keeps it one press from coming back. */
function AcceptAction({ task }: { task: Task }) {
  return (
    <button
      type="button"
      className="btn small"
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
  );
}

function RowAction({
  task,
  move,
  state
}: {
  task: Task;
  move: OwnerMove | undefined;
  state: string;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, said: string) => {
    setBusy(true);
    try {
      await work();
      toast(said);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };
  if (!move) return <span className="goal-row-state">{state}</span>;
  switch (move.kind) {
    case 'deal':
      return (
        <button type="button" className="btn leaf small" onClick={() => openDeal(task.id)}>
          Review the deal
        </button>
      );
    case 'approval':
      return (
        <button
          type="button"
          className="btn leaf small"
          disabled={busy}
          onClick={() => void run(() => approve(move.approvalId), 'Approved.')}
        >
          Approve
        </button>
      );
    case 'spend': {
      const raised = raisedCap(move.spentUsd, move.maxSpendUsd);
      return (
        <button
          type="button"
          className="btn leaf small"
          disabled={busy}
          onClick={() => void run(() => raiseCapAndResume(task.id, raised), 'Carrying on.')}
        >
          Raise to {money(raised)}
        </button>
      );
    }
    default:
      return (
        <button type="button" className="btn small" onClick={() => openGoal(task.id)}>
          Answer
        </button>
      );
  }
}
