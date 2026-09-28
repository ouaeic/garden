import type { ModelRelease } from '@garden/contracts';
import { reconcileCodingMission } from './coding-mission-loop.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CodingMissionStart } from '@garden/contracts';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { encryptJson, generateDataKey, wrapDataKey } from '@garden/core';
import {
  executeCodingMission,
  parkCodingMissionWait,
  CODING_CHILD_TOOLS
} from './coding-missions.js';
import { executeToolCall, type ToolContext } from './tool-dispatch.js';
import { codingMissionApproval } from './coding-mission-approval.js';
import type { ApprovalFloorDeps } from './approval-floor.js';
import type { AgentState } from './agent-state.js';
const master = Buffer.alloc(32, 3),
  key = generateDataKey();
const input = CodingMissionStart.parse({
  name: 'Parser',
  instruction: 'Fix the parser and test it',
  sourceRoot: 'project',
  outputPaths: ['src'],
  maxComputeCredits: 0.3
});
const changed = {
  path: 'src/parser.ts',
  kind: 'modified',
  bytes: 20,
  baseHash: 'a',
  resultHash: 'b',
  conflict: false,
  permitted: true,
  diff: '-old\n+new',
  binary: false,
  diffOmitted: false
};
const digest = 'a'.repeat(64);
describe('native coding tool and durable parent wait', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' }),
    store = new DataStore(database);
  beforeAll(async () => {
    await migrateDatabase(database);
    await store.upsertModels([
      {
        id: 'model',
        providerModelId: 'model',
        displayName: 'Model',
        provider: 'custom',
        revision: 'test',
        availability: 'available',
        openness: 'remote_proprietary',
        license: 'Provider-defined',
        commercialUse: true,
        privacyRoute: 'provider_zdr',
        contextTokens: 128000,
        modalities: ['text'],
        capabilities: ['chat', 'tools', 'reasoning'],
        usageClass: 'light',
        recommendationTags: [],
        measuredQuality: 0.8,
        measuredLatencyMs: 100,
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.2
      }
    ]);
  });
  afterAll(async () => database.close());
  const fixture = async () => {
    const user = await store.createUser({ username: randomUUID(), displayName: 'Owner' }),
      workspaceId = randomUUID();
    const workspace = await store.createWorkspace({
      id: workspaceId,
      userId: user.id,
      name: 'Main',
      storageLimitBytes: 1e9,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: wrapDataKey(key, master, workspaceId)
    });
    await store.updateWorkspaceStatus(workspace.id, 'running');
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: encryptJson({ title: 'Main' }, key),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson({ prompt: 'Build the parser' }, key)
    });
    await database.query(
      "UPDATE tasks SET status='running',lease_owner='worker',lease_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [task.id]
    );
    const runner = {
      call: vi.fn(
        async (
          _workspace: string,
          _task: string,
          _scope: string,
          url: string,
          _body?: unknown
        ): Promise<unknown> => {
          void _body;
          if (url.endsWith('/capabilities')) return { available: true, reason: null };
          if (url.endsWith('/review'))
            return { digest, changes: [changed], canIntegrate: true, detail: 'Review' };
          if (url.endsWith('/integrate')) return { integrated: true, digest, changedFiles: 1 };
          return { generation: 1 };
        }
      )
    };
    const state: AgentState = { messages: [], step: 0, credits: 0, turnToolResults: {} };
    const context = {
      store,
      task,
      key,
      masterKey: master,
      runner,
      state,
      config: { WORKER_ID: 'worker' },
      connectedModels: async (_task: unknown, catalog: readonly ModelRelease[]) =>
        catalog.filter((model) => model.provider === 'custom')
    } as unknown as ToolContext;
    return { context, runner, state, task, user, workspace };
  };
  it('replays a native start once and presents a sealed child task with the same model, floor and fixed budget', async () => {
    const f = await fixture(),
      call = {
        id: 'start',
        name: 'coding_agent',
        arguments: { agent: 'garden', action: 'run', options: input }
      };
    const first = await executeCodingMission(f.context, call),
      second = await executeCodingMission(f.context, call);
    expect(first).toEqual(second);
    expect(await store.listWorkspaces(f.user.id)).toHaveLength(1);
    const missions = await store.listCodingMissions(f.user.id, f.task.id);
    expect(missions).toHaveLength(1);
    const child = await store.getTask(f.user.id, missions[0]!.childTaskId);
    expect(child).toMatchObject({
      modelId: f.task.modelId,
      securityMode: f.task.securityMode,
      maxComputeCredits: 0.3,
      parentMissionId: missions[0]!.id
    });
    expect(f.task.hasCodingFamily).toBe(true);
    expect(f.runner.call.mock.calls.filter((c) => c[3].endsWith('/start'))).toHaveLength(1);
  });
  it('parks the parent without another model call and wakes only after the child has stopped', async () => {
    const f = await fixture();
    await executeCodingMission(f.context, {
      id: 'start',
      name: 'coding_agent',
      arguments: { agent: 'garden', action: 'run', options: input }
    });
    const mission = (await store.listCodingMissions(f.user.id, f.task.id))[0]!;
    expect(
      await parkCodingMissionWait(
        f.context,
        f.task,
        key,
        f.state,
        { id: 'wait', name: 'coding_agent', arguments: { agent: 'garden', action: 'wait' } },
        [{ id: 'later', name: 'file_read', arguments: {} }]
      )
    ).toBe(true);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('awaiting_resource');
    expect(f.state.messages.map((m) => m.toolCallId)).toEqual(['wait', 'later']);
    expect(await store.wakeCodingMissionParents()).toEqual([]);
    await store.updateTask({ id: mission.childTaskId, status: 'completed' });
    expect(await store.wakeCodingMissionParents()).toEqual([f.task.id]);
    expect((await store.getTask(f.user.id, f.task.id))?.status).toBe('queued');
  });
  it('requires a parent-observed digest and binds the normal approval floor to actual changed paths', async () => {
    const f = await fixture();
    await executeCodingMission(f.context, {
      id: 'start',
      name: 'coding_agent',
      arguments: {
        agent: 'garden',
        action: 'run',
        options: { ...input, sourceRoot: 'workspace', outputPaths: ['src', 'AGENTS.md'] }
      }
    });
    const mission = (await store.listCodingMissions(f.user.id, f.task.id))[0]!;
    await store.updateTask({ id: mission.childTaskId, status: 'completed' });
    const integrate = {
      id: 'integrate',
      name: 'coding_agent',
      arguments: {
        agent: 'garden',
        action: 'integrate',
        options: { missionId: mission.id, digest, generation: 1 }
      }
    };
    await expect(executeCodingMission(f.context, integrate)).rejects.toThrow(/inspectable/);
    await executeCodingMission(f.context, {
      id: 'review',
      name: 'coding_agent',
      arguments: { agent: 'garden', action: 'review', options: { missionId: mission.id } }
    });
    const deps = {
      ...f.context,
      destinationContext: () => ({}),
      inferenceCredential: vi.fn()
    } as unknown as ApprovalFloorDeps;
    expect(await codingMissionApproval(deps, f.task, integrate, f.state, {})).toBeNull();
    f.runner.call.mockImplementation(async (_w, _t, _s, url) =>
      url.endsWith('/review')
        ? { digest, changes: [{ ...changed, path: 'AGENTS.md' }], canIntegrate: true }
        : {}
    );
    expect(
      await codingMissionApproval(deps, f.task, integrate, f.state, {
        taintSources: ['coding agent report']
      })
    ).toMatchObject({ sideEffect: 'workspace_write' });
    f.state.codingMissionReviews = {};
    await expect(codingMissionApproval(deps, f.task, integrate, f.state, {})).rejects.toThrow(
      /exact coding mission review/
    );
  });
  it('refuses recursive or noncoding child capabilities before dispatch', async () => {
    const f = await fixture();
    f.task.parentMissionId = randomUUID();
    expect(CODING_CHILD_TOOLS.size).toBeGreaterThan(10);
    await expect(
      executeToolCall(f.context, { id: 'bad', name: 'desktop_launch', arguments: {} })
    ).rejects.toThrow(/outside/);
    await expect(
      executeCodingMission(f.context, {
        id: 'bad',
        name: 'coding_agent',
        arguments: { agent: 'garden', action: 'run', options: input }
      })
    ).rejects.toThrow(/cannot create/);
    expect(f.runner.call).not.toHaveBeenCalled();
  });
  it('seals completed child runtime and cancels it when the parent has failed without another model call', async () => {
    const f = await fixture();
    await executeCodingMission(f.context, {
      id: 'start',
      name: 'coding_agent',
      arguments: { agent: 'garden', action: 'run', options: input }
    });
    const mission = (await store.listCodingMissions(f.user.id, f.task.id))[0]!;
    await store.updateTask({ id: mission.childTaskId, status: 'completed' });
    await reconcileCodingMission(
      store,
      f.context.runner,
      (await store.getCodingMission(f.user.id, mission.id))!
    );
    expect(f.runner.call.mock.calls.some((call) => call[3].endsWith('/seal'))).toBe(true);
    expect((await store.getCodingMission(f.user.id, mission.id))?.runnerSealed).toBe(true);
    await store.updateTask({ id: f.task.id, status: 'failed' });
    await reconcileCodingMission(
      store,
      f.context.runner,
      (await store.getCodingMission(f.user.id, mission.id))!
    );
    expect(f.runner.call.mock.calls.some((call) => call[3].endsWith('/cancel'))).toBe(true);
    expect(await store.getCodingMission(f.user.id, mission.id)).toMatchObject({
      phase: 'cancelled',
      runnerSealed: true
    });
  });
});
