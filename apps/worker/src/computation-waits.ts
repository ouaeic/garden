import { ComputationState } from '@athanor/contracts';
import { z } from 'zod';

export const ComputationWaitIdentity = z
  .object({
    kind: z.literal('computation'),
    sessionId: z.string().regex(/^kernel-[a-f0-9-]{36}$/),
    startedAt: z.string().datetime(),
    cellId: z.string().min(1).max(120),
    interpreterCreatedAt: z.string().datetime()
  })
  .strict();

const Snapshot = z.object({
  sessionId: ComputationWaitIdentity.shape.sessionId,
  workspaceId: z.uuid(),
  taskId: z.string().min(1).max(256),
  createdAt: z.string().datetime(),
  state: ComputationState,
  latestCell: z
    .object({
      cellId: ComputationWaitIdentity.shape.cellId,
      startedAt: z.string().datetime(),
      state: z.enum(['running', 'completed', 'failed', 'interrupted'])
    })
    .optional()
});

/** Only scheduling metadata may enter the resumed system message, never cell output or variables. */
export function computationWaitObservation(
  value: unknown,
  owner: { id: string; workspaceId: string },
  sessionId: string
) {
  const snapshot = Snapshot.parse(value);
  if (
    snapshot.sessionId !== sessionId ||
    snapshot.workspaceId !== owner.workspaceId ||
    snapshot.taskId !== owner.id
  )
    throw new Error('The analysis session belongs to another task or workspace.');
  const cell = snapshot.latestCell;
  if (!cell) return null;
  const status =
    cell.state !== 'running'
      ? cell.state
      : snapshot.state === 'busy'
        ? 'running'
        : snapshot.state === 'expired'
          ? 'timed_out'
          : snapshot.state === 'stopped'
            ? 'stopped'
            : snapshot.state === 'lost' || snapshot.state === 'interrupted'
              ? 'interrupted'
              : null;
  if (!status) throw new Error('The running analysis cell has inconsistent runtime state.');
  return {
    kind: 'computation' as const,
    sessionId,
    startedAt: cell.startedAt,
    interpreterCreatedAt: snapshot.createdAt,
    cellId: cell.cellId,
    runtimeState: snapshot.state,
    status
  };
}
