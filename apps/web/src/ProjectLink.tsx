import { useRef } from 'react';
import type { Task } from '@garden/contracts';
import { taskStatusLabel } from './model';
import StatusSprite, { stageOf } from './life/StatusSprite';

export function ProjectLink({
  task,
  current,
  onOpen
}: {
  task: Task;
  current: boolean;
  onOpen: (id: string) => void;
}) {
  const viewport = useRef<HTMLSpanElement>(null);
  function prepareReveal() {
    const element = viewport.current;
    const title = element?.firstElementChild;
    if (!element || !(title instanceof HTMLElement)) return;
    const overflow = Math.max(0, title.scrollWidth - element.clientWidth);
    element.dataset.overflow = String(overflow > 0);
    element.style.setProperty('--title-overflow', `${-overflow}px`);
    element.style.setProperty('--title-duration', `${Math.max(4, overflow / 24)}s`);
  }
  const label = `${task.title} · ${taskStatusLabel(task)}${task.pinned ? ' · Pinned' : ''}`;
  return (
    <button
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      title={label}
      onClick={() => onOpen(task.id)}
      onPointerEnter={prepareReveal}
      onFocus={prepareReveal}
    >
      <StatusSprite stage={task.deliveryStatus === 'pending' ? 'sprout' : stageOf(task)} />
      <span className="garden-project-title" ref={viewport}>
        <strong>{task.title}</strong>
      </span>
    </button>
  );
}
