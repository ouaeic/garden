import { z } from 'zod';
import { CodingMissionChange, type CodingMissionReview } from '@garden/contracts';
import { GardenError, unwrapDataKey } from '@garden/core';
import { codingMissionView } from '@garden/data';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

const Review = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z.array(CodingMissionChange).max(500),
  canIntegrate: z.boolean(),
  detail: z.string()
});
const Integration = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.number().int().positive()
});
export const registerCodingMissionRoutes = (context: RouteContext): void => {
  const { app, store, runner, masterKey, idempotent } = context;
  const held = async (userId: string, id: string) => {
    const mission = await store.getCodingMission(userId, id);
    if (!mission) throw new GardenError('coding_mission_missing', 'Coding mission not found', 404);
    const workspace = await store.getWorkspace(userId, mission.parentWorkspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError('workspace_not_found', 'Parent workspace not found', 404);
    return { mission, key: unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id) };
  };
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/coding-missions', async (request) => {
    const user = requireUser(request.user),
      task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new GardenError('task_not_found', 'Task not found', 404);
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError('workspace_not_found', 'Workspace not found', 404);
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    return {
      missions: (await store.listCodingMissions(user.id, task.id)).map((m) =>
        codingMissionView(m, key)
      )
    };
  });
  app.post<{ Params: { missionId: string } }>(
    '/v1/coding-missions/:missionId/review',
    async (request) => {
      const user = requireUser(request.user),
        { mission, key } = await held(user.id, request.params.missionId);
      const review = Review.parse(
        await runner.request({
          workspaceId: mission.parentWorkspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['coding.missions.read'],
          method: 'POST',
          path: `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}/review`,
          contentType: 'application/json',
          body: JSON.stringify({ generation: mission.generation })
        })
      );
      await store.recordCodingMissionReview(user.id, mission.id, mission.generation, {
        digest: review.digest,
        changedFiles: review.changes.length,
        conflicts: review.changes.filter((c) => c.conflict || !c.permitted).length
      });
      return {
        ...review,
        canIntegrate: review.canIntegrate && mission.childStatus === 'completed',
        mission: codingMissionView((await store.getCodingMission(user.id, mission.id))!, key)
      } satisfies CodingMissionReview;
    }
  );
  app.post<{ Params: { missionId: string } }>(
    '/v1/coding-missions/:missionId/integrate',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = Integration.parse(request.body),
          { mission, key } = await held(user.id, request.params.missionId);
        const claim = await store.beginCodingMissionIntegration(
          user.id,
          mission.id,
          input.generation,
          input.digest
        );
        if (claim.phase === 'integrated') return { mission: codingMissionView(claim, key) };
        try {
          await runner.request({
            workspaceId: mission.parentWorkspaceId,
            userId: user.id,
            role: 'user',
            scopes: ['coding.missions.integrate'],
            method: 'POST',
            path: `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}/integrate`,
            contentType: 'application/json',
            body: JSON.stringify(input)
          });
          await store.finishCodingMissionIntegration(
            user.id,
            mission.id,
            input.generation,
            input.digest,
            true
          );
        } catch (error) {
          const status = await runner
            .request<{
              phase: string;
              generation: number;
              digest: string | null;
            }>({
              workspaceId: mission.parentWorkspaceId,
              userId: user.id,
              role: 'user',
              scopes: ['coding.missions.read'],
              path: `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}/status`
            })
            .catch(() => null);
          if (
            status?.generation === input.generation &&
            status.phase === 'integrated' &&
            status.digest === input.digest
          )
            await store.finishCodingMissionIntegration(
              user.id,
              mission.id,
              input.generation,
              input.digest,
              true
            );
          else {
            if (
              status?.generation === input.generation &&
              ['active', 'ready'].includes(status.phase)
            )
              await store.finishCodingMissionIntegration(
                user.id,
                mission.id,
                input.generation,
                input.digest,
                false
              );
            throw error;
          }
        }
        return {
          mission: codingMissionView((await store.getCodingMission(user.id, mission.id))!, key)
        };
      });
    }
  );
  app.post<{ Params: { missionId: string } }>(
    '/v1/coding-missions/:missionId/cancel',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const { mission, key } = await held(user.id, request.params.missionId);
        const cancelled = await store.cancelCodingMission(user.id, mission.id);
        if (cancelled) {
          await runner.request({
            workspaceId: mission.parentWorkspaceId,
            userId: user.id,
            role: 'user',
            scopes: ['coding.missions.write'],
            method: 'POST',
            path: `/v1/workspaces/${mission.parentWorkspaceId}/coding-missions/${mission.id}/cancel`,
            contentType: 'application/json',
            body: JSON.stringify({
              generation: cancelled.generation,
              childWorkspaceId: cancelled.childWorkspaceId
            })
          });
          await store.acknowledgeCodingMissionRunner(user.id, mission.id, cancelled.generation);
        }
        return { mission: cancelled ? codingMissionView(cancelled, key) : null };
      });
    }
  );
};
