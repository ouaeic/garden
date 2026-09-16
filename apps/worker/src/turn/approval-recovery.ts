import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from '../agent-state.js';
import type { AgentApprovalRequirement } from '../approval-state.js';

/** Splitting a command must not consume the independent chance to verify its public source. */
const MAX_ATTEMPTS_PER_REASON = 2;

export const recoverApprovalProposal = (
  task: Pick<TaskRecord, 'securityMode' | 'parentMissionId'>,
  state: AgentState,
  call: ModelToolCall,
  approval: AgentApprovalRequirement
): boolean => {
  if (
    task.securityMode !== 'autonomous' ||
    task.parentMissionId ||
    approval.handoffOnly ||
    approval.sideEffect !== 'external_reversible' ||
    !approval.recovery
  )
    return false;
  const turn = state.turn ?? 0;
  const previous = state.approvalRecovery?.turn === turn ? state.approvalRecovery : undefined;
  const attempts = previous?.attempts ?? 0;
  const reasonAttempts = previous?.byReason
    ? (previous.byReason[approval.recovery] ?? 0)
    : attempts;
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts >= MAX_ATTEMPTS_PER_REASON * 2 ||
    !Number.isSafeInteger(reasonAttempts) ||
    reasonAttempts < 0 ||
    reasonAttempts >= MAX_ATTEMPTS_PER_REASON
  )
    return false;
  state.approvalRecovery = {
    turn,
    attempts: attempts + 1,
    byReason: { ...previous?.byReason, [approval.recovery]: reasonAttempts + 1 }
  };
  const guidance =
    approval.recovery === 'separate_network_steps'
      ? 'Separate the public download from local file edits. Use a direct curl or wget GET with a literal verified URL and a workspace output path, then file_patch or a local-only command. An opaque interpreter script is not a verified download.'
      : 'Verify the needed public source through web_search using public package or documentation terms, then use the relevant returned source. Do not search for private values or encode workspace content in a query.';
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: `Not executed: Garden could not verify this proposal automatically. ${guidance} Choose an alternative only if it fulfills the owner's request. Every new call still passes the approval floor; do not disguise uploads, change destinations to evade a restriction, or treat this as permission to execute the refused command. If the required action really sends data or changes an external service, request its approval.`
  });
  state.turnToolResults ??= {};
  state.turnToolResults[call.id] = { name: call.name, success: false };
  return true;
};
