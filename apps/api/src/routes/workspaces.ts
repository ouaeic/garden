import { removeCodingMissionFamily } from '../coding-mission-cleanup.js';
/**
 * The computer itself: making one, listing them, resizing, pausing, and deleting.
 *
 * Every route here carries a `workspaceId`, and NONE of them checks it: the pre-handler in
 * `http/auth-hook.ts` is the only place that boundary is enforced, for reads as well as writes.
 * A group registered before that hook would ship with no check at all.
 */

import {
  CreateWorkspaceRequest,
  UpdateLentKeysRequest,
  UpdateSecurityModeRequest
} from '@garden/contracts';
import type { Workspace } from '@garden/contracts';
import { GardenError } from '@garden/core';
import type { UserRecord } from '@garden/data';
import { z } from 'zod';
import { legacyWorkspaceBriefPaths, workspaceBriefPath, workspaceResponse } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { serverLimits } from '../plans.js';
import { recordSecurityEvent } from '../security-events.js';

export const registerWorkspaceRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    runner,
    hostStorageCache,
    meterWorkspace,
    cachedHostStorage,
    provisionWorkspace,
    requireRecentStepUp,
    idempotent
  } = context;
  app.get('/v1/workspaces', async (request) =>
    (await store.listWorkspaces(requireUser(request.user).id)).map((workspace) =>
      workspaceResponse(workspace)
    )
  );

  app.get<{ Params: { workspaceId: string } }>('/v1/workspaces/:workspaceId', async (request) => {
    const user = requireUser(request.user);
    const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
    if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found', 404);
    return workspaceResponse(workspace);
  });

  app.post('/v1/workspaces', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = CreateWorkspaceRequest.parse(request.body);
      return provisionWorkspace(user, input);
    });
  });

  app.post<{ Params: { workspaceId: string; action: string } }>(
    '/v1/workspaces/:workspaceId/:action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const action = z.enum(['hibernate', 'resume']).parse(request.params.action);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        if (action === 'hibernate') await meterWorkspace(workspace);
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/${action}`,
          method: 'POST',
          body: '{}',
          contentType: 'application/json'
        });
        await store.updateWorkspaceStatus(
          workspace.id,
          action === 'hibernate' ? 'hibernated' : 'running'
        );
        return workspaceResponse((await store.getWorkspace(user.id, workspace.id))!);
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/heartbeat',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      if (workspace.status === 'running') {
        // The client sends this on mount, so it is part of opening the app. The first heartbeat
        // after a restart waits for the walk because nothing else can tell the owner how much room
        // is left; every later one is served from the cache and refreshed behind the response.
        const usage = hostStorageCache.has(workspace.id)
          ? cachedHostStorage(workspace)
          : await meterWorkspace(workspace);
        await store.touchWorkspace(user.id, workspace.id);
        return {
          ok: true,
          status: workspace.status,
          storageBytes: usage?.storageBytes ?? workspace.storageBytes,
          ...(usage ?? {})
        };
      }
      await store.touchWorkspace(user.id, workspace.id);
      return { ok: true, status: workspace.status, storageBytes: workspace.storageBytes };
    }
  );

  const ResizeWorkspaceRequest = z.object({
    storageLimitBytes: z
      .number()
      .int()
      .min(10_000_000_000)
      .max(serverLimits.storageBytes)
      .optional()
  });

  const resizeWorkspace = async (
    user: UserRecord,
    workspaceId: string,
    input: z.infer<typeof ResizeWorkspaceRequest>
  ): Promise<Workspace> => {
    const workspace = await store.getWorkspace(user.id, workspaceId);
    if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
    if (input.storageLimitBytes && input.storageLimitBytes < workspace.storageBytes)
      throw new GardenError(
        'storage_limit',
        'Remove files until usage is below the smaller storage limit'
      );
    if (input.storageLimitBytes) {
      const allocatedElsewhere = (await store.listWorkspaces(user.id))
        .filter((item) => item.id !== workspace.id)
        .reduce((sum, item) => sum + item.storageLimitBytes, 0);
      if (allocatedElsewhere + input.storageLimitBytes > serverLimits.storageBytes) {
        throw new GardenError(
          'storage_limit',
          'The requested storage exceeds this server’s configured safety limit'
        );
      }
    }
    await meterWorkspace(workspace);
    await store.updateWorkspaceStatus(workspace.id, 'resizing');
    try {
      await runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${workspace.id}/resize`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({
          storageLimitBytes: input.storageLimitBytes ?? workspace.storageLimitBytes
        })
      });
      await store.updateWorkspaceResources(user.id, workspace.id, input.storageLimitBytes);
      await store.updateWorkspaceStatus(
        workspace.id,
        workspace.status === 'hibernated' ? 'hibernated' : 'running'
      );
      return workspaceResponse((await store.getWorkspace(user.id, workspace.id))!);
    } catch (error) {
      await store.updateWorkspaceStatus(workspace.id, 'failed');
      throw error;
    }
  };

  app.patch<{
    Params: { workspaceId: string };
    Body: { storageLimitBytes?: number };
  }>('/v1/workspaces/:workspaceId', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () =>
      resizeWorkspace(user, request.params.workspaceId, ResizeWorkspaceRequest.parse(request.body))
    );
  });

  /** The keys every new goal on this computer starts with. */
  app.patch<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/keys',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = UpdateLentKeysRequest.parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace || workspace.userId !== user.id)
        throw new GardenError(
          'workspace_owner_required',
          'Only the workspace owner can change the keys it lends',
          403
        );
      return idempotent(request, reply, user, async () => {
        const updated = await store.updateWorkspaceLentKeys(user.id, workspace.id, input.lentKeys);
        if (!updated) throw new GardenError('workspace_not_found', 'Workspace not found');
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_keys_changed',
          outcome: 'succeeded',
          metadata: { workspaceId: workspace.id, lentKeys: input.lentKeys }
        });
        return workspaceResponse(updated);
      });
    }
  );

  app.patch<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/security-mode',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = UpdateSecurityModeRequest.parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace || workspace.userId !== user.id)
        throw new GardenError(
          'workspace_owner_required',
          'Only the workspace owner can change its default security mode',
          403
        );
      // The same reasoning as the per-task route above: this is the setting the owner changes most,
      // and a passkey on it made Autonomous unreachable in practice.
      return idempotent(request, reply, user, async () => {
        const updated = await store.updateWorkspaceSecurityMode(
          user.id,
          workspace.id,
          input.securityMode
        );
        if (!updated) throw new GardenError('workspace_not_found', 'Workspace not found');
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_security_mode_changed',
          outcome: 'succeeded',
          metadata: { workspaceId: workspace.id, securityMode: input.securityMode }
        });
        return workspaceResponse(updated);
      });
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/brief',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      const readBrief = (path: string) =>
        runner.raw({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}`,
          acceptAnyStatus: true
        });
      let response = await readBrief(workspaceBriefPath);
      for (const legacyPath of legacyWorkspaceBriefPaths) {
        if (response.status !== 404) break;
        response = await readBrief(legacyPath);
      }
      if (response.status === 404) return { markdown: '', path: workspaceBriefPath };
      if (!response.ok)
        throw new GardenError(
          'workspace_brief_unavailable',
          `Workspace brief could not be read (${response.status})`,
          502
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > 64 * 1024)
        throw new GardenError(
          'workspace_brief_too_large',
          'Workspace brief exceeds the 64 KB safety limit'
        );
      return { markdown: bytes.toString('utf8'), path: workspaceBriefPath };
    }
  );

  app.put<{ Params: { workspaceId: string }; Body: { markdown: string } }>(
    '/v1/workspaces/:workspaceId/brief',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ markdown: z.string().max(50_000) }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        const content = Buffer.from(input.markdown, 'utf8');
        if (workspace.storageBytes + content.byteLength > workspace.storageLimitBytes)
          throw new GardenError('storage_limit', 'Workspace storage limit reached');
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(workspaceBriefPath)}`,
          method: 'PUT',
          body: Uint8Array.from(content).buffer,
          contentType: 'text/markdown; charset=utf-8'
        });
        const usage = await runner.request<{ storageBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`
        });
        await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
        return { markdown: input.markdown, path: workspaceBriefPath };
      });
    }
  );

  app.delete<{ Params: { workspaceId: string }; Body: { confirmName: string } }>(
    '/v1/workspaces/:workspaceId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ confirmName: z.string() }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        if (input.confirmName !== workspace.name)
          throw new GardenError(
            'confirmation_failed',
            'Type the exact workspace name to delete it'
          );
        const executionIds = await store.listProjectWorkspaces(user.id, workspace.id);
        const workspaceIds = [...executionIds, workspace.id];
        const tasks = (
          await Promise.all(workspaceIds.map((id) => store.listTasks(user.id, id)))
        ).flat();
        if (tasks.some((task) => task.parentMissionId))
          throw new GardenError(
            'coding_mission_scoped',
            'Remove an isolated specialist workspace through its parent task',
            409
          );
        for (const id of workspaceIds) await store.updateWorkspaceStatus(id, 'deleting');
        for (const task of tasks) await store.cancelTaskAndReleaseReservations(user.id, task.id);
        // Parent row cancellation serializes with any mission that was still being allocated.
        for (const task of tasks)
          if (task.hasCodingFamily) await removeCodingMissionFamily(context, task);
        await meterWorkspace(workspace);
        for (const id of workspaceIds)
          await runner.request({
            workspaceId: id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${id}`,
            method: 'DELETE'
          });
        await store.deleteWorkspace(user.id, workspace.id);
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_delete',
          outcome: 'completed',
          metadata: { workspaceId: workspace.id }
        });
        return {
          deleted: true,
          workspaceId: workspace.id,
          volumeDeletionRequested: true,
          applicationKeyRecordDeleted: true,
          backupExpiry: 'according_to_deployment_retention_policy'
        };
      });
    }
  );
};
