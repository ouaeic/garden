import type { TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import type { AgentApprovalRequirement } from './approval-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';
import { textValue } from './values.js';

export const jobRecoveryApproval = async (
  runner: AgentRunnerClient,
  task: TaskRecord,
  call: ModelToolCall,
  context: ApprovalContext
): Promise<AgentApprovalRequirement> => {
  const plan = await runner.call<{
    name: string;
    deadlineAt?: string;
    checkpointResume: Record<string, unknown>;
  }>(
    task.workspaceId,
    task.id,
    'exec',
    `/v1/workspaces/${task.workspaceId}/processes/${encodeURIComponent(textValue(call.arguments.sessionId))}/recovery`
  );
  const checkpoint = approvalRequirement(
    'shell',
    plan.checkpointResume,
    task.securityMode,
    context
  );
  return {
    sideEffect:
      checkpoint?.sideEffect === 'external_consequential' || context.taintSources?.length
        ? 'external_consequential'
        : 'external_reversible',
    action: `Resume ${plan.name} from its declared checkpoint`,
    preview: `${checkpoint?.preview ?? JSON.stringify(plan.checkpointResume)}\nThe original deadline remains ${plan.deadlineAt ?? 'unchanged'}. Completed work cannot be restarted.`
  };
};
