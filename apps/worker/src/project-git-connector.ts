import { createHash } from 'node:crypto';
import type { GitHubProjectAction } from '@athanor/contracts';
import type { ConnectorExecutionResult, ConnectorSecret } from '@athanor/core';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { ToolContext } from './tool-dispatch.js';

export async function executeProjectGitConnector(
  context: ToolContext,
  call: ModelToolCall,
  connectorId: string,
  secret: ConnectorSecret,
  input: GitHubProjectAction
): Promise<ConnectorExecutionResult> {
  const { task } = context;
  if (!task.projectId || task.parentMissionId)
    throw Error('Git synchronization requires a project conversation');
  if (!secret.token) throw Error('The GitHub connection has no repository credential');
  const digest = createHash('sha256')
    .update(`${task.id}:${context.state.turn ?? 0}:${call.id}`)
    .digest('hex');
  const requestId =
    input.requestId ??
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const started = Date.now();
  const status = input.action === 'github_git_status';
  const result = await context.runner.call(
    task.workspaceId,
    task.id,
    status
      ? 'project.git.read'
      : input.action === 'github_git_push'
        ? 'project.git.push'
        : 'project.git.fetch',
    `/v1/workspaces/${task.workspaceId}/projects/${task.projectId}/git-remote`,
    status
      ? { action: 'status', requestId, connectorId, credential: secret.token }
      : {
          action: 'start',
          credential: secret.token,
          input: {
            ...input,
            action: input.action === 'github_git_push' ? 'push' : 'fetch',
            requestId,
            connectorId
          }
        }
  );
  return {
    action: input.action,
    result,
    statusCode: 202,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: Date.now() - started
  };
}
