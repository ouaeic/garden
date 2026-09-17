import { UNKNOWN_SURFACES, type ModelRelease } from '@athanor/contracts';
import { AthanorError } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import {
  retainInterruptedResponse,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse
} from '@athanor/model-gateway';
import { describe, expect, it, vi } from 'vitest';
import type { AgentState, AgentWorkerConfig } from '../agent-state.js';
import { COMPACT_CONTEXT_TOOL, prepareModelContext } from '../context.js';
import { handOffAtStepLimit, type HandoffDeps } from '../handoff.js';
import { agentToolsFor } from '../tools.js';
import type { TurnRun } from './claim.js';
import { generateModelStep, type TurnGenerateDeps } from './generate.js';

describe('interrupted model calls', () => {
  it.each(['lead', 'handoff'] as const)(
    'settles %s usage once and preserves failure without accepting tools',
    async (mode) => {
      const key = new Uint8Array(32).fill(7);
      const task = {
        id: '44444444-4444-4444-8444-444444444444',
        userId: 'owner',
        workspaceId: 'workspace',
        maxComputeCredits: 1000
      } as TaskRecord;
      const model = {
        id: 'custom/model',
        provider: 'custom',
        providerModelId: 'model',
        displayName: 'Model',
        contextTokens: 128000,
        usageClass: 'light'
      } as ModelRelease;
      const state = {
        messages: [
          { role: 'system', content: 'ATHANOR RUNTIME CONTEXT (dynamic)' },
          { role: 'user', content: 'Complete the analysis.' }
        ],
        step: mode === 'handoff' ? 120 : 0,
        turn: 0,
        credits: 0,
        turnToolResults: {}
      } as unknown as AgentState;
      const initialMessages = structuredClone(state.messages);
      const response: ModelResponse = {
        text: 'Partial answer',
        toolCalls: [
          { id: 'finish-pending', name: 'finish', arguments: { summary: 'Must not complete' } }
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 4, totalTokens: 4, estimated: true },
        metadata: { provider: 'custom', model: 'model', latencyMs: 5, privacyRoute: 'provider_zdr' }
      };
      const failure = new AthanorError('provider_unavailable', 'connection interrupted', 503);
      retainInterruptedResponse(failure, response);
      const chat = vi.fn(async (_provider: string, input: ModelRequest) => {
        await input.onTextDelta?.('Partial answer');
        throw failure;
      });
      const gateway = { chat } as unknown as ModelGateway;
      const recordUsage = vi.fn<(input: Parameters<DataStore['recordUsage']>[0]) => Promise<void>>(
        async () => undefined
      );
      const billModelStep = vi.fn<TurnGenerateDeps['billModelStep']>(async () => undefined);
      const checkpoint = vi.fn(async () => undefined);
      const execute = vi.fn(async () => {
        throw Error('Incomplete response dispatched a tool');
      });
      const completeTurn = vi.fn(async () => {
        throw Error('Incomplete response completed a turn');
      });
      const store = {
        taskClaim: async () => ({ id: task.id, status: 'running', leaseOwner: 'worker' }),
        appendTaskEvent: async () => ({ id: 'event', sequence: 1 }),
        recordUsage
      } as unknown as DataStore;
      const withLeaseRenewal = async <T>(_task: TaskRecord, operation: () => Promise<T>) =>
        operation();
      const config = { WORKER_ID: 'worker', TASK_MAX_SELF_CONTINUATIONS: 0 } as AgentWorkerConfig;
      const maxOutputTokens = 16384;
      if (mode === 'lead') {
        const reservedTokens = Math.ceil(JSON.stringify([]).length / 4);
        const windowOptions = { precedingTokens: 0, reservedTokens };
        const preparedContext = prepareModelContext(
          state.messages,
          model.contextTokens,
          maxOutputTokens,
          windowOptions
        );
        const run = {
          model,
          catalog: [model],
          gateway,
          provider: 'custom',
          requestTools: [],
          withdrawnTools: new Set(
            [...agentToolsFor('lead', UNKNOWN_SURFACES, []), COMPACT_CONTEXT_TOOL].map(
              (tool) => tool.name
            )
          ),
          reservedTokens,
          surfaces: UNKNOWN_SURFACES,
          connectorKinds: []
        } as unknown as TurnRun;
        const deps = {
          config,
          store,
          withLeaseRenewal,
          billModelStep,
          checkpoint,
          compactContext: async () => false,
          noteRepeatingAnswer: async () => undefined
        } as unknown as TurnGenerateDeps;
        await expect(
          generateModelStep(
            deps,
            task,
            key,
            state,
            run,
            { maxOutputTokens, turn: 0 },
            { preparedContext, reasoningEffort: 'medium', windowOptions },
            { honorUserControl: async () => false, refreshActivePlan: async () => false }
          )
        ).rejects.toBe(failure);
        expect(billModelStep).toHaveBeenCalledOnce();
        expect(billModelStep.mock.calls[0]?.[3].response).toMatchObject({
          finishReason: 'error',
          usage: response.usage
        });
        expect(recordUsage).not.toHaveBeenCalled();
      } else {
        const deps = {
          config,
          store,
          withLeaseRenewal,
          outstandingPlanSteps: async () => ['Analysis'],
          execute,
          completeTurn,
          checkpoint
        } as unknown as HandoffDeps;
        await expect(
          handOffAtStepLimit(deps, task, key, state, {
            gateway,
            provider: 'custom',
            model,
            catalog: [model],
            turn: 0,
            maxOutputTokens,
            tools: [],
            webPlan: { mode: 'inhouse' } as never
          })
        ).rejects.toBe(failure);
        expect(recordUsage).toHaveBeenCalledOnce();
        expect(recordUsage.mock.calls[0]?.[0].state).toBe('settled');
        expect(recordUsage.mock.calls[0]?.[0].quantity).toBeGreaterThan(
          response.usage.outputTokens
        );
      }
      expect(chat).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(completeTurn).not.toHaveBeenCalled();
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledWith(
        task,
        key,
        expect.objectContaining({ step: mode === 'lead' ? 1 : 121 })
      );
      expect(state.messages.slice(0, initialMessages.length)).toEqual(initialMessages);
      expect(state.messages.slice(initialMessages.length)).toEqual(
        mode === 'handoff' ? [expect.objectContaining({ role: 'system' })] : []
      );
    }
  );
});
