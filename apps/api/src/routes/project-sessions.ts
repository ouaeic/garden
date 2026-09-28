import { GardenError } from '@garden/core';
import type { ComputerSessions, ProjectSessions } from '@garden/contracts';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export function registerProjectSessionRoutes({
  app,
  store,
  database,
  runner,
  privateTaskResponse
}: RouteContext): void {
  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/sessions',
    async (request) => {
      const user = requireUser(request.user);
      const projectId = request.params.projectId;
      if (!(await store.getProject(user.id, projectId)))
        throw new GardenError('project_not_found', 'Project not found', 404);
      const members = await store.projectExecutionMembers(user.id, projectId, 'project');
      const roots = [...new Map(members.map((member) => [member.workspaceId, member])).values()];
      const result: ProjectSessions = {
        sessions: [],
        unavailableWorkspaces: 0,
        observedAt: new Date().toISOString()
      };
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, roots.length) }, async () => {
          while (next < roots.length) {
            const member = roots[next++]!;
            // A legacy shared workspace has no project-private computer to expose.
            const shared = await database.query(
              `SELECT 1 FROM tasks WHERE workspace_id=$1 AND project_id IS DISTINCT FROM $2
          UNION ALL SELECT 1 FROM project_workspaces WHERE workspace_id=$1 AND project_id<>$2 LIMIT 1`,
              [member.workspaceId, projectId]
            );
            if (shared.rows.length) {
              result.unavailableWorkspaces++;
              continue;
            }
            try {
              const task = await store.getTask(user.id, member.taskId);
              if (!task || task.workspaceId !== member.workspaceId) continue;
              const sessions = await runner.request<ComputerSessions>({
                workspaceId: member.workspaceId,
                userId: user.id,
                role: 'user',
                scopes: ['browser.read', 'desktop.read'],
                path: `/v1/workspaces/${member.workspaceId}/computer-sessions`,
                timeoutMs: 5000
              });
              const workspace = await store.getWorkspace(user.id, member.workspaceId);
              const title = (await privateTaskResponse(task, workspace ?? undefined)).title;
              result.sessions.push({ ...sessions, ...member, title });
            } catch {
              result.unavailableWorkspaces++;
            }
          }
        })
      );
      result.sessions.sort((a, b) => a.taskId.localeCompare(b.taskId));
      return result;
    }
  );
}
