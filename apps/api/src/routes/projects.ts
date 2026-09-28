import { GardenError } from '@garden/core';
import { CreateProjectNoteRequest, UpdateProjectRequest } from '@garden/contracts';
import { projectResponse } from '@garden/data';
import { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { projectActivity } from '../project-activity.js';

const Page = z.object({
  before: z.uuid().optional(),
  archived: z.enum(['true', 'false']).optional()
});
export function registerProjectRoutes(context: RouteContext) {
  const { app, store, masterKey } = context;
  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId/notes', async (request) => {
    const user = requireUser(request.user),
      query = Page.extend({ history: z.enum(['true', 'false']).optional() }).parse(request.query);
    return store.listProjectNotes(user.id, request.params.projectId, masterKey, {
      ...(query.before ? { before: query.before } : {}),
      history: query.history === 'true'
    });
  });
  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/notes',
    async (request, reply) => {
      const user = requireUser(request.user);
      return context.idempotent(request, reply, user, () =>
        store.addProjectNote(
          user.id,
          request.params.projectId,
          CreateProjectNoteRequest.parse(request.body),
          masterKey
        )
      );
    }
  );
  app.delete<{ Params: { projectId: string; noteId: string } }>(
    '/v1/projects/:projectId/notes/:noteId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return context.idempotent(request, reply, user, () =>
        store.removeProjectNote(user.id, request.params.projectId, request.params.noteId)
      );
    }
  );
  app.get('/v1/projects', async (request) => {
    const user = requireUser(request.user);
    const query = Page.parse(request.query);
    const page = await store.listProjects(user.id, {
      ...(query.before ? { before: query.before } : {}),
      archived: query.archived === 'true'
    });
    return {
      ...page,
      projects: page.projects.map((project) => projectResponse(project, masterKey, false))
    };
  });
  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request) => {
    const user = requireUser(request.user);
    const project = await store.getProject(user.id, request.params.projectId);
    if (!project) throw new GardenError('project_not_found', 'Project not found', 404);
    return projectResponse(project, masterKey);
  });
  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return context.idempotent(request, reply, user, async () =>
        projectResponse(
          await store.updateProject(
            user.id,
            request.params.projectId,
            UpdateProjectRequest.parse(request.body),
            masterKey
          ),
          masterKey
        )
      );
    }
  );
  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/conversations',
    async (request) => {
      const user = requireUser(request.user),
        query = Page.parse(request.query);
      if (!(await store.getProject(user.id, request.params.projectId)))
        throw new GardenError('project_not_found', 'Project not found', 404);
      const page = await store.listProjectConversations(user.id, request.params.projectId, {
        ...(query.before ? { before: query.before } : {}),
        ...(query.archived ? { archived: query.archived === 'true' } : {})
      });
      const activity = await projectActivity(
        context,
        user.id,
        request.params.projectId,
        page.tasks.map((task) => task.id)
      );
      return {
        ...page,
        tasks: await Promise.all(
          page.tasks.map(async (task) => ({
            ...(await context.privateTaskResponse(task)),
            activity: activity.get(task.id)
          }))
        )
      };
    }
  );
}
