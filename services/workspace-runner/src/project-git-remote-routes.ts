import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectGitRemoteInput } from '@garden/contracts';
import { requireScope } from './auth.js';
import type { ProjectUpdatesManager } from './project-updates.js';

const Credential = z.string().regex(/^[\x21-\x7e]{1,4096}$/);
const Request = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      input: ProjectGitRemoteInput,
      credential: Credential,
      taskId: z.uuid().optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('status'),
      requestId: z.uuid(),
      connectorId: z.uuid(),
      credential: Credential
    })
    .strict(),
  z.object({ action: z.literal('cancel'), requestId: z.uuid() }).strict()
]);

export function registerProjectGitRemoteRoutes(
  app: FastifyInstance,
  manager: ProjectUpdatesManager
) {
  app.post('/v1/workspaces/:workspaceId/projects/:projectId/git-remote', async (request) => {
    const { projectId, workspaceId } = z
      .object({ projectId: z.uuid(), workspaceId: z.uuid() })
      .parse(request.params);
    const input = Request.parse(request.body);
    requireScope(
      request,
      input.action === 'start'
        ? `project.git.${input.input.action}`
        : input.action === 'cancel'
          ? 'project.git.cancel'
          : 'project.git.read'
    );
    const agent = request.capability.role === 'agent';
    let taskId: string | null = null,
      targetWorkspace: string | null = null;
    if (agent) {
      taskId = request.capability.sub;
      if (input.action === 'start' && input.taskId && input.taskId !== taskId)
        throw Error('A conversation cannot act as another conversation');
      targetWorkspace = await manager.member(projectId, taskId);
      if (targetWorkspace !== workspaceId)
        throw Error('Project membership does not match this working area');
    } else {
      if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(projectId)) !== workspaceId
      )
        throw Error('Repository controls require the project owner');
      if (input.action === 'start' && input.taskId) {
        taskId = input.taskId;
        targetWorkspace = await manager.member(projectId, taskId);
      }
    }
    const transfers = manager.gitRemotes(projectId);
    if (input.action === 'start')
      return manager.startGitRemote(
        projectId,
        input.input,
        { taskId, workspaceId: targetWorkspace },
        input.credential
      );
    const record = await transfers.get(input.requestId);
    if (agent && (record.taskId !== taskId || record.workspaceId !== targetWorkspace))
      throw Error('A conversation can only control its own transfers');
    return input.action === 'cancel'
      ? transfers.cancel(input.requestId)
      : transfers.reconcile(input.requestId, input.connectorId, input.credential);
  });
}
