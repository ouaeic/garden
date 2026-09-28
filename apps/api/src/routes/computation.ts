import { z } from 'zod';
import { GardenError } from '@garden/core';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
export function registerComputationRoutes({ app, store, runner, idempotent }: RouteContext): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/computation',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/computation`,
        method: 'GET'
      });
    }
  );
  app.post<{ Params: { workspaceId: string; session: string } }>(
    '/v1/workspaces/:workspaceId/computation/:session/control',
    async (request, reply) => {
      const user = requireUser(request.user);
      if (request.apiToken)
        throw new GardenError(
          'session_required',
          'Control computation from a signed-in device',
          403
        );
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        const session = z
          .string()
          .regex(/^kernel-[a-f0-9-]{36}$/)
          .parse(request.params.session);
        const body = z
          .object({ action: z.enum(['interrupt', 'stop']) })
          .strict()
          .parse(request.body);
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['exec'],
          path: `/v1/workspaces/${workspace.id}/computation`,
          method: 'POST',
          body: JSON.stringify({ ...body, sessionId: session }),
          contentType: 'application/json'
        });
      });
    }
  );
}
