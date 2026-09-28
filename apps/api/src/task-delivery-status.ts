import { PENDING_MEDIA_DELIVERY } from '@garden/contracts';
import { taskDeliveryCountsSql, type Database } from '@garden/data';

/** One aggregate over a page's task IDs keeps delivery state out of per-row title reads. */
export const withTaskDeliveryStatus = async <T extends { id: string }>(
  database: Database,
  userId: string,
  tasks: readonly T[]
) => {
  if (!tasks.length) return [];
  if (
    tasks.every(
      (task) =>
        'userId' in task &&
        task.userId === userId &&
        'deliveryStatus' in task &&
        'pendingDeliveryCount' in task &&
        typeof task.pendingDeliveryCount === 'number' &&
        Number.isInteger(task.pendingDeliveryCount) &&
        task.pendingDeliveryCount >= 0 &&
        [null, 'pending', 'ready', 'incomplete'].some((status) => status === task.deliveryStatus)
    )
  )
    return tasks.map((task) => ({
      ...task,
      deliveryStatus: (task as T & { deliveryStatus: 'pending' | 'ready' | 'incomplete' | null })
        .deliveryStatus,
      pendingDeliveryCount: (task as T & { pendingDeliveryCount: number }).pendingDeliveryCount
    }));
  const result = await database.query(taskDeliveryCountsSql('SELECT unnest($2::uuid[])', '$3'), [
    userId,
    tasks.map((task) => task.id),
    [...PENDING_MEDIA_DELIVERY]
  ]);
  const states = new Map(
    result.rows.map((row) => [
      String(row.task_id),
      { pending: Number(row.pending), failed: Number(row.failed) }
    ])
  );
  return tasks.map((task) => {
    const state = states.get(task.id);
    return {
      ...task,
      deliveryStatus: !state
        ? null
        : state.failed
          ? ('incomplete' as const)
          : state.pending
            ? ('pending' as const)
            : ('ready' as const),
      pendingDeliveryCount: state?.pending ?? 0
    };
  });
};
