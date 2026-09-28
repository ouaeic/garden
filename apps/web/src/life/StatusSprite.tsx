import type { Project, Task } from '@garden/contracts';
import { growth } from './growth';
import { Sprite } from './Sprite';

export type Stage = keyof typeof growth | 'bloom';

/**
 * Every status as a plant, so state reads by shape on a screen with one colour: a seed waits, a
 * sprout grows, a bloom is done, a wilted stem failed, a sprout with a mark needs you.
 */
export function stageOf(task: Pick<Task, 'status' | 'hasOpenQuestion' | 'deliveryStatus'>): Stage {
  if (
    task.hasOpenQuestion ||
    task.status === 'awaiting_user' ||
    (task.status === 'completed' && task.deliveryStatus === 'incomplete')
  )
    return 'needs';
  // Output still generating after the run ended is still growing, not in bloom.
  if (task.status === 'completed' && task.deliveryStatus === 'pending') return 'sprout';
  switch (task.status) {
    case 'running':
    case 'planning':
      return 'sprout';
    case 'queued':
    case 'draft':
    case 'awaiting_resource':
      return 'seed';
    case 'paused':
      return 'bud';
    case 'failed':
      return 'wilted';
    case 'cancelled':
      return 'cut';
    default:
      return 'bloom';
  }
}

/** A project's plant: what needs you first, then what is running, then its latest conversation. */
export function projectStage(project: Project, latest: Task | undefined): Stage {
  if (project.attentionCount) return 'needs';
  if (project.activeCount) return 'sprout';
  return latest ? stageOf(latest) : 'bloom';
}

const bloom = [
  ['..333...', '.32023..', '..333...', '...3.33.', '.333323.', '...33...', '...3....', '33333333']
] as const;

export default function StatusSprite({
  stage,
  scale = 2,
  className = ''
}: {
  stage: Stage;
  scale?: number;
  className?: string;
}) {
  const frames = stage === 'bloom' ? bloom : growth[stage];
  return (
    <Sprite
      frames={frames}
      scale={scale}
      fps={stage === 'needs' ? 3 : 2}
      className={`status-sprite stage-${stage} ${className}`}
    />
  );
}
