import { runtimeValue } from '@garden/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GardenError } from '@garden/core';
import type { ModelToolCall } from '@garden/model-gateway';
import type { TaskRecord } from '@garden/data';
import type { AgentState, InferenceCredential } from './agent-state.js';
import { canonicalJson, textValue } from './values.js';

export interface MediaGenerationApproval {
  binding: string;
  modelId: string;
}

const binding = (
  key: Uint8Array,
  task: TaskRecord,
  state: AgentState,
  call: ModelToolCall,
  secret: InferenceCredential
): MediaGenerationApproval => {
  const kind = textValue(call.arguments.kind);
  const route =
    kind === 'image' || kind === 'audio' || kind === 'video'
      ? secret.mediaRoutes?.[kind]
      : undefined;
  if (!route || route.modality !== kind || !route.providerModelId || route.unavailableReason)
    throw new GardenError(
      'media_route_unavailable',
      'Choose a currently available media route in Settings.',
      409
    );
  const {
    updatedAt: _updatedAt,
    metadataVerifiedAt: _verifiedAt,
    recommendationTags: _tags,
    ...identity
  } = route;
  return {
    modelId: route.providerModelId,
    binding: runtimeValue('media.binding', () =>
      createHmac('sha256', key)
        .update(
          canonicalJson({
            taskId: task.id,
            workspaceId: task.workspaceId,
            turn: state.turn ?? 0,
            taskPrivacy: task.privacyRoute,
            tool: call.name,
            arguments: call.arguments,
            provider: secret.provider,
            baseUrl: secret.baseUrl,
            apiKey: secret.apiKey ?? '',
            enforceZeroDataRetention: secret.enforceZeroDataRetention,
            route: identity
          })
        )
        .digest('hex')
    )
  };
};

export const pinMediaGenerationApproval = (
  key: Uint8Array,
  task: TaskRecord,
  state: AgentState,
  call: ModelToolCall,
  secret: InferenceCredential
): MediaGenerationApproval => {
  const proof = binding(key, task, state, call, secret);
  state.mediaApprovals = Object.fromEntries([
    ...Object.entries(state.mediaApprovals ?? {})
      .filter(([id]) => id !== call.id)
      .slice(-15),
    [call.id, proof]
  ]);
  return proof;
};

export const requireMediaGenerationApproval = (
  key: Uint8Array,
  task: TaskRecord,
  state: AgentState,
  call: ModelToolCall,
  secret: InferenceCredential
): void => {
  const saved = state.mediaApprovals?.[call.id];
  const current = binding(key, task, state, call, secret);
  const before = Buffer.from(saved?.binding ?? '', 'hex');
  const after = Buffer.from(current.binding, 'hex');
  if (before.length !== after.length || !timingSafeEqual(before, after))
    throw new GardenError(
      'media_route_changed',
      'The media route, credential or price changed. Request this generation again so its current details can be reviewed.',
      409
    );
};
