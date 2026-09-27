import { runtimeValue } from '@athanor/core';
import { createHmac } from 'node:crypto';
import { AthanorError } from '@athanor/core';
import {
  isNativeOpenAIEndpoint,
  isOpenRouterEndpoint,
  refreshOpenRouterTranscriptionModel,
  type ModelToolCall
} from '@athanor/model-gateway';
import type { TaskRecord } from '@athanor/data';
import type { AgentState, InferenceCredential } from './agent-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { resolvedTranscriptionRoute } from './media.js';
import { TranscriptionControls } from './media-controls.js';
import { transcriptionRouteAllowed } from './routing.js';
import { canonicalJson, textValue } from './values.js';

export interface TranscriptionApproval {
  binding: string;
  sourceSha256: string;
  sourceBytes: number;
}

export const currentTranscriptionCredential = async (
  secret: InferenceCredential
): Promise<InferenceCredential> => {
  const route = secret.mediaRoutes?.transcription;
  if (
    !route ||
    !(
      secret.provider === 'openrouter' ||
      isOpenRouterEndpoint(secret.baseUrl) ||
      route.apiProtocol === 'openrouter'
    )
  )
    return secret;
  const refreshed = await refreshOpenRouterTranscriptionModel(route, {
    baseUrl: secret.baseUrl,
    apiKey: secret.apiKey ?? ''
  });
  return { ...secret, mediaRoutes: { ...secret.mediaRoutes, transcription: refreshed } };
};

export const transcriptionPrivacy = (
  secret: InferenceCredential,
  call: ModelToolCall
): 'provider_zdr' | 'external' => {
  const controls = TranscriptionControls.parse(call.arguments.options ?? {});
  if (controls.privacyRoute === 'external') return 'external';
  if (
    !transcriptionRouteAllowed(
      secret.mediaRoutes?.transcription,
      'provider_zdr',
      secret.provider !== 'openrouter' &&
        isNativeOpenAIEndpoint(secret.baseUrl) &&
        secret.enforceZeroDataRetention === true
    )
  )
    throw new AthanorError(
      'transcription_external_consent_required',
      'This transcription endpoint has no verified private route. Set options.privacyRoute="external" to request approval for this recording only, or choose a verified native private transcription route. Task and credential privacy remain unchanged.',
      409
    );
  return 'provider_zdr';
};

export const transcriptionBinding = (
  key: Uint8Array,
  task: TaskRecord,
  state: AgentState,
  call: ModelToolCall,
  secret: InferenceCredential
) => {
  const route = secret.mediaRoutes?.transcription;
  const model = resolvedTranscriptionRoute(
    secret.mediaRoutes,
    secret.provider !== 'openrouter' && isNativeOpenAIEndpoint(secret.baseUrl)
  );
  return runtimeValue('transcription.binding', () =>
    createHmac('sha256', key)
      .update(
        canonicalJson({
          version: 1,
          task: task.id,
          workspace: task.workspaceId,
          taskPrivacy: task.privacyRoute,
          turn: state.turn ?? 0,
          arguments: call.arguments,
          provider: secret.provider,
          baseUrl: secret.baseUrl,
          apiKey: secret.apiKey ?? '',
          enforceZeroDataRetention: secret.enforceZeroDataRetention,
          privacyRoute: transcriptionPrivacy(secret, call),
          route: route
            ? {
                id: route.id,
                providerModelId: route.providerModelId,
                provider: route.provider,
                apiProtocol: route.apiProtocol,
                zeroDataRetentionAvailable: route.zeroDataRetentionAvailable,
                requiresRetentionApproval: route.requiresRetentionApproval,
                unavailableReason: route.unavailableReason ?? null,
                pricing: route.pricing ?? [],
                priceSource: route.priceSource,
                usdPerMinute: route.usdPerMinute,
                bound: model?.transcriptionBound ?? null
              }
            : null
        })
      )
      .digest('hex')
  );
};

export const pinTranscriptionApproval = async (
  input: { runner: AgentRunnerClient; key: Uint8Array; task: TaskRecord; state: AgentState },
  call: ModelToolCall,
  secret: InferenceCredential
): Promise<TranscriptionApproval> => {
  const approvedBinding = transcriptionBinding(input.key, input.task, input.state, call, secret);
  const source = await input.runner.inspectAudioSource(
    input.task.workspaceId,
    input.task.id,
    textValue(call.arguments.path)
  );
  if (
    !/^[0-9a-f]{64}$/.test(source.sourceSha256) ||
    !Number.isSafeInteger(source.sourceBytes) ||
    source.sourceBytes <= 0
  )
    throw new AthanorError(
      'transcription_source_unverified',
      'The runner could not identify the recording for approval',
      409
    );
  const proof = { binding: approvedBinding, ...source };
  input.state.transcriptionApprovals = Object.fromEntries([
    ...Object.entries(input.state.transcriptionApprovals ?? {})
      .filter(([id]) => id !== call.id)
      .slice(-15),
    [call.id, proof]
  ]);
  return proof;
};

export const requireTranscriptionApproval = (
  input: { key: Uint8Array; task: TaskRecord; state: AgentState },
  call: ModelToolCall,
  secret: InferenceCredential
): TranscriptionApproval => {
  const proof = input.state.transcriptionApprovals?.[call.id];
  if (
    !proof ||
    proof.binding !== transcriptionBinding(input.key, input.task, input.state, call, secret)
  )
    throw new AthanorError(
      'transcription_approval_changed',
      'The recording approval no longer matches its task, route, credential, price or options. Request a new approval before sending it.',
      409
    );
  return proof;
};
