import { z } from 'zod';
import { GitHubProjectAction } from '@athanor/contracts';
import {
  AthanorError,
  decryptJson,
  executeConnectorAction,
  type ConnectorSecret
} from '@athanor/core';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export function registerProjectGitRoutes(
  context: RouteContext,
  owned: (userId: string, projectId: string) => Promise<{ id: string; workspaceId: string }>
) {
  const { app, store, runner } = context;
  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/git-remote',
    async (request, reply) => {
      const user = requireUser(request.user);
      const project = await owned(user.id, request.params.projectId);
      const input = z
        .object({
          connectorId: z.uuid(),
          taskId: z.uuid().optional(),
          operation: GitHubProjectAction
        })
        .strict()
        .parse(request.body);
      const run = async () => {
        const connector = await store.getConnector(user.id, input.connectorId);
        if (!connector?.enabled)
          throw new AthanorError('connector_not_found', 'Connected service is unavailable', 404);
        if (connector.secretCiphertext.aad !== `connector:${user.id}:${connector.id}`)
          throw new AthanorError(
            'connector_secret_context',
            'Connector secret encryption context is invalid'
          );
        const secret = decryptJson<ConnectorSecret>(connector.secretCiphertext, context.masterKey);
        try {
          const result = await executeConnectorAction({
            kind: connector.kind,
            baseUrl: connector.baseUrl,
            scopes: connector.scopes,
            secret,
            allowedHostSuffixes: context.connectorAllowedHosts(connector.kind, connector.baseUrl),
            action: input.operation,
            projectGit: async (action) => {
              if (!secret.token) throw Error('The GitHub connection has no repository credential');
              const status = action.action === 'github_git_status';
              if (!action.requestId) throw Error('A stable transfer identity is required');
              const started = Date.now();
              const result = await runner.request({
                workspaceId: project.workspaceId,
                userId: user.id,
                role: 'user',
                scopes: [
                  status
                    ? 'project.git.read'
                    : action.action === 'github_git_push'
                      ? 'project.git.push'
                      : 'project.git.fetch'
                ],
                method: 'POST',
                path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/git-remote`,
                contentType: 'application/json',
                body: JSON.stringify(
                  status
                    ? {
                        action: 'status',
                        requestId: action.requestId,
                        connectorId: connector.id,
                        credential: secret.token
                      }
                    : {
                        action: 'start',
                        taskId: input.taskId,
                        credential: secret.token,
                        input: {
                          ...action,
                          action: action.action === 'github_git_push' ? 'push' : 'fetch',
                          connectorId: connector.id
                        }
                      }
                )
              });
              return {
                action: action.action,
                result,
                statusCode: 202,
                requestBytes: 0,
                responseBytes: 0,
                durationMs: Date.now() - started
              };
            }
          });
          await store.recordConnectorAudit({
            connectorId: connector.id,
            userId: user.id,
            operation: result.action,
            outcome: 'succeeded',
            statusCode: result.statusCode,
            durationMs: result.durationMs
          });
          return result.result;
        } catch (error) {
          await store.recordConnectorAudit({
            connectorId: connector.id,
            userId: user.id,
            operation: input.operation.action,
            outcome:
              error instanceof AthanorError && error.code === 'connector_scope_denied'
                ? 'denied'
                : 'failed'
          });
          throw error;
        }
      };
      return input.operation.action === 'github_git_status'
        ? run()
        : context.idempotent(request, reply, user, run, { reconcile: run });
    }
  );
  app.post<{ Params: { projectId: string; requestId: string } }>(
    '/v1/projects/:projectId/git-remote/:requestId/cancel',
    async (request) => {
      const user = requireUser(request.user),
        project = await owned(user.id, request.params.projectId);
      const requestId = z.uuid().parse(request.params.requestId);
      z.object({}).strict().parse(request.body);
      return runner.request({
        workspaceId: project.workspaceId,
        userId: user.id,
        role: 'user',
        scopes: ['project.git.cancel'],
        method: 'POST',
        path: `/v1/workspaces/${project.workspaceId}/projects/${project.id}/git-remote`,
        contentType: 'application/json',
        body: JSON.stringify({ action: 'cancel', requestId })
      });
    }
  );
}
