import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentRunnerClient } from './runner-client.js';
import type { AgentApprovalRequirement } from './approval-state.js';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';
import { textValue } from './values.js';
import { callDestinations } from './command-classification.js';

/** Input inherits the actual process command and is checked as its complete stdin stream. */
export async function processInputApproval(
  runner: AgentRunnerClient,
  task: TaskRecord,
  call: ModelToolCall,
  context: ApprovalContext
): Promise<AgentApprovalRequirement | null> {
  const plan = await runner.call<{
    invocation: Record<string, unknown>;
    inputRevision: number;
    inputGeneration: string;
  }>(
    task.workspaceId,
    task.id,
    'exec',
    `/v1/workspaces/${task.workspaceId}/processes/${encodeURIComponent(textValue(call.arguments.sessionId))}/input-plan`,
    { data: textValue(call.arguments.data) }
  );
  if (
    !Number.isSafeInteger(plan.inputRevision) ||
    plan.inputRevision < 0 ||
    !/^[a-f0-9-]{36}$/.test(plan.inputGeneration)
  )
    throw new Error('The process returned an invalid input revision');
  const data = textValue(call.arguments.data);
  const stdin = textValue(plan.invocation.stdin);
  const previous = new Set(
    callDestinations('shell', {
      ...plan.invocation,
      stdin: data ? stdin.slice(0, -data.length) : stdin
    })
  );
  call.arguments.options = {
    inputRevision: plan.inputRevision,
    inputGeneration: plan.inputGeneration,
    inputDestinations: callDestinations('shell', plan.invocation).filter(
      (url) => !previous.has(url)
    )
  };
  const requirement = approvalRequirement('shell', plan.invocation, task.securityMode, context);
  if (!requirement) return null;
  const { taskGrant: _grant, ...decision } = requirement;
  return { ...decision, action: `Process input: ${decision.action}` };
}
