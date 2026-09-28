import { describe, expect, it } from 'vitest';
import { seedMediaModels, type ModelToolCall } from '@garden/model-gateway';
import type { TaskRecord } from '@garden/data';
import type { AgentState, InferenceCredential } from './agent-state.js';
import { pinMediaGenerationApproval, requireMediaGenerationApproval } from './media-approval.js';

const key = Buffer.alloc(32, 17);
const task = { id: 'task', workspaceId: 'workspace', privacyRoute: 'provider_zdr' } as TaskRecord;
const call: ModelToolCall = {
  id: 'call',
  name: 'generate_media',
  arguments: { kind: 'image', prompt: 'A blue circle' }
};
const secret = (): InferenceCredential => {
  const image = seedMediaModels().find((route) => route.modality === 'image');
  expect(image).toBeDefined();
  return {
    provider: 'openrouter',
    baseUrl: 'https://provider.example/v1',
    apiKey: 'key',
    enforceZeroDataRetention: true,
    mediaRoutes: {
      image: {
        ...image!,
        providerEndpointTag: 'private',
        pricing: [{ billable: 'output_image', unit: 'image', costUsd: 0.04 }]
      }
    }
  };
};
const state = (): AgentState => ({ messages: [], step: 0, credits: 0 });

describe('the media route reviewed is the route that may submit', () => {
  it('survives a durable resume and ignores only catalogue display timestamps', () => {
    const before = state(),
      credential = secret();
    pinMediaGenerationApproval(key, task, before, call, credential);
    const resumed = JSON.parse(JSON.stringify(before)) as AgentState;
    credential.mediaRoutes!.image!.updatedAt = new Date().toISOString();
    expect(() =>
      requireMediaGenerationApproval(key, task, resumed, call, credential)
    ).not.toThrow();
    expect(resumed.mediaApprovals?.call?.modelId).toBe(
      credential.mediaRoutes?.image?.providerModelId
    );
  });

  it.each([
    'model',
    'endpoint',
    'price',
    'credential',
    'privacy',
    'arguments',
    'turn',
    'missing'
  ] as const)('refuses changed %s before spending', (change) => {
    const approved = state(),
      credential = secret();
    pinMediaGenerationApproval(key, task, approved, call, credential);
    let submitted = call;
    if (change === 'model') credential.mediaRoutes!.image!.providerModelId = 'another/model';
    if (change === 'endpoint') credential.mediaRoutes!.image!.providerEndpointTag = 'another';
    if (change === 'price') credential.mediaRoutes!.image!.pricing![0]!.costUsd = 0.08;
    if (change === 'credential') credential.apiKey = 'replacement';
    if (change === 'privacy') credential.enforceZeroDataRetention = false;
    if (change === 'arguments')
      submitted = { ...call, arguments: { ...call.arguments, prompt: 'Other work' } };
    if (change === 'turn') approved.turn = 1;
    if (change === 'missing') delete approved.mediaApprovals;
    expect(() =>
      requireMediaGenerationApproval(key, task, approved, submitted, credential)
    ).toThrow(/route, credential or price changed/);
  });
});
