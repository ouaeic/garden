import { encryptJson } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import { approvalRequirement } from '../approval-policy.js';
import { lentKeysCover } from '../approval-common.js';
import { approvalPreviewHash } from '../approval-state.js';

/**
 * Writes down an outward action that runs on a lent key instead of on a card.
 *
 * "Act as me" is the Autonomous mode, and the floor lets its sends, submissions and bookings run
 * without asking - so the approvals list, which is the record of what left this computer, would
 * miss exactly the actions the owner most wants to see afterwards. The yardstick is what Balanced
 * would have carded as consequential: the same words the owner would have read on the card, kept
 * beside the cards they did read. The other keys - spend, publish, remove, rules - answer cards
 * the goal's own mode still raises, so for them the yardstick is that card.
 *
 * Best effort, and before the call: a receipt that cannot be written is not a reason to hold the
 * owner's work, and a receipt written after the call would be lost by the worker that died in it.
 */
export const recordKeyAuthorized = async (
  store: Pick<DataStore, 'recordKeyAuthorizedAction'>,
  task: TaskRecord,
  key: Uint8Array,
  call: ModelToolCall
): Promise<void> => {
  const own = task.lentKeys?.length
    ? approvalRequirement(call.name, call.arguments, task.securityMode)
    : null;
  const lent = own && lentKeysCover(own, task) ? own : null;
  const acted =
    task.securityMode === 'autonomous'
      ? approvalRequirement(call.name, call.arguments, 'balanced')
      : null;
  const card = lent ?? (acted?.sideEffect === 'external_consequential' ? acted : null);
  if (!card) return;
  try {
    await store.recordKeyAuthorizedAction({
      userId: task.userId,
      taskId: task.id,
      action: card.action,
      sideEffect: card.sideEffect,
      previewCiphertext: encryptJson(
        {
          action: card.action,
          preview: card.preview,
          tool: call.name,
          securityMode: task.securityMode,
          authorizedBy: 'key'
        },
        key,
        `approval:${task.id}`
      ),
      previewHash: approvalPreviewHash(key, call.name, call.arguments)
    });
  } catch {
    // The receipt is the record's, not the action's; see above.
  }
};
