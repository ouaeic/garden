import type { FastifyInstance } from 'fastify';
import { ComputationRequest } from '@athanor/contracts';
import { requireScope } from './auth.js';
import type { ComputationManager } from './computation.js';
export function registerComputationRoutes(app: FastifyInstance, manager: ComputationManager): void {
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
