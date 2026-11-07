import { useState } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { accept } from '../app/actions';
import { ago } from '../app/derive';
import { openGoal } from '../app/route';
import { toast } from '../app/toast';
import { moveKey } from '../today/Moves';
import { DecisionFace } from './faces';
import './waiting.css';

/** Something that has waited on the owner for days: a decision, or a goal left paused. */
export type WaitingItem =
  | { kind: 'decision'; move: OwnerMove; task: Task | undefined }
  | { kind: 'idle'; task: Task };

const WHAT: Record<OwnerMove['kind'], string> = {
  spend: 'Paused at its spending cap',
  approval: 'Wants your permission',
  question: 'Has a question for you',
  handoff: 'Needs you to take a step',
  deal: 'Has a plan for you to agree'
};

const keyOf = (item: WaitingItem) =>
  item.kind === 'decision' ? moveKey(item.move) : `idle:${item.task.id}`;
const taskIdOf = (item: WaitingItem) =>
  item.kind === 'decision' ? item.move.taskId : item.task.id;
const titleOf = (item: WaitingItem) =>
  item.kind === 'decision' ? item.move.taskTitle : item.task.title;
const sinceOf = (item: WaitingItem) =>
  item.kind === 'decision' ? item.move.at : item.task.updatedAt;
const whatOf = (item: WaitingItem) => (item.kind === 'decision' ? WHAT[item.move.kind] : 'Paused');

const monthDay = (at: number) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);

/**
 * What has waited on the owner for more than a few days, folded into one card: decisions nobody
 * answered and goals left paused. They are still the owner's, so they stay on the desk; but a pause
 * from weeks ago does not get to push this morning's results off the first screen. A decision opens
 * into its own card here; a paused goal opens as itself. Setting one aside files its goal away the
 * way keeping a result does, with the same undo.
 */
export default function Waiting({ items }: { items: readonly WaitingItem[] }) {
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const shown = items.filter((item) => !gone.has(keyOf(item)));
  if (!shown.length) return null;
  const leave = (key: string) => setGone((current) => new Set([...current, key]));
  const back = (key: string) =>
    setGone((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  const oldest = Math.min(...shown.map((item) => Date.parse(sinceOf(item))));
  const opened = shown.find(
    (item): item is Extract<WaitingItem, { kind: 'decision' }> =>
      item.kind === 'decision' && keyOf(item) === open
  );
  const setAside = (item: WaitingItem) => {
    const key = keyOf(item);
    const title = titleOf(item);
    const taskId = taskIdOf(item);
    leave(key);
    void accept(taskId).then(
      () =>
        toast(`Set “${title}” aside.`, {
          action: {
            label: 'Undo',
            run: () => {
              back(key);
              void accept(taskId, false);
            }
          }
        }),
      (cause: unknown) => {
        back(key);
        toast(cause instanceof Error ? cause.message : 'That did not go through.');
      }
    );
  };
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
                leave(keyOf(opened));
                setOpen(null);
              }}
            />
          </div>
        ) : (
          <>
            <p className="waiting-kicker">Waiting on you since {monthDay(oldest)}</p>
            <ul className="waiting-list">
              {shown.map((item) => {
                const key = keyOf(item);
                const title = titleOf(item);
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className="waiting-goal"
                      onClick={() =>
                        item.kind === 'decision' ? setOpen(key) : openGoal(item.task.id)
                      }
                      aria-label={`${title}. ${whatOf(item)}. ${item.kind === 'decision' ? 'Answer' : 'Open'}`}
                    >
                      <span className="waiting-title">{title}</span>
                      <span className="waiting-what">
                        {whatOf(item)} · {ago(sinceOf(item))}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="waiting-aside"
                      title="Set it aside: the goal is filed away and stays in search"
                      onClick={() => setAside(item)}
                    >
                      Set aside
                    </button>
                    <button
                      type="button"
                      className="waiting-visit"
                      title="Open the goal"
                      aria-label={`Open “${title}”`}
                      onClick={() => openGoal(taskIdOf(item))}
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
