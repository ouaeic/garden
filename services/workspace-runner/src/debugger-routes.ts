import type { FastifyInstance } from 'fastify';
import { DebuggerRequest } from '@garden/contracts';
import { requireScope } from './auth.js';
import type { DebuggerManager } from './debugger.js';

export function registerDebuggerRoutes(app: FastifyInstance, manager: DebuggerManager): void {
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/debugger',
    async (request) => {
      requireScope(request, 'files.read');
      return {
        sessions: manager.list(
          request.params.workspaceId,
          request.capability.role === 'agent' ? request.capability.sub : null
        ),
        available: await manager.availability()
      };
    }
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/debugger',
    async (request) => {
      const body = DebuggerRequest.parse(request.body);
      const read = ['list', 'status'].includes(body.action);
      requireScope(request, read ? 'files.read' : 'exec');
      if (!read && request.capability.role !== 'agent' && body.action !== 'stop')
        throw Error('Live debugger operations require an owning task capability');
      return manager.act(
        request.params.workspaceId,
        request.capability.role === 'agent' ? request.capability.sub : null,
        body
      );
    }
  );
}
