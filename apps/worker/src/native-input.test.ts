import { describe, expect, it, vi } from 'vitest';
import {
  seedModels,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse
} from '@garden/model-gateway';
import type { ModelRelease } from '@garden/contracts';
import { UNKNOWN_SURFACES } from '@garden/contracts';
import type { ModelGateway } from '@garden/model-gateway';
import { generateModelStep, type TurnGenerateDeps } from './turn/generate.js';
import type { TurnRun } from './turn/claim.js';
import { COMPACT_CONTEXT_TOOL, prepareModelContext } from './context.js';
import { agentToolsFor } from './tools.js';
import type { DataStore, TaskRecord } from '@garden/data';
import type { AgentState, InferenceCredential } from './agent-state.js';
import type { ToolContext } from './tool-dispatch.js';
import {
  stageNativeInput,
  materializeNativeInputs,
  nativeCredentialBinding,
  prepareNativeInputApproval
} from './native-input.js';
import { nativeInputAdapter } from './native-input-gateway.js';
import { approvalRequirement } from './approval-policy.js';
import { approvalForCall, type ApprovalFloorDeps } from './approval-floor.js';
import { startTurnState } from './completion.js';
import { recordModelStepUsage } from './billing.js';

const wav = Buffer.alloc(48);
wav.write('RIFF');
wav.writeUInt32LE(40, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(4, 40);
const model: ModelRelease = {
  ...seedModels()[0]!,
  id: 'test',
  providerModelId: 'test/model',
  provider: 'openrouter',
  availability: 'available' as const,
  providerAvailable: true,
  zeroDataRetentionAvailable: true,
  contextTokens: 32000,
  modalities: ['text', 'audio', 'video'] as ('text' | 'audio' | 'video')[],
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 2,
  nativeInputPricing: { audioUsdPerMillionTokens: 3, videoUsdPerMillionTokens: 3 }
};
const secret = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test',
  enforceZeroDataRetention: true
} as InferenceCredential;
const task = {
  id: 'task',
  userId: 'owner',
  workspaceId: 'workspace',
  modelId: model.id,
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 10
} as TaskRecord;
const response: ModelResponse = {
  text: 'A sound',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, costUsd: 0.00032 },
  metadata: {
    provider: 'openrouter',
    model: model.providerModelId,
    latencyMs: 1,
    privacyRoute: 'provider_zdr'
  }
};
const fixture = () => {
  const order: string[] = [];
  const store = {
    taskClaim: vi.fn(async () => ({ status: 'running', leaseOwner: 'worker' })),
    listModels: vi.fn(async () => [model]),
    recordUsage: vi.fn(async () => {
      order.push('reserve');
    }),
    settleNativeInputUsage: vi.fn(async () => {
      order.push('settle');
    })
  };
  const runner = { readBytes: vi.fn(async () => ({ bytes: wav, mimeType: 'audio/wav' })) };
  const state: AgentState = { messages: [], step: 0, credits: 0 };
  const context = {
    store,
    runner,
    task,
    state,
    consequentialApproved: true,
    inferenceCredential: async () => secret
  } as unknown as ToolContext;
  const adapter = {
    provider: 'openrouter',
    privacyRoute: 'provider_zdr',
    list: async () => [],
    chat: vi.fn(async (_request: ModelRequest) => {
      void _request;
      order.push('provider');
      return response;
    })
  };
  const current = vi.fn(async () => nativeCredentialBinding(secret));
  const wrapped = nativeInputAdapter(
    adapter as ModelAdapter,
    store as unknown as DataStore,
    task,
    model,
    nativeCredentialBinding(secret),
    current,
    'worker'
  );
  return { store, runner, state, context, adapter, wrapped, order, current };
};
const call = {
  id: 'read-1',
  arguments: { path: 'workspace/sound.wav', options: { action: 'native', kind: 'audio' } }
};
const prepare = async (f: ReturnType<typeof fixture>) => {
  await prepareNativeInputApproval(f.context, task, f.state, call);
  await stageNativeInput(f.context, call);
  return {
    model: model.providerModelId,
    tools: [],
    temperature: 0,
    ...(await materializeNativeInputs(
      f.context.runner,
      task,
      f.state,
      [{ role: 'user', content: 'What happened?' }],
      model
    ))
  } as ModelRequest;
};
describe('native recording reads', () => {
  it('binds the real approval card to sealed source, route, and price across a delayed decision', async () => {
    for (const change of ['source', 'credential', 'model-route', 'price'] as const) {
      const f = fixture();
      const card = await approvalForCall(
        {
          ...f.context,
          masterKey: Buffer.alloc(32),
          destinationContext: () => ({})
        } as unknown as ApprovalFloorDeps,
        task,
        { ...call, name: 'audio_read' },
        f.state
      );
      const approved = f.state.nativeInputApprovals![call.id]!;
      expect(card?.preview).toContain(approved.reference.sha256);
      expect(card?.preview).toContain(approved.reference.maxCostUsd.toFixed(3));
      expect(JSON.stringify(f.state)).not.toContain(wav.toString('base64'));
      let resumed: ToolContext = {
        ...f.context,
        state: JSON.parse(JSON.stringify(f.state)) as AgentState
      };
      if (change === 'source') {
        const changed = Buffer.from(wav);
        changed[44] = 1;
        f.runner.readBytes.mockResolvedValue({ bytes: changed, mimeType: 'audio/wav' });
      }
      if (change === 'credential')
        resumed = {
          ...resumed,
          inferenceCredential: async () => ({ ...secret, apiKey: 'replacement' })
        };
      if (change === 'model-route')
        f.store.listModels.mockResolvedValue([{ ...model, providerModelId: 'different/model' }]);
      if (change === 'price')
        f.store.listModels.mockResolvedValue([
          {
            ...model,
            nativeInputPricing: { audioUsdPerMillionTokens: 9, videoUsdPerMillionTokens: 9 }
          }
        ]);
      await expect(stageNativeInput(resumed, call)).rejects.toMatchObject({
        code:
          change === 'price'
            ? 'native_input_approved_cost_exceeded'
            : 'native_input_approval_changed'
      });
      expect(resumed.state.pendingNativeInputs).toBeUndefined();
      expect(f.adapter.chat).not.toHaveBeenCalled();
      expect(f.store.recordUsage).not.toHaveBeenCalled();
    }
  });
  it('requires its preflight approval and retains the approved cost ceiling through submission', async () => {
    const f = fixture();
    await expect(stageNativeInput(f.context, call)).rejects.toMatchObject({
      code: 'native_input_approval_required'
    });
    const request = await prepare(f);
    expect(f.state.nativeInputApprovals).toEqual({});
    await expect(stageNativeInput(f.context, call)).rejects.toMatchObject({
      code: 'native_input_approval_required'
    });
    await expect(
      materializeNativeInputs(f.context.runner, task, f.state, [], {
        ...model,
        nativeInputPricing: { audioUsdPerMillionTokens: 9, videoUsdPerMillionTokens: 9 }
      })
    ).rejects.toMatchObject({ code: 'native_input_approved_cost_exceeded' });
    request.nativeInputApprovedCostUsd = 0;
    await expect(f.wrapped.chat(request)).rejects.toMatchObject({
      code: 'native_input_approved_cost_exceeded'
    });
    expect(f.adapter.chat).not.toHaveBeenCalled();
    expect(f.store.recordUsage).not.toHaveBeenCalled();
    expect(
      startTurnState(f.state as unknown as Record<string, unknown>, {
        prompt: 'new',
        turn: 1,
        reservationKey: 'new'
      })
    ).not.toHaveProperty('nativeInputApprovals');
  });
  it('consumes native references in the real ordinary generation path without an observer or a repeated upload', async () => {
    const f = fixture();
    await prepareNativeInputApproval(f.context, task, f.state, call);
    await stageNativeInput(f.context, call);
    f.state.messages = [
      { role: 'system', content: 'Runtime instructions' },
      { role: 'user', content: 'Describe the sound' }
    ];
    const run = {
      model,
      catalog: [model],
      gateway: {
        chat: async (_provider: string, request: ModelRequest) => f.wrapped.chat(request)
      } as ModelGateway,
      provider: 'openrouter',
      requestTools: [],
      withdrawnTools: new Set(
        [...agentToolsFor('lead', UNKNOWN_SURFACES, []), COMPACT_CONTEXT_TOOL].map(
          (tool) => tool.name
        )
      ),
      reservedTokens: 1,
      surfaces: UNKNOWN_SURFACES,
      connectorKinds: []
    } as unknown as TurnRun;
    const deps = {
      runner: f.context.runner,
      store: {
        ...f.store,
        getTask: async () => null,
        appendTaskEvent: async () => ({ id: 'event', sequence: 1 })
      },
      config: { WORKER_ID: 'worker' },
      withLeaseRenewal: async <T>(_task: TaskRecord, operation: () => Promise<T>) => operation(),
      billModelStep: async () => undefined,
      compactContext: async () => false,
      noteRepeatingAnswer: async () => undefined
    } as unknown as TurnGenerateDeps;
    const windowOptions = { precedingTokens: 0, reservedTokens: 1 };
    const request = {
      preparedContext: prepareModelContext(
        f.state.messages,
        model.contextTokens,
        1024,
        windowOptions
      ),
      reasoningEffort: undefined,
      windowOptions
    };
    for (let count = 0; count < 2; count++) {
      expect(
        (
          await generateModelStep(
            deps,
            task,
            new Uint8Array(32),
            f.state,
            run,
            { maxOutputTokens: 1024, turn: 0 },
            request,
            { honorUserControl: async () => false, refreshActivePlan: async () => false }
          )
        ).outcome
      ).toBe('generated');
    }
    expect(f.adapter.chat).toHaveBeenCalledTimes(2);
    expect(f.adapter.chat.mock.calls[0]![0].messages.at(-1)?.nativeInputs).toHaveLength(1);
    expect(
      f.adapter.chat.mock.calls[1]![0].messages.some((message) => message.nativeInputs?.length)
    ).toBe(false);
    expect(f.state).not.toHaveProperty('pendingNativeInputs');
    expect(f.store.recordUsage).toHaveBeenCalledOnce();
  });
  it('stages sealed references without base64 and sends exact bytes once with a single durable ledger receipt', async () => {
    const f = fixture();
    const request = await prepare(f);
    expect(f.state.pendingNativeInputs).toHaveLength(1);
    expect(JSON.stringify(f.state)).not.toContain(wav.toString('base64'));
    expect(request.messages.at(-1)?.nativeInputs?.[0]?.data).toBe(wav.toString('base64'));
    const result = await f.wrapped.chat(request);
    await recordModelStepUsage(f.store, result, {
      userId: 'owner',
      taskId: 'task',
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 110,
      unit: 'tokens',
      credits: 0.1,
      costUsd: 0.00032,
      state: 'settled',
      idempotencyKey: 'ordinary-step'
    });
    expect(f.order).toEqual(['reserve', 'provider', 'settle']);
    expect(result.nativeInputUsageRecorded).toBe(true);
    expect(f.store.settleNativeInputUsage).toHaveBeenCalledWith(
      expect.objectContaining({ costUsd: 0.00032, quantity: 110 })
    );
    expect(
      startTurnState(f.state as unknown as Record<string, unknown>, {
        prompt: 'new',
        turn: 1,
        reservationKey: 'new'
      })
    ).not.toHaveProperty('pendingNativeInputs');
  });
  it('rejects changed bytes, unapproved reads and unknown pricing before provider contact', async () => {
    const f = fixture();
    await prepareNativeInputApproval(f.context, task, f.state, call);
    await stageNativeInput(f.context, call);
    f.runner.readBytes.mockResolvedValue({ bytes: Buffer.from('changed'), mimeType: 'audio/wav' });
    await expect(
      materializeNativeInputs(f.context.runner, task, f.state, [], model)
    ).rejects.toMatchObject({ code: 'native_input_source_changed' });
    f.runner.readBytes.mockResolvedValue({ bytes: wav, mimeType: 'audio/wav' });
    await prepareNativeInputApproval(f.context, task, f.state, call);
    await expect(
      stageNativeInput({ ...f.context, consequentialApproved: false }, call)
    ).rejects.toMatchObject({ code: 'native_input_approval_required' });
    f.store.listModels.mockResolvedValue([
      {
        ...model,
        nativeInputPricing: { audioUsdPerMillionTokens: null, videoUsdPerMillionTokens: null }
      }
    ] as (typeof model)[]);
    await expect(prepareNativeInputApproval(f.context, task, f.state, call)).rejects.toMatchObject({
      code: 'native_input_pricing_unknown'
    });
    expect(f.adapter.chat).not.toHaveBeenCalled();
    expect(f.store.recordUsage).not.toHaveBeenCalled();
  });
  it('reserves nothing on revoked routing, model change, cancellation, or insufficient credits', async () => {
    for (const kind of ['credential', 'catalogue', 'cancel', 'credits', 'model'] as const) {
      const f = fixture();
      const request = await prepare(f);
      if (kind === 'credential') f.current.mockResolvedValue('changed');
      if (kind === 'catalogue')
        f.store.listModels.mockResolvedValue([
          { ...model, availability: 'unavailable' }
        ] as (typeof model)[]);
      if (kind === 'cancel') request.signal = AbortSignal.abort();
      if (kind === 'credits') request.nativeInputCreditLimit = 0;
      if (kind === 'model') {
        f.state.pendingNativeInputs![0]!.modelId = 'other';
        await expect(
          materializeNativeInputs(f.context.runner, task, f.state, [], model)
        ).rejects.toThrow(/changed/);
        continue;
      }
      await expect(f.wrapped.chat(request)).rejects.toThrow();
      expect(f.adapter.chat).not.toHaveBeenCalled();
      expect(f.store.recordUsage).not.toHaveBeenCalled();
    }
  });
  it('retains ambiguous paid exposure and refuses a denied reservation without a provider call', async () => {
    const f = fixture();
    const request = await prepare(f);
    f.adapter.chat.mockRejectedValue(new Error('connection lost'));
    await expect(f.wrapped.chat(request)).rejects.toThrow('connection lost');
    expect(f.store.recordUsage).toHaveBeenCalledOnce();
    expect(f.store.settleNativeInputUsage).not.toHaveBeenCalled();
    const denied = fixture();
    const other = await prepare(denied);
    denied.store.recordUsage.mockRejectedValue(new Error('spend cap'));
    await expect(denied.wrapped.chat(other)).rejects.toThrow('spend cap');
    expect(denied.adapter.chat).not.toHaveBeenCalled();
    const cut = fixture();
    const cutRequest = await prepare(cut);
    cut.adapter.chat.mockResolvedValue({
      ...response,
      usage: { ...response.usage, estimated: true }
    });
    await cut.wrapped.chat(cutRequest);
    expect(cut.store.settleNativeInputUsage).not.toHaveBeenCalled();
  });
  it('requires a recording-specific approval while keeping transcription and cheap discovery distinct', () => {
    const native = approvalRequirement('audio_read', call.arguments, 'autonomous');
    expect(native?.sideEffect).toBe('external_reversible');
    expect(native?.preview).toContain('exact bytes');
    expect(
      approvalRequirement('audio_read', { options: { action: 'describe' } }, 'autonomous')
    ).toBeNull();
  });
});
