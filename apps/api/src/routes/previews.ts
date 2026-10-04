/**
 * Serving something the agent built, on a port and under a name the owner chose.
 *
 * Publishing is deliberately a separate act from previewing: a preview is reachable by the owner,
 * a published one is reachable by whoever has the address.
 */

import { randomBytes } from 'node:crypto';
import { CreateWorkspacePreviewRequest, PublishWorkspacePreviewRequest } from '@garden/contracts';
import { GardenError, assertPublishablePort, sha256 } from '@garden/core';
import type { WorkspacePreviewRecord } from '@garden/data';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { serverLimits } from '../plans.js';
import { recordSecurityEvent } from '../security-events.js';
import { issuePreviewAccess } from '../preview-access.js';
import { registerPreviewStartRoutes } from './preview-start.js';

export const registerPreviewRoutes = (context: RouteContext): void => {
  registerPreviewStartRoutes(context);
  const {
    app,
    store,
    masterKey,
    runner,
    reservedPreviewPortSet,
    workspacePreviewResponse,
    requireRecentStepUp,
    idempotent
  } = context;
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/previews',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return (await store.listWorkspacePreviews(user.id, workspace.id)).map((preview) =>
        workspacePreviewResponse(preview)
      );
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/previews',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = CreateWorkspacePreviewRequest.parse(request.body);
        assertPublishablePort(input.port, reservedPreviewPortSet);
        let workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        if (workspace.status === 'hibernated') {
          await runner.request({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'control',
            scopes: ['workspace.manage'],
            path: `/v1/workspaces/${workspace.id}/resume`,
            method: 'POST',
            body: '{}',
            contentType: 'application/json'
          });
          await store.updateWorkspaceStatus(workspace.id, 'running');
          workspace = (await store.getWorkspace(user.id, workspace.id))!;
        }
        if (workspace.status !== 'running')
          throw new GardenError(
            'workspace_unavailable',
            'The computer must be running before exposing a preview'
          );
        const check = await runner.request<{ available: boolean }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: [`preview:${input.port}`],
          path: `/v1/workspaces/${workspace.id}/preview-check/${input.port}`
        });
        if (!check.available)
          throw new GardenError(
            'preview_port_unavailable',
            `Nothing is listening on port ${input.port} of this computer`
          );
        const accessToken = randomBytes(32).toString('base64url');
        let preview: WorkspacePreviewRecord;
        try {
          preview = await store.createWorkspacePreview({
            userId: user.id,
            workspaceId: workspace.id,
            label: input.label,
            port: input.port,
            slug: randomBytes(16).toString('hex'),
            accessTokenHash: sha256(accessToken),
            entryPath: input.entryPath || null,
            maxPreviews: serverLimits.maxPreviews
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'preview_limit')
            throw new GardenError(
              'preview_limit',
              `This server runs up to ${serverLimits.maxPreviews} previews at once`
            );
          throw error;
        }
        reply.status(201);
        return workspacePreviewResponse(preview, accessToken);
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/access',
    async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const preview = await store.getWorkspacePreview(user.id, request.params.previewId);
        if (
          !preview ||
          preview.status !== 'active' ||
          (preview.expiresAt !== null && new Date(preview.expiresAt).getTime() <= Date.now())
        )
          throw new GardenError('preview_unavailable', 'Preview is expired or revoked', 404);
        return workspacePreviewResponse(preview, issuePreviewAccess(preview, masterKey));
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/rotate-access',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const accessToken = randomBytes(32).toString('base64url');
        const preview = await store.rotateWorkspacePreviewAccess(
          user.id,
          request.params.previewId,
          sha256(accessToken)
        );
        if (!preview)
          throw new GardenError('preview_unavailable', 'Preview is expired or revoked', 404);
        return workspacePreviewResponse(preview, accessToken);
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/publish',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        PublishWorkspacePreviewRequest.parse(request.body);
        const existing = await store.getWorkspacePreview(user.id, request.params.previewId);
        if (!existing) throw new GardenError('preview_not_found', 'Preview not found', 404);
        const accessToken = randomBytes(32).toString('base64url');
        const preview = await store.publishWorkspacePreview(
          user.id,
          request.params.previewId,
          'public',
          sha256(accessToken)
        );
        if (!preview) throw new GardenError('preview_not_found', 'Preview not found', 404);
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'preview_publish',
          outcome: 'completed',
          metadata: { previewId: preview.id, workspaceId: preview.workspaceId }
        });
        return {
          ...workspacePreviewResponse(preview),
          // What publishing actually does, and nothing else.
          warning:
            'This address is on the public internet: anyone holding it reaches the app on this computer, with no sign-in, until you unpublish or revoke it. If the computer is asleep the first request wakes it, so that one waits.'
        };
      });
    }
  );

  app.post<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId/unpublish',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      return idempotent(request, reply, user, async () => {
        const accessToken = randomBytes(32).toString('base64url');
        // Taking a site off the public internet returns it to the owner's own private link, with a
        // fresh token so the public address stops working. It is not a two-hour grace period: the
        // app is still theirs and still running, and the only thing they asked to end is the part
        // other people could reach.
        const preview = await store.publishWorkspacePreview(
          user.id,
          request.params.previewId,
          'private',
          sha256(accessToken)
        );
        if (!preview) throw new GardenError('preview_not_found', 'Preview not found', 404);
        return workspacePreviewResponse(preview, accessToken);
      });
    }
  );

  app.delete<{ Params: { previewId: string } }>(
    '/v1/previews/:previewId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => ({
        revoked: await store.revokeWorkspacePreview(user.id, request.params.previewId)
      }));
    }
  );
};
