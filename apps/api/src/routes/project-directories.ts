import { GardenError } from '@garden/core';
import type { ProjectDirectory } from '@garden/contracts';
import { z } from 'zod';
import { downloadSignal, sendDownload } from '../download-response.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerProjectDirectoryRoutes = ({ app, store, runner }: RouteContext): void => {
  for (const kind of ['task', 'project'] as const)
    app.get<{ Params: { taskId: string } }>(`/v1/${kind}s/:taskId/directories`, async (request) => {
      const user = requireUser(request.user);
      const members = await store.projectExecutionMembers(user.id, request.params.taskId, kind);
      const project =
        kind === 'project' ? await store.getProject(user.id, request.params.taskId) : null;
      const current =
        kind === 'project'
          ? project
          : members.find((member) => member.taskId === request.params.taskId);
      if (!current) throw new GardenError('task_not_found', 'Project not found', 404);
      const directories: ProjectDirectory[] = [];
      for (const workspaceId of new Set(members.map((member) => member.workspaceId))) {
        const workspace = await store.getWorkspace(user.id, workspaceId);
        if (workspace)
          directories.push({
            workspaceId,
            name: workspace.name,
            path: 'workspace',
            current: workspaceId === current.workspaceId
          });
      }
      return { directories: directories.sort((a, b) => Number(b.current) - Number(a.current)) };
    });
  for (const operation of ['directory', 'directory.zip', 'table'] as const) {
    app.get<{ Params: { workspaceId: string }; Querystring: { path?: string; cursor?: string } }>(
      `/v1/workspaces/:workspaceId/${operation}`,
      async (request, reply) => {
        const user = requireUser(request.user);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found', 404);
        const query = z
          .object({
            path: z.string().min(1).max(4096).default('workspace'),
            cursor: z.string().max(8192).optional()
          })
          .parse(request.query);
        const params = new URLSearchParams({ path: query.path });
        if (['directory', 'table'].includes(operation) && query.cursor)
          params.set('cursor', query.cursor);
        const response = await runner.raw({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/${operation}?${params}`,
          signal: downloadSignal(reply),
          acceptAnyStatus: true
        });
        return sendDownload(reply, response);
      }
    );
  }
};
