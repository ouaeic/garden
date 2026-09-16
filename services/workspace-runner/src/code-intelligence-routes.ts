import type { FastifyInstance } from 'fastify';
import { CodeIntelligenceRequest } from '@athanor/contracts';
import { requireScope } from './auth.js';
import { workspacePath } from './files.js';
import type { CodeIntelligenceManager } from './code-intelligence.js';

export function registerCodeIntelligenceRoutes(
  app: FastifyInstance,
  workspaceRoot: string,
  manager: CodeIntelligenceManager
): void {
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/code-intelligence',
    async (request) => {
      const body = CodeIntelligenceRequest.parse(request.body);
      requireScope(
        request,
        body.action === 'apply'
          ? 'files.write'
          : body.action === 'start' || body.action === 'stop'
            ? 'exec'
            : 'files.read'
      );
      return manager.act(
        workspacePath(workspaceRoot, request.params.workspaceId),
        request.capability.sub,
        body
      );
    }
  );
}
