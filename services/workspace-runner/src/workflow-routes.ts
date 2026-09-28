import type { FastifyInstance } from 'fastify';
import { WorkflowRequest } from '@garden/contracts';
import { z } from 'zod';
import { requireScope } from './auth.js';
import type { WorkflowManager } from './workflows.js';

export function registerWorkflowRoutes(app: FastifyInstance, manager: WorkflowManager): void {
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/workflows',
    async (request) => {
      const envelope = z
        .object({ request: WorkflowRequest, requestId: z.string().min(1).max(256).optional() })
        .strict()
        .parse(request.body);
      const action = envelope.request.action,
        read = action === 'list' || action === 'status';
      requireScope(request, read ? 'files.read' : 'exec');
      if (!read && action !== 'cancel' && request.capability.role !== 'agent')
        throw new Error('Workflow execution requires an owning task capability');
      return manager.act(
        request.params.workspaceId,
        request.capability.role === 'agent' ? request.capability.sub : null,
        envelope.request,
        envelope.requestId
      );
    }
  );
  app.post<{ Params: { workspaceId: string; workflowId: string } }>(
    '/v1/workspaces/:workspaceId/workflows/:workflowId/resume',
    async (request) => {
      requireScope(request, 'exec');
      if (request.capability.role !== 'user')
        throw new Error('Use the task workflow tool for agent execution');
      const body = z.object({ attempt: z.number().int().positive() }).strict().parse(request.body);
      return manager.resumeByOwner(
        request.params.workspaceId,
        z.uuid().parse(request.params.workflowId),
        body.attempt
      );
    }
  );
  app.get<{ Params: { workspaceId: string; workflowId: string } }>(
    '/v1/workspaces/:workspaceId/workflows/:workflowId/plan',
    async (request) => {
      requireScope(request, 'files.read');
      if (request.capability.role !== 'agent')
        throw new Error('Workflow plan requires its owning task');
      return manager.plan(
        request.params.workspaceId,
        request.capability.sub,
        z.uuid().parse(request.params.workflowId)
      );
    }
  );
}
