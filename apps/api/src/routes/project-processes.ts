import { registerProcessHistoryRoutes } from './process-history.js';
import { z } from 'zod';
import { AthanorError } from '@athanor/core';
import type { ComputationSession, ProcessList } from '@athanor/contracts';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export const registerProjectProcessRoutes = (context: RouteContext): void => {
  const { app, store, runner } = context;
  registerProcessHistoryRoutes(context);
  app.post<{ Params: { workspaceId: string; workflowId: string } }>(
    '/v1/workspaces/:workspaceId/workflows/:workflowId/resume',
    async (request) => {
      const user = requireUser(request.user);
      if (request.apiToken)
        throw new AthanorError('session_required', 'Resume workflows from a signed-in device', 403);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found', 404);
      const workflowId = z.uuid().parse(request.params.workflowId),
        body = z.object({ attempt: z.number().int().positive() }).strict().parse(request.body);
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['exec'],
        method: 'POST',
        path: `/v1/workspaces/${workspace.id}/workflows/${workflowId}/resume`,
        contentType: 'application/json',
        body: JSON.stringify(body),
        timeoutMs: 30_000
      });
    }
  );
  for (const kind of ['task', 'project'] as const)
    app.get<{ Params: { taskId: string } }>(`/v1/${kind}s/:taskId/processes`, async (request) => {
      const user = requireUser(request.user);
      const members = await store.projectExecutionMembers(user.id, request.params.taskId, kind);
      if (
        kind === 'project'
          ? !(await store.getProject(user.id, request.params.taskId))
          : !members.some((member) => member.taskId === request.params.taskId)
      )
        throw new AthanorError('task_not_found', 'Project not found', 404);
      const scopes = new Map<string, Set<string>>();
      for (const member of members) {
        const owners = scopes.get(member.workspaceId) ?? new Set<string>();
        owners.add(member.taskId);
        scopes.set(member.workspaceId, owners);
      }
      const results: ProcessList[] = [];
      const computationSessions: ComputationSession[] = [];
      let unavailableComputationWorkspaces = 0;
      let unavailableWorkspaces = 0,
        next = 0;
      const workspaces = [...scopes.entries()];
      if (!workspaces.length)
        return {
          processes: [],
          observedAt: new Date().toISOString(),
          resourcesAvailable: false
        } satisfies ProcessList;
      await Promise.all(
        Array.from({ length: Math.min(4, workspaces.length) }, async () => {
          while (next < workspaces.length) {
            const [workspaceId, owners] = workspaces[next++]!;
            const computationRead = runner
              .request<{ sessions: ComputationSession[] }>({
                workspaceId,
                userId: user.id,
                role: 'user',
                scopes: ['files.read'],
                path: `/v1/workspaces/${workspaceId}/computation`,
                method: 'GET',
                timeoutMs: 5000
              })
              .then((value) => {
                if (!Array.isArray(value.sessions)) throw Error('Computation status is incomplete');
                for (const session of value.sessions)
                  if (session.workspaceId === workspaceId && owners.has(session.taskId))
                    computationSessions.push(session);
              })
              .catch(() => {
                unavailableComputationWorkspaces++;
              });
            try {
              const list = await runner.request<ProcessList>({
                workspaceId,
                userId: user.id,
                role: 'user',
                scopes: ['exec'],
                path: `/v1/workspaces/${workspaceId}/processes`,
                timeoutMs: 5_000
              });
              if (list.processes.some((process) => !process.ownerTaskId)) unavailableWorkspaces++;
              results.push({
                ...list,
                processes: list.processes
                  .filter((process) => process.ownerTaskId && owners.has(process.ownerTaskId))
                  .map((process) => ({ ...process, workspaceId }))
              });
            } catch {
              unavailableWorkspaces++;
            }
            await computationRead;
          }
        })
      );
      if (!results.length && !computationSessions.length)
        throw new AthanorError(
          'runner_unavailable',
          'Process status is temporarily unavailable',
          503
        );
      const first = results[0];
      return {
        processes: results.flatMap((list) => list.processes),
        computationSessions: computationSessions.sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt) || a.sessionId.localeCompare(b.sessionId)
        ),
        unavailableComputationWorkspaces,
        observedAt: new Date().toISOString(),
        ...(first?.refreshAfterMs ? { refreshAfterMs: first?.refreshAfterMs } : {}),
        resourcesAvailable: results.some((list) => list.resourcesAvailable),
        ...(first?.host ? { host: first?.host } : {}),
        unavailableWorkspaces,
        ...(unavailableWorkspaces
          ? { note: 'Some project execution roots are unavailable. This list may be incomplete.' }
          : {})
      } satisfies ProcessList;
    });
};
