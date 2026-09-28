import { DebugSessionSchema } from '@garden/contracts';
import type { TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import type { AgentApprovalRequirement } from './approval-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import type { ApprovalContext } from './approval-policy.js';
import { debuggerRequest } from './tools/debugger.js';
export async function debuggerApproval(
  runner: AgentRunnerClient,
  task: TaskRecord,
  call: ModelToolCall,
  context: ApprovalContext
): Promise<AgentApprovalRequirement | null> {
  const body = debuggerRequest(call.arguments);
  if (['list', 'status'].includes(body.action)) return null;
  if (body.action === 'launch')
    return {
      sideEffect: 'external_consequential',
      action: `Launch the ${body.language} debugger`,
      preview: `Run ${body.program} with arguments ${JSON.stringify(body.args)} in ${body.cwd} for up to ${body.lifetimeSeconds}s. Task-scoped native sandbox, network disabled. Initial breakpoints: ${JSON.stringify(body.breakpoints ?? [])}. Conditional breakpoints and logpoints can execute code. No automatic restart or external attach.`
    };
  const stored = DebugSessionSchema.parse(
    await runner.call(
      task.workspaceId,
      task.id,
      'files.read',
      `/v1/workspaces/${task.workspaceId}/debugger`,
      { action: 'status', sessionId: body.sessionId }
    )
  );
  if (stored.taskId !== task.id || stored.workspaceId !== task.workspaceId)
    throw Error('Debug session ownership mismatch');
  if (['stack', 'scopes'].includes(body.action) && !context.taintSources?.length) return null;
  return {
    sideEffect: 'external_consequential',
    action:
      body.action === 'evaluate'
        ? 'Evaluate an expression in the stopped program'
        : body.action === 'variables'
          ? 'Inspect live debug values'
          : `${body.action} the debug session`,
    preview: `${body.action === 'evaluate' ? body.expression : body.action === 'variables' ? 'Expanding variables can execute object representations and getters.' : body.action === 'breakpoints' ? `${body.path}: ${JSON.stringify(body.breakpoints)}. Conditions and logpoints can execute code.` : `Perform ${body.action}.`} Stored session ${stored.sessionId}: ${stored.language}, ${stored.program}, cwd ${stored.cwd}. Current stop epoch ${stored.stopEpoch}; requested ${body.epoch ?? 'not applicable'}. Network disabled; filesystem confined. Deadline ${stored.deadlineAt}.`
  };
}
