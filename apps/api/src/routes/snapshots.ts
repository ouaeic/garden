/**
 * Named restore points, and putting the computer back on one.
 *
 * Both taking and restoring refuse while work is executing, for two different meanings of "in
 * use", and the question is asked of the database rather than of a list held in this process.
 */

import { GardenError } from '@garden/core';
import type { DataStore } from '@garden/data';
import { z } from 'zod';
import { workspaceResponse } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { serverLimits } from '../plans.js';
import { recordSecurityEvent } from '../security-events.js';

export const registerSnapshotRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    runner,
    meterWorkspace,
    assertWorkspaceHasNoActiveWork,
    requireRecentStepUp,
    idempotent
  } = context;
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return store.listWorkspaceSnapshots(user.id, workspace.id);
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { name: string } }>(
    '/v1/workspaces/:workspaceId/snapshots',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        if (!['running', 'hibernated'].includes(workspace.status)) {
          throw new GardenError(
            'workspace_unavailable',
            'Recovery points can only be created for a running or hibernated workspace',
            409
          );
        }
        const snapshots = await store.listWorkspaceSnapshots(user.id, workspace.id);
        if (snapshots.length >= serverLimits.maxSnapshots) {
          throw new GardenError(
            'snapshot_limit',
            `This server keeps up to ${serverLimits.maxSnapshots} recovery points`,
            409
          );
        }
        const previousStatus = workspace.status;
        await meterWorkspace(workspace);
        await store.updateWorkspaceStatus(workspace.id, 'resizing');
        let snapshot: Awaited<ReturnType<DataStore['createWorkspaceSnapshot']>> | undefined;
        try {
          await assertWorkspaceHasNoActiveWork(user.id, workspace.id);
          snapshot = await store.createWorkspaceSnapshot({
            userId: user.id,
            workspaceId: workspace.id,
            name: input.name,
            sizeBytes: 0
          });
          const archived = await runner.request<{ sizeBytes: number }>({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/snapshots`,
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ snapshotId: snapshot.id })
          });
          await store.completeWorkspaceSnapshot(String(snapshot.id), archived.sizeBytes);
          await recordSecurityEvent(store, {
            userId: user.id,
            kind: 'workspace_snapshot_created',
            outcome: 'completed',
            metadata: { workspaceId: workspace.id, snapshotId: snapshot.id }
          });
          return {
            ...(await store.getWorkspaceSnapshot(user.id, workspace.id, String(snapshot.id))),
            scope: 'workspace_files_and_browser_profile',
            excludes: [
              'task_history',
              'account_metadata',
              'server_settings',
              'mounted_bulk_storage'
            ]
          };
        } catch (error) {
          if (snapshot) await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'failed');
          throw error;
        } finally {
          await store.updateWorkspaceStatus(workspace.id, previousStatus);
        }
      });
    }
  );

  app.delete<{ Params: { workspaceId: string; snapshotId: string } }>(
    '/v1/workspaces/:workspaceId/snapshots/:snapshotId',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        const snapshot = await store.getWorkspaceSnapshot(
          user.id,
          workspace.id,
          request.params.snapshotId
        );
        if (!snapshot) throw new GardenError('snapshot_not_found', 'Recovery point not found', 404);
        if (snapshot.status === 'creating' || snapshot.status === 'deleting') {
          throw new GardenError('snapshot_busy', 'This recovery point is still changing', 409);
        }
        await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'deleting');
        const snapshotId = String(snapshot.id);
        try {
          await runner.request({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/snapshots/${snapshotId}`,
            method: 'DELETE'
          });
          await store.deleteWorkspaceSnapshot(user.id, workspace.id, snapshotId);
          await recordSecurityEvent(store, {
            userId: user.id,
            kind: 'workspace_snapshot_deleted',
            outcome: 'completed',
            metadata: { workspaceId: workspace.id, snapshotId: snapshot.id }
          });
          return { deleted: true, id: snapshot.id };
        } catch (error) {
          await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'failed');
          throw error;
        }
      });
    }
  );

  app.post<{
    Params: { workspaceId: string; snapshotId: string };
    Body: { confirmName: string };
  }>('/v1/workspaces/:workspaceId/snapshots/:snapshotId/restore', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ confirmName: z.string() }).parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      if (input.confirmName !== workspace.name) {
        throw new GardenError(
          'confirmation_mismatch',
          'Enter the exact computer name to restore this recovery point',
          400
        );
      }
      if (!['running', 'hibernated'].includes(workspace.status)) {
        throw new GardenError(
          'workspace_unavailable',
          'A restore cannot start while another computer operation is active',
          409
        );
      }
      const target = await store.getWorkspaceSnapshot(
        user.id,
        workspace.id,
        request.params.snapshotId
      );
      if (!target || target.status !== 'ready') {
        throw new GardenError(
          'snapshot_unavailable',
          'Only a ready recovery point can be restored',
          409
        );
      }
      const snapshots = await store.listWorkspaceSnapshots(user.id, workspace.id);
      if (snapshots.length >= serverLimits.maxSnapshots) {
        throw new GardenError(
          'snapshot_limit',
          'Delete a recovery point first; restore creates an additional safety point',
          409
        );
      }
      const previousStatus = workspace.status;
      await meterWorkspace(workspace);
      await store.updateWorkspaceStatus(workspace.id, 'resizing');
      let safety: Awaited<ReturnType<DataStore['createWorkspaceSnapshot']>> | undefined;
      let safetyReady = false;
      let destructiveRestoreStarted = false;
      try {
        await assertWorkspaceHasNoActiveWork(user.id, workspace.id);
        safety = await store.createWorkspaceSnapshot({
          userId: user.id,
          workspaceId: workspace.id,
          name: `Safety before restore · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          sizeBytes: 0
        });
        const safetyArchive = await runner.request<{ sizeBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/snapshots`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify({ snapshotId: safety.id })
        });
        await store.completeWorkspaceSnapshot(String(safety.id), safetyArchive.sizeBytes);
        safetyReady = true;
        destructiveRestoreStarted = true;
        const targetId = String(target.id);
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['workspace.manage'],
          path: `/v1/workspaces/${workspace.id}/snapshots/${targetId}/restore`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify({
            storageLimitBytes: workspace.storageLimitBytes,
            imageRevision: workspace.imageRevision
          })
        });
        await store.updateWorkspaceStatus(workspace.id, 'running');
        await meterWorkspace({ ...workspace, status: 'running' });
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'workspace_snapshot_restored',
          outcome: 'completed',
          metadata: {
            workspaceId: workspace.id,
            snapshotId: target.id,
            safetySnapshotId: safety.id
          }
        });
        return {
          workspace: workspaceResponse((await store.getWorkspace(user.id, workspace.id))!),
          restoredFrom: target.id,
          safetySnapshotId: safety.id,
          scope: 'workspace_files_and_browser_profile',
          excludes: ['task_history', 'account_metadata', 'server_settings', 'mounted_bulk_storage'],
          warning:
            'Artifact and task records remain current; verify file-backed artifacts after restore.'
        };
      } catch (error) {
        if (safety && !safetyReady) {
          await store.setWorkspaceSnapshotStatus(String(safety.id), 'failed');
        }
        await store.updateWorkspaceStatus(
          workspace.id,
          destructiveRestoreStarted ? 'failed' : previousStatus
        );
        throw error;
      }
    });
  });
};
