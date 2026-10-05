import type { OwnerMove, Task } from '@garden/contracts';

/**
 * What a goal looks like from the desk, worked out from the task and the moves alone.
 *
 * Pure, so the plant on a card, the dot in the header and the sentence at the top of Today can
 * never disagree about the same conversation.
 */
export type Growth = 'working' | 'needs' | 'resting' | 'ready' | 'done' | 'failed' | 'stopped';

export const GROWTH_WORD: Record<Growth, string> = {
  working: 'Growing',
  needs: 'Needs you',
  resting: 'Resting',
  ready: 'Ready',
  done: 'Accepted',
  failed: 'Stopped short',
  stopped: 'Stopped'
};

export const GROWTH_COLOR: Record<Growth, string> = {
  working: 'var(--leaf)',
  needs: 'var(--dew)',
  resting: 'var(--ink-3)',
  ready: 'var(--bloom)',
  done: 'var(--bloom)',
  failed: 'var(--rose)',
  stopped: 'var(--ink-3)'
};

export const movesFor = (moves: readonly OwnerMove[], taskId: string) =>
  moves.filter((move) => move.taskId === taskId);

export function growth(task: Task, moves: readonly OwnerMove[]): Growth {
  if (task.spendPausedAt || task.status === 'awaiting_user' || movesFor(moves, task.id).length)
    return 'needs';
  switch (task.status) {
    case 'completed':
      return task.archivedAt ? 'done' : 'ready';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    case 'paused':
    case 'awaiting_resource':
    case 'draft':
      return 'resting';
    default:
      return 'working';
  }
}

const DAY = 86_400_000;

/** The beds on Today: what is growing, and what has finished and is waiting to be read. */
export function beds(tasks: readonly Task[], moves: readonly OwnerMove[], now = Date.now()) {
  const growing: Task[] = [];
  const ready: Task[] = [];
  for (const task of tasks) {
    if (task.archivedAt || task.parentMissionId) continue;
    const state = growth(task, moves);
    // A schedule's runs belong to its rhythm unless one of them is asking for something.
    if (task.scheduleId && state !== 'needs' && state !== 'ready') continue;
    const age = now - Date.parse(task.completedAt ?? task.updatedAt);
    if (state === 'ready' && age < 14 * DAY) ready.push(task);
    else if (state === 'working' || state === 'needs' || state === 'resting') growing.push(task);
    else if (state === 'failed' && age < 3 * DAY) growing.push(task);
  }
  const order: Record<Growth, number> = {
    needs: 0,
    working: 1,
    failed: 2,
    resting: 3,
    ready: 4,
    done: 5,
    stopped: 6
  };
  growing.sort(
    (a, b) =>
      order[growth(a, moves)] - order[growth(b, moves)] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
  ready.sort(
    (a, b) => Date.parse(b.completedAt ?? b.updatedAt) - Date.parse(a.completedAt ?? a.updatedAt)
  );
  return { growing, ready };
}

/** How far a goal has grown: its plan's steps, done and in hand. */
export function leaves(task: Task): { total: number; done: number; current: boolean } {
  const activity = task.activity;
  if (activity && activity.stepsTotal > 0)
    return {
      total: Math.min(activity.stepsTotal, 9),
      done: Math.min(activity.stepsCompleted + (activity.stepsSkipped ?? 0), 9),
      current: Boolean(activity.currentStep) && task.status !== 'completed'
    };
  const finished = task.status === 'completed';
  return { total: 3, done: finished ? 3 : 0, current: !finished };
}

/** The line under a goal's title: what it is doing, or what it needs. */
export function goalLine(task: Task, moves: readonly OwnerMove[]): string {
  const move = movesFor(moves, task.id)[0];
  if (move)
    switch (move.kind) {
      case 'deal':
        return `A deal is ready: ${move.deal.summary}`;
      case 'question':
      case 'handoff':
        return move.question;
      case 'approval':
        return `Asking before: ${move.action}`;
      case 'spend':
        return 'Paused at its spending cap';
    }
  if (task.status === 'awaiting_resource')
    return task.resourceWait?.summary ?? 'Waiting for the model to be available again';
  if (task.status === 'paused') return 'Paused';
  if (task.status === 'failed') return task.activity?.latest || 'Stopped before it finished';
  if (task.status === 'completed') {
    const verified = task.activity?.ending?.verification === 'verified';
    return verified ? 'Checked and ready' : task.activity?.latest || 'Ready';
  }
  if (task.status === 'queued' && !task.activity) return 'Thinking it through';
  return task.activity?.currentStep || task.activity?.latest || 'Working';
}

export const money = (usd: number): string =>
  usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(usd >= 10 ? 1 : 2)}`;

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

export const dayStamp = (date = new Date()): string =>
  date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) +
  ' · ' +
  date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const greeting = (hour: number) =>
  hour < 5
    ? 'Still up'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';

/** The sentence at the top of Today, in the owner's terms. */
export function verdict(
  name: string,
  tasks: readonly Task[],
  moves: readonly OwnerMove[],
  now = new Date()
): { greeting: string; line: string } {
  const { growing, ready } = beds(tasks, moves, now.getTime());
  const working = growing.filter((task) => growth(task, moves) === 'working').length;
  const parts = [
    moves.length
      ? `${moves.length === 1 ? 'One thing needs' : `${moves.length} things need`} you`
      : '',
    ready.length ? `${ready.length === 1 ? 'one is' : `${ready.length} are`} ready` : '',
    working ? `${working === 1 ? 'one goal is' : `${working} goals are`} growing` : ''
  ].filter(Boolean);
  const line = parts.length
    ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.${moves.length ? '' : ' Nothing needs you.'}`
    : 'Nothing is growing yet. Say what you want, and garden comes back with a deal.';
  return { greeting: `${greeting(now.getHours())}, ${name}.`, line };
}
