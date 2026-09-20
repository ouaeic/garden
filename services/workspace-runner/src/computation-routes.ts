import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ComputationRequest, ProcessHistoryQuery } from '@athanor/contracts';
import { requireScope } from './auth.js';
import type { ComputationManager } from './computation.js';
export function registerComputationRoutes(app: FastifyInstance, manager: ComputationManager): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/computation/history',
    async (request) => {
      requireScope(request, 'files.read');
      const query = ProcessHistoryQuery.parse(request.query);
      const owners =
        request.capability.role === 'agent'
          ? [request.capability.sub]
          : query.owners === undefined
            ? null
            : z.array(z.string().min(1).max(256)).max(512).parse(JSON.parse(query.owners));
      return manager.history(request.params.workspaceId, owners, {
        cursor: query.cursor,
        limit: query.limit
      });
    }
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/computation',
    async (request) => {
      requireScope(request, 'files.read');
      await manager.refreshResources();
      return {
        sessions: manager.list(
          request.params.workspaceId,
          request.capability.role === 'agent' ? request.capability.sub : null
        )
      };
    }
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/computation',
    async (request) => {
      const body = ComputationRequest.parse(request.body);
      const read = body.action === 'status' || body.action === 'list';
      requireScope(request, read ? 'files.read' : 'exec');
      if (
        !read &&
        request.capability.role !== 'agent' &&
        !['stop', 'interrupt'].includes(body.action)
      )
        throw Error('Computation execution requires an owning task capability');
      return manager.act(
        request.params.workspaceId,
        request.capability.role === 'agent' ? request.capability.sub : null,
        body
      );
    }
  );
}
