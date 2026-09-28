import { afterEach, describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '@garden/core';
import { createDatabase, migrateDatabase, DataStore, type Database } from '@garden/data';
import type { AgentState } from '../agent-state.js';
import { approvalPreviewHash } from '../approval-state.js';
import { parkForApproval } from './approval-park.js';

let database: Database | undefined;
afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe('the first observable approval', () => {
  it('preserves broker-observed destinations in the sealed browser card, including the port', async () => {
    const key = new Uint8Array(32).fill(7);
    let preview: Record<string, unknown> | undefined;
    const store = {
      parkTaskForApproval: async (input: {
        previewCiphertext: Parameters<typeof decryptJson>[0];
      }) => {
        preview = decryptJson(input.previewCiphertext, key, 'approval:task');
        return false;
      }
    } as unknown as DataStore;
    await parkForApproval(
      { store, config: { WORKER_ID: 'worker' } } as never,
      { id: 'task', userId: 'owner' } as never,
      key,
      { messages: [], credits: 0 } as unknown as AgentState,
      {
        id: 'upload',
        name: 'browser_action',
        arguments: { action: 'upload', selector: '#cv', paths: ['workspace/cv.pdf'] }
      },
      {
        sideEffect: 'external_consequential',
        action: 'Upload CV',
        preview: 'Upload the CV',
        destinations: ['https://careers.example:8443']
      },
      []
    );
    expect(preview?.addresses).toEqual(['careers.example:8443']);
  });
  it('can be answered immediately without losing the exact sealed continuation', async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    const store = new DataStore(database);
    const key = new Uint8Array(32).fill(7);
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Fixture',
      storageLimitBytes: 1024 ** 3,
      imageRevision: 'fixture',
      region: 'auto',
      wrappedKey: 'fixture'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: encryptJson('Fixture', key),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'fixture',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: encryptJson('Fixture', key)
    });
    const leased = await store.leaseNextTask('worker');
    expect(leased?.id).toBe(task.id);
    const call = { id: 'call-1', name: 'shell', arguments: { command: 'echo fixture' } };
    const deferred = { id: 'call-2', name: 'file_read', arguments: { path: 'workspace/result' } };
    const state = { messages: [], credits: 0.25 } as unknown as AgentState;
    const append = store.appendTaskEvent.bind(store);
    let answered = 0;
    store.appendTaskEvent = async (input) => {
      const event = await append(input);
      if (input.kind === 'approval_requested') {
        const cards = await store.listApprovals(user.id);
        expect(cards).toHaveLength(1);
        const parked = await store.getTask(user.id, task.id);
        expect(parked?.agentStateCiphertext).not.toBeNull();
        const sealed = decryptJson<AgentState>(
          parked!.agentStateCiphertext!,
          key,
          `task-state:${task.id}`
        );
        expect(sealed.pending).toEqual({ approvalId: cards[0]!.id, toolCall: call });
        expect(sealed.messages).toEqual([
          expect.objectContaining({ role: 'tool', toolCallId: deferred.id })
        ]);
        expect(cards[0]?.previewHash).toBe(approvalPreviewHash(key, call.name, call.arguments));
        expect(await store.resolveApproval(user.id, String(cards[0]!.id), 'approved')).toBe(true);
        answered += 1;
      }
      return event;
    };
    await parkForApproval(
      { store, config: { WORKER_ID: 'worker' } } as never,
      leased!,
      key,
      state,
      call,
      { sideEffect: 'external_consequential', action: 'Run fixture', preview: 'Only this command' },
      [deferred]
    );
    expect(answered).toBe(1);
    const queued = await store.getTask(user.id, task.id);
    expect(queued?.status).toBe('queued');
    expect(
      decryptJson<AgentState>(queued!.agentStateCiphertext!, key, `task-state:${task.id}`).pending
        ?.toolCall
    ).toEqual(call);
  });

  it('publishes no card event when the worker no longer owns the task', async () => {
    const events: unknown[] = [];
    const store = {
      parkTaskForApproval: async () => false,
      appendTaskEvent: async (input: unknown) => events.push(input)
    } as unknown as DataStore;
    await parkForApproval(
      { store, config: { WORKER_ID: 'worker' } } as never,
      { id: 'task', userId: 'owner' } as never,
      new Uint8Array(32),
      { messages: [], credits: 0 } as unknown as AgentState,
      { id: 'call', name: 'shell', arguments: {} },
      { sideEffect: 'external_consequential', action: 'Run fixture', preview: 'Fixture' },
      []
    );
    expect(events).toEqual([]);
  });
});
