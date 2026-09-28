import type { TaskRecord } from '@garden/data';
import type { RouteContext } from './http/server-context.js';

/** Cancellation is not acknowledged until every isolated child has lost native execution authority. */
export async function stopCodingMissionFamily(
  context: Pick<RouteContext, 'store' | 'runner'>,
  task: TaskRecord
): Promise<void> {
  if (!task.hasCodingFamily) return;
  const missions = task.parentMissionId
    ? [await context.store.codingMissionForTask(task.id)].filter((m) => m !== null)
    : await context.store.listCodingMissions(task.userId, task.id);
  for (const mission of missions) {
    if (mission.phase === 'integrated') continue;
    const base = `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}`;
    try {
      await context.runner.request({
        workspaceId: mission.parentWorkspaceId,
        userId: task.userId,
        role: 'user',
        scopes: ['coding.missions.write'],
        method: 'POST',
        path: `${base}/cancel`,
        contentType: 'application/json',
        body: JSON.stringify({
          generation: mission.generation,
          childWorkspaceId: mission.childWorkspaceId
        })
      });
      if (mission.phase === 'integrating' && mission.reviewDigest)
        await context.store.finishCodingMissionIntegration(
          task.userId,
          mission.id,
          mission.generation,
          mission.reviewDigest,
          false
        );
      await context.store.acknowledgeCodingMissionRunner(
        task.userId,
        mission.id,
        mission.generation,
        true
      );
    } catch (error) {
      const status = await context.runner.request<{
        phase: string;
        generation: number;
        digest: string | null;
      }>({
        workspaceId: mission.parentWorkspaceId,
        userId: task.userId,
        role: 'user',
        scopes: ['coding.missions.read'],
        path: `${base}/status`
      });
      if (
        status.phase !== 'integrated' ||
        status.generation !== mission.generation ||
        status.digest !== mission.reviewDigest
      )
        throw error;
      await context.store.finishCodingMissionIntegration(
        task.userId,
        mission.id,
        mission.generation,
        mission.reviewDigest!,
        true
      );
    }
  }
}

/** Remove only dedicated child roots after native execution authority has been withdrawn. */
export async function removeCodingMissionFamily(
  context: Pick<RouteContext, 'store' | 'runner'>,
  task: TaskRecord
): Promise<void> {
  if (!task.hasCodingFamily) return;
  await stopCodingMissionFamily(context, task);
  for (const mission of await context.store.listCodingMissions(task.userId, task.id)) {
    await context.runner.request({
      workspaceId: mission.parentWorkspaceId,
      userId: task.userId,
      role: 'user',
      scopes: ['coding.missions.write'],
      method: 'POST',
      path: `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}/remove`,
      contentType: 'application/json',
      body: JSON.stringify({
        generation: mission.generation,
        childWorkspaceId: mission.childWorkspaceId
      })
    });
  }
}
