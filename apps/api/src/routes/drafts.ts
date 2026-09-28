import { SaveDraftRequest } from '@garden/contracts';
import {
  GardenError,
  decryptJson,
  deriveServiceSecret,
  encryptJson,
  sha256,
  unwrapDataKey
} from '@garden/core';
import { createHmac } from 'node:crypto';
import type { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { sessionCookieName } from '../session.js';

const DraftScope = SaveDraftRequest.pick({ workspaceId: true, taskId: true });

export const registerDraftRoutes = (context: RouteContext): void => {
  const { app, store, masterKey, idempotent, secure } = context;
  const workspaceFor = async (userId: string, input: z.infer<typeof DraftScope>) => {
    const workspace = await store.getWorkspace(userId, input.workspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError('workspace_not_found', 'Workspace not found', 404);
    if (input.taskId) {
      const task = await store.getTask(userId, input.taskId);
      if (!task || task.workspaceId !== workspace.id)
        throw new GardenError(
          'task_not_found',
          'This conversation is not in the selected workspace',
          404
        );
    }
    return workspace;
  };
  app.get('/v1/drafts/device-key', async (request, reply) => {
    const user = requireUser(request.user);
    const token = request.cookies[sessionCookieName(secure)];
    const sessionId = token ? await store.getSessionPublicId(user.id, sha256(token)) : null;
    if (!sessionId)
      throw new GardenError('authentication_required', 'A signed-in device is required', 401);
    const secret = Buffer.from(deriveServiceSecret(masterKey, 'device-drafts'), 'base64url');
    const key = createHmac('sha256', secret)
      .update(JSON.stringify([user.id, sessionId]))
      .digest('base64url');
    reply.header('Cache-Control', 'no-store');
    return { userId: user.id, sessionId, key };
  });
  app.get('/v1/drafts', async (request, reply) => {
    const user = requireUser(request.user);
    const input = DraftScope.parse(request.query);
    const workspace = await workspaceFor(user.id, input);
    const row = await store.getMessageDraft(user.id, workspace.id, input.taskId ?? null);
    const content = row?.bodyCiphertext
      ? decryptJson<{
          body: string;
          attachments?: unknown[];
          controls?: unknown;
        }>(
          row.bodyCiphertext,
          unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id),
          `draft:${workspace.id}`
        )
      : { body: '', attachments: [] };
    reply.header('Cache-Control', 'no-store');
    return {
      ...content,
      workspaceId: workspace.id,
      taskId: input.taskId ?? null,
      attachments: content.attachments ?? [],
      revision: row?.revision ?? 0,
      updatedAt: row?.updatedAt
    };
  });
  app.put('/v1/drafts', async (request, reply) => {
    const user = requireUser(request.user);
    const input = SaveDraftRequest.parse(request.body);
    const workspace = await workspaceFor(user.id, input);
    return idempotent(
      request,
      reply,
      user,
      async () => {
        const attachments = (input.attachments ?? []).filter((item) => item.path);
        const receipt = await store.saveMessageDraft({
          userId: user.id,
          workspaceId: workspace.id,
          taskId: input.taskId ?? null,
          expectedRevision: input.expectedRevision,
          bodyCiphertext:
            input.body.trim() || attachments.length || input.controls
              ? encryptJson(
                  {
                    body: input.body,
                    attachments,
                    ...(input.controls ? { controls: input.controls } : {})
                  },
                  unwrapDataKey(workspace.wrappedKey!, masterKey, workspace.id),
                  `draft:${workspace.id}`
                )
              : null
        });
        if (!receipt)
          throw new GardenError(
            'draft_conflict',
            'A newer draft was saved on another device. Choose which version to keep.',
            409
          );
        return { saved: true, ...receipt };
      },
      { databaseOnly: true }
    );
  });
};
