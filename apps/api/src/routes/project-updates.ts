import { registerProjectGitRoutes } from './project-git.js';
import { downloadSignal, sendDownload } from '../download-response.js';
import { GardenError } from '@garden/core';
import {
  ProjectUpdateAction,
  ProjectRepositoryInput,
  ProjectGitExportInput,
  ProjectRepositoryRemovalInput,
  GitObjectId,
  ProjectVersionPinInput,
  PinnedProjectVersionCursor,
  ProjectPurgeApply,
  ProjectPurgeSelection,
  ProjectRetentionApply,
  ProjectRetentionSelection
} from '@garden/contracts';
import { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export function registerProjectUpdateRoutes(context: RouteContext) {
  const { app, store, runner } = context;
  const bound = new Map<string, number>();
  const owned = async (userId: string, projectId: string) => {
    const project = await store.getProject(userId, projectId);
    if (!project) throw new GardenError('project_not_found', 'Project not found', 404);
    if ((bound.get(projectId) ?? 0) < Date.now() - 60_000) {
      let before: string | undefined;
      do {
        const page = await store.listProjectConversations(userId, projectId, {
          limit: 100,
          ...(before ? { before } : {})
        });
        if (page.tasks.length)
          await runner.request({
            workspaceId: project.workspaceId,
            userId,
            role: 'control',
            scopes: ['workspace.manage'],
            method: 'PUT',
            path: `/v1/workspaces/${project.workspaceId}/projects/${projectId}/members`,
            contentType: 'application/json',
            body: JSON.stringify(
              page.tasks.map((task) => ({ taskId: task.id, workspaceId: task.workspaceId }))
            )
          });
        before = page.nextCursor ?? undefined;
      } while (before);
      bound.set(projectId, Date.now());
    }
    return project;
  };
  registerProjectGitRoutes(context, owned);
  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/repositories',
    async (request) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      return runner.request({
        workspaceId: project.workspaceId,
        userId: user.id,
        role: 'user',
        scopes: ['project.updates.read'],
        path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repositories`
      });
    }
  );
  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/repositories',
    async (request, reply) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const input = ProjectRepositoryInput.parse(request.body);
      const run = () =>
        runner.request({
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['project.updates.write'],
          method: 'POST',
          path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repositories`,
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      return context.idempotent(request, reply, user, run, { reconcile: run });
    }
  );
  app.get<{ Params: { projectId: string; repositoryId: string } }>(
    '/v1/projects/:projectId/repositories/:repositoryId',
    async (request) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const repositoryId = z.uuid().parse(request.params.repositoryId);
      const { before } = z.object({ before: GitObjectId.optional() }).strict().parse(request.query);
      return runner.request({
        workspaceId: project.workspaceId,
        userId: user.id,
        role: 'user',
        scopes: ['project.updates.read'],
        path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repositories/${repositoryId}${before ? '?before=' + before : ''}`
      });
    }
  );
  app.post<{ Params: { projectId: string; repositoryId: string } }>(
    '/v1/projects/:projectId/repositories/:repositoryId/exports',
    async (request, reply) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const repositoryId = z.uuid().parse(request.params.repositoryId),
        input = ProjectGitExportInput.parse(request.body);
      const run = () =>
        runner.request({
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['project.updates.read'],
          method: 'POST',
          path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repositories/${repositoryId}/exports`,
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      return context.idempotent(request, reply, user, run, { reconcile: run });
    }
  );
  app.post<{ Params: { projectId: string; exportId: string } }>(
    '/v1/projects/:projectId/repository-exports/:exportId/remove',
    async (request, reply) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const exportId = z.uuid().parse(request.params.exportId);
      z.object({}).strict().parse(request.body);
      const run = () =>
        runner.request({
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['project.updates.write'],
          method: 'POST',
          path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repository-exports/${exportId}/remove`,
          contentType: 'application/json',
          body: '{}'
        });
      return context.idempotent(request, reply, user, run, { reconcile: run });
    }
  );
  app.get<{ Params: { projectId: string; exportId: string } }>(
    '/v1/projects/:projectId/repository-exports/:exportId/download',
    async (request, reply) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const exportId = z.uuid().parse(request.params.exportId);
      const headers: Record<string, string> = {};
      for (const name of ['range', 'if-range'])
        if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
      return sendDownload(
        reply,
        await runner.raw({
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['files.read'],
          path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repository-exports/${exportId}/download?path=workspace/repository.bundle`,
          headers,
          signal: downloadSignal(reply),
          acceptAnyStatus: true
        })
      );
    }
  );
  app.post<{ Params: { projectId: string; repositoryId: string } }>(
    '/v1/projects/:projectId/repositories/:repositoryId/remove',
    async (request, reply) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const repositoryId = z.uuid().parse(request.params.repositoryId),
        input = ProjectRepositoryRemovalInput.parse(request.body);
      const run = () =>
        runner.request({
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['project.updates.write'],
          method: 'POST',
          path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/repositories/${repositoryId}/remove`,
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      return context.idempotent(request, reply, user, run, { reconcile: run });
    }
  );
  for (const action of ['preview', 'archive', 'restore'] as const) {
    app.post<{ Params: { projectId: string } }>(
      `/v1/projects/:projectId/retention/${action}`,
      async (request, reply) => {
        const user = requireUser(request.user);
        const input = (
          action === 'preview'
            ? ProjectRetentionSelection
            : action === 'archive'
              ? ProjectRetentionApply
              : z.object({ revisionId: z.uuid(), requestId: z.uuid() }).strict()
        ).parse(request.body);
        const project = await owned(user.id, request.params.projectId);
        const run = () =>
          runner.request({
            workspaceId: project.workspaceId,
            userId: user.id,
            role: 'user',
            scopes: [action === 'preview' ? 'project.updates.read' : 'project.updates.write'],
            method: 'POST',
            path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/retention/${action}`,
            contentType: 'application/json',
            body: JSON.stringify(input)
          });
        return action === 'preview'
          ? run()
          : context.idempotent(request, reply, user, run, { reconcile: run });
      }
    );
  }
  for (const action of ['preview', 'apply', 'status', 'pending'] as const) {
    app.post<{ Params: { projectId: string } }>(
      `/v1/projects/:projectId/cleanup/${action}`,
      async (request, reply) => {
        const user = requireUser(request.user);
        const input = (
          action === 'preview'
            ? ProjectPurgeSelection
            : action === 'apply'
              ? ProjectPurgeApply
              : action === 'pending'
                ? z.object({}).strict()
                : z.object({ requestId: z.uuid() }).strict()
        ).parse(request.body);
        const project = await owned(user.id, request.params.projectId);
        const run = () =>
          runner.request({
            workspaceId: project.workspaceId,
            userId: user.id,
            role: 'user',
            scopes: [action === 'apply' ? 'project.updates.write' : 'project.updates.read'],
            method: 'POST',
            path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/cleanup/${action}`,
            contentType: 'application/json',
            body: JSON.stringify(input)
          });
        return action === 'apply'
          ? context.idempotent(request, reply, user, run, { reconcile: run })
          : run();
      }
    );
  }
  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId/storage', async (request) => {
    const user = requireUser(request.user),
      project = await owned(user.id, request.params.projectId);
    return runner.request({
      workspaceId: project.workspaceId,
      userId: user.id,
      role: 'user',
      scopes: ['project.updates.read'],
      path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/storage`
    });
  });
  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/pinned-versions',
    async (request) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const query = z
        .object({ before: PinnedProjectVersionCursor.optional() })
        .strict()
        .parse(request.query);
      return runner.request({
        workspaceId: project.workspaceId,
        userId: user.id,
        role: 'user',
        scopes: ['project.updates.read'],
        path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/pinned-versions${query.before ? '?' + new URLSearchParams({ before: query.before }).toString() : ''}`
      });
    }
  );
  app.put<{ Params: { projectId: string; revisionId: string } }>(
    '/v1/projects/:projectId/versions/:revisionId/pin',
    async (request, reply) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const revisionId = z.uuid().parse(request.params.revisionId);
      const input = ProjectVersionPinInput.parse(request.body);
      return context.idempotent(request, reply, user, () =>
        runner.request({
          workspaceId: project.workspaceId,
          userId: user.id,
          role: 'user',
          scopes: ['project.updates.write'],
          method: 'PUT',
          path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/versions/${revisionId}/pin`,
          contentType: 'application/json',
          body: JSON.stringify(input)
        })
      );
    }
  );
  for (const source of ['versions', 'checks'] as const)
    for (const operation of ['directory', 'directory.zip', 'download', 'table'] as const) {
      const route = source === 'versions' ? 'versions/:revisionId' : 'checks/:updateId/:checkId';
      app.get<{
        Params: { projectId: string; revisionId?: string; updateId?: string; checkId?: string };
      }>(`/v1/projects/:projectId/${route}/${operation}`, async (request, reply) => {
        const user = requireUser(request.user),
          project = await owned(user.id, request.params.projectId);
        const selected =
          source === 'versions'
            ? `versions/${z.uuid().parse(request.params.revisionId)}`
            : `checks/${z.uuid().parse(request.params.updateId)}/${z.uuid().parse(request.params.checkId)}`;
        const query = z
          .object({
            path: z.string().min(1).max(4096).default('workspace'),
            cursor: z.string().max(8192).optional()
          })
          .parse(request.query);
        const params = new URLSearchParams({ path: query.path });
        if (['directory', 'table'].includes(operation) && query.cursor)
          params.set('cursor', query.cursor);
        const headers: Record<string, string> = {};
        for (const name of ['range', 'if-range'])
          if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
        return sendDownload(
          reply,
          await runner.raw({
            workspaceId: project.workspaceId,
            userId: user.id,
            role: 'user',
            scopes: ['files.read'],
            path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/${selected}/${operation}?${params}`,
            headers,
            signal: downloadSignal(reply),
            acceptAnyStatus: true
          })
        );
      });
    }
  const run = async (
    userId: string,
    projectId: string,
    operation: ProjectUpdateAction,
    taskId?: string
  ) => {
    const project = await owned(userId, projectId);
    if (taskId) {
      const task = await store.getTask(userId, taskId);
      if (!task || task.projectId !== projectId || task.parentMissionId)
        throw new GardenError(
          'conversation_not_found',
          'Conversation not found in this project',
          404
        );
    }
    return runner.request({
      workspaceId: project.workspaceId,
      userId,
      role: 'user',
      scopes: [
        operation.action === 'check'
          ? 'exec'
          : ['status', 'log'].includes(operation.action)
            ? 'project.updates.read'
            : 'project.updates.write'
      ],
      method: 'POST',
      path: `/v1/workspaces/${project.workspaceId}/projects/${projectId}/updates`,
      contentType: 'application/json',
      body: JSON.stringify({ operation, ...(taskId ? { taskId } : {}) })
    });
  };
  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId/changes', async (request) => {
    const user = requireUser(request.user);
    const project = await owned(user.id, request.params.projectId);
    const query = z.object({ tasks: z.string().max(3700) }).parse(request.query);
    const tasks = z.array(z.uuid()).min(1).max(100).parse(query.tasks.split(','));
    return runner.request({
      workspaceId: project.workspaceId,
      userId: user.id,
      role: 'user',
      scopes: ['files.read'],
      method: 'POST',
      path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/changes`,
      contentType: 'application/json',
      body: JSON.stringify(tasks)
    });
  });
  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId/updates', async (request) => {
    const query = z
      .object({
        before: z.uuid().optional(),
        revisionsBefore: z.uuid().optional(),
        updateId: z.uuid().optional(),
        changesAfter: z.string().max(4096).optional()
      })
      .parse(request.query);
    return run(requireUser(request.user).id, request.params.projectId, {
      action: 'status',
      ...query
    });
  });
  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/updates',
    async (request, reply) => {
      const user = requireUser(request.user);
      const input = z
        .object({ taskId: z.uuid().optional(), operation: ProjectUpdateAction })
        .strict()
        .parse(request.body);
      return context.idempotent(request, reply, user, () =>
        run(user.id, request.params.projectId, input.operation, input.taskId)
      );
    }
  );
}
