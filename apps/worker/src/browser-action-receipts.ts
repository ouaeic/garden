import { createHash } from 'node:crypto';
import type { AgentState } from './agent-state.js';

/** The checkpointed start distinguishes repeated provider call IDs across turns. */
export function browserActionRequestId(taskId: string, state: AgentState, callId: string) {
  const start =
    state.inFlight?.toolCallId === callId
      ? state.inFlight.startedAt
      : `${state.turn ?? 0}:${state.step}`;
  return createHash('sha256')
    .update(JSON.stringify([taskId, start, callId]))
    .digest('hex');
}
