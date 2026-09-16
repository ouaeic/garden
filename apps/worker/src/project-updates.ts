import { createHash } from 'node:crypto';
import { ProjectUpdateAction, type ProjectUpdate } from '@athanor/contracts';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { TaskRecord } from '@athanor/data';
import type { AgentRunnerClient } from './runner-client.js';
import type { ToolContext } from './tool-dispatch.js';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';
import { APPROVAL_RANK, type ApprovalRequirement } from './approval-common.js';

export function projectOperation(task: TaskRecord, call: ModelToolCall): ProjectUpdateAction {
  if (!task.projectId || task.parentMissionId)
    throw new Error('Project updates belong to a project conversation');
  const options =
    call.arguments.options &&
    typeof call.arguments.options === 'object' &&
    !Array.isArray(call.arguments.options)
      ? (call.arguments.options as Record<string, unknown>)
      : {};
  const digest = createHash('sha256').update(`${task.id}:${call.id}`).digest('hex');
  const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return ProjectUpdateAction.parse({
    ...options,
    action: call.arguments.action,
    ...(['prepare', 'rebase'].includes(String(call.arguments.action)) ? { requestId } : {})
  });
}
export function projectRequest<T>(
  runner: AgentRunnerClient,
  task: TaskRecord,
  operation: ProjectUpdateAction
): Promise<T> {
  return runner.call(
    task.workspaceId,
    task.id,
    operation.action === 'check'
      ? 'exec'
      : ['status', 'log'].includes(operation.action)
        ? 'project.updates.read'
        : 'project.updates.write',
    `/v1/workspaces/${task.workspaceId}/projects/${task.projectId}/updates`,
    { operation }
  );
}
export async function executeProjectUpdate(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const operation = projectOperation(context.task, call);
  const result = await projectRequest(context.runner, context.task, operation);
  if (operation.action === 'status' && operation.includeDiff) return result;
  if (!result || typeof result !== 'object') return result;
  const view = result as Record<string, unknown>;
  if (Array.isArray(view.changes)) return compactUpdate(view);
  if (Array.isArray(view.updates))
    return { ...view, updates: view.updates.map((update: ProjectUpdate) => compactUpdate(update)) };
  return result;
}

/** Status polling needs identities and check progress; file content is an explicit read. */
function compactUpdate<T extends { changes?: unknown }>(update: T) {
  if (!Array.isArray(update.changes)) return update;
  return {
    ...update,
    changes: update.changes.map(({ diff, ...change }: ProjectUpdate['changes'][number]) => ({
      ...change,
      diffAvailable: diff !== null,
      diffBytes: diff === null ? 0 : Buffer.byteLength(diff)
    }))
  };
}

/** Persisted check commands and content digests are the approval subject, never a model-supplied substitute. */
export async function projectUpdateApproval(
  runner: AgentRunnerClient,
  task: TaskRecord,
  call: ModelToolCall,
  context: ApprovalContext
): Promise<ApprovalRequirement | null> {
  const operation = projectOperation(task, call);
  if (['status', 'log'].includes(operation.action)) return null;
  if (operation.action === 'check' || operation.action === 'publish') {
    const update = await projectRequest<ProjectUpdate>(runner, task, {
      action: 'status',
      updateId: operation.updateId
    });
    if (update.taskId !== task.id || update.candidateDigest !== operation.digest)
      throw new Error('Inspect the current candidate before running checks or publishing');
    if (operation.action === 'check') {
      const command = update.checks.find((check) => check.id === operation.checkId);
      if (!command || command.candidateDigest !== operation.digest)
        throw new Error('Check does not belong to this candidate');
      return approvalRequirement(
        'shell',
        {
          executable: command.executable,
          args: command.args,
          cwd: command.cwd,
          background: true,
          job: command.name
        },
        task.securityMode,
        context
      );
    }
    if (operation.uncheckedReason)
      throw new Error('Only the owner can choose to publish without automated checks');
    let required: ApprovalRequirement | null = null;
    const changes = [...update.changes];
    let cursor = update.nextChange;
    while (cursor) {
      const page = await projectRequest<ProjectUpdate>(runner, task, {
        action: 'status',
        updateId: operation.updateId,
        changesAfter: cursor
      });
      if (page.candidateDigest !== operation.digest)
        throw new Error('Candidate changed during publication review');
      changes.push(...page.changes);
      cursor = page.nextChange;
    }
    if (!changes.length || changes.length !== update.changeCount)
      throw new Error('Project update file review is incomplete');
    for (const change of changes) {
      const result = approvalRequirement(
        'file_write',
        { path: `workspace/${change.path}`, content: change.diff ?? '' },
        task.securityMode,
        context
      );
      if (
        result &&
        (!required || APPROVAL_RANK[result.sideEffect] > APPROVAL_RANK[required.sideEffect])
      )
        required = result;
    }
    return required
      ? {
          ...required,
          action: 'Publish the checked project version',
          preview: `${required.preview}\nCandidate ${operation.digest}. Earlier versions and working directories remain available.`
        }
      : null;
  }
  return task.securityMode === 'review'
    ? {
        sideEffect: 'workspace_write',
        action: `Project update: ${operation.action}`,
        preview:
          'Changes this conversation’s prepared update, check process, or working files. Published versions remain available.'
      }
    : null;
}
