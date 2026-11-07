import { useState } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { accept } from '../app/actions';
import { ago } from '../app/derive';
import { openGoal } from '../app/route';
import { toast } from '../app/toast';
import { moveKey } from '../today/Moves';
import { DecisionFace } from './faces';

/** How long a decision waits before it stops being news. */
export const WAITING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const WHAT: Record<OwnerMove['kind'], string> = {
  spend: 'Paused at its spending cap',
  approval: 'Wants your permission',
  question: 'Has a question for you',
  handoff: 'Needs you to take a step',
  deal: 'Has a plan for you to agree'
};

const monthDay = (at: number) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);

/**
 * Decisions that have waited more than a few days, folded into one card. They still need the
 * owner, so they stay on the desk; but a pause from weeks ago does not get to push this morning's
 * results off the first screen. Each is one line that opens into its own card, and setting one
 * aside files its goal away the way keeping a result does, with the same undo.
 */
export default function Waiting({
  items
}: {
  items: readonly { move: OwnerMove; task: Task | undefined }[];
}) {
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const shown = items.filter(({ move }) => !gone.has(moveKey(move)));
  if (!shown.length) return null;
  const leave = (key: string) => setGone((current) => new Set([...current, key]));
  const oldest = Math.min(...shown.map(({ move }) => Date.parse(move.at)));
  const opened = shown.find(({ move }) => moveKey(move) === open);
  return (
    <article
      className={`obj ${shown.length > 3 ? 'size-w' : 'size-s'} is-waiting`}
      aria-label="Waiting on you for days"
    >
      <div className="obj-face face-waiting">
        {opened ? (
          <div className="waiting-open">
            <button type="button" className="waiting-back" onClick={() => setOpen(null)}>
              <span aria-hidden="true">←</span> All {shown.length} waiting
            </button>
            <DecisionFace
              move={opened.move}
              onDone={() => {
                leave(moveKey(opened.move));
                setOpen(null);
              }}
            />
          </div>
        ) : (
          <>
            <p className="waiting-kicker">Waiting on you since {monthDay(oldest)}</p>
            <ul className="waiting-list">
              {shown.map(({ move }) => {
                const key = moveKey(move);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="waiting-goal"
                      onClick={() => setOpen(key)}
                      aria-label={`${move.taskTitle}. ${WHAT[move.kind]}. Answer`}
                    >
                      <span className="waiting-title">{move.taskTitle}</span>
                      <span className="waiting-what">
                        {WHAT[move.kind]} · {ago(move.at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="waiting-aside"
                      title="Set it aside: the goal is filed away and stays in search"
                      onClick={() => {
                        leave(key);
                        void accept(move.taskId).then(
                          () =>
                            toast(`Set “${move.taskTitle}” aside.`, {
                              action: {
                                label: 'Undo',
                                run: () => {
                                  setGone((current) => {
                                    const next = new Set(current);
                                    next.delete(key);
                                    return next;
                                  });
                                  void accept(move.taskId, false);
                                }
                              }
                            }),
                          (cause: unknown) => {
                            setGone((current) => {
                              const next = new Set(current);
                              next.delete(key);
                              return next;
                            });
                            toast(
                              cause instanceof Error ? cause.message : 'That did not go through.'
                            );
                          }
                        );
                      }}
                    >
                      Set aside
                    </button>
                    <button
                      type="button"
                      className="waiting-visit"
                      title="Open the goal"
                      aria-label={`Open “${move.taskTitle}”`}
                      onClick={() => openGoal(move.taskId)}
                    >
                      <span aria-hidden="true">↗</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </article>
  );
}
