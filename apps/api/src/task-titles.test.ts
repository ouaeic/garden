/**
 * Naming a conversation, and the three things that must not happen while it is named: a name the
 * owner wrote must never be replaced, a box at its spending ceiling must not spend on names, and a
 * provider that is refusing must not be asked once per answer for as long as it refuses.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AthanorError,
  buildConversationNameIndex,
  decryptJson,
  encryptJson,
  memoryIndexKey,
  wrapDataKey
} from '@athanor/core';
import { createDatabase, DataStore, migrateDatabase, type Database } from '@athanor/data';
import { createLogger } from './log.js';
import {
  cleanGeneratedTitle,
  provisionalTaskTitle,
  MAX_GENERATED_TITLE_LENGTH,
  startTaskTitler,
  titleTasksOnce,
  type TitleCompletion,
  type TaskTitlerDeps
} from './task-titles.js';

const masterKey = Buffer.alloc(32, 7);
const log = createLogger({ level: 'silent' });

const completion = (text: string): TitleCompletion => ({
  text,
  costUsd: 0.0004,
  inputTokens: 120,
  outputTokens: 6,
  providerRef: 'openrouter:z-ai/glm-5.2',
  resourceClass: 'medium'
});

/** A box with one conversation whose first answer has landed and which still wears a placeholder. */
const boxWithAnsweredTask = async () => {
  const database: Database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
  const dataKey = Buffer.alloc(32, 9);
  // The workspace key is bound to the workspace id, so the id is chosen before the row is written.
  const workspaceId = randomUUID();
  const workspace = await store.createWorkspace({
    id: workspaceId,
    userId: user.id,
    name: 'Computer',
    storageLimitBytes: 10_000_000_000,
    imageRevision: 'dev',
    region: 'local',
    securityMode: 'balanced',
    wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson(
      { title: 'Have a look at the build log and tell me' },
      dataKey,
      `task-title:${workspace.id}`
    ),
    nameIndex: buildConversationNameIndex(
      'Have a look at the build log and tell me',
      'Have a look at the build log and tell me why the release job is red',
      memoryIndexKey(dataKey)
    ),
    modelId: 'openrouter/z-ai/glm-5.2',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    securityMode: 'balanced',
    promptCiphertext: encryptJson(
      { prompt: 'Have a look at the build log and tell me why the release job is red' },
      dataKey,
      `task-prompt:${workspace.id}`
    )
  });
  await store.appendTaskEvent({
    taskId: task.id,
    kind: 'assistant_message',
    summary: 'Answered',
    payloadCiphertext: encryptJson(
      { markdown: 'The lockfile is stale.' },
      dataKey,
      `task-event:${task.id}`
    )
  });
  const titleOf = async () => {
    const current = await store.getTask(user.id, task.id);
    return current?.titleCiphertext
      ? decryptJson<{ title: string }>(current.titleCiphertext, dataKey).title
      : null;
  };
  return { database, store, user, workspace, task, dataKey, titleOf };
};

const freshState = () => ({ attempts: new Map<string, number>(), providerReadyAt: 0 });

describe('turning a model answer into a name', () => {
  it('keeps a complete descriptive title and drops only decoration', () => {
    expect(cleanGeneratedTitle('Release job failure')).toBe('Release job failure');
    expect(cleanGeneratedTitle('  "Release job failure."  ')).toBe('Release job failure');
    expect(cleanGeneratedTitle('Title: Release job failure\nHere is why:')).toBe(
      'Release job failure'
    );
    expect(cleanGeneratedTitle('\n\nRelease job failure\n')).toBe('Release job failure');
    const long = cleanGeneratedTitle(
      'Investigating the release pipeline failure caused by a stale dependency lockfile'
    );
    expect(long!.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
    expect(long!.endsWith(' ')).toBe(false);
    expect(long).toBe(
      'Investigating the release pipeline failure caused by a stale dependency lockfile'
    );
    expect(cleanGeneratedTitle('x'.repeat(MAX_GENERATED_TITLE_LENGTH + 1))).toBeNull();
    expect(cleanGeneratedTitle('   ')).toBeNull();
    expect(cleanGeneratedTitle('')).toBeNull();
  });
});

describe('the titler', () => {
  it('names a conversation under its existing privacy route and records the billed model', async () => {
    const { database, store, user, task, titleOf } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('Release job failure')
      );
      const named = await titleTasksOnce({ store, masterKey, log, complete }, freshState());

      expect(named).toBe(1);
      expect(await titleOf()).toBe('Release job failure');
      expect(complete.mock.lastCall?.[0]).toMatchObject({
        modelId: 'openrouter/z-ai/glm-5.2',
        privacyRoute: 'provider_zdr',
        prompt: 'Have a look at the build log and tell me why the release job is red'
      });
      await expect(store.taskSpend(task.id)).resolves.toBeCloseTo(0.0004, 6);
      // Attributed to the model that was actually billed, so a title shows up in the usage pane
      // beside the work rather than as an unexplained charge.
      const spend = await store.spendByModel(user.id, new Date(0), new Date());
      expect(spend).toMatchObject([{ key: 'z-ai/glm-5.2', calls: 1 }]);
      expect(spend[0]!.costUsd).toBeCloseTo(0.0004, 6);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('leaves a name the owner wrote alone, and does not look at it twice', async () => {
    const { database, store, user, task, dataKey, workspace, titleOf } =
      await boxWithAnsweredTask();
    try {
      await store.renameTask(
        user.id,
        task.id,
        encryptJson({ title: 'Red release' }, dataKey, `task-title:${workspace.id}`),
        buildConversationNameIndex('Red release', '', memoryIndexKey(dataKey))
      );
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('Release job failure')
      );
      await expect(titleTasksOnce({ store, masterKey, log, complete }, freshState())).resolves.toBe(
        0
      );
      expect(complete).not.toHaveBeenCalled();
      expect(await titleOf()).toBe('Red release');
    } finally {
      await database.close();
    }
  }, 60_000);

  it('does not spend on a name once the owner is over their cap', async () => {
    const { database, store, user, titleOf } = await boxWithAnsweredTask();
    try {
      await store.setSpendLimits({ userId: user.id, dailyCapUsd: 1 });
      await store.recordUsage({
        userId: user.id,
        kind: 'model_inference',
        resourceClass: 'medium',
        quantity: 1,
        unit: 'tokens',
        credits: 0,
        state: 'settled',
        idempotencyKey: 'already-spent',
        costUsd: 1.5
      });
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('Release job failure')
      );
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };
      // Four sweeps: more than the number of attempts a conversation the model cannot name is
      // given, because a conversation nobody was allowed to pay for has not been attempted at all.
      for (let sweep = 0; sweep < 4; sweep += 1)
        await expect(titleTasksOnce(deps, state)).resolves.toBe(0);
      expect(complete).not.toHaveBeenCalled();
      expect(await titleOf()).toBe('Have a look at the build log and tell me');

      // The window rolls over and the conversation is nameable again, rather than having quietly
      // used up its chances while the box was refusing to spend.
      await store.setSpendLimits({ userId: user.id, dailyCapUsd: null });
      await expect(titleTasksOnce(deps, state)).resolves.toBe(1);
      expect(await titleOf()).toBe('Release job failure');
    } finally {
      await database.close();
    }
  }, 60_000);

  it('waits out a provider that cannot answer instead of asking per conversation', async () => {
    const { database, store } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => null);
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };

      await expect(titleTasksOnce(deps, state, 1_000)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(state.providerReadyAt).toBeGreaterThan(1_000);

      // Every answer that lands during the outage would otherwise be one more provider call.
      await expect(titleTasksOnce(deps, state, 2_000)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);

      await expect(titleTasksOnce(deps, state, state.providerReadyAt + 1)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      await database.close();
    }
  }, 60_000);

  /*
   * The same wall, arriving as a throw.
   *
   * `complete` promises `null` for a provider that will not serve us, and the caller in server.ts
   * kept that promise for every check it made before the call and broke it on the call itself. So a
   * box with no provider configured charged each conversation an attempt, wrote a stack trace for
   * each, and asked the same refusing provider again for the next one - fourteen times on every
   * boot, never once reaching the cooldown built for it.
   *
   * The caller is fixed. This pins the sweep not depending on it.
   */
  it('waits out a provider that refuses by throwing, and spends no conversation on it', async () => {
    const { database, store } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => {
        throw new AthanorError('provider_unavailable', 'the provider did not answer');
      });
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };

      await expect(titleTasksOnce(deps, state, 1_000)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(state.providerReadyAt).toBeGreaterThan(1_000);
      // The conversation was not tried - the provider was - so it keeps every one of its chances.
      expect(state.attempts.size).toBe(0);

      await expect(titleTasksOnce(deps, state, 2_000)).resolves.toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      await database.close();
    }
  }, 60_000);

  /* A fault in this code is not a wall, and must still be reported per conversation. */
  it('still reports a failure that is not the provider refusing', async () => {
    const { database, store } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => {
        throw new TypeError('undefined is not a function');
      });
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };

      await expect(titleTasksOnce(deps, state, 1_000)).resolves.toBe(0);
      expect(state.providerReadyAt).toBe(0);
      expect(state.attempts.size).toBe(1);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('gives up on a conversation the model will not name rather than retrying it forever', async () => {
    const { database, store } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => completion('   '));
      const state = freshState();
      const deps: TaskTitlerDeps = { store, masterKey, log, complete };
      for (let sweep = 0; sweep < 6; sweep += 1) await titleTasksOnce(deps, state);
      expect(complete).toHaveBeenCalledTimes(3);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('reserves once before submission, settles the receipt, and cannot buy a retry after restart', async () => {
    const { database, store, user, task } = await boxWithAnsweredTask();
    try {
      let providerCalls = 0;
      const complete: TaskTitlerDeps['complete'] = async (input) => {
        await input.beforeSubmit!({
          costUsd: 0.001,
          providerRef: 'openrouter:title',
          modelId: 'title'
        });
        providerCalls++;
        const rows = await database.query(
          'SELECT state,cost_usd FROM usage_entries WHERE idempotency_key=$1',
          [`task:${task.id}:title`]
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]).toMatchObject({ state: 'reserved' });
        return completion('');
      };
      await titleTasksOnce({ store, masterKey, log, complete }, freshState());
      await titleTasksOnce({ store, masterKey, log, complete }, freshState());
      expect(providerCalls).toBe(1);
      expect(await store.taskSpend(task.id)).toBeCloseTo(0.0004);
      await expect(
        store.recordUsage({
          userId: user.id,
          taskId: task.id,
          kind: 'model_inference',
          resourceClass: 'unapproved:kind',
          quantity: 0,
          unit: 'tokens',
          credits: 0,
          state: 'reserved',
          reserveAgainstCaps: true,
          idempotencyKey: 'invalid-title-class',
          costUsd: 0.001
        })
      ).rejects.toMatchObject({ code: 'media_reservation_invalid' });
    } finally {
      await database.close();
    }
  }, 60_000);

  it('defers an unavailable route without spending an attempt and retries after capabilities change', async () => {
    const { database, store, titleOf } = await boxWithAnsweredTask();
    try {
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () => ({ skipped: true }));
      const state = freshState();
      for (let n = 0; n < 4; n++)
        await titleTasksOnce({ store, masterKey, log, complete }, state, 1000 + n);
      expect(complete).toHaveBeenCalledOnce();
      expect(state.attempts.size).toBe(0);
      expect(state.providerReadyAt).toBe(0);
      complete.mockResolvedValue(completion('Release repair'));
      expect(await titleTasksOnce({ store, masterKey, log, complete }, state, 301_001)).toBe(1);
      expect(await titleOf()).toBe('Release repair');
    } finally {
      await database.close();
    }
  }, 60_000);

  it('names new work beyond a full window of permanently skipped conversations', async () => {
    const { database, store, task, dataKey } = await boxWithAnsweredTask();
    try {
      for (let index = 0; index < 25; index++) {
        const newer = await store.createTask({
          userId: task.userId,
          workspaceId: task.workspaceId,
          titleCiphertext: task.titleCiphertext!,
          nameIndex: buildConversationNameIndex(
            'New project',
            'New analysis',
            memoryIndexKey(dataKey)
          ),
          modelId: task.modelId,
          privacyRoute: task.privacyRoute,
          maxComputeCredits: 1,
          securityMode: task.securityMode,
          promptCiphertext: task.promptCiphertext
        });
        await store.appendTaskEvent({
          taskId: newer.id,
          kind: 'assistant_message',
          summary: 'Working',
          payloadCiphertext: encryptJson({ markdown: 'Working' }, dataKey, `task-event:${newer.id}`)
        });
      }
      const pending = await store.listTasksNeedingTitle(50);
      expect(pending).toHaveLength(26);
      const last = pending.at(-1)!;
      const state = freshState();
      for (const old of pending.slice(0, 25)) state.attempts.set(old.id, 3);
      const complete = vi.fn<TaskTitlerDeps['complete']>(async () =>
        completion('New analysis results')
      );
      const deps = { store, masterKey, log, complete };
      expect(await titleTasksOnce(deps, state)).toBe(0);
      expect(await titleTasksOnce(deps, state)).toBe(1);
      expect(complete).toHaveBeenCalledOnce();
      expect((await store.getTask(task.userId, last.id))?.titleSource).toBe('generated');
      // Removing the page boundary cannot strand the cursor on a missing row.
      await database.query('DELETE FROM tasks WHERE id=$1', [pending[0]!.id]);
      expect(await store.listTasksNeedingTitle(50, pending[0]!.id)).toHaveLength(24);
    } finally {
      await database.close();
    }
  }, 60_000);

  it('survives a store that fails under it, and stops when it is asked to', async () => {
    const { database, store } = await boxWithAnsweredTask();
    const failing = {
      ...store,
      listTasksNeedingTitle: async () => {
        throw new Error('the database went away');
      },
      waitForAnsweredTask: (timeoutMs: number) => store.waitForAnsweredTask(timeoutMs)
    } as unknown as DataStore;
    try {
      const titler = startTaskTitler(
        { store: failing, masterKey, log, complete: async () => completion('Anything') },
        50
      );
      // The loop has to outlive the failure: an unhandled rejection here would take the API down.
      await new Promise((resolve) => setTimeout(resolve, 120));
      await expect(titler.stop()).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  }, 60_000);
});

describe('provisional task names', () => {
  it('uses a compact opening without copying a long prompt into the title', () => {
    const prompt =
      'Please analyse the RNA sequencing data and compare treatment responses across every batch. Use these extensive details...';
    const title = provisionalTaskTitle(prompt);
    expect(title).toBe('Analyse the RNA sequencing data and compare…');
    expect(title.length).toBeLessThan(60);
    expect(provisionalTaskTitle('Can you create a plot? Here are details')).toBe('Create a plot');
    expect(provisionalTaskTitle('\n\n')).toBe('New project');
    expect(
      provisionalTaskTitle('Open https://example.com in the project browser and report the heading')
    ).toBe('Open example.com in the project browser and…');
    expect(provisionalTaskTitle('研究'.repeat(100))).not.toContain('�');
  });
});

it('reads title choices from owner, project and conversation settings in that order', async () => {
  const { database, store, task, user } = await boxWithAnsweredTask();
  const pin = (modelId: string) => ({ automatic: false, preference: 'balanced' as const, modelId });
  const complete = vi.fn<TaskTitlerDeps['complete']>(async () => ({ skipped: true }));
  try {
    const { writeProjectModelPreferences, writeConversationModelPreferences } =
      await import('@athanor/data');
    await store.mergeUserPreferences(user.id, { modelPurposes: { title: pin('owner-title') } });
    await titleTasksOnce({ store, masterKey, log, complete }, freshState());
    expect(complete.mock.lastCall?.[0].choice).toEqual(pin('owner-title'));
    await writeProjectModelPreferences(store, masterKey, task, {
      expectedRevision: 0,
      choices: { title: pin('project-title') }
    });
    await titleTasksOnce({ store, masterKey, log, complete }, freshState());
    expect(complete.mock.lastCall?.[0].choice).toEqual(pin('project-title'));
    await writeConversationModelPreferences(store, masterKey, task, {
      expectedRevision: 0,
      choices: { title: pin('conversation-title') }
    });
    await titleTasksOnce({ store, masterKey, log, complete }, freshState());
    expect(complete.mock.lastCall?.[0].choice).toEqual(pin('conversation-title'));
    expect(complete).toHaveBeenCalledTimes(3);
  } finally {
    await database.close();
  }
}, 60_000);
