import { afterEach, expect, it, vi } from 'vitest';
import { seedMediaModels, type ModelToolCall } from '@garden/model-gateway';
import type { AgentState, InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
import { pinMediaGenerationApproval } from './media-approval.js';
import { executeDocumentTool } from './tools/documents.js';
afterEach(() => vi.unstubAllGlobals());
it('quotes, reserves and dispatches one generation using the selected model default dimensions', async () => {
  const template = seedMediaModels().find((route) => route.modality === 'image');
  expect(template).toBeDefined();
  const route = {
    ...template!,
    providerModelId: 'bytedance-seed/seedream-4.5',
    apiProtocol: 'openrouter' as const,
    capabilities: { parameters: {}, supportsStreaming: false },
    pricing: [{ billable: 'output_image', unit: 'megapixel' as const, costUsd: 0.01 }]
  };
  const secret: InferenceCredential = {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'offline',
    enforceZeroDataRetention: true,
    mediaRoutes: { image: route }
  };
  const key = Buffer.alloc(32, 9),
    state: AgentState = { messages: [], step: 0, credits: 0 };
  const call: ModelToolCall = {
    id: 'default-image',
    name: 'generate_media',
    arguments: { kind: 'image', prompt: 'A blue circle', path: 'circle.png' }
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bQAAAABJRU5ErkJggg==',
    'base64'
  );
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON image request');
    expect(JSON.parse(init.body)).toMatchObject({
      model: route.providerModelId,
      size: '2048x2048'
    });
    return Response.json({ data: [{ b64_json: png.toString('base64') }], usage: { cost: 0.04 } });
  });
  vi.stubGlobal('fetch', fetch);
  const recordUsage = vi.fn(),
    writeBytes = vi.fn(),
    spendGuard = vi.fn(async () => ({ outcome: 'allow' }));
  const context = {
    key,
    state,
    task: { id: 'task', userId: 'owner', workspaceId: 'workspace', privacyRoute: 'provider_zdr' },
    config: { WORKER_ID: 'worker', PUBLIC_APP_URL: 'https://garden.example' },
    inferenceCredential: async () => secret,
    store: {
      spendGuard,
      recordUsage,
      setWorkspaceStorage: vi.fn(),
      taskClaim: async () => ({ status: 'running', leaseOwner: 'worker' })
    },
    runner: { writeBytes, call: async () => ({ storageBytes: png.length }) }
  } as unknown as ToolContext;
  pinMediaGenerationApproval(key, context.task, state, call, secret);
  await expect(executeDocumentTool(context, call)).resolves.toMatchObject({
    modelId: route.providerModelId,
    paths: ['workspace/circle.png'],
    costUsd: 0.04
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(spendGuard).toHaveBeenCalledWith(expect.objectContaining({ estimateUsd: 0.04194304 }));
  expect(recordUsage).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ costUsd: 0.04194304, state: 'reserved', reserveAgainstCaps: true })
  );
  expect(recordUsage).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ costUsd: 0.04, state: 'settled' })
  );
  expect(writeBytes).toHaveBeenCalledWith('workspace', 'task', 'workspace/circle.png', png);
});
it.each(['model', 'price', 'credential'] as const)(
  'refuses a %s change after preparation and before reservation or provider upload',
  async (change) => {
    const routes = seedMediaModels();
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((item) => item.modality === 'image')!;
    const secret: InferenceCredential = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'first',
      enforceZeroDataRetention: true,
      mediaRoutes: { image: route }
    };
    let latest = secret;
    const key = Buffer.alloc(32, 9),
      state: AgentState = { messages: [], step: 0, credits: 0 };
    const call: ModelToolCall = {
      id: 'image-request',
      name: 'generate_media',
      arguments: { kind: 'image', prompt: 'A blue circle', path: 'circle.png' }
    };
    const upload = vi.fn(() => {
      throw Error('Provider must not be contacted');
    });
    vi.stubGlobal('fetch', upload);
    const recordUsage = vi.fn(),
      guard = vi.fn(async () => {
        latest = {
          ...secret,
          ...(change === 'credential'
            ? { apiKey: 'replacement' }
            : {
                mediaRoutes: {
                  image: {
                    ...route,
                    ...(change === 'model'
                      ? { providerModelId: 'replacement' }
                      : { usdPerImage: 0.9 })
                  }
                }
              })
        };
        return { outcome: 'allow' };
      });
    const context = {
      key,
      state,
      task: { id: 'task', userId: 'owner', workspaceId: 'workspace', privacyRoute: 'provider_zdr' },
      config: { WORKER_ID: 'worker', PUBLIC_APP_URL: 'https://garden.example' },
      inferenceCredential: async () => latest,
      store: {
        spendGuard: guard,
        recordUsage,
        taskClaim: async () => ({ status: 'running', leaseOwner: 'worker' })
      }
    } as unknown as ToolContext;
    pinMediaGenerationApproval(key, context.task, state, call, secret);
    await expect(executeDocumentTool(context, call)).rejects.toMatchObject({
      code: 'media_route_changed'
    });
    expect(guard).toHaveBeenCalledOnce();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  }
);
