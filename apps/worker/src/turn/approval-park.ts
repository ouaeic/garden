import { runtimeNow, runtimeUUID } from '@athanor/core';
/**
 * Parking a turn on an approval card: the card, the calls behind it, and the saved state.
 *
 * The decision and its continuation become durable together before the event is published.
 *
 * The **card** carries an encrypted preview and a hash of the exact arguments. The hash is what the
 * resume checks against on the way back in (`turn/resume.ts`), so an approval the owner gave for
 * one action cannot be inherited by a different one.
 *
 * The **calls behind it** are answered in writing before anything is saved. A model routinely
 * proposes several actions at once; a tool call with no tool result is a malformed window, and
 * nothing behind a decision may run before the decision is made.
 *
 * The **state** and decision are written together while releasing the worker lease. No caller
 * can answer the decision before the exact pending call is available to the next worker.
 */
import { encryptJson } from '@athanor/core';

import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import { approvalPreviewHash, type AgentApprovalRequirement } from '../approval-state.js';
import { event } from '../tool-recording.js';
import { approvalOrigin } from '../turn-bounds.js';
import { textValue } from '../values.js';
import { callDestinations } from '../command-classification.js';

/** What parking a turn on a card needs from the worker that owns it. */
export interface ApprovalParkDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
}

export const parkForApproval = async (
  deps: ApprovalParkDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  approval: AgentApprovalRequirement,
  /** The rest of this step's batch, answered in writing so the saved window is well formed. */
  deferredCalls: readonly ModelToolCall[]
): Promise<void> => {
  const origin = approvalOrigin(state);
  const approvalId = runtimeUUID();
  state.pending = {
    approvalId,
    toolCall: call,
    ...(approval.handoffOnly ? { handoffOnly: true } : {})
  };
  for (const deferred of deferredCalls) {
    state.messages.push({
      role: 'tool',
      toolCallId: deferred.id,
      content:
        'Deferred because an earlier action requires user approval. Request it again if still needed.'
    });
  }
  const parked = await deps.store.parkTaskForApproval({
    id: approvalId,
    workerId: deps.config.WORKER_ID,
    userId: task.userId,
    taskId: task.id,
    action: approval.handoffOnly ? 'secure_input_handoff' : call.name,
    ...(origin === undefined ? {} : { origin }),
    sideEffect: approval.sideEffect,
    previewCiphertext: encryptJson(
      {
        action: approval.action,
        preview: approval.preview,
        tool: call.name,
        ...(approval.handoff ? { handoff: approval.handoff } : {}),
        securityMode: task.securityMode,
        ...(!task.parentMissionId &&
        !approval.handoffOnly &&
        approval.sideEffect !== 'external_consequential' &&
        approval.taskGrant?.tool === call.name
          ? {
              taskGrant: {
                scope: approval.taskGrant,
                turn: state.turn ?? 0,
                securityMode: task.securityMode
              }
            }
          : {}),
        addresses: [
          ...new Set(
            [...callDestinations(call.name, call.arguments), ...(approval.destinations ?? [])].map(
              (address) => {
                try {
                  return new URL(address).host;
                } catch {
                  return 'Unresolved address';
                }
              }
            )
          )
        ],
        arguments: approval.handoffOnly
          ? { action: textValue(call.arguments.action, 'secure_input') }
          : call.arguments
      },
      key,
      `approval:${task.id}`
    ),
    previewHash: approvalPreviewHash(key, call.name, call.arguments),
    expiresAt: new Date(runtimeNow() + 24 * 60 * 60 * 1000),
    actualComputeCredits: state.credits,
    agentStateCiphertext: encryptJson(state, key, `task-state:${task.id}`)
  });
  if (!parked) return;
  await event(deps.store, task, key, 'approval_requested', approval.action, {
    approvalId,
    sideEffect: approval.sideEffect,
    preview: approval.preview
  });
};
