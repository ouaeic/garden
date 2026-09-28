import { describe, expect, it, vi } from 'vitest';
import { encryptJson } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import { declaredTaskOutputs, resolveDelivery } from './delivery.js';
import type { AgentState } from './agent-state.js';
import { AgentRunnerClient } from './runner-client.js';
import { handleFinishCall, type TurnFinishDeps } from './turn/finish.js';

const key = new Uint8Array(32).fill(9);
const task = { id: 'task', workspaceId: 'workspace', userId: 'owner' } as TaskRecord;
const preview = {
  id: 'preview',
  workspaceId: task.workspaceId,
  slug: 'real',
  entryPath: null,
  status: 'active',
  port: 8080,
  expiresAt: null as string | null
};
const fixture = () => {
  const store = {
    listMediaJobs: vi.fn(async () => []),
    getLatestTaskPlan: vi.fn(async () => null),
    listArtifacts: vi.fn(async () => [] as Array<Record<string, unknown>>),
    listWorkspacePreviews: vi.fn(async () => [preview]),
    listTaskEvents: vi.fn(async () => [
      {
        taskId: task.id,
        kind: 'preview',
        payloadCiphertext: encryptJson(
          {
            __gardenEventVersion: 1,
            payload: { previewId: preview.id }
          },
          key,
          `task-event:${task.id}`
        )
      }
    ]),
    appendTaskEvent: vi.fn(async () => ({ id: 'event' }))
  };
  const runner = { call: vi.fn(async () => ({ available: true })) };
  const deps = {
    store: store as unknown as DataStore,
    runner: runner as unknown as AgentRunnerClient,
    config: { PREVIEW_BASE_URL: 'https://garden.test/preview' }
  };
  const state: AgentState = { messages: [], step: 1, credits: 0, answered: true };
  return { deps, store, runner, state };
};

describe('delivery resolves against scoped output evidence', () => {
  it('accepts only task-scoped artifact names and immutable reference forms', async () => {
    const { deps, store, runner, state } = fixture();
    store.listArtifacts.mockResolvedValue([
      {
        id: 'known',
        taskId: task.id,
        nameCiphertext: encryptJson(
          { name: 'result.json' },
          key,
          `artifact-name:${task.workspaceId}`
        )
      },
      {
        id: 'foreign',
        taskId: 'another-task',
        nameCiphertext: encryptJson(
          { name: 'private.json' },
          key,
          `artifact-name:${task.workspaceId}`
        )
      }
    ]);
    const references = [
      'result.json',
      'known',
      'artifact:known',
      'artifact:result.json',
      'artifact:result.json (known)'
    ];
    expect(references.length).toBeGreaterThan(0);
    expect(await resolveDelivery(deps, task, key, state, references)).toEqual({
      deliverables: ['result.json'],
      unavailable: []
    });
    expect(runner.call).not.toHaveBeenCalled();
    expect(
      (
        await resolveDelivery(deps, task, key, state, [
          'artifact:private.json',
          'artifact:wrong.json (known)'
        ])
      ).unavailable
    ).toEqual(['artifact:private.json', 'artifact:wrong.json (known)']);
  });

  it('verifies a JSON file prefix without parsing it and still rejects missing files', async () => {
    const { deps, state } = fixture();
    deps.runner = new AgentRunnerClient('http://runner.invalid', 'r'.repeat(48));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(url instanceof Request ? url.url : url);
      expect(path.searchParams.get('maxBytes')).toBe('1');
      return path.searchParams.get('path')?.endsWith('missing.json')
        ? new Response(JSON.stringify({ error: { code: 'file_not_found', message: 'Missing' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
          })
        : new Response('{', { headers: { 'content-type': 'application/json' } });
    });
    try {
      expect(
        await resolveDelivery(deps, task, key, state, ['results.json', 'missing.json'])
      ).toEqual({
        deliverables: ['results.json', 'missing.json'],
        unavailable: ['missing.json']
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });
  it('requires an app preview even when finish omitted every output reference', async () => {
    const { deps, store, state } = fixture();
    store.listWorkspacePreviews.mockResolvedValueOnce([]);
    const result = await resolveDelivery(deps, task, key, state, [], {
      outputs: [{ kind: 'app', title: 'Maze', files: ['maze/index.html'] }]
    });
    expect(result.deliverables).toContain('maze/index.html');
    expect(result.unavailable).toEqual([expect.stringContaining('publish a usable preview')]);
  });

  it('resolves declared app intent to a registered live preview without manufacturing an access token', async () => {
    const { deps, state, runner } = fixture();
    const result = await resolveDelivery(deps, task, key, state, [], {
      outputs: [{ kind: 'app', title: 'Maze', files: ['maze/index.html'] }]
    });
    expect(result.unavailable).toEqual([]);
    expect(result.deliverables).toEqual(['maze/index.html', 'https://garden.test/preview/real/']);
    expect(result.deliverables.join()).not.toContain('access=');
    expect(
      (runner.call.mock.calls as unknown[][]).filter((call) =>
        String(call[3]).includes('/preview-check/')
      )
    ).toHaveLength(1);
  });

  it('requires a real source manifest and a passed command check for runnable package delivery', async () => {
    const { deps, state, runner } = fixture();
    runner.call.mockResolvedValue({ fileCount: 3 } as unknown as { available: boolean });
    const outputs = [
      {
        kind: 'app' as const,
        title: 'Analysis app',
        directories: ['analysis-app'],
        delivery: 'package' as const,
        run: { command: 'python app.py', acceptanceCheckId: 'smoke' }
      }
    ];
    expect((await resolveDelivery(deps, task, key, state, [], { outputs })).unavailable).toEqual([
      expect.stringContaining('passed named command acceptance check')
    ]);
    expect(
      (
        await resolveDelivery(deps, task, key, state, [], {
          outputs,
          passedCheckIds: new Set(['smoke'])
        })
      ).unavailable
    ).toEqual([]);
    runner.call.mockRejectedValue(new Error('missing source directory'));
    expect(
      (
        await resolveDelivery(deps, task, key, state, [], {
          outputs,
          passedCheckIds: new Set(['smoke'])
        })
      ).unavailable
    ).toEqual([expect.stringContaining('not available as a source bundle')]);
  });

  it('reads output intent from the sealed task plan and refuses a plan from another task', async () => {
    const { deps, store } = fixture();
    const outputs = [{ kind: 'answer', title: 'Explain the result' }];
    store.getLatestTaskPlan.mockResolvedValue({
      stepsCiphertext: encryptJson({ outputs }, key, `task-plan:${task.id}`)
    } as never);
    expect(await declaredTaskOutputs(deps.store, task.id, key)).toEqual(outputs);
    store.getLatestTaskPlan.mockResolvedValue({
      stepsCiphertext: encryptJson({ outputs }, key, 'task-plan:other')
    } as never);
    await expect(declaredTaskOutputs(deps.store, task.id, key)).rejects.toThrow();
  });
  it('adds changed source files without running a model or checking unrelated outputs', async () => {
    const { deps, store, runner, state } = fixture();
    state.artifactLedger = {
      entries: [{ path: 'workspace/app/index.html', mode: 'wrote', bytes: 120, step: 1 }],
      dropped: 0
    };
    expect(await resolveDelivery(deps, task, key, state, [])).toEqual({
      deliverables: ['workspace/app/index.html'],
      unavailable: []
    });
    expect(store.listArtifacts).not.toHaveBeenCalled();
    expect(runner.call).not.toHaveBeenCalled();
  });

  it('does not turn a pure answer into a publishing task', async () => {
    const { deps, state, store } = fixture();
    expect(await resolveDelivery(deps, task, key, state, undefined)).toEqual({
      deliverables: [],
      unavailable: []
    });
    expect(store.listTaskEvents).not.toHaveBeenCalled();
  });

  it('checks only one byte of a declared local file', async () => {
    const { deps, runner, state } = fixture();
    expect((await resolveDelivery(deps, task, key, state, ['app/index.html'])).unavailable).toEqual(
      []
    );
    expect(runner.call).toHaveBeenCalledExactlyOnceWith(
      task.workspaceId,
      task.id,
      'files.read',
      '/v1/workspaces/workspace/file?path=workspace%2Fapp%2Findex.html&maxBytes=1',
      undefined,
      { responseType: 'text' }
    );
  });

  it('matches a private preview through its registry and publication receipt without exposing its token', async () => {
    const { deps, runner, state } = fixture();
    const result = await resolveDelivery(deps, task, key, state, [
      'https://garden.test/preview/real/?access=private-token'
    ]);
    expect(result.unavailable).toEqual([]);
    expect(runner.call).toHaveBeenCalledExactlyOnceWith(
      task.workspaceId,
      task.id,
      'preview:8080',
      '/v1/workspaces/workspace/preview-check/8080'
    );
  });

  it('does not accept a preview belonging to another task or an invented URL', async () => {
    const { deps, store, runner, state } = fixture();
    store.listTaskEvents.mockResolvedValueOnce([]);
    const result = await resolveDelivery(deps, task, key, state, [
      'https://garden.test/preview/real/',
      'https://invented.test/'
    ]);
    expect(result.unavailable).toHaveLength(2);
    expect(runner.call).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'expired', 'unreachable'])('withdraws %s previews', async (failure) => {
    const { deps, store, runner, state } = fixture();
    if (failure === 'revoked')
      store.listWorkspacePreviews.mockResolvedValueOnce([{ ...preview, status: 'revoked' }]);
    if (failure === 'expired')
      store.listWorkspacePreviews.mockResolvedValueOnce([
        { ...preview, expiresAt: '2000-01-01T00:00:00Z' } as typeof preview
      ]);
    if (failure === 'unreachable') runner.call.mockResolvedValueOnce({ available: false });
    expect(
      (await resolveDelivery(deps, task, key, state, ['https://garden.test/preview/real/']))
        .unavailable
    ).toHaveLength(1);
  });

  it('accepts this task’s published artifact name and refuses another task’s name', async () => {
    const { deps, store, runner, state } = fixture();
    store.listArtifacts.mockResolvedValueOnce([
      {
        taskId: task.id,
        nameCiphertext: encryptJson(
          { name: 'Report.pdf' },
          key,
          `artifact-name:${task.workspaceId}`
        )
      },
      {
        taskId: 'other',
        nameCiphertext: encryptJson(
          { name: 'Secret.pdf' },
          key,
          `artifact-name:${task.workspaceId}`
        )
      }
    ]);
    runner.call.mockRejectedValue(new Error('missing'));
    const result = await resolveDelivery(deps, task, key, state, ['Report.pdf', 'Secret.pdf']);
    expect(result.unavailable).toEqual(['Secret.pdf']);
  });

  it('rejects unsafe paths without attempting a read', async () => {
    const { deps, runner, state } = fixture();
    expect(
      (
        await resolveDelivery(deps, task, key, state, [
          '../../etc/passwd',
          '/etc/passwd',
          'javascript:alert(1)'
        ])
      ).unavailable
    ).toHaveLength(3);
    expect(runner.call).not.toHaveBeenCalled();
  });
});

describe('finish holds missing outputs once and reports the unresolved result honestly', () => {
  it('finishes text work with explicit pending delivery while a durable video job continues, without a repair loop', async () => {
    const { deps, store, runner, state } = fixture();
    store.listMediaJobs.mockResolvedValue([
      { status: 'pending', outputPath: 'workspace/video.mp4' }
    ] as never);
    store.getLatestTaskPlan.mockResolvedValue({
      stepsCiphertext: encryptJson(
        { outputs: [{ kind: 'media', title: 'Video', files: ['video.mp4'] }] },
        key,
        `task-plan:${task.id}`
      )
    } as never);
    state.turnToolResults = { video: { name: 'generate_media', success: true } };
    const completeTurn = vi.fn<TurnFinishDeps['completeTurn']>(async () => undefined);
    const finishDeps = {
      ...deps,
      outstandingPlanSteps: async () => [],
      completeTurn
    } as unknown as TurnFinishDeps;
    const outcome = await handleFinishCall(
      finishDeps,
      task,
      key,
      state,
      {
        id: 'finish',
        name: 'finish',
        arguments: {
          summary: 'The video is generating.',
          deliverables: ['video.mp4'],
          verification: {
            status: 'verified',
            evidence: [
              {
                claim: 'The provider job was submitted',
                source: 'tool_result',
                toolCallId: 'video'
              }
            ]
          }
        }
      },
      { turn: 1, assistantText: 'The video is generating.' }
    );
    expect(outcome).toBe('completed');
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(completeTurn.mock.calls[0]?.[3].verification.status).toBe('delivery_pending');
    expect(runner.call).not.toHaveBeenCalled();
    expect(state.deliveryNagged).not.toBe(true);
  });
  it('survives a persisted resume and cannot mark a missing download verified', async () => {
    const { deps, runner, state } = fixture();
    runner.call.mockRejectedValue(new Error('missing'));
    const completeTurn = vi.fn<TurnFinishDeps['completeTurn']>(async () => undefined);
    state.turnToolResults = { check: { name: 'shell', success: true } };
    const finishDeps = {
      ...deps,
      outstandingPlanSteps: async () => [],
      completeTurn
    } as unknown as TurnFinishDeps;
    const call: ModelToolCall = {
      id: 'finish',
      name: 'finish',
      arguments: {
        summary: 'The report is ready.',
        deliverables: ['report.pdf'],
        verification: {
          status: 'verified',
          evidence: [{ claim: 'The command completed', source: 'tool_result', toolCallId: 'check' }]
        }
      }
    };
    expect(
      await handleFinishCall(finishDeps, task, key, state, call, { turn: 1, assistantText: 'Done' })
    ).toBe('held');
    expect(completeTurn).not.toHaveBeenCalled();
    const resumed = JSON.parse(JSON.stringify(state)) as AgentState;
    expect(
      await handleFinishCall(finishDeps, task, key, resumed, call, {
        turn: 1,
        assistantText: 'Done'
      })
    ).toBe('completed');
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(completeTurn.mock.calls[0]?.[3]).toMatchObject({
      verification: {
        status: 'delivery_incomplete'
      }
    });
    expect(completeTurn.mock.calls[0]?.[3].verification.remainingRisks).toContain(
      'Unavailable output: report.pdf'
    );
  });
});
