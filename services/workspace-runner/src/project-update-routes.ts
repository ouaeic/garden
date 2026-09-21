import { registerFileReadRoutes } from './file-downloads.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ProjectUpdateAction,
  ProjectRepositoryInput,
  ProjectGitExportInput,
  ProjectRepositoryRemovalInput,
  GitObjectId,
  ProjectVersionPinInput,
  PinnedProjectVersionCursor
} from '@athanor/contracts';
import { requireScope } from './auth.js';
import type { ProjectUpdatesManager } from './project-updates.js';

export function registerProjectUpdateRoutes(app: FastifyInstance, manager: ProjectUpdatesManager) {
  const ownerRetention = async (
    request: FastifyRequest,
    scope: 'project.updates.read' | 'project.updates.write' | 'files.read'
  ) => {
    requireScope(request, scope);
    const { projectId, workspaceId } = z
      .object({ projectId: z.uuid(), workspaceId: z.uuid() })
      .parse(request.params);
    if (
      request.capability.role !== 'user' ||
      (await manager.projectWorkspace(projectId)) !== workspaceId
    )
      throw new Error('Project controls require the project owner');
    return manager.retention(projectId);
  };
  app.get('/v1/workspaces/:workspaceId/projects/:projectId/repositories', async (request) => {
    const owner = await ownerRetention(request, 'project.updates.read');
    return {
      repositories: await manager.repositories(owner.projectId).list(),
      operations: await manager.repositoryOperations(owner.projectId),
      exports: await manager.gitExports(owner.projectId).list(),
      workingCopies: await manager.gitWorkingCopies(owner.projectId).list(),
      removals: await manager.repositories(owner.projectId).removals()
    };
  });
  app.post(
    '/v1/workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/remove',
    async (request) => {
      const owner = await ownerRetention(request, 'project.updates.write');
      const { repositoryId } = z.object({ repositoryId: z.uuid() }).parse(request.params);
      return manager.removeRepository(
        owner.projectId,
        repositoryId,
        ProjectRepositoryRemovalInput.parse(request.body)
      );
    }
  );
  app.post('/v1/workspaces/:workspaceId/projects/:projectId/repositories', async (request) => {
    const owner = await ownerRetention(request, 'project.updates.write');
    return manager.beginRepository(owner.projectId, ProjectRepositoryInput.parse(request.body));
  });
  app.get(
    '/v1/workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId',
    async (request) => {
      const owner = await ownerRetention(request, 'project.updates.read');
      const { repositoryId } = z.object({ repositoryId: z.uuid() }).parse(request.params);
      const { before } = z.object({ before: GitObjectId.optional() }).strict().parse(request.query);
      return manager.repositories(owner.projectId).history(repositoryId, before);
    }
  );
  app.post(
    '/v1/workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/exports',
    async (request) => {
      const owner = await ownerRetention(request, 'project.updates.read');
      const { repositoryId } = z.object({ repositoryId: z.uuid() }).parse(request.params);
      return manager
        .gitExports(owner.projectId)
        .start(repositoryId, ProjectGitExportInput.parse(request.body));
    }
  );
  app.post(
    '/v1/workspaces/:workspaceId/projects/:projectId/repository-exports/:exportId/remove',
    async (request) => {
      const owner = await ownerRetention(request, 'project.updates.write');
      const { exportId } = z.object({ exportId: z.uuid() }).parse(request.params);
      z.object({}).strict().parse(request.body);
      await manager.gitExports(owner.projectId).remove(exportId);
      return { removed: true };
    }
  );
  registerFileReadRoutes(
    app,
    '/v1/workspaces/:workspaceId/projects/:projectId/repository-exports/:exportId',
    async (request) => {
      const owner = await ownerRetention(request, 'files.read');
      const { exportId } = z.object({ exportId: z.uuid() }).parse(request.params);
      return manager.gitExports(owner.projectId).open(exportId);
    }
  );
  app.post('/v1/workspaces/:workspaceId/projects/:projectId/retention/preview', async (request) => {
    return (await ownerRetention(request, 'project.updates.read')).preview(request.body);
  });
  app.post('/v1/workspaces/:workspaceId/projects/:projectId/retention/archive', async (request) => {
    const retention = await ownerRetention(request, 'project.updates.write');
    const result = await retention.archive(request.body);
    return {
      ...result,
      revisions: await Promise.all(
        result.versions.map((id) => manager.version(retention.projectId, id))
      )
    };
  });
  app.post('/v1/workspaces/:workspaceId/projects/:projectId/retention/restore', async (request) => {
    const retention = await ownerRetention(request, 'project.updates.write');
    const { revisionId, requestId } = z
      .object({ revisionId: z.uuid(), requestId: z.uuid() })
      .strict()
      .parse(request.body);
    await retention.restore(revisionId, requestId);
    return { restored: true, revision: await manager.version(retention.projectId, revisionId) };
  });
  for (const action of ['preview', 'apply', 'status', 'pending'] as const) {
    app.post(
      '/v1/workspaces/:workspaceId/projects/:projectId/cleanup/' + action,
      async (request) => {
        const owner = await ownerRetention(
          request,
          action === 'apply' ? 'project.updates.write' : 'project.updates.read'
        );
        const purge = manager.purge(owner.projectId);
        if (action === 'pending') {
          z.object({}).strict().parse(request.body);
          return purge.pendingRequests();
        }
        if (action === 'preview') return purge.preview(request.body);
        if (action === 'apply') return purge.apply(request.body);
        const input = z.object({ requestId: z.uuid() }).strict().parse(request.body);
        const result = await purge.status(input.requestId);
        return {
          ...result,
          revisions: await Promise.all(
            result.selection.versions.map((id) => manager.version(owner.projectId, id))
          )
        };
      }
    );
  }
  app.get<{ Params: { workspaceId: string; projectId: string } }>(
    '/v1/workspaces/:workspaceId/projects/:projectId/storage',
    async (request) => {
      requireScope(request, 'project.updates.read');
      const { projectId, workspaceId } = request.params;
      if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(projectId)) !== workspaceId
      )
        throw new Error('Project storage inspection requires the project owner');
      return manager.storage(projectId);
    }
  );
  app.get<{ Params: { workspaceId: string; projectId: string } }>(
    '/v1/workspaces/:workspaceId/projects/:projectId/pinned-versions',
    async (request) => {
      requireScope(request, 'project.updates.read');
      const { projectId, workspaceId } = request.params;
      if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(projectId)) !== workspaceId
      )
        throw new Error('Pinned versions require the project owner');
      const query = z
        .object({ before: PinnedProjectVersionCursor.optional() })
        .strict()
        .parse(request.query);
      return manager.pinnedVersions(projectId, query.before);
    }
  );
  app.put<{ Params: { workspaceId: string; projectId: string; revisionId: string } }>(
    '/v1/workspaces/:workspaceId/projects/:projectId/versions/:revisionId/pin',
    async (request) => {
      requireScope(request, 'project.updates.write');
      const { projectId, workspaceId, revisionId } = request.params;
      if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(projectId)) !== workspaceId
      )
        throw new Error('Only the project owner can change version pins');
      const input = ProjectVersionPinInput.parse(request.body);
      return manager.pinVersion(projectId, revisionId, input.label);
    }
  );
  app.post<{ Params: { workspaceId: string; projectId: string } }>(
    '/v1/workspaces/:workspaceId/projects/:projectId/changes',
    async (request) => {
      requireScope(request, 'files.read');
      const { projectId, workspaceId } = request.params;
      if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(projectId)) !== workspaceId
      )
        throw new Error('Live change counts require the project owner');
      const taskIds = z.array(z.uuid()).min(1).max(100).parse(request.body);
      return manager.liveChanges(projectId, [...new Set(taskIds)]);
    }
  );
  registerFileReadRoutes(
    app,
    '/v1/workspaces/:workspaceId/projects/:projectId/versions/:revisionId',
    async (request) => {
      const params = z
        .object({ workspaceId: z.uuid(), projectId: z.uuid(), revisionId: z.uuid() })
        .parse(request.params);
      if (request.capability.role === 'agent') {
        if ((await manager.member(params.projectId, request.capability.sub)) !== params.workspaceId)
          throw new Error('Project membership does not match this working area');
      } else if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(params.projectId)) !== params.workspaceId
      )
        throw new Error('Project files require the owner and project working area');
      return manager.openFiles(params.projectId, () =>
        manager.revisionRoot(params.projectId, params.revisionId)
      );
    }
  );
  registerFileReadRoutes(
    app,
    '/v1/workspaces/:workspaceId/projects/:projectId/checks/:updateId/:checkId',
    async (request) => {
      const params = z
        .object({
          workspaceId: z.uuid(),
          projectId: z.uuid(),
          updateId: z.uuid(),
          checkId: z.uuid()
        })
        .parse(request.params);
      if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(params.projectId)) !== params.workspaceId
      )
        throw new Error('Check files require the project owner');
      return manager.openFiles(params.projectId, () =>
        manager.checkRoot(params.projectId, params.updateId, params.checkId)
      );
    }
  );
  app.put<{ Params: { workspaceId: string; projectId: string } }>(
    '/v1/workspaces/:workspaceId/projects/:projectId/members',
    async (request) => {
      requireScope(request, 'workspace.manage');
      if (request.capability.role !== 'control')
        throw new Error('Only the control plane can bind project membership');
      const members = z
        .array(z.object({ taskId: z.uuid(), workspaceId: z.uuid() }).strict())
        .min(1)
        .max(4096)
        .parse(request.body);
      for (const member of members)
        await manager.bind(
          request.params.projectId,
          request.params.workspaceId,
          member.taskId,
          member.workspaceId
        );
      return { registered: members.length };
    }
  );
  app.post<{ Params: { workspaceId: string; projectId: string } }>(
    '/v1/workspaces/:workspaceId/projects/:projectId/updates',
    async (request) => {
      const input = z
        .object({ taskId: z.uuid().optional(), operation: ProjectUpdateAction })
        .strict()
        .parse(request.body);
      const action = input.operation;
      requireScope(
        request,
        action.action === 'check'
          ? 'exec'
          : ['status', 'log'].includes(action.action)
            ? 'project.updates.read'
            : 'project.updates.write'
      );
      const { projectId, workspaceId } = request.params;
      const agent = request.capability.role === 'agent';
      const taskId = agent ? request.capability.sub : input.taskId;
      if (agent) {
        if (input.taskId && input.taskId !== taskId)
          throw new Error('A conversation cannot act as another conversation');
        if ((await manager.member(projectId, taskId!)) !== workspaceId)
          throw new Error('Project membership does not match this working area');
      } else if (
        request.capability.role !== 'user' ||
        (await manager.projectWorkspace(projectId)) !== workspaceId
      ) {
        throw new Error('Project controls require the owner and project working area');
      }
      if ('updateId' in action && action.updateId && !['status', 'log'].includes(action.action)) {
        const update = await manager.update(projectId, action.updateId);
        if (agent && update.taskId !== taskId)
          throw new Error('A conversation can only change its own project updates');
      }
      switch (action.action) {
        case 'status':
          return action.updateId
            ? manager.inspect(projectId, action.updateId, action.changesAfter)
            : manager.list(projectId, action.before, action.revisionsBefore);
        case 'prepare':
          if (!taskId) throw new Error('Choose the conversation whose files are being prepared');
          return manager.prepare(
            projectId,
            taskId,
            action.update,
            action.sourceTaskId,
            action.requestId
          );
        case 'checkout':
          if (!taskId) throw new Error('Choose a conversation working area');
          return manager.checkout(
            projectId,
            taskId,
            action.paths,
            action.revisionId,
            action.gitOnly
          );
        case 'rebase':
          return manager.rebase(projectId, action.updateId, action.requestId);
        case 'check':
          return manager.startCheck(projectId, action.updateId, action.checkId, action.digest);
        case 'log':
          return manager.checkOutput(projectId, action.updateId, action.checkId);
        case 'stop':
          return manager.checkOutput(projectId, action.updateId, action.checkId, true);
        case 'cancel':
          return manager.cancel(projectId, action.updateId);
        case 'publish':
          if (agent && action.uncheckedReason)
            throw new Error('Only the owner can explicitly publish without automated checks');
          return manager.publish(projectId, action.updateId, action.digest, action.uncheckedReason);
      }
    }
  );
}
