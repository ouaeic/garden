import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseFixtures, type DatabaseFixture } from './test-support/database-fixtures.js';
import {
  CONVERSATION_NAME_INDEX_STAMP,
  MEMORY_KINDS,
  MEMORY_PREDICATES,
  buildConversationNameIndex,
  buildMemoryItemIndex,
  conversationNamePrefixTokens,
  buildMemorySourceIndex,
  deadEndFromCheck,
  memoryDeadEndTagKey,
  memoryIndexKey,
  memoryOriginKey,
  memorySubjectKey,
  OWNER_MEMORY_MAX_ROWS,
  planMemoryQuery,
  renderMemoryPack,
  spendWindowBounds
} from '@athanor/core';
import {
  encryptJson,
  generateDataKey,
  hashRecoveryCode,
  sha256,
  verifyRecoveryCode,
  wrapDataKey
} from '@athanor/core';
import type { EncryptedEnvelope, MemoryItemContent, MemoryKind } from '@athanor/core';
import {
  MAX_AGENT_NOTIFICATIONS_PER_TASK,
  PREVIEW_IDLE_EXPIRY_DAYS,
  TaskStatus
} from '@athanor/contracts';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { migrations } from './migrations.js';
/*
 * The domain modules, named directly.
 *
 * `DataStore` forwards the surface every other package reaches, and a forward with no caller
 * outside `packages/data` is a line that exists only because this file asked for it. Fourteen were
 * in exactly that state; they are gone from the facade and the calls below name the module that
 * owns the table instead. Nothing about what is being tested changed - the same method, the same
 * statement, the same `Database` handle - which is why every test name in this file is unchanged.
 */
import { BillingStore, DEFAULT_MONTHLY_CAP_USD } from './store/billing.js';
import { ConnectorStore } from './store/connectors.js';
import { MemoryStore } from './store/memory.js';
import { MEMORY_RECALL_SQL } from './store/sql/memory.js';
import { TaskSignals, TaskStore } from './store/tasks.js';
import { WorkspaceStore } from './store/workspaces.js';
import {
  agentNotificationAad,
  DataStore,
  LIVE_TASK_STATUSES,
  MAX_APPROVAL_PAGE,
  MAX_TASK_EVENT_PAGE,
  MEMORY_SOURCE_SEARCH_PER_TASK,
  SETTLED_TASK_STATUSES,
  TASK_MAX_ATTEMPTS,
  type RecallMemoryInput
} from './store.js';

/** For the conversations in this file that are never searched by name. */
const UNINDEXED_NAME = { nameTokens: '', openingTokens: '' };

const workspaceInput = (
  userId: string,
  name: string
): Parameters<DataStore['createWorkspace']>[0] => ({
  userId,
  name,
  storageLimitBytes: 10 * 1024 ** 3,
  imageRevision: 'dev',
  region: 'auto',
  wrappedKey: 'wrapped'
});

const taskInput = (
  userId: string,
  workspaceId: string
): Parameters<DataStore['createTask']>[0] => ({
  userId,
  workspaceId,
  titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
  nameIndex: UNINDEXED_NAME,
  modelId: 'qwen',
  privacyRoute: 'provider_zdr',
  maxComputeCredits: 1,
  promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
});

describe('DataStore', () => {
  const fixtures = new DatabaseFixtures();
  let fixture: DatabaseFixture | undefined;
  afterAll(() => fixtures.close());
  let database: Database;
  let store: DataStore;
  let billing: BillingStore;
  let connectors: ConnectorStore;
  let tasks: TaskStore;
  let workspaces: WorkspaceStore;

  beforeEach(async () => {
    fixture = await fixtures.create();
    database = fixture.database;
    store = new DataStore(database);
    // The same handle the facade holds, over the same connection. `TaskSignals` opens nothing until
    // something subscribes, so a second one costs a test nothing.
    billing = new BillingStore(database);
    connectors = new ConnectorStore(database);
    tasks = new TaskStore(database, new TaskSignals(database));
    workspaces = new WorkspaceStore(database);
  });

  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  it('consumes authentication challenges exactly once', async () => {
    const id = await store.createChallenge({
      username: 'Ada',
      challenge: 'challenge',
      kind: 'registration'
    });
    await expect(store.consumeChallenge(id, 'registration')).resolves.toEqual({
      username: 'ada',
      challenge: 'challenge',
      expectedOrigin: null,
      rpId: null
    });
    await expect(store.consumeChallenge(id, 'registration')).resolves.toBeNull();
  });

  it('tracks recent passkey verification on a session', async () => {
    const user = await store.createUser({ username: 'reauth', displayName: 'Reauth' });
    await store.createSession(
      user.id,
      'recent-session',
      new Date(Date.now() + 60_000),
      undefined,
      'Test',
      true
    );
    const inserted = await database.query(
      'SELECT id_hash,step_up_at,expires_at,NOW() AS now FROM sessions'
    );
    expect(inserted.rows[0]).toMatchObject({ id_hash: 'recent-session' });
    expect(inserted.rows[0]?.step_up_at).not.toBeNull();
    await expect(store.hasRecentSessionStepUp(user.id, 'recent-session')).resolves.toBe(true);
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    await expect(store.hasRecentSessionStepUp(user.id, 'recent-session')).resolves.toBe(false);
    await expect(store.markSessionStepUp(user.id, 'recent-session')).resolves.toBe(true);
    await expect(store.hasRecentSessionStepUp(user.id, 'recent-session')).resolves.toBe(true);
  });

  it('stores only hashed, scoped API credentials and revokes them immediately', async () => {
    const user = await store.createUser({ username: 'cli-user', displayName: 'CLI user' });
    const token = await store.createApiToken({
      userId: user.id,
      label: 'Laptop CLI',
      tokenHash: 'one-way-hash',
      prefix: 'oc_live_example',
      scopes: ['models:read', 'tasks:read'],
      expiresAt: new Date(Date.now() + 60_000)
    });
    expect(await store.listApiTokens(user.id)).toMatchObject([
      { id: token.id, label: 'Laptop CLI', scopes: ['models:read', 'tasks:read'] }
    ]);
    const raw = await database.query('SELECT token_hash,token_prefix FROM api_tokens');
    expect(raw.rows[0]).toMatchObject({
      token_hash: 'one-way-hash',
      token_prefix: 'oc_live_example'
    });
    await expect(store.authenticateApiToken('one-way-hash')).resolves.toMatchObject({
      user: { id: user.id },
      token: { id: token.id }
    });
    await expect(store.revokeApiToken(user.id, token.id)).resolves.toBe(true);
    await expect(store.authenticateApiToken('one-way-hash')).resolves.toBeNull();
  });

  /*
   * A workspace and the key that opens it are one thing written as two rows, and every read path
   * inner-joins them - so a workspaces row whose key never landed is invisible to the owner, to
   * `deleteWorkspace` (only ever called with an id the owner can see) and to the create route,
   * which mints another. On a box with a single workspace that is the whole product gone, from one
   * connection dropping between two statements while the installer restarts services back to back.
   *
   * The injection is the point: replayed against a healthy database this passes either way.
   */
  it('leaves no workspace behind when the key that opens it never lands', async () => {
    const user = await store.createUser({ username: 'installer', displayName: 'Installer' });
    /** The store's database with one statement taken out from under it, transactions included. */
    const failingOn = (real: Database, statement: RegExp): Database => ({
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        if (statement.test(sql)) throw new Error('connection terminated unexpectedly');
        return real.query<T>(sql, params);
      },
      exec: (sql: string) => real.exec(sql),
      transaction: (callback) =>
        real.transaction((scoped) => callback(failingOn(scoped, statement))),
      withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
        real.withAdvisoryLock(lock, callback),
      notify: (channel, payload) => real.notify(channel, payload),
      listen: (channel, handler) => real.listen(channel, handler),
      close: async () => undefined
    });
    const dropped = new DataStore(failingOn(database, /INSERT INTO workspace_keys/));

    await expect(dropped.createWorkspace(workspaceInput(user.id, 'Home'))).rejects.toThrow(
      /connection terminated/
    );

    await expect(store.listWorkspaces(user.id)).resolves.toEqual([]);
    const stranded = await database.query('SELECT id FROM workspaces');
    expect(stranded.rows).toEqual([]);
  });

  it('keeps reviewed memory and skills in encrypted workspace records', async () => {
    const user = await store.createUser({ username: 'knowledge-user', displayName: 'Knowledge' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Knowledge room',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const memory = await store.createWorkspaceMemory({
      userId: user.id,
      workspaceId: workspace.id,
      target: 'workspace',
      contentCiphertext: { v: 1, iv: 'memory', tag: 'tag', ciphertext: 'cipher' }
    });
    await expect(store.listWorkspaceMemories(user.id, workspace.id)).resolves.toMatchObject([
      { id: memory.id, target: 'workspace' }
    ]);
    const skill = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'opaque-name-hash',
      documentCiphertext: { v: 1, iv: 'skill', tag: 'tag', ciphertext: 'cipher' }
    });
    const revised = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'opaque-name-hash',
      documentCiphertext: { v: 1, iv: 'skill-2', tag: 'tag', ciphertext: 'cipher-2' }
    });
    expect(revised).toMatchObject({ id: skill.id, version: 2, nameHash: 'opaque-name-hash' });
    await store.markWorkspaceSkillUsed(user.id, workspace.id, skill.id);
    await expect(
      workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id)
    ).resolves.toMatchObject({
      useCount: 1,
      status: 'active'
    });
    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      pinned: false
    });
    await database.query(
      "UPDATE workspace_skills SET last_used_at=NOW()-INTERVAL '100 days',updated_at=NOW()-INTERVAL '100 days' WHERE id=$1",
      [skill.id]
    );
    await store.curateWorkspaceSkills(workspace.id);
    await expect(
      workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id)
    ).resolves.toMatchObject({
      status: 'archived'
    });
    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      pinned: true,
      status: 'active'
    });
    await expect(store.deleteWorkspaceMemory(user.id, workspace.id, memory.id)).resolves.toBe(true);
    await expect(store.deleteWorkspaceSkill(user.id, workspace.id, skill.id)).resolves.toBe(true);
  });

  /*
   * Turning a learned procedure off without deleting it.
   *
   * `enabled` was a real column with a real reader - a disabled skill is dropped from the index the
   * model sees - and no writer anywhere in the repository, while the approval card for a skill
   * upsert told the owner "You had turned this off. Approving this switches it back on." about a
   * state the product could not enter. Deletion was the only way to stop a procedure the agent kept
   * reaching for at the wrong moment, and deletion is not reversible.
   *
   * The omitted-leaves-alone half is the part worth pinning: the same statement writes status and
   * pinned, so a caller flipping one of those must not silently re-enable a skill the owner turned
   * off.
   */
  it('turns a learned skill off and leaves it off when something else about it changes', async () => {
    const user = await store.createUser({ username: 'switcher', displayName: 'Switcher' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Switching',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const skill = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'ledger-reconcile',
      documentCiphertext: { v: 1, iv: 'skill', tag: 'tag', ciphertext: 'cipher' }
    });
    await expect(
      workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id)
    ).resolves.toMatchObject({ enabled: true });

    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      enabled: false
    });
    await expect(
      workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id)
    ).resolves.toMatchObject({ enabled: false });

    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      pinned: true
    });
    await expect(
      workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id)
    ).resolves.toMatchObject({ enabled: false, pinned: true });

    await store.setWorkspaceSkillState({
      id: skill.id,
      userId: user.id,
      workspaceId: workspace.id,
      enabled: true
    });
    await expect(
      workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id)
    ).resolves.toMatchObject({ enabled: true });
  });

  it('leaves a skill whose occasion has not come up, instead of blinking it out every 31 days', async () => {
    // The clock was COALESCE(last_used_at,updated_at) while the same statement wrote updated_at, so
    // for a never-used skill the anchor was the column the transition overwrote: stale on day 31,
    // clock reset, stale again on day 61, and 'archived' unreachable forever. Every workspace skill
    // was approved by this owner in full, so one whose trigger has not arisen is left alone.
    const user = await store.createUser({ username: 'curator', displayName: 'Curator' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Curation',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const skill = await store.upsertWorkspaceSkill({
      userId: user.id,
      workspaceId: workspace.id,
      nameHash: 'never-used-hash',
      documentCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'cipher' }
    });
    await database.query(
      "UPDATE workspace_skills SET last_used_at=NULL,updated_at=NOW()-INTERVAL '400 days' WHERE id=$1",
      [skill.id]
    );
    const before = await workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id);
    await store.curateWorkspaceSkills(workspace.id);
    const after = await workspaces.getWorkspaceSkill(user.id, workspace.id, skill.id);
    expect(after).toMatchObject({ status: 'active' });
    // A true no-op: the row is not even rewritten, so updated_at keeps meaning "when this changed".
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it("takes a conversation's memory with it when the conversation is deleted", async () => {
    // "Delete this conversation" used to leave the episode and, worse, the chunks of the owner's
    // own words held verbatim in mem.source. On a computer that offers to keep no logs it has to
    // mean it, and the schema is the only place that cannot be forgotten by a later caller.
    const user = await store.createUser({ username: 'forgetful', displayName: 'Forgetful' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Forgetting',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      modelId: 'model-1',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      titleCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'title' },
      nameIndex: UNINDEXED_NAME,
      promptCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'prompt' }
    });
    const item = await store.createMemoryItem({
      userId: user.id,
      workspaceId: workspace.id,
      kind: 'episode',
      trust: 'derived',
      documentCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'episode' },
      index: buildMemoryItemIndex(
        { title: 'A past run', body: 'what happened' },
        memoryIndexKey(Buffer.alloc(32, 9))
      ),
      taskId: task.id
    });
    await expect(
      database.query('SELECT 1 FROM mem.item WHERE id=$1', [item.id])
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(store.deleteTask(user.id, task.id)).resolves.toBe(true);
    await expect(
      database.query('SELECT 1 FROM mem.item WHERE id=$1', [item.id])
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("keeps the owner's choices on the box, and merges rather than clobbers them", async () => {
    // These lived in localStorage, so they were facts about a browser rather than about the person:
    // pick a model on the laptop and the phone still offered the old one. On a computer whose whole
    // point is being the same computer from anywhere, a setting that does not travel is not set.
    const user = await store.createUser({ username: 'chooser', displayName: 'Chooser' });
    await expect(store.getUserById(user.id)).resolves.toMatchObject({ preferences: {} });

    await store.mergeUserPreferences(user.id, {
      model: { automatic: false, preference: 'best', modelId: 'vendor/one' }
    });
    // A second device saving a different key must not erase the first. `place` is the live example:
    // it is written every time the owner opens another conversation, so if this merged badly it
    // would silently reset the model choice several times an hour.
    const merged = await store.mergeUserPreferences(user.id, {
      place: { taskId: 'task-one', workspaceId: 'workspace-one' }
    });
    expect(merged).toMatchObject({
      model: { automatic: false, preference: 'best', modelId: 'vendor/one' },
      place: { taskId: 'task-one', workspaceId: 'workspace-one' }
    });
    await expect(store.getUserById(user.id)).resolves.toMatchObject({
      preferences: { model: { modelId: 'vendor/one' } }
    });
  });

  it('keeps a half-typed message on the box, for the conversation and for the one not started', async () => {
    // The draft lived in localStorage, so "close the laptop, pick it up on the phone" - the reason
    // the client's storage module gives for existing - was true only if both were the same device.
    const user = await store.createUser({ username: 'drafter', displayName: 'Drafter' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Drafting',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const sealed = (body: string) => ({ v: 1, iv: 'iv', tag: 'tag', ciphertext: body }) as const;

    // The one with no conversation yet, which is where most first sentences are typed.
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      bodyCiphertext: sealed('a first sentence')
    });
    // And again, to prove the upsert finds the partial index rather than inserting a second row.
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      bodyCiphertext: sealed('a better first sentence')
    });
    let drafts = await store.listMessageDrafts(user.id, workspace.id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      taskId: null,
      bodyCiphertext: { ciphertext: 'a better first sentence' }
    });

    // Emptying it removes the row rather than storing emptiness for every conversation ever opened.
    await store.saveMessageDraft({
      userId: user.id,
      workspaceId: workspace.id,
      bodyCiphertext: null
    });
    drafts = await store.listMessageDrafts(user.id, workspace.id);
    expect(drafts).toHaveLength(0);
  });

  it('reaches nothing in a workspace it does not own', async () => {
    const owner = await store.createUser({ username: 'box-owner', displayName: 'Owner' });
    const stranger = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    const workspace = await store.createWorkspace({
      userId: owner.id,
      name: 'Private analysis',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: owner.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    await expect(store.getWorkspace(owner.id, workspace.id)).resolves.toMatchObject({
      id: workspace.id
    });
    await expect(store.getTask(owner.id, task.id)).resolves.toMatchObject({ id: task.id });
    await expect(store.setTaskStatusForUser(owner.id, task.id, 'paused')).resolves.toBe(true);

    // There is one owner on this box, so a second account is a stranger to every workspace on it -
    // there is no group, no policy and no role that could ever grant it a read.
    await expect(store.getWorkspace(stranger.id, workspace.id)).resolves.toBeNull();
    await expect(store.getTask(stranger.id, task.id)).resolves.toBeNull();
    await expect(store.listWorkspaces(stranger.id)).resolves.toEqual([]);
    await expect(store.listTasks(stranger.id, workspace.id)).resolves.toEqual([]);
    await expect(store.workspaceBelongsToUser(stranger.id, workspace.id)).resolves.toBe(false);
    await expect(store.workspaceBelongsToUser(owner.id, workspace.id)).resolves.toBe(true);
    await expect(store.setTaskStatusForUser(stranger.id, task.id, 'queued')).resolves.toBe(false);
  });

  it('queues a follow-up on the same durable task with a fresh reservation', async () => {
    const user = await store.createUser({ username: 'follow-up', displayName: 'Follow up' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Conversation',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'title', tag: 'tag', ciphertext: 'cipher' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'prompt', tag: 'tag', ciphertext: 'cipher' }
    });
    await store.updateTask({
      id: task.id,
      status: 'completed',
      agentStateCiphertext: { v: 1, iv: 'state', tag: 'tag', ciphertext: 'cipher' },
      clearLease: true
    });
    const continued = await store.continueTask({
      id: task.id,
      userId: user.id,
      modelId: 'qwen-next',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 2,
      agentStateCiphertext: { v: 1, iv: 'next', tag: 'tag', ciphertext: 'cipher' },
      reservationKey: `task:${task.id}:turn:1:reservation`,
      resourceClass: 'medium',
      userMessageCiphertext: { v: 1, iv: 'message', tag: 'tag', ciphertext: 'cipher' }
    });
    expect(continued).toMatchObject({
      id: task.id,
      status: 'queued',
      modelId: 'qwen-next',
      maxComputeCredits: 3
    });
    await expect(store.listTaskEvents(task.id, 0)).resolves.toMatchObject([
      { sequence: 1, kind: 'user_message', summary: 'User message' }
    ]);
    await expect(
      store.usageTotals(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000))
    ).resolves.toMatchObject({ reserved: 2 });
  });

  it('keeps active follow-ups FIFO and promotes them without ending the conversation', async () => {
    const user = await store.createUser({ username: 'queue-user', displayName: 'Queue user' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Queue lab',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'title', tag: 'tag', ciphertext: 'cipher' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'lead-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'prompt', tag: 'tag', ciphertext: 'cipher' }
    });
    await expect(store.leaseNextTask('queue-worker')).resolves.toMatchObject({ id: task.id });
    const messageId = '12b65a33-e4bf-4f8e-99bc-43f2d1a89e29';
    const queued = await store.enqueueTaskMessage({
      id: messageId,
      taskId: task.id,
      userId: user.id,
      modelId: 'next-model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 2,
      resourceClass: 'high',
      reservationKey: `task:${task.id}:message:${messageId}:reservation`,
      promptCiphertext: { v: 1, iv: 'queue', tag: 'tag', ciphertext: 'cipher' },
      queuedEventCiphertext: { v: 1, iv: 'event', tag: 'tag', ciphertext: 'cipher' }
    });
    expect(queued).toMatchObject({ id: task.id, queuedMessageCount: 1, maxComputeCredits: 1 });
    await expect(store.getNextQueuedTaskMessage(task.id)).resolves.toMatchObject({
      id: messageId,
      modelId: 'next-model',
      maxComputeCredits: 2
    });
    const promoted = await store.promoteQueuedTaskMessage({
      taskId: task.id,
      messageId,
      workerId: 'queue-worker',
      modelId: 'next-model',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 2,
      agentStateCiphertext: { v: 1, iv: 'next', tag: 'tag', ciphertext: 'cipher' },
      userMessageCiphertext: { v: 1, iv: 'user', tag: 'tag', ciphertext: 'cipher' },
      statusEventCiphertext: { v: 1, iv: 'status', tag: 'tag', ciphertext: 'cipher' }
    });
    expect(promoted).toMatchObject({
      status: 'queued',
      modelId: 'next-model',
      maxComputeCredits: 3,
      queuedMessageCount: 0
    });
    await expect(store.listTaskEvents(task.id)).resolves.toMatchObject([
      { sequence: 1, kind: 'queued_message' },
      { sequence: 2, kind: 'status' },
      { sequence: 3, kind: 'user_message' }
    ]);
  });

  it('selects the oldest correction without consuming ordinary follow-ups or another task queue', async () => {
    const user = await store.createUser({
      username: 'queue-corrections',
      displayName: 'Corrections'
    });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Corrections'));
    const task = await store.createTask({ ...taskInput(user.id, workspace.id), maxSpendUsd: 0.35 });
    const other = await store.createTask(taskInput(user.id, workspace.id));
    await expect(store.leaseNextTask('correction-worker')).resolves.toMatchObject({ id: task.id });
    const envelope = { v: 1 as const, iv: 'queue', tag: 'tag', ciphertext: 'cipher' };
    const messages = [
      { id: randomUUID(), taskId: other.id, interrupt: true, cap: 7 },
      { id: randomUUID(), taskId: task.id, interrupt: false, cap: 0.1 },
      { id: randomUUID(), taskId: task.id, interrupt: true, cap: 0.25 },
      { id: randomUUID(), taskId: task.id, interrupt: true, cap: 0.4 }
    ];
    expect(messages).toHaveLength(4);
    for (const [index, message] of messages.entries()) {
      await store.enqueueTaskMessage({
        id: message.id,
        taskId: message.taskId,
        userId: user.id,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 2,
        maxSpendUsd: message.cap,
        resourceClass: 'medium',
        reservationKey: `message:${message.id}`,
        promptCiphertext: envelope,
        queuedEventCiphertext: envelope,
        interrupt: message.interrupt
      });
      await database.query('UPDATE task_message_queue SET created_at=$2 WHERE id=$1', [
        message.id,
        new Date(Date.UTC(2026, 6, 1, 0, 0, index))
      ]);
    }
    const ordinary = messages[1]!;
    const correction = messages[2]!;
    await expect(store.getNextQueuedTaskMessage(task.id)).resolves.toMatchObject({
      id: ordinary.id
    });
    await expect(
      store.getNextQueuedTaskMessage(task.id, { interruptOnly: true })
    ).resolves.toMatchObject({ id: correction.id });
    expect((await store.getTask(user.id, task.id))?.maxSpendUsd).toBe(0.35);
    await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(6);

    const consume = (workerId: string) =>
      store.consumeQueuedTaskMessageInTurn({
        taskId: task.id,
        messageId: correction.id,
        workerId,
        additionalComputeCredits: 2,
        additionalSpendUsd: 0.25,
        userMessageCiphertext: envelope
      });
    await expect(consume('not-the-lease-owner')).resolves.toBe(false);
    await expect(consume('correction-worker')).resolves.toBe(true);
    await expect(consume('correction-worker')).resolves.toBe(false);
    expect((await store.getTask(user.id, task.id))?.maxSpendUsd).toBeCloseTo(0.6);
    await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(6);
    await expect(store.getNextQueuedTaskMessage(task.id)).resolves.toMatchObject({
      id: ordinary.id
    });
    await expect(
      store.getNextQueuedTaskMessage(task.id, { interruptOnly: true })
    ).resolves.toMatchObject({ id: messages[3]!.id });
    await expect(
      store.getNextQueuedTaskMessage(other.id, { interruptOnly: true })
    ).resolves.toMatchObject({ id: messages[0]!.id });
  });

  describe('promoted message reservations', () => {
    const envelope = { v: 1 as const, iv: 'message', tag: 'tag', ciphertext: 'sealed' };
    const running = async () => {
      const user = await store.createUser({ username: 'reservation-owner', displayName: 'Owner' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Reservations'));
      const task = await store.createTask({
        ...taskInput(user.id, workspace.id),
        maxSpendUsd: 0.35
      });
      await expect(store.leaseNextTask('reservation-worker')).resolves.toMatchObject({
        id: task.id
      });
      const enqueue = async (credits: number, interrupt: boolean) => {
        const id = randomUUID();
        await store.enqueueTaskMessage({
          id,
          taskId: task.id,
          userId: user.id,
          modelId: 'qwen',
          privacyRoute: 'provider_zdr',
          maxComputeCredits: credits,
          maxSpendUsd: 0.25,
          resourceClass: 'medium',
          reservationKey: `message:${id}`,
          promptCiphertext: envelope,
          queuedEventCiphertext: envelope,
          interrupt
        });
        return id;
      };
      for (const [credits, interrupt] of [
        [2, true],
        [3, false]
      ] as const) {
        const messageId = await enqueue(credits, interrupt);
        await expect(
          store.consumeQueuedTaskMessageInTurn({
            taskId: task.id,
            messageId,
            workerId: 'reservation-worker',
            additionalComputeCredits: credits,
            additionalSpendUsd: 0.25,
            userMessageCiphertext: envelope
          })
        ).resolves.toBe(true);
      }
      await store.recordUsage({
        userId: user.id,
        workspaceId: workspace.id,
        taskId: task.id,
        kind: 'model',
        resourceClass: 'medium',
        quantity: 1,
        unit: 'call',
        credits: 1,
        costUsd: 0.1,
        state: 'settled',
        idempotencyKey: `settled:${task.id}`
      });
      const otherOwner = await store.createUser({
        username: 'other-reservation-owner',
        displayName: 'Other'
      });
      const otherWorkspace = await store.createWorkspace(workspaceInput(otherOwner.id, 'Other'));
      const other = await store.createTask(taskInput(otherOwner.id, otherWorkspace.id));
      await store.recordUsage({
        userId: otherOwner.id,
        workspaceId: otherWorkspace.id,
        taskId: other.id,
        kind: 'task_compute',
        resourceClass: 'medium',
        quantity: 11,
        unit: 'credits',
        credits: 11,
        state: 'reserved',
        idempotencyKey: `other:${other.id}`
      });
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(5);
      const retained = async () => {
        await expect(billing.reservedUsageForTask(other.id)).resolves.toBe(11);
        expect(
          (
            await database.query(
              'SELECT state,cost_usd FROM usage_entries WHERE idempotency_key=$1',
              [`settled:${task.id}`]
            )
          ).rows
        ).toEqual([{ state: 'settled', cost_usd: 0.1 }]);
      };
      const complete = (workerId = 'reservation-worker') =>
        store.completeTaskIfNoQueued({
          id: task.id,
          workerId,
          actualComputeCredits: 1,
          agentStateCiphertext: envelope
        });
      return { task, user, enqueue, complete, retained };
    };

    it('releases consumed correction and question-answer reservations only after leased completion', async () => {
      const { task, user, complete, retained } = await running();
      await expect(complete('not-the-lease-owner')).resolves.toBe(false);
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(5);
      await expect(complete()).resolves.toBe(true);
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(0);
      await expect(complete()).resolves.toBe(false);
      expect((await store.getTask(user.id, task.id))?.maxSpendUsd).toBeCloseTo(0.85);
      await retained();
    });

    it('releases completed-turn reservations at handoff while keeping queued and next-turn reservations', async () => {
      const { task, user, enqueue, complete, retained } = await running();
      const next = await enqueue(7, false);
      const last = await enqueue(13, false);
      await expect(complete()).resolves.toBe(false);
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(25);
      const promote = (messageId: string, credits: number, workerId = 'reservation-worker') =>
        store.promoteQueuedTaskMessage({
          taskId: task.id,
          messageId,
          workerId,
          modelId: 'qwen',
          privacyRoute: 'provider_zdr',
          additionalComputeCredits: credits,
          additionalSpendUsd: 0.25,
          agentStateCiphertext: envelope,
          userMessageCiphertext: envelope,
          statusEventCiphertext: envelope
        });
      await expect(promote(next, 7, 'not-the-lease-owner')).resolves.toBeNull();
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(25);
      await expect(promote(next, 7)).resolves.toMatchObject({
        status: 'queued',
        queuedMessageCount: 1
      });
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(20);
      await expect(promote(next, 7)).resolves.toBeNull();
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(20);
      await expect(store.leaseNextTask('reservation-worker')).resolves.toMatchObject({
        id: task.id
      });
      await expect(promote(last, 13)).resolves.toMatchObject({
        status: 'queued',
        queuedMessageCount: 0
      });
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(13);
      await expect(store.leaseNextTask('reservation-worker')).resolves.toMatchObject({
        id: task.id
      });
      await expect(complete()).resolves.toBe(true);
      await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(0);
      expect((await store.getTask(user.id, task.id))?.maxSpendUsd).toBeCloseTo(1.35);
      await retained();
    });

    it.each(['failed', 'cancelled'] as const)(
      'releases promoted reservations when a %s task has no queued messages to strand',
      async (status) => {
        const { task, retained } = await running();
        await expect(store.strandQueuedTaskMessages(task.id)).resolves.toEqual([]);
        await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(5);
        await store.updateTask({ id: task.id, status, clearLease: true });
        await expect(store.strandQueuedTaskMessages(task.id)).resolves.toEqual([]);
        await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(0);
        await expect(store.strandQueuedTaskMessages(task.id)).resolves.toEqual([]);
        await retained();
      }
    );
  });

  /**
   * Nothing in this repository has ever built a conversation longer than a handful of events, so
   * the paging the timeline and its stream rest on has only ever been read at a size where one page
   * held everything - and a bound nobody has ever crossed is a bound nobody has ever tested.
   *
   * Real transcripts do cross it. A streamed turn writes an `assistant_delta` several times a
   * second, and a turn that ends without an `assistant_message` - cancelled, or failed mid-stream -
   * keeps every one of them: `appendTaskEvent` supersedes deltas only when the closing message
   * lands, and `cleanupExpired`'s sweep looks for that same closing message before it deletes
   * anything. So the whole of a transcript has to stay assemblable by a reader that is only ever
   * given a page at a time, in either direction, with no row seen twice and none skipped.
   */
  it('assembles a transcript longer than one page by paging it in both directions', async () => {
    const user = await store.createUser({ username: 'pager', displayName: 'Pager' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Pager'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const total = MAX_TASK_EVENT_PAGE * 2 + 7;
    // One statement rather than `appendTaskEvent` per row, which takes the task's row lock each
    // time: what is under test here is the size of the read, and the writer has its own tests.
    await database.query(
      `INSERT INTO task_events(id, task_id, sequence, kind, summary)
       SELECT gen_random_uuid(), $1, g, 'assistant_delta', 'Encrypted delta event'
       FROM generate_series(1, $2::int) AS g`,
      [task.id, total]
    );
    const everySequence = Array.from({ length: total }, (_, index) => index + 1);

    // Forwards, the way a live stream resumes: each page starts where the last one stopped.
    const forward: number[] = [];
    let cursor = 0;
    for (let page = 0; page < 20; page += 1) {
      const window = await store.listTaskEventPage(task.id, { after: cursor });
      forward.push(...window.events.map((event) => event.sequence));
      cursor = window.nextCursor;
      if (!window.hasMore) break;
    }
    expect(forward).toEqual(everySequence);

    // Backwards, the way a reader walks into the history the first load deliberately did not send.
    const backward: number[] = [];
    let older = await store.listRecentTaskEvents(task.id);
    for (let page = 0; page < 20; page += 1) {
      backward.unshift(...older.events.map((event) => event.sequence));
      if (!older.hasMore) break;
      older = await store.listTaskEventPage(task.id, { before: older.oldestSequence ?? 0 });
    }
    expect(backward).toEqual(everySequence);

    // And no caller reaches the whole transcript in one breath by naming a large enough number.
    await expect(
      store
        .listTaskEventPage(task.id, { after: 0, limit: total })
        .then((window) => window.events.length)
    ).resolves.toBe(MAX_TASK_EVENT_PAGE);
  });

  /**
   * The turn the owner corrected died before it could read the correction.
   *
   * Everything here is about one question: whether a message they sent is still going to happen.
   * The store is where that is decided, because it is the only place that can read the task's
   * status, its attempt count and its queue in one breath and act on all three at once.
   */
  describe('a message left over from a turn that died', () => {
    /** A task a worker is inside, with one message queued behind the turn it is running. */
    const workingTaskWithAMessage = async (
      name: string
    ): Promise<{ userId: string; taskId: string; messageId: string }> => {
      const user = await store.createUser({ username: name, displayName: name });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
      const task = await store.createTask(taskInput(user.id, workspace.id));
      await store.leaseNextTask('worker-1');
      const messageId = randomUUID();
      await store.enqueueTaskMessage({
        id: messageId,
        taskId: task.id,
        userId: user.id,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 2,
        resourceClass: 'medium',
        reservationKey: `task:${task.id}:message:${messageId}:reservation`,
        interrupt: true,
        promptCiphertext: { v: 1, iv: 'queue', tag: 'tag', ciphertext: 'cipher' },
        queuedEventCiphertext: { v: 1, iv: 'event', tag: 'tag', ciphertext: 'cipher' }
      });
      return { userId: user.id, taskId: task.id, messageId };
    };

    it('puts the conversation back in the queue without spending a second budget on it', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('carried');

      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toEqual({ attempt: 1, queuedMessageCount: 1 });

      // Leasable again, and the message is untouched - the loop takes it at its next step, which is
      // what the owner was told would happen before the turn died.
      const requeued = await store.getTask(userId, taskId);
      expect(requeued).toMatchObject({ status: 'queued', attempt: 1, queuedMessageCount: 1 });
      expect(requeued?.leaseOwner).toBeNull();
      await expect(store.leaseNextTask('worker-2')).resolves.toMatchObject({
        id: taskId,
        attempt: 2
      });
    });

    /**
     * The bound, and it is the one the queue already has. Nothing here invents a retry budget: the
     * attempt count is left standing on every requeue, so a failure that simply repeats walks the
     * count up to the ceiling and stops, rather than running the owner's money out against it.
     */
    it('stops at the ceiling the queue already keeps, rather than a second one of its own', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('bounded');
      let requeues = 0;
      for (let round = 0; round < TASK_MAX_ATTEMPTS * 2; round += 1) {
        if (!(await store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' }))) break;
        requeues += 1;
        // What the worker does next: the queue hands the task back out, which is the attempt.
        if (!(await store.leaseNextTask('worker-1'))) break;
      }
      expect(requeues).toBe(TASK_MAX_ATTEMPTS - 1);
      expect(await store.getTask(userId, taskId)).toMatchObject({ attempt: TASK_MAX_ATTEMPTS });
      await expect(store.leaseNextTask('worker-1')).resolves.toBeNull();
    });

    /**
     * The one thing this must never do. Stop is the owner saying stop, and a message they sent
     * before they said it cannot become the way the conversation starts itself up again.
     */
    it('never restarts a conversation the owner cancelled', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('cancelled');
      expect(await store.cancelTaskAndReleaseReservations(userId, taskId)).toBe(true);

      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toBeNull();
      // Cancelling empties the queue, so that refusal could have come from either lock. This is the
      // other one on its own: a queued row against a stopped conversation still starts nothing.
      await database.query(
        `UPDATE task_message_queue SET status='queued' WHERE task_id=$1 AND status='cancelled'`,
        [taskId]
      );
      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toBeNull();
      expect(await store.getTask(userId, taskId)).toMatchObject({ status: 'cancelled' });
      await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();
    });

    it('leaves a task another worker has taken over alone', async () => {
      const { taskId } = await workingTaskWithAMessage('handed-over');
      await database.query(`UPDATE tasks SET lease_owner='worker-2' WHERE id=$1`, [taskId]);

      await expect(
        store.requeueTaskForQueuedMessage({ id: taskId, workerId: 'worker-1' })
      ).resolves.toBeNull();
    });

    it('has nothing to say about a failure with no message behind it', async () => {
      const user = await store.createUser({ username: 'plain', displayName: 'Plain' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
      const task = await store.createTask(taskInput(user.id, workspace.id));
      await store.leaseNextTask('worker-1');

      await expect(
        store.requeueTaskForQueuedMessage({ id: task.id, workerId: 'worker-1' })
      ).resolves.toBeNull();
    });

    /**
     * The header pill read a count of queued rows, so a message stuck on a dead conversation was
     * advertised for ever. Taking the row out of the queue is what makes the count true again, and
     * handing it back is what stops that being the same thing as throwing it away.
     */
    it('hands back the words it can no longer deliver, and stops advertising them', async () => {
      const { userId, taskId, messageId } = await workingTaskWithAMessage('undelivered');
      await store.updateTask({ id: taskId, status: 'failed', clearLease: true });

      const stranded = await store.strandQueuedTaskMessages(taskId);
      expect(stranded).toMatchObject([
        { id: messageId, status: 'undelivered', promptCiphertext: { iv: 'queue' } }
      ]);
      expect(await store.getTask(userId, taskId)).toMatchObject({ queuedMessageCount: 0 });
      // And the ceiling it was holding against work nobody is going to do comes back.
      await expect(billing.reservedUsageForTask(taskId)).resolves.toBe(0);
      // Said once. A second sweep of the same conversation has nothing left to report.
      await expect(store.strandQueuedTaskMessages(taskId)).resolves.toEqual([]);
    });

    it('leaves a message alone while the conversation can still reach it', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('still-running');

      await expect(store.strandQueuedTaskMessages(taskId)).resolves.toEqual([]);
      expect(await store.getTask(userId, taskId)).toMatchObject({ queuedMessageCount: 1 });
    });

    /**
     * A turn that takes the worker process down with it never reaches the worker's own failure
     * path, so the sweep is the only thing that ever reads these rows again.
     */
    it('clears the queue of a conversation the attempt sweep has given up on', async () => {
      const { userId, taskId } = await workingTaskWithAMessage('swept');
      await database.query(
        `UPDATE tasks SET attempt=$2, lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
        [taskId, TASK_MAX_ATTEMPTS]
      );

      await expect(store.failTasksAtAttemptLimit()).resolves.toMatchObject([
        { id: taskId, undeliveredMessages: 1 }
      ]);
      expect(await store.getTask(userId, taskId)).toMatchObject({
        status: 'failed',
        queuedMessageCount: 0
      });
    });
  });

  it('versions task plans atomically and preserves explicit branch ancestry', async () => {
    const user = await store.createUser({ username: 'planner', displayName: 'Planner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Plan lab',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const first = await store.createTaskPlan({
      taskId: task.id,
      expectedVersion: 0,
      branchName: 'Main',
      stepsCiphertext: { v: 1, iv: 'step-a', tag: 'step-b', ciphertext: 'step-c' },
      createdBy: 'agent'
    });
    expect(first).toMatchObject({ version: 1, parentVersion: null, branchName: 'encrypted' });
    const second = await store.createTaskPlan({
      taskId: task.id,
      expectedVersion: 1,
      parentVersion: 1,
      branchName: 'User revision',
      stepsCiphertext: { v: 1, iv: 'step-d', tag: 'step-e', ciphertext: 'step-f' },
      createdBy: 'user'
    });
    expect(second).toMatchObject({ version: 2, parentVersion: 1, createdBy: 'user' });
    await expect(
      store.createTaskPlan({
        taskId: task.id,
        expectedVersion: 1,
        branchName: 'Stale writer',
        stepsCiphertext: { v: 1, iv: 'g', tag: 'h', ciphertext: 'i' },
        createdBy: 'user'
      })
    ).rejects.toThrow('plan_version_conflict');
    await expect(store.getLatestTaskPlan(task.id)).resolves.toMatchObject({ id: second.id });
    await expect(store.listTaskPlans(task.id)).resolves.toMatchObject([
      { version: 2 },
      { version: 1 }
    ]);
  });

  it('atomically rotates recovery, passkeys, and active sessions', async () => {
    const user = await store.createUser({
      username: 'recovering',
      displayName: 'Recovering user',
      recoveryHash: 'old-recovery-hash'
    });
    await store.addPasskey({
      userId: user.id,
      credentialId: 'old-credential',
      publicKey: 'old-key',
      counter: 0,
      transports: [],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await store.createSession(user.id, 'old-session', new Date(Date.now() + 60_000));
    await store.replacePasskeysForRecovery({
      userId: user.id,
      username: user.username,
      expectedRecoveryHash: 'old-recovery-hash',
      newRecoveryHash: 'new-recovery-hash',
      passkey: {
        credentialId: 'new-credential',
        publicKey: 'new-key',
        counter: 0,
        transports: ['internal'],
        deviceType: 'multiDevice',
        backedUp: true
      }
    });
    await expect(store.listPasskeys(user.id)).resolves.toMatchObject([
      { credentialId: 'new-credential', backedUp: true }
    ]);
    await expect(store.listSessions(user.id)).resolves.toEqual([]);
    await expect(store.getUserById(user.id)).resolves.toMatchObject({
      recoveryHash: 'new-recovery-hash'
    });
    await expect(
      store.replacePasskeysForRecovery({
        userId: user.id,
        username: user.username,
        expectedRecoveryHash: 'old-recovery-hash',
        newRecoveryHash: 'attacker-hash',
        passkey: {
          credentialId: 'second-credential',
          publicKey: 'second-key',
          counter: 0,
          transports: [],
          deviceType: 'singleDevice',
          backedUp: false
        }
      })
    ).rejects.toThrow('already been rotated');
  });

  it('never removes the final passkey', async () => {
    const user = await store.createUser({ username: 'keys', displayName: 'Keys' });
    const first = await store.addPasskey({
      userId: user.id,
      credentialId: 'first-credential',
      publicKey: 'first-key',
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false
    });
    await expect(store.deletePasskeyForUser(user.id, first.id)).resolves.toBe('last_passkey');
    const second = await store.addPasskey({
      userId: user.id,
      credentialId: 'second-credential',
      publicKey: 'second-key',
      counter: 0,
      transports: ['hybrid'],
      deviceType: 'multiDevice',
      backedUp: true
    });
    await expect(store.deletePasskeyForUser(user.id, first.id)).resolves.toBe('deleted');
    await expect(store.deletePasskeyForUser(user.id, first.id)).resolves.toBe('not_found');
    await expect(store.deletePasskeyForUser(user.id, second.id)).resolves.toBe('last_passkey');
    const remaining = await store.listPasskeys(user.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second.id);
    expect(typeof remaining[0]?.createdAt).toBe('string');
  });

  it('keeps a device signed in by sliding the session, and still lapses an idle one', async () => {
    const lifetime = 180 * 24 * 60 * 60;
    const user = await store.createUser({ username: 'slider', displayName: 'Slider' });
    await store.createSession(user.id, 'sliding-session', new Date(Date.now() + lifetime * 1000));

    // Freshly issued: over halfway through its window, so nothing is rewritten.
    const untouched = await store.getSession('sliding-session', lifetime);
    expect(untouched?.user.id).toBe(user.id);
    expect(untouched?.renewedExpiresAt).toBeNull();

    // Past halfway, a request renews the full window rather than letting it run out.
    await database.query("UPDATE sessions SET expires_at = NOW() + INTERVAL '10 days'");
    const renewed = await store.getSession('sliding-session', lifetime);
    expect(renewed?.user.id).toBe(user.id);
    expect(renewed?.renewedExpiresAt).toBeInstanceOf(Date);
    const stored = await database.query('SELECT expires_at FROM sessions');
    expect(new Date(String(stored.rows[0]?.expires_at)).getTime()).toBeGreaterThan(
      Date.now() + 170 * 24 * 60 * 60 * 1000
    );

    // An abandoned device is still signed out on schedule.
    await database.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 second'");
    await expect(store.getSession('sliding-session', lifetime)).resolves.toBeNull();
  });

  it('leases a queued task durably', async () => {
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Main',
      storageLimitBytes: 50 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'title-a', tag: 'title-b', ciphertext: 'title-c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const leased = await store.leaseNextTask('worker-1');
    expect(leased?.status).toBe('planning');
    expect(leased?.leaseOwner).toBe('worker-1');
  });

  /**
   * Re-pointing a walled task at a provider that is answering, and refusing to do it to a task
   * somebody else is holding.
   *
   * Three facts move together here - the route, the state that knows which providers have already
   * refused, and the credits spent getting this far - because a crash between them leaves a task
   * pointed at a model its own saved state has never heard of.
   */
  it('re-queues a walled task on another route, and only for the worker holding it', async () => {
    const user = await store.createUser({ username: 'reroute', displayName: 'Reroute' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.leaseNextTask('worker-1');
    const state = { v: 1, iv: 'state-a', tag: 'state-b', ciphertext: 'walled-openrouter' };

    // Another worker's task is not this one's to move, whatever it knows about the wall.
    await expect(
      store.rerouteTaskModel({
        id: task.id,
        workerId: 'worker-2',
        modelId: 'elsewhere',
        actualComputeCredits: 3,
        agentStateCiphertext: state
      })
    ).resolves.toBe(false);
    await expect(store.getTask(user.id, task.id)).resolves.toMatchObject({ modelId: 'qwen' });

    await expect(
      store.rerouteTaskModel({
        id: task.id,
        workerId: 'worker-1',
        modelId: 'elsewhere',
        actualComputeCredits: 3,
        agentStateCiphertext: state
      })
    ).resolves.toBe(true);
    await expect(store.getTask(user.id, task.id)).resolves.toMatchObject({
      modelId: 'elsewhere',
      status: 'queued',
      actualComputeCredits: 3,
      leaseOwner: null,
      agentStateCiphertext: state
    });
    // Queued and unleased means the next worker can take it - which is the whole point of moving
    // it rather than parking it - and the attempt count does not punish it for the wall.
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: task.id, attempt: 1 });
  });

  /**
   * The outage this ordering exists to end: a turn that takes the worker process down with it is
   * back in the queue the moment systemd restarts, and by age it is ahead of everything the owner
   * sent while it was crashing. Ordered by attempt first, it drops a place per death and is out of
   * the queue entirely at the ceiling.
   */
  it('puts a task that keeps dying behind a healthy one, and stops leasing it at the ceiling', async () => {
    const user = await store.createUser({ username: 'queue-order', displayName: 'Queue order' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const crasher = await store.createTask(taskInput(user.id, workspace.id));
    const healthy = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(
      `UPDATE tasks SET attempt=$2, created_at=NOW() - INTERVAL '2 minutes' WHERE id=$1`,
      [crasher.id, TASK_MAX_ATTEMPTS - 1]
    );

    // Oldest, and still second: the message the owner sent two minutes later goes first.
    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: healthy.id, attempt: 1 });
    // Second means after it, not beside it: both of these are the same computer.
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    await database.query(
      `UPDATE tasks SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1`,
      [healthy.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({
      id: crasher.id,
      attempt: TASK_MAX_ATTEMPTS
    });

    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [crasher.id]
    );
    // The lease has expired and the status is still live, which before the ceiling was all it took
    // to be handed straight back to a worker.
    await expect(store.leaseNextTask('worker-3')).resolves.toBeNull();
  });

  /**
   * The most ordinary thing an owner does is ask about a second thing while the first is still
   * running. That must not put two agents in one filesystem, one browser and one desktop.
   */
  it('hands a workspace to one worker at a time, and leaves other workspaces alone', async () => {
    const user = await store.createUser({ username: 'one-writer', displayName: 'One writer' });
    const main = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const spare = await store.createWorkspace(workspaceInput(user.id, 'Spare'));
    const running = await store.createTask(taskInput(user.id, main.id));
    const waiting = await store.createTask(taskInput(user.id, main.id));
    const elsewhere = await store.createTask(taskInput(user.id, spare.id));

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: running.id });
    // The second question waits; a workspace of its own is a different computer and runs at once.
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: elsewhere.id });
    await expect(store.leaseNextTask('worker-3')).resolves.toBeNull();

    // Parking the first turn hands the computer over, without waiting for any lease to run out.
    await store.updateTask({
      id: running.id,
      workerId: 'worker-1',
      status: 'awaiting_user',
      clearLease: true
    });
    expect(await store.leaseNextTask('worker-3')).toMatchObject({ id: waiting.id });
  });

  /**
   * The window this closes cannot be reproduced against one connection, so what is proved here is
   * the property that makes it impossible rather than the collision itself: the answer to "is
   * anybody in this workspace" is a column on the row the statement locks, so a poll whose snapshot
   * of the tasks table is a moment out of date has nothing to read it from.
   */
  it('decides one writer from the workspace row, not from a reading of the tasks in it', async () => {
    const user = await store.createUser({ username: 'row-truth', displayName: 'Row truth' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const first = await store.createTask(taskInput(user.id, workspace.id));
    const second = await store.createTask(taskInput(user.id, workspace.id));
    // Stands in for the turn another worker just started. Parked, so it is never a candidate here
    // and can only ever appear as a name on the hold.
    const competitor = await store.createTask(taskInput(user.id, workspace.id));
    await database.query("UPDATE tasks SET status='paused' WHERE id=$1", [competitor.id]);
    // Two rows can be created in the same instant, so which one the queue prefers is said.
    await database.query(`UPDATE tasks SET created_at=NOW() + INTERVAL '1 second' WHERE id=$1`, [
      second.id
    ]);
    const hold = async (): Promise<Record<string, unknown> | undefined> =>
      (
        await database.query(
          `SELECT w.lease_task_id, w.lease_expires_at = t.lease_expires_at AS same_deadline
           FROM workspaces w LEFT JOIN tasks t ON t.id=w.lease_task_id WHERE w.id=$1`,
          [workspace.id]
        )
      ).rows[0];
    const freeEveryTaskLease = async (): Promise<unknown> =>
      database.query('UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL');

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: first.id });
    // Written by the statement that leased the task, and written to run out at the same instant:
    // a worker that dies holding both lets go of both together, with nobody left to do it for it.
    expect(await hold()).toMatchObject({ lease_task_id: first.id, same_deadline: true });

    // Exactly what a poll a millisecond behind the winner reads. Every task in the workspace looks
    // free, and the only trace of the turn that just started is on the row being locked - which is
    // the one place the question is now asked, and the one place it was never written before.
    await database.query(
      `UPDATE workspaces SET lease_task_id=$2, lease_expires_at=NOW() + INTERVAL '1 minute'
       WHERE id=$1`,
      [workspace.id, competitor.id]
    );
    await freeEveryTaskLease();
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    // And the same row is what hands the computer back, three ways, none of which needs anything
    // to still be running to notice: a deadline that has passed, a holder that was deleted, and a
    // hold half written. A workspace nothing can take back is the one failure worse than the race.
    await database.query(
      `UPDATE workspaces SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [workspace.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: second.id });

    await store.deleteTask(user.id, second.id);
    expect(await hold()).toMatchObject({ lease_task_id: null });
    expect(await store.leaseNextTask('worker-3')).toMatchObject({ id: first.id });

    await database.query(
      `UPDATE workspaces SET lease_task_id=$2, lease_expires_at=NULL WHERE id=$1`,
      [workspace.id, competitor.id]
    );
    await freeEveryTaskLease();
    expect(await store.leaseNextTask('worker-4')).toMatchObject({ id: first.id });
  });

  /**
   * The invariant used to be eight callers each remembering one flag. A task the queue will not
   * hand out again cannot go on holding a workspace, so the status decides and the caller cannot
   * get it wrong.
   */
  it('takes the workspace back from a caller that forgot to let go of it', async () => {
    const user = await store.createUser({ username: 'forgetful', displayName: 'Forgetful' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const first = await store.createTask(taskInput(user.id, workspace.id));
    const second = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(`UPDATE tasks SET created_at=NOW() + INTERVAL '1 second' WHERE id=$1`, [
      second.id
    ]);
    const holder = async (): Promise<unknown> =>
      (await database.query('SELECT lease_task_id FROM workspaces WHERE id=$1', [workspace.id]))
        .rows[0]?.lease_task_id;

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: first.id });
    // Mid-turn, still working: a status the queue would lease keeps what it was given.
    await store.updateTask({ id: first.id, workerId: 'worker-1', status: 'running' });
    expect(await holder()).toBe(first.id);

    // Parked without the flag - and the workspace comes back anyway, along with the wake-up the
    // conversation waiting behind it would otherwise have sat out a whole worker poll for.
    const startedAt = Date.now();
    const woken = store.waitForQueuedTask(4_000);
    await store.updateTask({ id: first.id, workerId: 'worker-1', status: 'awaiting_user' });
    await woken;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await holder()).toBeNull();
    expect(await store.getTask(user.id, first.id)).toMatchObject({
      leaseOwner: null,
      leaseExpiresAt: null
    });
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: second.id });
  });

  it('takes the workspace back when the worker holding it dies, and still retries its task', async () => {
    const user = await store.createUser({ username: 'dead-worker', displayName: 'Dead worker' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const first = await store.createTask(taskInput(user.id, workspace.id));
    const second = await store.createTask(taskInput(user.id, workspace.id));

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: first.id, attempt: 1 });
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    // Nothing is renewing the lease any more, so the process that is gone stops holding the box.
    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [first.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: second.id, attempt: 1 });

    // And the turn that died is still the same task, so it comes back rather than being lost.
    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [second.id]
    );
    expect(await store.leaseNextTask('worker-3')).toMatchObject({ id: first.id, attempt: 2 });
  });

  /**
   * The hold is a deadline, and any answer worth waiting for outlives it. Nothing else in the
   * schema says the workspace is occupied any more, so whatever keeps a task's lease alive has to
   * keep the workspace's alive with it - otherwise the one-writer rule quietly stops applying two
   * minutes into every long turn, which is the only kind of turn during which the owner has time
   * to ask a second question.
   */
  it('holds the workspace for as long as the worker keeps saying it is alive', async () => {
    const user = await store.createUser({ username: 'long-turn', displayName: 'Long turn' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const running = await store.createTask(taskInput(user.id, workspace.id));
    const waiting = await store.createTask(taskInput(user.id, workspace.id));
    const hold = async (): Promise<Record<string, unknown> | undefined> =>
      (
        await database.query(
          `SELECT w.lease_task_id, w.lease_expires_at = t.lease_expires_at AS same_deadline
           FROM workspaces w LEFT JOIN tasks t ON t.id=w.lease_task_id WHERE w.id=$1`,
          [workspace.id]
        )
      ).rows[0];

    // A hold short enough to run out inside a test, and a turn that goes on past it.
    expect(await store.leaseNextTask('worker-1', 1)).toMatchObject({ id: running.id });
    await expect(store.renewTaskLease(running.id, 'worker-1', 120)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The original hold has run out; the turn has not, and says so every step.
    await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();
    // Still welded to the lease it renewed, so a worker that dies now still lets go of both at the
    // same instant and no sweep has to exist.
    expect(await hold()).toMatchObject({ lease_task_id: running.id, same_deadline: true });

    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [running.id]
    );
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: waiting.id });
  });

  /**
   * Waiting for the workspace is not an attempt at anything. If a poll that finds the workspace
   * held were to spend one, an idle worker would count a patient conversation to death in a few
   * seconds and the sweep would fail it as a task that keeps dying, having never once run.
   */
  it('spends no attempt on a conversation that is only waiting for the workspace', async () => {
    const user = await store.createUser({ username: 'patient', displayName: 'Patient' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const holder = await store.createTask(taskInput(user.id, workspace.id));
    const waiting = await store.createTask(taskInput(user.id, workspace.id));

    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: holder.id, attempt: 1 });
    for (let poll = 0; poll < TASK_MAX_ATTEMPTS + 3; poll += 1)
      await expect(store.leaseNextTask('worker-2')).resolves.toBeNull();

    const untouched = await store.getTask(user.id, waiting.id);
    expect(untouched).toMatchObject({ attempt: 0, status: 'queued', leaseOwner: null });
    // And nothing swept it up as a task that has run out of tries while it stood in line.
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([]);

    await store.updateTask({
      id: holder.id,
      workerId: 'worker-1',
      status: 'completed',
      clearLease: true
    });
    expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: waiting.id, attempt: 1 });
  });

  /**
   * The owner is watching at exactly this moment - one answer has just finished and the question
   * they asked while it ran is next. Every door out of a turn has to say so, or the conversation
   * that was waiting for the computer sits out a whole worker poll after it became leasable.
   */
  it('wakes the queue on every door a turn leaves the workspace by', async () => {
    const user = await store.createUser({ username: 'handover', displayName: 'Handover' });
    const state: EncryptedEnvelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' };
    const doors: Array<[string, (holderId: string) => Promise<unknown>]> = [
      [
        'end of turn',
        (id) => store.updateTask({ id, workerId: 'worker-1', status: 'paused', clearLease: true })
      ],
      [
        'finished',
        (id) =>
          store.completeTaskIfNoQueued({
            id,
            workerId: 'worker-1',
            actualComputeCredits: 1,
            agentStateCiphertext: state
          })
      ],
      ['stopped from the screen', (id) => store.setTaskStatusForUser(user.id, id, 'paused')],
      ['cancelled', (id) => store.cancelTaskAndReleaseReservations(user.id, id)],
      ['deleted', (id) => store.deleteTask(user.id, id)]
    ];
    for (const [door, release] of doors) {
      const workspace = await store.createWorkspace(workspaceInput(user.id, door));
      const holder = await store.createTask(taskInput(user.id, workspace.id));
      const waiting = await store.createTask(taskInput(user.id, workspace.id));
      // The queue hands out the older conversation first, and two writes can land in the same
      // instant here, so which of these is the holder is said rather than assumed.
      await database.query(`UPDATE tasks SET created_at=NOW() + INTERVAL '1 second' WHERE id=$1`, [
        waiting.id
      ]);
      expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: holder.id });

      const startedAt = Date.now();
      const woken = store.waitForQueuedTask(4_000);
      await release(holder.id);
      await woken;
      expect(Date.now() - startedAt, door).toBeLessThan(1_000);
      expect(await store.leaseNextTask('worker-2')).toMatchObject({ id: waiting.id });

      // Left held by nobody, so the next door in this list is the only thing the queue can offer.
      await store.updateTask({
        id: waiting.id,
        workerId: 'worker-2',
        status: 'completed',
        clearLease: true
      });
    }
  });

  /**
   * A wake-up is every worker slot in the install stopping to poll, so the price of announcing one
   * that freed nothing is paid by every turn that is running at the time.
   */
  it('says nothing on a write that let go of no workspace', async () => {
    const user = await store.createUser({ username: 'quiet', displayName: 'Quiet' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Quiet'));
    const holder = await store.createTask(taskInput(user.id, workspace.id));
    expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: holder.id });

    let woke = false;
    const woken = store.waitForQueuedTask(500).then(() => {
      woke = true;
    });
    // The ordinary mid-turn write: the worker is still in there and still holding the computer.
    await store.updateTask({ id: holder.id, workerId: 'worker-1', status: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(woke).toBe(false);

    // And a lease that ran out was already excluding nobody: whatever was behind it became
    // leasable when it expired, which is what the poll interval is the floor for.
    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [holder.id]
    );
    await store.updateTask({
      id: holder.id,
      workerId: 'worker-1',
      status: 'paused',
      clearLease: true
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(woke).toBe(false);
    await woken;
  });

  it('fails a task that has used every attempt exactly once, and gives back what it held', async () => {
    const user = await store.createUser({ username: 'exhausted', displayName: 'Exhausted' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'task_compute',
      resourceClass: 'medium',
      quantity: 1,
      unit: 'credit',
      credits: 4,
      state: 'reserved',
      idempotencyKey: `task:${task.id}:reservation`
    });
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'media:video',
      quantity: 1,
      unit: 'job',
      credits: 4,
      costUsd: 4,
      state: 'reserved',
      idempotencyKey: `provider-media:${task.id}`
    });
    await database.query(
      `UPDATE tasks SET status='running', attempt=$2, lease_owner='worker-1',
         lease_expires_at=NOW() + INTERVAL '2 minutes' WHERE id=$1`,
      [task.id, TASK_MAX_ATTEMPTS]
    );

    // A live lease means a worker is in there renewing it, whatever the count says.
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([]);

    await database.query(
      `UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second' WHERE id=$1`,
      [task.id]
    );
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([
      {
        id: task.id,
        userId: user.id,
        workspaceId: workspace.id,
        attempt: TASK_MAX_ATTEMPTS,
        undeliveredMessages: 0
      }
    ]);
    expect((await store.getTask(user.id, task.id))?.status).toBe('failed');
    await expect(billing.reservedUsageForTask(task.id)).resolves.toBe(4);
    // Exactly once, so the owner is told once: the statement that finds the rows is the statement
    // that moves them out of the statuses it looks at.
    await expect(store.failTasksAtAttemptLimit()).resolves.toEqual([]);
  });

  it('starts the count again whenever a task re-enters the queue, so a long conversation never runs out', async () => {
    const user = await store.createUser({ username: 'long-run', displayName: 'Long run' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const attemptOf = async (): Promise<number | undefined> =>
      (await store.getTask(user.id, task.id))?.attempt;

    // Many more turns than the ceiling: an approval answered, a pause resumed, a follow-up sent -
    // each one is a fresh start, and the ceiling must not be counting them.
    for (let turn = 0; turn < TASK_MAX_ATTEMPTS + 2; turn += 1) {
      expect(await store.leaseNextTask('worker-1')).toMatchObject({ id: task.id, attempt: 1 });
      await store.updateTask({
        id: task.id,
        workerId: 'worker-1',
        status: 'awaiting_user',
        clearLease: true
      });
      // Parked, not queued: the count stands until something puts it back in the queue, which is
      // what keeps `attempt = 0` meaning "never leased" for the scheduled-run recovery sweep.
      expect(await attemptOf()).toBe(1);
      await store.setTaskStatusForUser(user.id, task.id, 'queued');
      expect(await attemptOf()).toBe(0);
    }

    // A lease that simply expires - the worker died - is the one that counts.
    await store.leaseNextTask('worker-1');
    await database.query(`UPDATE tasks SET lease_expires_at=NOW() - INTERVAL '1 second'`);
    await store.leaseNextTask('worker-2');
    expect(await attemptOf()).toBe(2);

    // And the way back in for a task the ceiling stopped: the owner writes again.
    await database.query(
      `UPDATE tasks SET status='failed', attempt=$2, lease_owner=NULL WHERE id=$1`,
      [task.id, TASK_MAX_ATTEMPTS]
    );
    const continued = await store.continueTask({
      id: task.id,
      userId: user.id,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      agentStateCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      reservationKey: `task:${task.id}:turn:1:reservation`,
      resourceClass: 'medium',
      userMessageCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    expect(continued).toMatchObject({ status: 'queued', attempt: 0 });
    await expect(store.leaseNextTask('worker-3')).resolves.toMatchObject({ id: task.id });
  });

  it('materialises a due schedule exactly once, whichever worker got there first', async () => {
    const user = await store.createUser({ username: 'scheduler', displayName: 'Scheduler' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Scheduled work',
      storageLimitBytes: 20 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const periodStart = new Date(Date.now() - 60_000);
    const periodEnd = new Date(Date.now() + 86_400_000);
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    const updatedSchedule = await store.updateTaskSchedule(user.id, schedule.id, {
      titleCiphertext: { ...envelope, ciphertext: 'updated-title' },
      promptCiphertext: { ...envelope, ciphertext: 'updated-prompt' },
      spec: { kind: 'daily', timeZone: 'UTC', localTime: '09:30' },
      maxComputeCredits: 1.5,
      nextRunAt: new Date(Date.now() + 120_000)
    });
    expect(updatedSchedule).toMatchObject({
      id: schedule.id,
      spec: { kind: 'daily', timeZone: 'UTC', localTime: '09:30' },
      maxComputeCredits: 1.5
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    const leased = await store.leaseDueTaskSchedule('scheduler-1');
    expect(leased?.id).toBe(schedule.id);
    await expect(store.leaseDueTaskSchedule('scheduler-2')).resolves.toBeNull();
    const taskId = '00000000-0000-4000-8000-000000000001';
    const materialized = await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-1',
      taskId,
      nextRunAt: new Date(Date.now() + 1_800_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    expect(materialized).toMatchObject({ outcome: 'queued', errorCode: null });
    expect(materialized?.task.status).toBe('awaiting_resource');
    // Where the run came from is written by the statement that creates it, and survives the read
    // path: it is the only thing that lets the sidebar fold a watcher's runs into one line rather
    // than interleaving ninety-six of them a day with the owner's own conversations.
    expect(materialized?.task.scheduleId).toBe(schedule.id);
    await expect(store.getTask(user.id, taskId)).resolves.toMatchObject({
      scheduleId: schedule.id
    });
    await expect(
      store.materializeTaskSchedule({
        scheduleId: schedule.id,
        workerId: 'scheduler-1',
        taskId: '00000000-0000-4000-8000-000000000002',
        nextRunAt: null,
        resourceClass: 'medium',
        preparingEventCiphertext: envelope,
        failureEventCiphertext: envelope
      })
    ).resolves.toBeNull();
    await expect(store.usageTotals(user.id, periodStart, periodEnd)).resolves.toMatchObject({
      reserved: 1.5
    });

    // A run the caller has already decided against - an unavailable model, a workspace that is not
    // there - still lands as a failed task with its reason, rather than as silence.
    const refused = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 2,
      spec: { kind: 'once', runAt: new Date(Date.now() + 60_000).toISOString() },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query(
      "UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute' WHERE id=$1",
      [refused.id]
    );
    await store.leaseDueTaskSchedule('scheduler-1');
    const failed = await store.materializeTaskSchedule({
      scheduleId: refused.id,
      workerId: 'scheduler-1',
      taskId: '00000000-0000-4000-8000-000000000003',
      nextRunAt: null,
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope,
      forceFailureCode: 'model_unavailable'
    });
    expect(failed).toMatchObject({ outcome: 'failed', errorCode: 'model_unavailable' });
    expect(failed?.task.status).toBe('failed');
    // A run that never started reserves nothing, so the earlier reservation is all there is.
    await expect(store.usageTotals(user.id, periodStart, periodEnd)).resolves.toMatchObject({
      reserved: 1.5
    });
  });

  it('tracks user-owned workspace snapshots', async () => {
    const user = await store.createUser({ username: 'snapshot', displayName: 'Snapshot' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Main',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const snapshot = await store.createWorkspaceSnapshot({
      userId: user.id,
      workspaceId: workspace.id,
      name: 'Before upgrade',
      sizeBytes: workspace.storageLimitBytes
    });
    await store.setWorkspaceSnapshotStatus(String(snapshot.id), 'ready');
    await expect(store.listWorkspaceSnapshots(user.id, workspace.id)).resolves.toMatchObject([
      { id: snapshot.id, name: 'Before upgrade', status: 'ready', sizeBytes: 10 * 1024 ** 3 }
    ]);
    await expect(
      store.deleteWorkspaceSnapshot(user.id, workspace.id, String(snapshot.id))
    ).resolves.toBe(true);
    await expect(store.listWorkspaceSnapshots(user.id, workspace.id)).resolves.toEqual([]);
  });

  it('stores connector secrets as ciphertext and records content-free capability audit', async () => {
    const user = await store.createUser({ username: 'connector', displayName: 'Connector' });
    const connector = await store.createConnector({
      id: '00000000-0000-4000-8000-000000000101',
      userId: user.id,
      kind: 'github',
      authMode: 'secret',
      label: 'Work GitHub',
      baseUrl: 'https://api.github.com',
      scopes: ['github:repository.read'],
      secretCiphertext: {
        v: 1,
        iv: 'encrypted-iv',
        tag: 'encrypted-tag',
        ciphertext: 'encrypted-secret',
        aad: `connector:${user.id}:00000000-0000-4000-8000-000000000101`
      }
    });
    expect(connector).toMatchObject({
      kind: 'github',
      scopes: ['github:repository.read'],
      enabled: true,
      lastUsedAt: null
    });
    const raw = await database.query('SELECT * FROM connectors WHERE id=$1', [connector.id]);
    expect(JSON.stringify(raw.rows)).not.toContain('plaintext-token');
    await store.recordConnectorAudit({
      connectorId: connector.id,
      userId: user.id,
      operation: 'github_list_repositories',
      outcome: 'succeeded',
      statusCode: 200,
      responseBytes: 128,
      durationMs: 12
    });
    await expect(store.listConnectorAudit(user.id)).resolves.toMatchObject([
      {
        connectorId: connector.id,
        operation: 'github_list_repositories',
        outcome: 'succeeded',
        statusCode: 200,
        responseBytes: 128,
        durationMs: 12
      }
    ]);
    expect((await store.listConnectors(user.id))[0]?.lastUsedAt).not.toBeNull();
    await expect(store.revokeConnector(user.id, connector.id)).resolves.toBe(true);
    await expect(store.getConnector(user.id, connector.id)).resolves.toBeNull();
  });

  /**
   * How fast the quickest company serving a model runs, kept so a speed floor can be a share of it.
   *
   * The aggregator will compare each company against a threshold but publishes no per-endpoint
   * throughput to compute one from, so this is read from its own account of a generation it routed
   * by throughput - its measurement, of its own choice of fastest.
   */
  it('keeps a model’s speed ceiling, replaces it, and withholds a stale one', async () => {
    await store.recordModelThroughputCeiling({
      modelId: 'vendor/model',
      tokensPerSecond: 142,
      providerName: 'Novita'
    });
    await expect(store.modelThroughputCeiling('vendor/model')).resolves.toEqual({
      tokensPerSecond: 142,
      providerName: 'Novita'
    });

    // Replaced rather than averaged: this is a ceiling other companies are judged against, and the
    // quickest one changes when the aggregator's fleet does. A mean would blend a company retired
    // last week into a threshold applied today.
    await store.recordModelThroughputCeiling({
      modelId: 'vendor/model',
      tokensPerSecond: 90,
      providerName: 'Someone Else'
    });
    await expect(store.modelThroughputCeiling('vendor/model')).resolves.toEqual({
      tokensPerSecond: 90,
      providerName: 'Someone Else'
    });

    // A figure that is not a measurement is not stored at all, rather than stored as zero and read
    // back as a ceiling that would put the floor on the ground.
    await store.recordModelThroughputCeiling({
      modelId: 'other/model',
      tokensPerSecond: 0,
      providerName: 'Nobody'
    });
    await expect(store.modelThroughputCeiling('other/model')).resolves.toBeNull();

    /*
     * Withheld rather than aged. A stale ceiling that is too high deprioritises every company at
     * once, and a price sort over a wholly deprioritised field returns the cheapest - which turns
     * the rule silently back into the aggregator's own default. Absent is safe; wrong is not.
     */
    await database.query(
      "UPDATE model_throughput_ceiling SET sampled_at = NOW() - INTERVAL '5 days'"
    );
    await expect(store.modelThroughputCeiling('vendor/model')).resolves.toBeNull();
    await expect(store.modelThroughputCeiling('vendor/model', 24 * 7)).resolves.toMatchObject({
      tokensPerSecond: 90
    });
  });

  /**
   * A visit renews a preview by its own window, not by the global one.
   *
   * A `brief` conversation's page is created with a twenty-four hour deadline, and the renewal
   * used to read the thirty-day constant - so the first person to open a short-lived page turned
   * it into a long-lived one and the owner's lifetime choice stopped meaning anything. Publishing
   * and unpublishing renew on the same path and had the same defect.
   */
  it('renews a short-lived preview by its own window rather than the ordinary one', async () => {
    const user = await store.createUser({ username: 'brief-preview', displayName: 'Brief' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'App'));
    const brief = await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Mock-up',
      port: 3000,
      slug: '1123456789abcdef0123456789abcdef',
      accessTokenHash: 'brief-hash',
      idleInterval: '24 hours'
    });
    const ordinary = await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'The app itself',
      port: 3001,
      slug: '2123456789abcdef0123456789abcdef',
      accessTokenHash: 'ordinary-hash'
    });
    const hoursOut = async (id: string): Promise<number> => {
      const row = await database.query('SELECT expires_at FROM workspace_previews WHERE id=$1', [
        id
      ]);
      return (Date.parse(String(row.rows[0]!.expires_at)) - Date.now()) / 3_600_000;
    };
    expect(await hoursOut(brief.id)).toBeLessThan(25);

    // The visit that used to undo it.
    await store.touchWorkspacePreview(brief.id);
    expect(await hoursOut(brief.id)).toBeLessThan(25);
    await store.touchWorkspacePreview(ordinary.id);
    // A preview with no window of its own is every preview that existed before the column, and it
    // still renews to the ordinary one.
    expect(await hoursOut(ordinary.id)).toBeGreaterThan(24 * 20);

    // Publishing drops the deadline entirely, and coming back to private restores this preview's
    // own window rather than handing it the long one.
    await store.publishWorkspacePreview(user.id, brief.id, 'public', 'public-hash');
    await expect(
      store.publishWorkspacePreview(user.id, brief.id, 'private', 'private-hash')
    ).resolves.toMatchObject({ visibility: 'private' });
    expect(await hoursOut(brief.id)).toBeLessThan(25);
  });

  it('limits, rotates, publishes, expires, and revokes isolated workspace previews', async () => {
    const user = await store.createUser({ username: 'preview', displayName: 'Preview' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'App',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const preview = await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Private app',
      port: 3000,
      slug: '0123456789abcdef0123456789abcdef',
      accessTokenHash: 'first-hash',
      maxPreviews: 1
    });
    await expect(
      store.createWorkspacePreview({
        userId: user.id,
        workspaceId: workspace.id,
        label: 'Second',
        port: 3001,
        slug: 'abcdef0123456789abcdef0123456789',
        accessTokenHash: 'second-hash',
        maxPreviews: 1
      })
    ).rejects.toThrow('preview_limit');
    await expect(
      store.rotateWorkspacePreviewAccess(user.id, preview.id, 'rotated-hash')
    ).resolves.toMatchObject({ accessTokenHash: 'rotated-hash' });
    await expect(
      store.publishWorkspacePreview(user.id, preview.id, 'public', 'public-hash')
    ).resolves.toMatchObject({
      visibility: 'public',
      accessTokenHash: 'public-hash',
      expiresAt: null
    });
    await store.touchWorkspacePreview(preview.id);
    expect((await store.getWorkspacePreviewBySlug(preview.slug))?.lastAccessedAt).not.toBeNull();
    await expect(store.revokeWorkspacePreview(user.id, preview.id)).resolves.toBe(true);
    await expect(
      store.rotateWorkspacePreviewAccess(user.id, preview.id, 'late-hash')
    ).resolves.toBeNull();
  });

  it('replays sealed operations and retains unresolved claims', async () => {
    const user = await store.createUser({ username: 'grace', displayName: 'Grace' });
    const input = {
      userId: user.id,
      idempotencyKey: 'stable-key-0001',
      method: 'POST',
      path: '/v1/workspaces',
      requestHash: 'hash-a'
    };
    await expect(store.beginOperation(input)).resolves.toBeNull();
    const receipt = encryptJson({ id: 'one' }, generateDataKey(), 'receipt-test');
    await store.completeOperation(user.id, input.idempotencyKey, 200, receipt);
    await expect(store.beginOperation(input)).resolves.toMatchObject({
      state: 'completed',
      method: 'POST',
      path: '/v1/workspaces',
      responseCiphertext: receipt
    });
    await expect(store.beginOperation({ ...input, path: '/v1/tasks' })).resolves.toMatchObject({
      path: '/v1/workspaces',
      requestHash: 'hash-a'
    });

    const retry = { ...input, idempotencyKey: 'stable-key-0002' };
    await expect(store.beginOperation(retry)).resolves.toBeNull();
    await store.failOperation(user.id, retry.idempotencyKey);
    await expect(store.beginOperation(retry)).resolves.toMatchObject({ state: 'failed' });
  });

  it('queues only undelivered generic notification references for new device subscriptions', async () => {
    const user = await store.createUser({ username: 'lin', displayName: 'Lin' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Cloud',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'session-hash',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/opaque',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'private-title', tag: 'title-tag', ciphertext: 'title-data' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'browser.submit',
      sideEffect: 'external_write',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'completed');

    const pending = await store.listPendingNotifications();
    // The approval leads. Both land in the same instant here, and the agent is stopped until the
    // approval is answered while a finished task is only news - so ordering by timestamp alone left
    // it to chance which one the owner's phone showed first, and left two reads of the same page
    // disagreeing about their order.
    expect(pending.map((item) => ({ kind: item.kind, resourceId: item.resourceId }))).toEqual([
      { kind: 'approval_required', resourceId: approvalId },
      { kind: 'task_finished', resourceId: task.id }
    ]);
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(pending.map((row) => row.kind));
    expect(JSON.stringify(pending)).not.toContain('private-title');
    await store.recordNotificationDelivery(subscription.id, 'task_finished', task.id);
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'approval_required', resourceId: approvalId }
    ]);
    await store.deleteSessionForUser(user.id, (await store.listSessions(user.id))[0]!.id as string);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  /**
   * A box run in Balanced mode answers approvals all day and keeps every answer it has ever given.
   * The list read was the whole table - months of settled decisions handed to a caller that then
   * issues two more queries and a decrypt for each row it was given.
   *
   * So the read is a page, and what falls off the end stays reachable by asking again from where
   * the page stopped. That has to hold when a run of approvals share a timestamp, which approvals
   * written by one turn do: the position is the row, not the clock.
   */
  it('bounds an approval list months of answers have grown, and reaches the rest by cursor', async () => {
    const user = await store.createUser({ username: 'approver', displayName: 'Approver' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Approvals'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const total = MAX_APPROVAL_PAGE + 37;
    // Two to a timestamp, so paging has to break a tie rather than trust the clock to do it.
    await database.query(
      `INSERT INTO approvals(id,user_id,task_id,action,side_effect,preview_ciphertext,
         preview_hash,status,expires_at,created_at)
       SELECT gen_random_uuid(), $1, $2, 'browser.submit', 'external_write',
         '{"v":1,"iv":"a","tag":"b","ciphertext":"c"}'::jsonb, 'hash', 'pending',
         NOW() + INTERVAL '1 hour', NOW() - ((g / 2) * INTERVAL '1 second')
       FROM generate_series(1, $3::int) AS g`,
      [user.id, task.id, total]
    );

    const first = await store.listApprovals(user.id, 'pending');
    expect(first).toHaveLength(MAX_APPROVAL_PAGE);
    const rest = await store.listApprovals(user.id, 'pending', {
      cursor: String(first.at(-1)!.cursor)
    });
    expect(rest).toHaveLength(total - MAX_APPROVAL_PAGE);
    // Every approval exactly once: none shown twice by the page boundary, none skipped past it.
    expect(new Set([...first, ...rest].map((approval) => String(approval.id))).size).toBe(total);
    // Newest first the whole way through. A page boundary is not a place where a list may re-sort.
    const stamps = [...first, ...rest].map((approval) => String(approval.createdAt));
    expect([...stamps].sort().reverse()).toEqual(stamps);
    // A limit is honoured, and is not a way to ask for the whole table back.
    await expect(store.listApprovals(user.id, 'pending', { limit: 5 })).resolves.toHaveLength(5);
    await expect(
      store.listApprovals(user.id, 'pending', { limit: total }).then((rows) => rows.length)
    ).resolves.toBe(MAX_APPROVAL_PAGE);
  });

  /**
   * Whether this conversation is stopped on an approval is one indexed question, and the send path
   * answered it by reading every pending approval the owner has and scanning them in JavaScript -
   * on the hot path, for every follow-up message sent to a waiting task.
   *
   * The answer here has to be the same answer, or converting that caller changes when a follow-up
   * unparks a conversation. That includes an approval whose deadline has passed but which the
   * expiry sweep has not reached yet: it is still `pending`, and it still holds the task.
   */
  it('answers whether one conversation is stopped on an approval without reading them all', async () => {
    const user = await store.createUser({ username: 'parked', displayName: 'Parked' });
    const stranger = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Parked'));
    const parked = await store.createTask(taskInput(user.id, workspace.id));
    const working = await store.createTask(taskInput(user.id, workspace.id));
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: parked.id,
      action: 'browser.submit',
      sideEffect: 'external_write',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      expiresAt: new Date(Date.now() + 60_000)
    });
    /** The read this replaces, kept beside it so the two can be held against each other. */
    const byScanning = async (taskId: string): Promise<boolean> =>
      (await store.listApprovals(user.id, 'pending')).some(
        (approval) => String(approval.taskId) === taskId
      );

    await expect(connectors.hasPendingApproval(user.id, parked.id)).resolves.toBe(true);
    await expect(connectors.hasPendingApproval(user.id, working.id)).resolves.toBe(false);
    expect(await byScanning(parked.id)).toBe(true);
    expect(await byScanning(working.id)).toBe(false);
    // Somebody else's approval is not an answer about this owner's conversation.
    await expect(connectors.hasPendingApproval(stranger.id, parked.id)).resolves.toBe(false);
    // An approval past its deadline that the sweep has not reached is still holding the task.
    await database.query('UPDATE approvals SET expires_at = NOW() - $1::interval WHERE id = $2', [
      '1 hour',
      approvalId
    ]);
    await expect(connectors.hasPendingApproval(user.id, parked.id)).resolves.toBe(true);
    expect(await byScanning(parked.id)).toBe(true);
    // Answered is not pending, which is what lets a follow-up move the conversation back to work.
    await store.cleanupExpired();
    await expect(connectors.hasPendingApproval(user.id, parked.id)).resolves.toBe(false);
    expect(await byScanning(parked.id)).toBe(false);
  });

  /**
   * Whether a computer still has work running on it decides whether the owner may put its files
   * back. It was answered by reading every conversation in the workspace - each row carrying two
   * correlated subqueries for its live counts - and testing them in JavaScript, to establish a
   * fact that one indexed row proves.
   */
  it('answers whether a workspace still has live work without reading its conversations', async () => {
    const user = await store.createUser({ username: 'busy', displayName: 'Busy' });
    const stranger = await store.createUser({ username: 'onlooker', displayName: 'Onlooker' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Busy'));
    const quiet = await store.createWorkspace(workspaceInput(user.id, 'Quiet'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const executing = ['queued', 'planning', 'running'] as const;
    const settled = SETTLED_TASK_STATUSES;

    // The two lists are complements, and a status nobody has classified is live rather than
    // settled: the refusal they feed has to fail towards saying no while an agent is working.
    expect([...LIVE_TASK_STATUSES, ...SETTLED_TASK_STATUSES].sort()).toEqual(
      [...TaskStatus.options].sort()
    );
    expect(LIVE_TASK_STATUSES.filter((status) => SETTLED_TASK_STATUSES.includes(status))).toEqual(
      []
    );
    await expect(
      tasks.workspaceHasTasksInStatus(user.id, workspace.id, LIVE_TASK_STATUSES)
    ).resolves.toBe(true);

    await expect(tasks.workspaceHasTasksInStatus(user.id, workspace.id, executing)).resolves.toBe(
      true
    );
    await expect(tasks.workspaceHasTasksInStatus(user.id, workspace.id, settled)).resolves.toBe(
      false
    );
    await store.setTaskStatusForUser(user.id, task.id, 'completed');
    await expect(tasks.workspaceHasTasksInStatus(user.id, workspace.id, executing)).resolves.toBe(
      false
    );
    await expect(tasks.workspaceHasTasksInStatus(user.id, workspace.id, settled)).resolves.toBe(
      true
    );
    // Scoped to the owner, and to the one computer being asked about.
    await expect(tasks.workspaceHasTasksInStatus(stranger.id, workspace.id, settled)).resolves.toBe(
      false
    );
    await expect(tasks.workspaceHasTasksInStatus(user.id, quiet.id, settled)).resolves.toBe(false);
    // Nothing to look for is not a reason to go looking.
    await expect(tasks.workspaceHasTasksInStatus(user.id, workspace.id, [])).resolves.toBe(false);
  });

  it('wakes a reader on the write rather than making it ask again a second later', async () => {
    const user = await store.createUser({ username: 'signal', displayName: 'Signal' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Signal'));

    // A worker with nothing to do waits on the queue, and a send ends that wait immediately -
    // this is what used to cost up to a full poll interval before the model was even called.
    const startedAt = Date.now();
    const waited = store.waitForQueuedTask(5_000);
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await waited;
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    // And an open activity stream is told about its own conversation, and only its own.
    const woken: string[] = [];
    const other = await store.createTask(taskInput(user.id, workspace.id));
    const unsubscribe = store.onTaskEvent(task.id, () => woken.push('woken'));
    await store.appendTaskEvent({ taskId: other.id, kind: 'status', summary: 'Elsewhere' });
    expect(woken).toEqual([]);
    await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_delta', summary: 'Reply' });
    expect(woken).toEqual(['woken']);

    unsubscribe();
    await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_delta', summary: 'More' });
    expect(woken).toEqual(['woken']);
  });

  it('raises a spend pause, names the conversation, and keeps titles sealed without a key', async () => {
    const masterKey = Buffer.alloc(32, 5);
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const dataKey = generateDataKey();
    // The key is wrapped against the workspace id, so the id is chosen before the row is written.
    const workspaceId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf1';
    const workspace = await store.createWorkspace({
      ...workspaceInput(user.id, 'Cloud'),
      id: workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'spend-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/spend',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      titleCiphertext: encryptJson(
        { title: 'Rebuild the invoice script' },
        dataKey,
        `task-title:${workspace.id}`
      )
    });

    // An ordinary Pause is the owner's own decision and needs no notification.
    await store.updateTask({ id: task.id, status: 'paused' });
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // A pause at a spending ceiling is the one nobody chose, and it waits forever unheard.
    await store.updateTask({ id: task.id, status: 'paused', spendPausedAt: new Date() });
    const pending = await store.listPendingNotifications(100, masterKey);
    expect(pending.map((item) => ({ kind: item.kind, resourceId: item.resourceId }))).toEqual([
      { kind: 'spend_paused', resourceId: task.id }
    ]);
    expect(pending[0]!.taskTitle).toBe('Rebuild the invoice script');

    // Without the master key the row still describes the pause and reveals nothing about it.
    const sealed = await store.listPendingNotifications();
    expect(sealed[0]!.taskTitle).toBeNull();
    expect(JSON.stringify(sealed)).not.toContain('invoice');

    await store.recordNotificationDelivery(subscription.id, 'spend_paused', task.id);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // Resuming answers the pause, so it can never be raised a second time for the same stop.
    await store.setTaskStatusForUser(user.id, task.id, 'queued');
    await store.updateTask({ id: task.id, status: 'paused', spendPausedAt: new Date() });
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('stores the kinds the owner kept and the window the box may not wake them in', async () => {
    const user = await store.createUser({ username: 'quiet', displayName: 'Quiet' });
    // Nothing stored is not "notify nothing": it is the default, and the caller supplies it.
    await expect(store.notificationSettings(user.id)).resolves.toBeNull();

    // Every kind that can reach a device has a switch, the two the agent raises included: the one
    // notification the owner asked for should not also be the one they cannot turn down.
    const kinds = {
      approval_required: true,
      task_finished: false,
      spend_paused: true,
      agent_message: true,
      takeover_needed: false
    };
    await store.setNotificationSettings(user.id, {
      kinds,
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
      quietHoursAllowApprovals: false
    });
    await expect(store.notificationSettings(user.id)).resolves.toEqual({
      kinds,
      quietHours: { startMinute: 1320, endMinute: 420 },
      quietHoursAllowApprovals: false
    });

    // A null window is how quiet hours are switched off; there is no second flag to disagree with.
    await store.setNotificationSettings(user.id, {
      kinds: { ...kinds, task_finished: true, takeover_needed: true },
      quietHours: null,
      quietHoursAllowApprovals: true
    });
    await expect(store.notificationSettings(user.id)).resolves.toMatchObject({
      kinds: { ...kinds, task_finished: true, takeover_needed: true },
      quietHours: null
    });
  });

  it('keeps a private preview alive while it is used and closes it once it is not', async () => {
    const user = await store.createUser({ username: 'persistent', displayName: 'Persistent' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'App'));
    const daysAway = (value: string | null): number =>
      (new Date(String(value)).getTime() - Date.now()) / 86_400_000;

    // Created with no lifetime to choose: the deadline is an idle window, not a countdown.
    const preview = await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Club site',
      port: 3000,
      slug: '0123456789abcdef0123456789abcdef',
      accessTokenHash: 'hash'
    });
    expect(daysAway(preview.expiresAt)).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);

    // A month of silence would end it, and one visit puts the whole window back.
    await database.query(
      "UPDATE workspace_previews SET expires_at=NOW()+INTERVAL '2 hours' WHERE id=$1",
      [preview.id]
    );
    await store.touchWorkspacePreview(preview.id);
    const visited = await store.getWorkspacePreviewBySlug(preview.slug);
    expect(daysAway(visited!.expiresAt)).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);
    expect(visited!.lastAccessedAt).not.toBeNull();

    // Publishing is not a lease: a public address stays until it is taken down.
    const published = await store.publishWorkspacePreview(
      user.id,
      preview.id,
      'public',
      'public-hash'
    );
    expect(published?.expiresAt).toBeNull();
    // ...and a published site has no deadline for a visit to move.
    await store.touchWorkspacePreview(preview.id);
    await expect(store.getWorkspacePreviewBySlug(preview.slug)).resolves.toMatchObject({
      expiresAt: null
    });

    // Taking it private again restores the idle window rather than a grace period.
    const unpublished = await store.publishWorkspacePreview(
      user.id,
      preview.id,
      'private',
      'private-hash'
    );
    expect(daysAway(unpublished!.expiresAt)).toBeGreaterThan(PREVIEW_IDLE_EXPIRY_DAYS - 1);
  });

  it('pushes what the agent asked to say, and nothing when a scheduled run merely ends', async () => {
    const masterKey = Buffer.alloc(32, 7);
    const user = await store.createUser({ username: 'watcher', displayName: 'Watcher' });
    const dataKey = generateDataKey();
    const workspaceId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf2';
    const workspace = await store.createWorkspace({
      ...workspaceInput(user.id, 'Watch'),
      id: workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'watch-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/watch',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: encryptJson(
        { title: 'Watch the permit page' },
        dataKey,
        `task-title:${workspace.id}`
      ),
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler-watch');
    const runId = '00000000-0000-4000-8000-0000000000a1';
    await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-watch',
      taskId: runId,
      nextRunAt: new Date(Date.now() + 1_800_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });

    // Ninety-six times a day, this used to be a notification saying only that a timer had fired.
    await store.setTaskStatusForUser(user.id, runId, 'completed');
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    const raised = await store.createAgentNotification({
      userId: user.id,
      taskId: runId,
      kind: 'agent_message',
      messageCiphertext: encryptJson(
        { message: 'Three September slots opened on the permit page.' },
        dataKey,
        agentNotificationAad(runId)
      )
    });
    const pending = await store.listPendingNotifications(100, masterKey);
    expect(pending.map((item) => ({ kind: item.kind, resourceId: item.resourceId }))).toEqual([
      { kind: 'agent_message', resourceId: raised.id }
    ]);
    expect(pending[0]!.message).toBe('Three September slots opened on the permit page.');
    expect(pending[0]!.taskTitle).toBe('Watch the permit page');

    // Without the master key the row still routes the push and says nothing about its contents.
    const sealed = await store.listPendingNotifications();
    expect(sealed[0]!.message).toBeNull();
    expect(JSON.stringify(sealed)).not.toContain('September');

    await store.recordNotificationDelivery(
      (await store.listPendingNotifications())[0]!.id,
      'agent_message',
      raised.id
    );
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // A takeover is the agent stopped, so it goes ahead of news that merely happened.
    const takeover = await store.createAgentNotification({
      userId: user.id,
      taskId: runId,
      kind: 'takeover_needed',
      messageCiphertext: encryptJson(
        { message: 'A bot check is blocking the permit page.' },
        dataKey,
        agentNotificationAad(runId)
      )
    });
    await database.query(
      'UPDATE agent_notifications SET created_at=(SELECT completed_at FROM tasks WHERE id=$1) WHERE id=$2',
      [runId, takeover.id]
    );
    const manual = await store.createTask({
      ...taskInput(user.id, workspace.id),
      titleCiphertext: encryptJson({ title: 'By hand' }, dataKey, `task-title:${workspace.id}`)
    });
    await store.setTaskStatusForUser(user.id, manual.id, 'completed');
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(['takeover_needed', 'task_finished']);
  });

  it('keeps a standing record of everything the agent has said, whether or not it was pushed', async () => {
    const masterKey = Buffer.alloc(32, 9);
    const user = await store.createUser({ username: 'reader', displayName: 'Reader' });
    const dataKey = generateDataKey();
    const workspaceId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf3';
    const workspace = await store.createWorkspace({
      ...workspaceInput(user.id, 'Watching'),
      id: workspaceId,
      wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId)
    });
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      titleCiphertext: encryptJson({ title: 'Permit watch' }, dataKey, `task-title:${workspaceId}`)
    });
    const say = async (message: string) =>
      store.createAgentNotification({
        userId: user.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: encryptJson({ message }, dataKey, agentNotificationAad(task.id))
      });
    await say('Three September slots opened.');
    const newest = await say('They went again overnight.');

    // Newest first, and settled deliveries do not remove anything: a push having reached a phone
    // says nothing about whether the owner read it.
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'record-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/record',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    await store.recordNotificationDelivery(subscription.id, 'agent_message', newest.id);
    const read = await store.listAgentNotifications(user.id, 50, masterKey);
    expect(read.map((row) => row.message)).toEqual([
      'They went again overnight.',
      'Three September slots opened.'
    ]);
    expect(read[0]).toMatchObject({ kind: 'agent_message', taskTitle: 'Permit watch' });

    // Without the key the rows are still there and still say nothing.
    const sealed = await store.listAgentNotifications(user.id);
    expect(sealed.map((row) => row.message)).toEqual([null, null]);
    expect(JSON.stringify(sealed)).not.toContain('September');

    // Another account's conversations are not part of this owner's record.
    const stranger = await store.createUser({ username: 'elsewhere', displayName: 'Elsewhere' });
    await expect(store.listAgentNotifications(stranger.id, 50, masterKey)).resolves.toEqual([]);
  });

  it('bounds how many notifications one conversation can raise', async () => {
    const user = await store.createUser({ username: 'loop', displayName: 'Loop' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Loop'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    for (let raised = 0; raised < MAX_AGENT_NOTIFICATIONS_PER_TASK; raised += 1) {
      await store.createAgentNotification({
        userId: user.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: envelope
      });
    }
    await expect(
      store.createAgentNotification({
        userId: user.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: envelope
      })
    ).rejects.toThrow('notifications');
    await expect(
      database.query('SELECT COUNT(*) AS count FROM agent_notifications WHERE task_id=$1', [
        task.id
      ])
    ).resolves.toMatchObject({ rows: [{ count: MAX_AGENT_NOTIFICATIONS_PER_TASK }] });

    // A conversation belonging to somebody else is not a conversation to notify about.
    const stranger = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    await expect(
      store.createAgentNotification({
        userId: stranger.id,
        taskId: task.id,
        kind: 'agent_message',
        messageCiphertext: envelope
      })
    ).rejects.toThrow('Conversation not found');
  });

  it('tells the owner when a scheduled run breaks, and stops re-offering stale news', async () => {
    const user = await store.createUser({ username: 'broken', displayName: 'Broken' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Broken'));
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'broken-session',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://fcm.googleapis.com/fcm/send/broken',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler-broken');
    const runId = '00000000-0000-4000-8000-0000000000b1';
    await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-broken',
      taskId: runId,
      nextRunAt: new Date(Date.now() + 1_800_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    // Silence about a watcher that has stopped watching is the one silence that costs something.
    await store.setTaskStatusForUser(user.id, runId, 'failed');
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(['task_finished']);

    // A terminal task stays terminal, so without a horizon it would be offered forever and the
    // ledger row that settles it could never be pruned.
    await database.query(
      "UPDATE tasks SET completed_at=NOW()-INTERVAL '20 days', updated_at=NOW()-INTERVAL '20 days' WHERE id=$1",
      [runId]
    );
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    await store.recordNotificationDelivery(subscription.id, 'task_finished', runId);
    await database.query(
      "UPDATE notification_deliveries SET delivered_at=NOW()-INTERVAL '45 days'"
    );
    await store.cleanupExpired();
    await expect(
      database.query('SELECT COUNT(*) AS count FROM notification_deliveries')
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  /*
   * A run the box started on its own is not news, and the notifier has to be able to say so from
   * the conversation rather than from the ledger of due slots.
   *
   * `task_schedule_runs` is pruned - the same thirty days as the delivery ledger - and asking
   * `NOT EXISTS` of a pruned table means a scheduled run whose row has gone reads as a conversation
   * the owner started. Today that never happens only because the candidate horizon is fourteen days
   * and the prune is thirty, so a run has always fallen out of consideration before its row is
   * removed. That is an accident of two constants, not a property: a run that parks - `awaiting_user`
   * after an ask, or paused at a spend cap - and is resumed five weeks later completes inside the
   * fourteen-day window with its ledger row already gone, and the owner is told a task they never
   * started has finished. `tasks.schedule_id` answers it from the row itself and cannot be pruned.
   */
  it('still knows a resumed scheduled run was scheduled after its ledger row has been pruned', async () => {
    const user = await store.createUser({ username: 'watcher', displayName: 'Watcher' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Watching'));
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(
        user.id,
        'session-hash',
        new Date(Date.now() + 60_000)
      ),
      endpoint: 'https://push.example/resumed',
      p256dh: 'key-material-for-the-device',
      auth: 'auth-secret'
    });
    expect(subscription.endpoint).toContain('resumed');

    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 15 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler');
    const runId = '00000000-0000-4000-8000-0000000000c7';
    await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler',
      taskId: runId,
      nextRunAt: new Date(Date.now() + 900_000),
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    await store.setTaskStatusForUser(user.id, runId, 'completed');
    // The property while the ledger row is still there, which is what holds today.
    await expect(store.listPendingNotifications()).resolves.toEqual([]);

    // The run parked and was resumed five weeks later: `cleanupExpired` removed its ledger row
    // while it was parked, and the completion is fresh.
    await database.query(
      "UPDATE task_schedule_runs SET created_at=NOW()-INTERVAL '40 days' WHERE schedule_id=$1",
      [schedule.id]
    );
    await store.cleanupExpired();
    await expect(
      database.query('SELECT COUNT(*) AS count FROM task_schedule_runs')
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    expect((await store.getTask(user.id, runId))!.scheduleId).toBe(schedule.id);

    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('replaces the recovery code for an owner who still holds a passkey', async () => {
    const user = await store.createUser({
      username: 'lost-paper',
      displayName: 'Lost Paper',
      recoveryHash: await hashRecoveryCode('original-code')
    });
    await expect(
      store.setRecoveryHash(user.id, await hashRecoveryCode('replacement'))
    ).resolves.toBe(true);
    const stored = (await store.getUserByUsername('lost-paper'))!.recoveryHash!;
    await expect(verifyRecoveryCode('original-code', stored)).resolves.toBe(false);
    await expect(verifyRecoveryCode('replacement', stored)).resolves.toBe(true);
  });

  it('round-trips live catalogue enrichment, and leaves pre-enrichment rows undefined', async () => {
    const base = {
      id: 'openrouter/z-ai/glm-5.2',
      providerModelId: 'z-ai/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'openrouter',
      revision: 'openrouter-live',
      availability: 'available',
      openness: 'permissive_open_weight',
      license: 'MIT',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 200_000,
      modalities: ['text'],
      capabilities: ['chat', 'tools'],
      usageClass: 'high',
      recommendationTags: ['Tools'],
      measuredQuality: 0.7,
      measuredLatencyMs: 900,
      inputUsdPerMillionTokens: 4,
      outputUsdPerMillionTokens: 12,
      benchmarkRank: 3,
      benchmarkSource: 'artificial-analysis',
      benchmarkUpdatedAt: '2026-07-01T00:00:00.000Z'
    };
    await store.upsertModels([
      {
        ...base,
        agenticQuality: 0.81,
        codingQuality: 0.74,
        intelligenceQuality: 0.66,
        providerAvailable: true,
        zeroDataRetentionAvailable: false
      }
    ]);

    await expect(store.listModels()).resolves.toMatchObject([
      {
        id: base.id,
        agenticQuality: 0.81,
        codingQuality: 0.74,
        intelligenceQuality: 0.66,
        providerAvailable: true,
        zeroDataRetentionAvailable: false
      }
    ]);

    // The fields an unattended server routes on used to be written by one hand-kept list and read
    // back by another, so anything the two disagreed about was dropped in transit and the whole
    // routing layer ran on defaults it had never been told to use. They now share one contract.
    await store.upsertModels([
      {
        ...base,
        metadataSource: 'declared',
        promptCacheStyle: 'explicit',
        expiresAt: '2026-12-01T00:00:00.000Z',
        maxOutputTokens: 32_768,
        uptimeLast1dPercent: 99.4
      }
    ]);
    await expect(store.listModels()).resolves.toMatchObject([
      {
        id: base.id,
        metadataSource: 'declared',
        promptCacheStyle: 'explicit',
        expiresAt: '2026-12-01T00:00:00.000Z',
        maxOutputTokens: 32_768,
        uptimeLast1dPercent: 99.4
      }
    ]);

    // A row written before enrichment existed carries only the price and benchmark keys.
    await database.query(`UPDATE model_releases SET metadata=$1::jsonb`, [
      JSON.stringify({ inputUsdPerMillionTokens: 4, benchmarkRank: 3 })
    ]);
    const [legacy] = await store.listModels();
    expect(legacy).toMatchObject({ id: base.id, agenticQuality: null, codingQuality: null });
    expect(legacy).not.toHaveProperty('providerAvailable');
    expect(legacy).not.toHaveProperty('zeroDataRetentionAvailable');
  });

  it('applies every migration exactly once when two services migrate at the same moment', async () => {
    const shared = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    try {
      await Promise.all([migrateDatabase(shared), migrateDatabase(shared)]);
      const applied = await shared.query<{ version: number; applications: string }>(
        'SELECT version,COUNT(*) AS applications FROM schema_migrations GROUP BY version'
      );
      expect(applied.rows).toHaveLength(migrations.length);
      expect(applied.rows.filter((row) => Number(row.applications) !== 1)).toEqual([]);
    } finally {
      await shared.close();
    }
    // Migrating a second database inside one test file is minutes of embedded-PostgreSQL work on a
    // loaded machine; the ceiling is the suite's, not the default five seconds.
  }, 60_000);

  it('refuses to run against a database a newer build has already migrated', async () => {
    const newer = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    try {
      await migrateDatabase(newer);
      // What an update that migrated and was then rolled back by hand leaves behind: a schema this
      // build has never seen. Starting anyway is the expensive mistake, because an older build
      // writes rows that satisfy the constraints it remembers and nothing complains until later.
      const ahead = Math.max(...migrations.map((migration) => migration.version)) + 1;
      await newer.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [
        ahead,
        'from_a_newer_build'
      ]);
      await expect(migrateDatabase(newer)).rejects.toThrow(/migrated by a newer athanor/);
      await expect(migrateDatabase(newer)).rejects.toThrow(new RegExp(`version ${ahead}`));
    } finally {
      await newer.close();
    }
  }, 60_000);

  it('deletes an account and everything hanging off it', async () => {
    const owner = await store.createUser({ username: 'departing', displayName: 'Departing' });
    const workspace = await store.createWorkspace(workspaceInput(owner.id, 'Everything'));
    const task = await store.createTask(taskInput(owner.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Do it' });

    await expect(store.deleteUser(owner.id)).resolves.toBe(true);

    // The account is the root of the graph on a one-owner box, so nothing survives it: no orphan
    // workspace holding a wrapped key, and no transcript nobody can reach.
    for (const table of ['workspaces', 'workspace_keys', 'tasks', 'task_events'])
      await expect(
        database
          .query(`SELECT COUNT(*) AS count FROM ${table}`)
          .then((r) => Number(r.rows[0]!.count))
      ).resolves.toBe(0);
  });

  it('drops streamed deltas as soon as the message that closes them lands', async () => {
    const user = await store.createUser({ username: 'retention', displayName: 'Retention' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Long answers'));
    const live = await store.createTask(taskInput(user.id, workspace.id));
    const interrupted = await store.createTask(taskInput(user.id, workspace.id));
    const legacy = await store.createTask(taskInput(user.id, workspace.id));

    for (const summary of ['Thinking', 'Thinking again'])
      await store.appendTaskEvent({ taskId: live.id, kind: 'assistant_delta', summary });
    const closing = await store.appendTaskEvent({
      taskId: live.id,
      kind: 'assistant_message',
      summary: 'Answer'
    });
    // A second reply on the same still-running task streams and closes the same way.
    await store.appendTaskEvent({ taskId: live.id, kind: 'assistant_delta', summary: 'More' });
    await store.appendTaskEvent({ taskId: live.id, kind: 'user_message', summary: 'Follow-up' });

    await store.appendTaskEvent({
      taskId: interrupted.id,
      kind: 'assistant_delta',
      summary: 'Thinking'
    });
    await database.query("UPDATE tasks SET status='failed' WHERE id=$1", [interrupted.id]);

    // Rows a previous version of the writer left behind still need the retention sweep.
    for (const [sequence, kind] of [
      [1, 'assistant_delta'],
      [2, 'assistant_delta'],
      [3, 'assistant_message']
    ] as const)
      await database.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary)
         VALUES (gen_random_uuid(),$1,$2,$3,'Encrypted event')`,
        [legacy.id, sequence, kind]
      );
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [legacy.id]);

    const kinds = async (taskId: string): Promise<string[]> =>
      (await store.listTaskEvents(taskId)).map((event) => event.kind);
    // The task is still running and its deltas are already gone: the closing message is the
    // authoritative text, so replaying the superseded snapshots would only cost bytes.
    await expect(kinds(live.id)).resolves.toEqual([
      'assistant_message',
      'assistant_delta',
      'user_message'
    ]);
    expect(closing.sequence).toBe(3);
    // Nothing superseded this one: the partial answer is all the failed task ever produced.
    await expect(kinds(interrupted.id)).resolves.toEqual(['assistant_delta']);

    await store.cleanupExpired();
    await expect(kinds(legacy.id)).resolves.toEqual(['assistant_message']);
    await expect(kinds(interrupted.id)).resolves.toEqual(['assistant_delta']);
  });

  it('drops the thinking frames as soon as the row carrying the whole of it lands', async () => {
    const user = await store.createUser({ username: 'thinker', displayName: 'Thinker' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Long thoughts'));
    const task = await store.createTask(taskInput(user.id, workspace.id));

    for (const summary of ['Consider', 'Reconsider'])
      await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_reasoning', summary });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_reasoning',
      summary: 'All of it',
      replacesEarlierFrames: true
    });
    // Unlike the answer, the thinking has no closing row of another kind to supersede its frames,
    // so nothing pruned them and a high-effort turn left hundreds behind for good.
    const summaries = async (): Promise<string[]> =>
      (await store.listTaskEvents(task.id)).map((event) => event.summary);
    await expect(summaries()).resolves.toEqual(['All of it']);

    // The next step thinks, and closes its own thinking the same way. What it carries is its own
    // run, so the step that already closed has to survive it: the consolidating row is the same
    // kind as the frames, and taking every earlier one would leave a long task holding only the
    // thinking of whichever step ran last.
    await store.appendTaskEvent({ taskId: task.id, kind: 'tool_result', summary: 'Read it' });
    await store.appendTaskEvent({ taskId: task.id, kind: 'assistant_reasoning', summary: 'More' });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_reasoning',
      summary: 'All of that too',
      replacesEarlierFrames: true
    });
    await expect(summaries()).resolves.toEqual(['All of it', 'Read it', 'All of that too']);
  });

  it('serves a task timeline as bounded pages in both directions', async () => {
    const user = await store.createUser({ username: 'pager', displayName: 'Pager' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Busy'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(
      `INSERT INTO task_events(id,task_id,sequence,kind,summary)
       SELECT gen_random_uuid(), $1, g, 'tool_result', 'Encrypted event'
       FROM generate_series(1, 450) g`,
      [task.id]
    );

    // Opening the task costs a page, not the 450-event history it happens to have.
    const newest = await store.listRecentTaskEvents(task.id, 100);
    expect(newest.events).toHaveLength(100);
    expect(newest.events[0]!.sequence).toBe(351);
    expect(newest.oldestSequence).toBe(351);
    expect(newest.nextCursor).toBe(450);
    expect(newest.hasMore).toBe(true);

    // The HTTP cursor accepts safe JavaScript integers even when the stored sequence is int4.
    const wideCursor = await store.listTaskEventPage(task.id, {
      before: Number.MAX_SAFE_INTEGER,
      limit: 100
    });
    expect(wideCursor).toEqual(newest);
    expect(
      await store.listTaskEventPage(task.id, { after: Number.MAX_SAFE_INTEGER, limit: 100 })
    ).toEqual({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: Number.MAX_SAFE_INTEGER
    });
    expect(await store.listTaskEvents(task.id, Number.MAX_SAFE_INTEGER)).toEqual([]);

    // Older material is reachable on demand, oldest first however it was fetched.
    const older = await store.listTaskEventPage(task.id, {
      before: newest.oldestSequence!,
      limit: 100
    });
    expect(older.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => 251 + index)
    );
    expect(older.hasMore).toBe(true);

    // Forward paging from a cursor is what the live stream resumes with.
    const forward = await store.listTaskEventPage(task.id, { after: 440, limit: 100 });
    expect(forward.events).toHaveLength(10);
    expect(forward.hasMore).toBe(false);
    expect(forward.nextCursor).toBe(450);

    // A page is never unbounded, whatever it is asked for.
    const capped = await store.listTaskEventPage(task.id, { limit: 10_000 });
    expect(capped.events.length).toBeLessThanOrEqual(500);

    const empty = await store.listRecentTaskEvents(
      (await store.createTask(taskInput(user.id, workspace.id))).id
    );
    expect(empty).toEqual({ events: [], hasMore: false, oldestSequence: null, nextCursor: 0 });
  });

  it('prunes a withdrawn model and never empties the catalogue on a failed refresh', async () => {
    const release = (id: string, provider: string): Record<string, unknown> => ({
      id,
      providerModelId: id.split('/').slice(1).join('/'),
      displayName: id,
      provider,
      revision: 'r1',
      availability: 'available',
      openness: 'remote_proprietary',
      license: 'Provider-defined',
      commercialUse: true,
      privacyRoute: 'external',
      contextTokens: 128_000,
      modalities: ['text'],
      capabilities: ['chat'],
      usageClass: 'medium',
      recommendationTags: [],
      measuredQuality: null,
      measuredLatencyMs: null
    });
    await store.upsertModels([
      release('openrouter/vendor/kept', 'openrouter'),
      release('openrouter/vendor/withdrawn', 'openrouter'),
      release('custom/local-model', 'custom')
    ]);

    const refreshed = await store.replaceModelCatalog([
      release('openrouter/vendor/kept', 'openrouter'),
      release('openrouter/vendor/new', 'openrouter')
    ]);
    expect(refreshed).toEqual({ upserted: 2, removed: 1, retired: 0 });
    // The withdrawn model is gone; a provider the refresh said nothing about is untouched.
    await expect(
      store.listModels().then((models) => models.map((model) => model.id))
    ).resolves.toEqual(['custom/local-model', 'openrouter/vendor/kept', 'openrouter/vendor/new']);

    // A provider outage returns nothing, and nothing is what it is allowed to remove.
    await expect(store.replaceModelCatalog([])).resolves.toEqual({
      upserted: 0,
      removed: 0,
      retired: 0
    });
    await expect(store.listModels()).resolves.toHaveLength(3);
  });

  it('retires rather than deletes a withdrawn model something is still pinned to', async () => {
    const user = await store.createUser({ username: 'pinner', displayName: 'Pinner' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Pinned room'));
    const release = (id: string): Record<string, unknown> => ({
      id,
      providerModelId: id.split('/').slice(1).join('/'),
      displayName: id,
      provider: 'openrouter',
      revision: 'r1',
      availability: 'available',
      openness: 'remote_proprietary',
      license: 'Provider-defined',
      commercialUse: true,
      privacyRoute: 'external',
      contextTokens: 128_000,
      modalities: ['text'],
      capabilities: ['chat'],
      usageClass: 'medium',
      recommendationTags: [],
      measuredQuality: null,
      measuredLatencyMs: null
    });
    await store.upsertModels([
      release('openrouter/vendor/scheduled'),
      release('openrouter/vendor/running'),
      release('openrouter/vendor/finished'),
      release('openrouter/vendor/survivor')
    ]);
    await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'i', tag: 't', ciphertext: 'c' },
      promptCiphertext: { v: 1, iv: 'i', tag: 't', ciphertext: 'c' },
      modelId: 'openrouter/vendor/scheduled',
      privacyRoute: 'external',
      maxComputeCredits: 10,
      spec: { kind: 'daily', timeZone: 'UTC', localTime: '09:30' },
      nextRunAt: new Date(Date.now() + 3_600_000)
    });
    const live = await store.createTask({
      ...taskInput(user.id, workspace.id),
      modelId: 'openrouter/vendor/running'
    });
    const done = await store.createTask({
      ...taskInput(user.id, workspace.id),
      modelId: 'openrouter/vendor/finished'
    });
    await store.updateTask({ id: done.id, status: 'completed' });
    expect(live.status).not.toBe('completed');

    // The provider now offers only one of the four.
    const refreshed = await store.replaceModelCatalog([release('openrouter/vendor/survivor')]);
    expect(refreshed).toEqual({ upserted: 1, removed: 1, retired: 2 });
    const after = await store.listModels();
    expect(after.map((model) => [model.id, model.availability])).toEqual([
      ['openrouter/vendor/running', 'unavailable'],
      ['openrouter/vendor/scheduled', 'unavailable'],
      ['openrouter/vendor/survivor', 'available']
    ]);

    // And when the provider brings one back it is live again, not a permanent tombstone.
    await store.replaceModelCatalog([
      release('openrouter/vendor/survivor'),
      release('openrouter/vendor/scheduled')
    ]);
    await expect(
      store
        .listModels()
        .then((models) => models.find((model) => model.id === 'openrouter/vendor/scheduled'))
    ).resolves.toMatchObject({ availability: 'available' });
  });

  /*
   * The tier that follows the person rather than the computer.
   *
   * `workspace_memories.target` has had a `'user'` value since migration 30, a label reading
   * "About you, everywhere" and an approval card promising it was loaded into every workspace. All
   * of it was false, because the only reader was `WHERE m.workspace_id=$2`. These tests are the
   * ones that were missing: each of them fails against the old statement, and each attacks the new
   * bound from the side that would let a row out of its scope as well as the side that would trap
   * it in one.
   */
  describe('memory that belongs to the owner rather than to a computer', () => {
    const envelope = (marker: string) => ({
      v: 1 as const,
      iv: 'iv',
      tag: 'tag',
      ciphertext: marker
    });

    it('is readable from a second computer, while that computer keeps its own notes to itself', async () => {
      const user = await store.createUser({ username: 'two-boxes', displayName: 'Owner' });
      const first = await store.createWorkspace(workspaceInput(user.id, 'First'));
      const second = await store.createWorkspace(workspaceInput(user.id, 'Second'));
      const owned = await store.createOwnerMemory({
        userId: user.id,
        maxRows: OWNER_MEMORY_MAX_ROWS,
        contentCiphertext: envelope('about-the-person')
      });
      const local = await store.createWorkspaceMemory({
        userId: user.id,
        workspaceId: first.id,
        target: 'workspace',
        contentCiphertext: envelope('about-the-first-box')
      });

      const fromFirst = await store.listWorkspaceMemories(user.id, first.id);
      const fromSecond = await store.listWorkspaceMemories(user.id, second.id);
      expect(fromFirst.map((record) => record.id).sort()).toEqual([owned!.id, local.id].sort());
      // Both directions. The owner row crosses; the workspace row does not, which is the half a
      // widened `WHERE` would have broken while looking like it worked.
      expect(fromSecond.map((record) => record.id)).toEqual([owned!.id]);
      expect(owned!.workspaceId).toBeNull();
      expect(owned!.keyScope).toBe('user');
      expect(local.keyScope).toBe('workspace');
    });

    it('does not reach another account, and does not reach a workspace the caller does not own', async () => {
      const owner = await store.createUser({ username: 'owner-a', displayName: 'A' });
      const stranger = await store.createUser({ username: 'owner-b', displayName: 'B' });
      const mine = await store.createWorkspace(workspaceInput(owner.id, 'Mine'));
      const theirs = await store.createWorkspace(workspaceInput(stranger.id, 'Theirs'));
      await store.createOwnerMemory({
        userId: owner.id,
        maxRows: OWNER_MEMORY_MAX_ROWS,
        contentCiphertext: envelope('mine-only')
      });
      await store.createWorkspaceMemory({
        userId: stranger.id,
        workspaceId: theirs.id,
        target: 'workspace',
        contentCiphertext: envelope('not-mine')
      });

      // The authorisation moved from the workspace join to `user_id`; this is the proof it did not
      // move to nothing. A second account sees none of it, and naming somebody else's workspace
      // returns neither their rows nor - the subtler failure - the caller's own owner tier.
      await expect(store.listWorkspaceMemories(stranger.id, theirs.id)).resolves.toMatchObject([
        { keyScope: 'workspace' }
      ]);
      await expect(store.listWorkspaceMemories(stranger.id, mine.id)).resolves.toEqual([]);
    });

    it('outlives the computer it was written from', async () => {
      const user = await store.createUser({ username: 'outlives', displayName: 'Owner' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Doomed'));
      const owned = await store.createOwnerMemory({
        userId: user.id,
        maxRows: OWNER_MEMORY_MAX_ROWS,
        contentCiphertext: envelope('still-here')
      });
      await store.createWorkspaceMemory({
        userId: user.id,
        workspaceId: workspace.id,
        target: 'workspace',
        contentCiphertext: envelope('goes-with-it')
      });

      await store.deleteWorkspace(user.id, workspace.id);

      // `workspace_id` is `ON DELETE CASCADE`, so before migration 70 this row went with the
      // computer - the tier that claimed to follow the owner everywhere was destroyed by "Delete
      // this computer". A NULL cannot be cascaded over.
      const replacement = await store.createWorkspace(workspaceInput(user.id, 'Rebuilt'));
      const surviving = await store.listWorkspaceMemories(user.id, replacement.id);
      expect(surviving.map((record) => record.id)).toEqual([owned!.id]);
      expect(surviving[0]!.contentCiphertext.ciphertext).toBe('still-here');
    });

    it('refuses the seventeenth row and evicts none of the sixteen', async () => {
      const user = await store.createUser({ username: 'bounded', displayName: 'Owner' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Box'));
      for (let index = 0; index < OWNER_MEMORY_MAX_ROWS; index += 1)
        expect(
          await store.createOwnerMemory({
            userId: user.id,
            maxRows: OWNER_MEMORY_MAX_ROWS,
            contentCiphertext: envelope(`row-${index}`)
          })
        ).not.toBeNull();
      const before = await store.listWorkspaceMemories(user.id, workspace.id);
      const fingerprint = sha256(JSON.stringify(before.map((record) => record.contentCiphertext)));

      await expect(
        store.createOwnerMemory({
          userId: user.id,
          maxRows: OWNER_MEMORY_MAX_ROWS,
          contentCiphertext: envelope('one-too-many')
        })
      ).resolves.toBeNull();

      // Refused, not made room for. The tier the owner cannot watch is the one that must never
      // drop a row quietly, so the bound is proved by what is still there byte for byte as well as
      // by the count.
      const after = await store.listWorkspaceMemories(user.id, workspace.id);
      expect(after).toHaveLength(OWNER_MEMORY_MAX_ROWS);
      expect(sha256(JSON.stringify(after.map((record) => record.contentCiphertext)))).toBe(
        fingerprint
      );
      await expect(store.countOwnerMemories(user.id)).resolves.toBe(OWNER_MEMORY_MAX_ROWS);
    });

    /**
     * The tier's second entrance, which had no bound on it at all.
     *
     * `createOwnerMemory` carries the row bound in its INSERT, and promotion is not an insert: it
     * is an `UPDATE` that moves a legacy `target:'user'` row - the shape a running turn could
     * write before this build - into the same tier. Driven against this database with the bound
     * only on the INSERT, forty promotions left the tier holding 56 rows against a bound of 16,
     * after which every honest write was refused for the rest of the account's life while the
     * character budget still read as nearly empty.
     *
     * So the promotion is attacked here from both ends: it fills the tier to the bound and then
     * proves the seventeenth promotion is refused, with the sixteen unchanged byte for byte.
     */
    it('charges a promotion the same row bound an insert pays', async () => {
      const user = await store.createUser({ username: 'promoter', displayName: 'Owner' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Box'));
      // The shape the `memory` tool wrote while it could still pass `target` through: an owner-tier
      // row filed under a workspace and sealed under that workspace's key.
      const legacy: string[] = [];
      for (let index = 0; index < OWNER_MEMORY_MAX_ROWS + 4; index += 1) {
        const id = randomUUID();
        await database.query(
          `INSERT INTO workspace_memories(id,user_id,workspace_id,target,key_scope,content_ciphertext)
           VALUES ($1,$2,$3,'user','workspace',$4::jsonb)`,
          [id, user.id, workspace.id, JSON.stringify(envelope(`legacy-${index}`))]
        );
        legacy.push(id);
      }

      const promote = async (id: string) =>
        store.updateWorkspaceMemory({
          id,
          userId: user.id,
          workspaceId: workspace.id,
          keyScope: 'user',
          maxOwnerRows: OWNER_MEMORY_MAX_ROWS,
          contentCiphertext: envelope(`promoted-${id.slice(0, 8)}`)
        });

      for (const id of legacy.slice(0, OWNER_MEMORY_MAX_ROWS))
        expect((await promote(id))?.keyScope).toBe('user');
      await expect(store.countOwnerMemories(user.id)).resolves.toBe(OWNER_MEMORY_MAX_ROWS);

      const before = await store.listWorkspaceMemories(user.id, workspace.id);
      const fingerprint = sha256(
        JSON.stringify(
          before
            .filter((record) => record.keyScope === 'user')
            .map((record) => record.contentCiphertext)
        )
      );
      for (const id of legacy.slice(OWNER_MEMORY_MAX_ROWS))
        await expect(promote(id)).resolves.toBeNull();

      // Still sixteen, still the same sixteen, and the rows that were refused are still in the
      // workspace tier where they were - a refused promotion moves nothing rather than half of it.
      await expect(store.countOwnerMemories(user.id)).resolves.toBe(OWNER_MEMORY_MAX_ROWS);
      const after = await store.listWorkspaceMemories(user.id, workspace.id);
      expect(
        sha256(
          JSON.stringify(
            after
              .filter((record) => record.keyScope === 'user')
              .map((record) => record.contentCiphertext)
          )
        )
      ).toBe(fingerprint);
      expect(
        after.filter((record) => record.keyScope === 'workspace' && record.target === 'user')
      ).toHaveLength(4);

      // And the bound is charged on entry, not on every edit: a row already inside the tier is
      // rewritten while the tier is full.
      const resident = after.find((record) => record.keyScope === 'user')!;
      await expect(
        store.updateWorkspaceMemory({
          id: resident.id,
          userId: user.id,
          workspaceId: workspace.id,
          keyScope: 'user',
          maxOwnerRows: OWNER_MEMORY_MAX_ROWS,
          contentCiphertext: envelope('rewritten-in-place')
        })
      ).resolves.not.toBeNull();
      await expect(store.countOwnerMemories(user.id)).resolves.toBe(OWNER_MEMORY_MAX_ROWS);
    });

    it('cannot be written by the path a running turn reaches', async () => {
      const user = await store.createUser({ username: 'no-turn-writes', displayName: 'Owner' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Box'));
      // The type already refuses this; the cast is what a JavaScript caller, a test double or a
      // future `as` would do, and the gate has to hold at the production call site rather than at
      // the compiler. `apps/worker/src/tools/knowledge.ts` is that call site.
      await expect(
        store.createWorkspaceMemory({
          userId: user.id,
          workspaceId: workspace.id,
          target: 'user' as 'workspace',
          contentCiphertext: envelope('smuggled')
        })
      ).rejects.toThrow(/owner tier/i);
      await expect(store.countOwnerMemories(user.id)).resolves.toBe(0);
    });

    it('lets the owner delete a row of theirs from whichever computer they have open', async () => {
      const user = await store.createUser({ username: 'deletes', displayName: 'Owner' });
      const first = await store.createWorkspace(workspaceInput(user.id, 'First'));
      const second = await store.createWorkspace(workspaceInput(user.id, 'Second'));
      const owned = await store.createOwnerMemory({
        userId: user.id,
        maxRows: OWNER_MEMORY_MAX_ROWS,
        contentCiphertext: envelope('regrettable')
      });

      // The old `DELETE ... WHERE workspace_id=$2` could not match a row whose workspace id is
      // NULL, so a tier the owner can see and cannot remove would have been the worse half of
      // shipping this.
      await expect(store.deleteWorkspaceMemory(user.id, second.id, owned!.id)).resolves.toBe(true);
      await expect(store.listWorkspaceMemories(user.id, first.id)).resolves.toEqual([]);
    });

    it('will not let a row be sealed under one scope and filed under the other', async () => {
      const user = await store.createUser({ username: 'constrained', displayName: 'Owner' });
      const workspace = await store.createWorkspace(workspaceInput(user.id, 'Box'));
      // The constraint added in migration 70, attacked directly. A `key_scope='user'` row carrying
      // a workspace id would be encrypted under one key, reachable through another, and deleted by
      // the cascade it was supposed to have escaped.
      await expect(
        database.query(
          `INSERT INTO workspace_memories(id,user_id,workspace_id,target,key_scope,content_ciphertext)
           VALUES ($1,$2,$3,'user','user',$4::jsonb)`,
          [randomUUID(), user.id, workspace.id, JSON.stringify(envelope('inconsistent'))]
        )
      ).rejects.toThrow();
      await expect(
        database.query(
          `INSERT INTO workspace_memories(id,user_id,workspace_id,target,key_scope,content_ciphertext)
           VALUES ($1,$2,NULL,'workspace','workspace',$3::jsonb)`,
          [randomUUID(), user.id, JSON.stringify(envelope('homeless'))]
        )
      ).rejects.toThrow();
    });
  });

  it('drops memories whose expiry passed long ago and keeps the rest', async () => {
    const user = await store.createUser({ username: 'memory-keeper', displayName: 'Keeper' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Memory room'));
    const memory = (validUntil?: string): Parameters<DataStore['createWorkspaceMemory']>[0] => ({
      userId: user.id,
      workspaceId: workspace.id,
      target: 'workspace',
      contentCiphertext: { v: 1, iv: 'memory', tag: 'tag', ciphertext: 'cipher' },
      ...(validUntil === undefined ? {} : { validUntil })
    });
    const day = 24 * 60 * 60 * 1000;
    const stale = await store.createWorkspaceMemory(
      memory(new Date(Date.now() - 120 * day).toISOString())
    );
    const recentlyExpired = await store.createWorkspaceMemory(
      memory(new Date(Date.now() - day).toISOString())
    );
    const evergreen = await store.createWorkspaceMemory(memory());
    expect(recentlyExpired.validUntil).not.toBeNull();
    expect(evergreen.validUntil).toBeNull();

    await store.cleanupExpired();

    const remaining = await store.listWorkspaceMemories(user.id, workspace.id);
    expect(remaining.map((record) => record.id).sort()).toEqual(
      [recentlyExpired.id, evergreen.id].sort()
    );
    expect(remaining.map((record) => record.id)).not.toContain(stale.id);
  });

  /**
   * Three tables nothing ever swept. A watcher on a quarter-hour writes a schedule run every
   * fifteen minutes for as long as the box is owned, and the owner is also the operator: nobody
   * else is going to notice the disk.
   */
  it('gives a horizon to the three records that used to be kept forever', async () => {
    const user = await store.createUser({ username: 'housekeeper', displayName: 'Housekeeper' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Main'));
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 15 },
      nextRunAt: new Date(Date.now() - 60_000)
    });
    const connector = await store.createConnector({
      id: '00000000-0000-4000-8000-0000000000c1',
      userId: user.id,
      kind: 'webdav',
      authMode: 'secret',
      label: 'Files',
      baseUrl: 'https://files.example/dav',
      scopes: ['webdav:files.read'],
      secretCiphertext: envelope
    });

    const runs: string[] = [];
    for (const runId of [
      '00000000-0000-4000-8000-0000000000d1',
      '00000000-0000-4000-8000-0000000000d2'
    ]) {
      await store.leaseDueTaskSchedule('scheduler');
      await store.materializeTaskSchedule({
        scheduleId: schedule.id,
        workerId: 'scheduler',
        taskId: runId,
        nextRunAt: new Date(Date.now() - 60_000),
        resourceClass: 'medium',
        preparingEventCiphertext: envelope,
        failureEventCiphertext: envelope
      });
      await store.createAgentNotification({
        userId: user.id,
        taskId: runId,
        kind: 'agent_message',
        messageCiphertext: envelope
      });
      await store.recordConnectorAudit({
        connectorId: connector.id,
        userId: user.id,
        taskId: runId,
        operation: 'GET /calendar.ics',
        outcome: 'succeeded'
      });
      runs.push(runId);
    }

    const count = async (table: string): Promise<number> =>
      Number((await database.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0]?.count ?? 0);
    const age = async (table: string, column: string, days: number): Promise<unknown> =>
      database.query(
        `UPDATE ${table} SET created_at=NOW() - ($2 * INTERVAL '1 day') WHERE ${column}=$1`,
        [runs[0], days]
      );

    // Each one is aged past its own horizon and no further, so this fails if a horizon moves.
    await age('task_schedule_runs', 'task_id', 31);
    await age('agent_notifications', 'task_id', 91);
    await age('connector_audit_events', 'task_id', 31);

    await store.cleanupExpired();

    for (const table of ['task_schedule_runs', 'agent_notifications', 'connector_audit_events'])
      expect(await count(table), table).toBe(1);
    // The conversation each run produced is not a record of the run and is not swept with it: the
    // sidebar groups these by the schedule the task itself names.
    await expect(store.getTask(user.id, runs[0]!)).resolves.toMatchObject({
      scheduleId: schedule.id
    });
    // And the ledger the owner's money reconciles against is not a retention question at all.
    await expect(count('usage_entries')).resolves.toBe(2);
  });

  it('bounds the backfills the API runs before it serves traffic', async () => {
    const user = await store.createUser({ username: 'backfill', displayName: 'Backfill' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Legacy room'));
    for (const title of ['First', 'Second', 'Third']) {
      const task = await store.createTask(taskInput(user.id, workspace.id));
      await database.query('UPDATE tasks SET title=$2 WHERE id=$1', [task.id, title]);
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'status',
        summary: `plaintext ${title}`
      });
    }

    await expect(store.listLegacyTaskTitles(2)).resolves.toHaveLength(2);
    await expect(store.listLegacyTaskTitles()).resolves.toHaveLength(3);

    // One batch of one row cannot finish three, and the caller is told so rather than the store
    // silently walking the whole table.
    await expect(store.scrubLegacyContentSummaries(1, 1)).resolves.toBe(true);
    const scrubbed = await database.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM task_events WHERE summary NOT LIKE 'Encrypted % event'`
    );
    expect(Number(scrubbed.rows[0]?.count)).toBe(2);
    await expect(store.scrubLegacyContentSummaries()).resolves.toBe(false);
    await expect(
      database.query(`SELECT id FROM task_events WHERE summary NOT LIKE 'Encrypted % event'`)
    ).resolves.toMatchObject({ rows: [] });
  });
  it('redeems a device grant exactly once and honours expiry and revocation', async () => {
    const user = await store.createUser({ username: 'owner-dev', displayName: 'Owner' });

    const granted = await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'grant-hash-1',
      label: 'Phone',
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    expect(granted.id).toBeTruthy();

    // First redemption wins.
    await expect(store.consumeDeviceEnrollment('grant-hash-1')).resolves.toEqual({
      userId: user.id
    });
    // A second device scanning the same code must not also get in.
    await expect(store.consumeDeviceEnrollment('grant-hash-1')).resolves.toBeNull();

    // Expiry is enforced independently of consumption.
    await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'grant-hash-2',
      label: 'Laptop',
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    await database.query(
      "UPDATE device_enrollments SET expires_at = NOW() - INTERVAL '1 second' WHERE token_hash='grant-hash-2'"
    );
    await expect(store.consumeDeviceEnrollment('grant-hash-2')).resolves.toBeNull();

    // Revoking a pending grant makes a photographed code useless.
    const revocable = await store.createDeviceEnrollment({
      userId: user.id,
      tokenHash: 'grant-hash-3',
      label: 'Tablet',
      expiresAt: new Date(Date.now() + 10 * 60_000)
    });
    await expect(store.revokeDeviceEnrollment(user.id, revocable.id)).resolves.toBe(true);
    await expect(store.consumeDeviceEnrollment('grant-hash-3')).resolves.toBeNull();
    // Revoking twice is not an error, but reports that nothing changed.
    await expect(store.revokeDeviceEnrollment(user.id, revocable.id)).resolves.toBe(false);

    // An unknown token never resolves to an account.
    await expect(store.consumeDeviceEnrollment('never-issued')).resolves.toBeNull();

    const listed = await store.listDeviceEnrollments(user.id);
    expect(listed.map((entry) => entry.status).sort()).toEqual(['expired', 'revoked', 'used']);
  });
});

describe('tiered agent memory', () => {
  let database: Database;
  let store: DataStore;
  let memory: MemoryStore;
  let userId: string;
  let workspaceId: string;

  const key = memoryIndexKey(Buffer.alloc(32, 7));
  const now = new Date('2026-07-31T08:00:00.000Z');
  const at = (days: number): Date => new Date(now.getTime() - days * 86_400_000);
  const sealed = (value: string): EncryptedEnvelope => ({
    v: 1,
    iv: 'iv',
    tag: 'tag',
    ciphertext: Buffer.from(value, 'utf8').toString('base64')
  });
  const opened = (envelope: EncryptedEnvelope): string =>
    Buffer.from(envelope.ciphertext, 'base64').toString('utf8');

  const addItem = async (
    kind: MemoryKind,
    content: MemoryItemContent,
    extra: Partial<Parameters<DataStore['createMemoryItem']>[0]> = {}
  ) =>
    store.createMemoryItem({
      userId,
      workspaceId,
      kind,
      trust: 'stated',
      documentCiphertext: sealed(content.body),
      index: buildMemoryItemIndex(content, key),
      observedAt: now,
      validFrom: now,
      ...extra
    });

  const addSource = async (body: string, occurredAt: Date = now, locator?: string) => {
    const index = buildMemorySourceIndex(body, key);
    return store.createMemorySource({
      userId,
      workspaceId,
      channel: 'terminal',
      bodyCiphertext: sealed(body),
      bodyTokens: index.bodyTokens,
      tokensEst: index.tokensEst,
      indexed: index.indexed,
      occurredAt,
      ...(locator
        ? { originCiphertext: sealed(locator), originKey: memoryOriginKey(locator, key) }
        : {})
    });
  };

  const recall = async (query: string, options: Partial<RecallMemoryInput> = {}) =>
    store.recallMemoryCandidates({
      workspaceId,
      plan: planMemoryQuery(query, key),
      now,
      ...options
    });

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    memory = new MemoryStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'computer'));
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  it('runs the whole lexical floor with no extensions installed', async () => {
    // PGlite ships without pg_trgm, which is exactly the degraded case the design requires to keep
    // working: fuzzy recall and fused ranking must not need it.
    await expect(memory.memoryCapabilities()).resolves.toEqual({ trigram: false });

    await addItem(
      'fact',
      {
        title: 'default shell',
        body: 'The owner uses fish on this computer.',
        subject: 'owner',
        object: 'fish'
      },
      { predicate: 'default_shell' }
    );
    await addItem('episode', {
      title: 'Rotated the certificate',
      body: 'Renewed the TLS certificate and reloaded nginx.'
    });

    const hits = await recall('which shell does the owner use');
    expect(hits.map((hit) => opened(hit.documentCiphertext))).toEqual([
      'The owner uses fish on this computer.'
    ]);
  });

  it('fuses lexical, fuzzy, structural and verbatim channels into one ranked result', async () => {
    await addItem(
      'fact',
      {
        title: 'preview port',
        body: 'The preview gateway listens on 8443.',
        subject: 'preview gateway',
        object: '8443'
      },
      { predicate: 'runs_on' }
    );
    await addItem('episode', {
      title: 'Restarted athanor',
      body: 'Ran systemctl restart athanor.target after the deploy.'
    });
    await addItem('procedure', {
      title: 'Deploy athanor',
      tags: ['deploy', 'athanor'],
      body: 'pnpm build then systemctl restart athanor.target'
    });
    await addSource('$ systemctl restart athanor.target\nJob for athanor.target succeeded.');
    await addItem('episode', { title: 'Wrote the brief', body: 'Edited PREFERENCES.md by hand.' });

    const hits = await recall('restart athanor.target after a deploy');
    const bodies = hits.map((hit) => opened(hit.documentCiphertext));
    expect(hits.map((hit) => hit.layer)).toContain('source');
    expect(bodies).toContain('pnpm build then systemctl restart athanor.target');
    expect(bodies).toContain('Ran systemctl restart athanor.target after the deploy.');
    // The unrelated episode never entered the candidate set at all.
    expect(bodies).not.toContain('Edited PREFERENCES.md by hand.');
    // Ordering is deterministic (kind, id), never by score - that is what the cached prefix needs.
    const rank = (hit: (typeof hits)[number]) => `${MEMORY_KINDS.indexOf(hit.kind)}:${hit.id}`;
    expect(hits.map(rank)).toEqual([...hits.map(rank)].sort());
    expect(hits.every((hit) => hit.score > 0)).toBe(true);
  });

  it('prefers a stated recent fact over an old derived one carrying the same words', async () => {
    const fresh = await addItem(
      'fact',
      {
        title: 'backup target',
        body: 'Backups go to the encrypted volume.',
        subject: 'backups',
        object: 'encrypted volume'
      },
      { trust: 'stated', predicate: 'located_at', observedAt: at(2), validFrom: at(2) }
    );
    const stale = await addItem(
      'fact',
      {
        title: 'backup target',
        body: 'Backups go to the encrypted disk instead.',
        subject: 'backups',
        object: 'encrypted disk'
      },
      { trust: 'derived', predicate: 'located_at', observedAt: at(900), validFrom: at(900) }
    );

    const hits = await recall('where do the backups go');
    const scores = new Map(hits.map((hit) => [hit.id, hit.score]));
    expect(scores.get(fresh.id)!).toBeGreaterThan(scores.get(stale.id)!);
  });

  it('supersedes a functional fact instead of deleting it and keeps it reachable as of a date', async () => {
    const first = await store.recordMemoryFact({
      userId,
      workspaceId,
      trust: 'stated',
      predicate: 'default_shell',
      documentCiphertext: sealed('owner default_shell fish'),
      index: buildMemoryItemIndex(
        { title: 'default shell', body: 'The owner uses fish.', subject: 'owner', object: 'fish' },
        key
      ),
      observedAt: at(30),
      validFrom: at(30)
    });
    expect(first.supersededIds).toEqual([]);

    const second = await store.recordMemoryFact({
      userId,
      workspaceId,
      trust: 'stated',
      predicate: 'default_shell',
      documentCiphertext: sealed('owner default_shell zsh'),
      index: buildMemoryItemIndex(
        {
          title: 'default shell',
          body: 'The owner uses zsh now.',
          subject: 'owner',
          object: 'zsh'
        },
        key
      ),
      observedAt: at(1),
      validFrom: at(1)
    });
    expect(second.supersededIds).toEqual([first.item.id]);

    // Retired, not removed: status, valid_to and a supersedes link all record what happened.
    const retired = await store.getMemoryItem(workspaceId, first.item.id);
    expect(retired?.status).toBe('superseded');
    expect(retired?.validTo).toBe(at(1).toISOString());
    expect(retired?.retiredAt).not.toBeNull();
    await expect(memory.listMemoryLinks(second.item.id)).resolves.toEqual([
      expect.objectContaining({ srcId: second.item.id, dstId: first.item.id, rel: 'supersedes' })
    ]);

    // A present-tense question gets the current value only.
    const present = await recall('which shell does the owner use');
    expect(present.map((hit) => hit.id)).toEqual([second.item.id]);

    // "What did I use before?" reaches the retired one, and as_of answers it exactly.
    const past = await recall('which shell did the owner use previously', {
      includeSuperseded: true
    });
    expect(past.map((hit) => hit.id).sort()).toEqual([first.item.id, second.item.id].sort());
    const asOf = await recall('which shell does the owner use', {
      asOf: at(10),
      includeSuperseded: true
    });
    expect(asOf.map((hit) => hit.id)).toEqual([first.item.id]);
  });

  it('refuses a predicate that is not in the vetted in-repo registry', async () => {
    await expect(
      store.recordMemoryFact({
        userId,
        workspaceId,
        trust: 'stated',
        predicate: 'favourite_colour',
        documentCiphertext: sealed('x'),
        index: buildMemoryItemIndex({ body: 'x', subject: 'owner', object: 'blue' }, key)
      })
    ).rejects.toThrow('favourite_colour');
    await expect(store.syncMemoryPredicates()).resolves.toBe(MEMORY_PREDICATES.length);
  });

  /**
   * `pred_functional` is a cache of the predicate's cardinality, written by `mem.index_row()` on a
   * trigger that fires on mem.item and on nothing else - so a release that changes a cardinality in
   * `MEMORY_PREDICATES` used to leave every stored row carrying the previous answer forever. It is
   * the sole predicate of the `mem_fact_current_one` unique index, so a stale value is not a stale
   * statistic: it decides whether the one-current-value-per-functional-predicate rule applies to a
   * row at all.
   *
   * The registry is edited directly in these three, because that is the only way to stand in the
   * position a release leaves a box in: `#recordMemoryFact` re-upserts the shipped definition on
   * every fact write, so a fact written the ordinary way can never disagree with the registry.
   */
  const cardinalityWas = async (name: string, cardinality: 'one' | 'many') =>
    database.query('UPDATE mem.predicate SET cardinality=$2 WHERE name=$1', [name, cardinality]);

  /**
   * The cached cardinality of every stored fact, in the keyed order of the values they carry - which
   * is a hash, so a caller that needs to know which value is which asks about the flags as a set.
   */
  const functionalFlags = async (): Promise<boolean[]> =>
    (
      await database.query<{ pred_functional: boolean }>(
        `SELECT pred_functional FROM mem.item WHERE kind='fact' ORDER BY object_key`
      )
    ).rows.map((row) => row.pred_functional);

  it('stops refusing a legitimate second value once a predicate has widened to many', async () => {
    // The box as a release that narrowed related_to to `one` left it: the row was written while the
    // registry said so, so the trigger cached TRUE and the unique index governs it.
    await cardinalityWas('related_to', 'one');
    const first = await addItem(
      'fact',
      { title: 'deploy host', body: 'Deploys go to alpha.', subject: 'deploys', object: 'alpha' },
      { predicate: 'related_to' }
    );
    expect(await functionalFlags()).toEqual([true]);

    // The symptom, before anything is fixed: the registry has since gone back to `many`, but the
    // stored row still says otherwise, and a second perfectly legal value is refused by a constraint
    // the agent reports to the owner as a failed memory write.
    const second = {
      title: 'deploy host',
      body: 'Deploys also go to beta.',
      subject: 'deploys',
      object: 'beta'
    };
    await expect(addItem('fact', second, { predicate: 'related_to' })).rejects.toThrow(
      /mem_fact_current_one/
    );

    await store.syncMemoryPredicates();

    expect(await functionalFlags()).toEqual([false]);
    const added = await addItem('fact', second, { predicate: 'related_to' });
    expect(added.id).not.toBe(first.id);
  });

  it('brings the rows a narrowed predicate now governs back under the unique index', async () => {
    await cardinalityWas('default_shell', 'many');
    await addItem(
      'fact',
      { title: 'shell', body: 'The bot uses bash.', subject: 'deploybot', object: 'bash' },
      { predicate: 'default_shell' }
    );
    expect(await functionalFlags()).toEqual([false]);

    await store.syncMemoryPredicates();

    expect(await functionalFlags()).toEqual([true]);
    // And the rule is now really enforced on that row, rather than only recorded against it.
    await expect(
      addItem(
        'fact',
        { title: 'shell', body: 'The bot uses zsh.', subject: 'deploybot', object: 'zsh' },
        { predicate: 'default_shell' }
      )
    ).rejects.toThrow(/mem_fact_current_one/);
  });

  it('leaves a subject that already holds two current values alone rather than failing the upgrade', async () => {
    // The case that decides the shape of the backfill. Under `many` a subject may legitimately hold
    // several current values; the moment the registry says `one`, promoting all of them collides in
    // the unique index. A plain UPDATE would abort - inside an unattended 3am `athanor update`,
    // against the owner's only copy of their memory. The contested subject stays outside the index
    // and stays retrievable; the uncontested one is converted in the same pass.
    await cardinalityWas('default_shell', 'many');
    for (const object of ['zsh', 'fish'])
      await addItem(
        'fact',
        { title: 'shell', body: `The owner uses ${object}.`, subject: 'owner', object },
        { predicate: 'default_shell' }
      );
    await addItem(
      'fact',
      { title: 'shell', body: 'The bot uses bash.', subject: 'deploybot', object: 'bash' },
      { predicate: 'default_shell' }
    );

    await expect(store.syncMemoryPredicates()).resolves.toBe(MEMORY_PREDICATES.length);

    const bySubject = (
      await database.query<{ subject_key: string; pred_functional: boolean }>(
        `SELECT subject_key, pred_functional FROM mem.item WHERE kind='fact'`
      )
    ).rows;
    const contested = memorySubjectKey('owner', key);
    expect(bySubject.filter((row) => row.subject_key === contested)).toEqual([
      { subject_key: contested, pred_functional: false },
      { subject_key: contested, pred_functional: false }
    ]);
    expect(bySubject.filter((row) => row.subject_key !== contested)).toEqual([
      { subject_key: memorySubjectKey('deploybot', key), pred_functional: true }
    ]);
    // Both contested values are still there and still findable - nothing was retired to make room.
    const found = await recall('which shell does the owner use');
    expect(found.filter((hit) => hit.subjectKey === contested)).toHaveLength(2);
  });

  /*
   * Why a stale flag is a dormant inconsistency rather than a refused memory - written down because
   * the fix above is easy to over-claim, and because the property that makes it true is one line of
   * `#recordMemoryFact` that a later reader could take for redundant.
   *
   * `syncMemoryPredicates` has no caller outside this file and the eval harness; neither service
   * runs anything after `migrateDatabase`. So the *only* thing that moves `mem.predicate` on a live
   * box is the upsert `#recordMemoryFact` does before every fact it writes - and because that upsert
   * lands before the insert, `mem.index_row()` computes the new row's flag from the definition that
   * has just arrived. A fact minted after a cardinality change therefore carries the current answer
   * whatever the rows beside it still claim, and the write is not refused.
   *
   * If that upsert ever moves after the insert, or is dropped as duplicated work, this goes red.
   */
  it('writes a fact under a widened predicate without being refused by the rows that came before', async () => {
    // The box as the release before last left it: related_to was functional, and the fact recorded
    // then still carries the cache that says so. `addItem` rather than `recordMemoryFact`, because
    // the latter would put the shipped definition back before writing and there would be nothing
    // stale to find.
    await cardinalityWas('related_to', 'one');
    const first = await addItem(
      'fact',
      { title: 'deploy host', body: 'Deploys go to alpha.', subject: 'deploys', object: 'alpha' },
      { predicate: 'related_to' }
    );
    expect(await functionalFlags()).toEqual([true]);

    // The write the audit expected to be refused: a second legitimate value for the same subject,
    // arriving on the release that widened the predicate back to `many`.
    const second = await store.recordMemoryFact({
      userId,
      workspaceId,
      trust: 'stated',
      predicate: 'related_to',
      documentCiphertext: sealed('Deploys also go to beta.'),
      index: buildMemoryItemIndex(
        {
          title: 'deploy host',
          body: 'Deploys also go to beta.',
          subject: 'deploys',
          object: 'beta'
        },
        key
      )
    });
    // Both current, neither retired: that is what cardinality `many` means. The new row sits outside
    // `mem_fact_current_one` because the upsert refreshed the registry the trigger reads, so the old
    // row's stale claim on that slot never comes up.
    expect(second.supersededIds).toEqual([]);
    // One of each: the row written under the old definition still claims the slot, the new one does
    // not ask for it. (Sorted rather than positional - `functionalFlags` orders by the keyed object,
    // which is a hash and so tells you nothing about which value was written first.)
    expect([...(await functionalFlags())].sort()).toEqual([false, true]);
    const current = await recall('where do deploys go');
    expect(
      current
        .filter((hit) => hit.status === 'active')
        .map((hit) => hit.id)
        .sort()
    ).toEqual([first.id, second.item.id].sort());
  });

  it('marks two conflicting owner statements disputed rather than picking a winner', async () => {
    const left = await addItem(
      'fact',
      {
        title: 'deploy host',
        body: 'Deploys go to alpha.',
        subject: 'deploys',
        object: 'alpha'
      },
      { predicate: 'located_at' }
    );
    const right = await addItem(
      'fact',
      {
        title: 'deploy host',
        body: 'Deploys go to beta.',
        subject: 'deploys',
        object: 'beta'
      },
      { predicate: 'located_at' }
    );
    await expect(store.markMemoryFactsDisputed(workspaceId, [left.id, right.id])).resolves.toBe(2);

    // Neither is retrieved by default; both are still there for the review queue.
    await expect(recall('where do deploys go')).resolves.toEqual([]);
    const disputed = await recall('where do deploys go', { includeSuperseded: true });
    expect(disputed.map((hit) => hit.status)).toEqual(['disputed', 'disputed']);
    await expect(memory.listMemoryLinks(left.id)).resolves.toEqual([
      expect.objectContaining({ rel: 'contradicts' })
    ]);

    /*
     * And the shape a review surface needs, in one read rather than one per row. "This is disputed"
     * with no answer to "with what" is not something a person can act on, and the pair is the whole
     * point of the status - `markMemoryFactsDisputed` writes the status and the links as one
     * statement of one fact precisely so that half of it is never shown on its own.
     */
    const queue = await store.listDisputedMemoryItems(workspaceId);
    expect(queue.map((item) => item.id).sort()).toEqual([left.id, right.id].sort());
    expect(queue.find((item) => item.id === left.id)!.contradicts).toEqual([right.id]);
    expect(queue.find((item) => item.id === right.id)!.contradicts).toEqual([left.id]);
    // The fields the owner is deciding on come back with it, so the route projects rather than
    // fetches: who said it, when it was true, and which conversation it came from.
    expect(queue[0]).toMatchObject({
      status: 'disputed',
      trust: 'stated',
      taskId: null,
      okCount: 0,
      failCount: 0,
      validTo: null
    });
    expect(Date.parse(queue[0]!.validFrom)).not.toBeNaN();

    // Retracting one is how the owner settles it, and it leaves the queue.
    await expect(store.retractMemoryItem(workspaceId, left.id)).resolves.toBe(true);
    await expect(
      store.listDisputedMemoryItems(workspaceId).then((rows) => rows.map((row) => row.id))
    ).resolves.toEqual([right.id]);
  });

  it('holds a repeated observation back until two episodes a day apart have seen it', async () => {
    const episodeOne = await addItem('episode', { body: 'Noticed the agent using ripgrep.' });
    const episodeTwo = await addItem('episode', { body: 'Noticed ripgrep again.' });
    const observation = {
      workspaceId,
      subjectKey: 'subject-owner',
      predicate: 'prefers',
      objectKey: 'object-ripgrep'
    };

    const first = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(3)
    });
    expect(first.episodeCount).toBe(1);

    // The same episode saying it twice is one observation, not two.
    const repeat = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(3)
    });
    expect(repeat.episodeCount).toBe(1);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);

    /*
     * The count, on its own, with the day already satisfied - which is what that assertion above
     * looks like it is doing and is not.
     *
     * One episode, seen twice two days apart, so `last_seen - first_seen` clears twenty-four hours
     * and `n_episodes` is still one. Changing the default `minEpisodes ?? 2` to `?? 1` left every
     * case in this file green, including the line above, because every single-sighting candidate
     * anywhere in it is also inside its own day and the GAP was refusing them all. The two
     * sightings are the half of this gate the corroboration ruling kept unconditionally and the
     * half the owner-conversation waiver leans on entirely - every corrupt row a gate-off replay
     * of this machine's corpus admits was seen exactly once - so it is worth a case that fails
     * when it moves.
     */
    const spread = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(1)
    });
    expect(spread.episodeCount).toBe(1);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    await expect(
      store
        .listPromotableMemoryFactCandidates(workspaceId, { minEpisodes: 1 })
        .then((rows) => rows.map((row) => row.objectKey))
    ).resolves.toEqual(['object-ripgrep']);

    const second = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeTwo.id,
      observedAt: at(1)
    });
    expect(second.episodeCount).toBe(2);
    expect(second.episodeIds).toEqual([episodeOne.id, episodeTwo.id]);
    const promotable = await store.listPromotableMemoryFactCandidates(workspaceId);
    expect(promotable.map((candidate) => candidate.objectKey)).toEqual(['object-ripgrep']);

    // A 48-hour gap does not satisfy a 72-hour requirement. This exercises the PARAMETER; the
    // default it usually runs under is pinned by its own case below, because these two sightings
    // are two days apart and every default in [0, 48) would pass here identically.
    await expect(
      store.listPromotableMemoryFactCandidates(workspaceId, { minGapHours: 72 })
    ).resolves.toEqual([]);
    await expect(
      memory.deleteMemoryFactCandidate(workspaceId, 'subject-owner', 'prefers', 'object-ripgrep')
    ).resolves.toBe(true);
  });

  /*
   * Who nominated a sentence, and the one direction that answer is allowed to move in.
   *
   * `origin` decides the trust a promotion is minted at - `stated` for the owner's own line,
   * `derived` for a model's wording of it - and it decides which rows the owner is shown as
   * proposals. So it has to be sticky towards `proposed`: a sentence a model wrote must not become
   * the owner's own by being matched once by a regex afterwards, which is the exact sequence a
   * model's normalisation of a phrase the owner keeps restating would produce.
   */
  it('remembers that a model wrote a sentence, however often a pattern matches it after', async () => {
    const episodeOne = await addItem('episode', { body: 'Told it to take the lead.' });
    const episodeTwo = await addItem('episode', { body: 'Told it again.' });
    const key = {
      workspaceId,
      subjectKey: 'subject-athanor',
      predicate: 'standing_order',
      objectKey: 'object-lead'
    };
    const proposed = await store.observeMemoryFactCandidate({
      ...key,
      episodeId: episodeOne.id,
      observedAt: at(3),
      origin: 'proposed'
    });
    expect(proposed.origin).toBe('proposed');
    const matched = await store.observeMemoryFactCandidate({
      ...key,
      episodeId: episodeTwo.id,
      observedAt: at(1)
    });
    expect(matched.origin).toBe('proposed');
    expect(matched.episodeCount).toBe(2);
    await expect(
      store.listMemoryFactProposals(workspaceId).then((rows) => rows.map((row) => row.objectKey))
    ).resolves.toEqual(['object-lead']);

    // The other direction, so the stickiness is a rule and not the order these two happened to run
    // in: a pattern first, a model second, still a proposal.
    const other = { ...key, objectKey: 'object-fanout' };
    await store.observeMemoryFactCandidate({
      ...other,
      episodeId: episodeOne.id,
      observedAt: at(3)
    });
    await expect(store.countMemoryFactProposals(workspaceId)).resolves.toBe(1);
    const crossed = await store.observeMemoryFactCandidate({
      ...other,
      episodeId: episodeTwo.id,
      observedAt: at(1),
      origin: 'proposed'
    });
    expect(crossed.origin).toBe('proposed');
    await expect(store.countMemoryFactProposals(workspaceId)).resolves.toBe(2);
  });

  /*
   * The owner's refusal, at the two statements that have to agree about it.
   *
   * A dismissal that only removed the row from the list would be a button that clears the screen
   * for one night. It has to be refused where candidates are WRITTEN, or the next observation
   * resurrects it; and it has to be refused where they are READ, or a sentence dismissed after it
   * had already accumulated its sightings promotes anyway.
   */
  it('refuses a dismissed sentence at the write and at the gate, and never deletes the refusal', async () => {
    const episodeOne = await addItem('episode', { body: 'Said it once.' });
    const episodeTwo = await addItem('episode', { body: 'Said it twice.' });
    const key = {
      workspaceId,
      subjectKey: 'subject-athanor',
      predicate: 'standing_order',
      objectKey: 'object-refused'
    };
    await store.observeMemoryFactCandidate({ ...key, episodeId: episodeOne.id, observedAt: at(3) });
    await store.observeMemoryFactCandidate({ ...key, episodeId: episodeTwo.id, observedAt: at(1) });
    // Promotable before the refusal, which is what makes the refusal below mean something.
    await expect(
      store
        .listPromotableMemoryFactCandidates(workspaceId)
        .then((rows) => rows.map((row) => row.objectKey))
    ).resolves.toEqual(['object-refused']);

    await expect(
      store.dismissMemoryFactCandidate(workspaceId, key.subjectKey, key.predicate, key.objectKey)
    ).resolves.toBe(true);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    // Twice is not two refusals. The route answers 404 on the second, so the store has to say so.
    await expect(
      store.dismissMemoryFactCandidate(workspaceId, key.subjectKey, key.predicate, key.objectKey)
    ).resolves.toBe(false);

    const again = await store.observeMemoryFactCandidate({
      ...key,
      episodeId: episodeOne.id,
      observedAt: at(0)
    });
    expect(again.dismissedAt).not.toBeNull();
    expect(again.episodeCount).toBe(2);
    expect(again.draftCiphertext).toBeNull();
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);

    /*
     * The same refusal against a fixture that can actually reach it, which the three lines above
     * cannot.
     *
     * They re-observe with an episode the row already holds and with no draft, so the two things
     * the guard protects are unreachable by arithmetic: `n_episodes` does not climb for an episode
     * already in `episode_ids`, and `draft_ciphertext = COALESCE(EXCLUDED.draft_ciphertext, ...)`
     * of NULL over NULL is NULL. Deleting `WHERE mem.fact_candidate.dismissed_at IS NULL` from the
     * upsert leaves every one of them green, and leaves this whole repository green - the report
     * a caller reads does not change either way, because the row still comes back carrying
     * `dismissedAt` and the caller still counts it as refused. What changes is the row.
     *
     * So: a THIRD episode, and a real draft. Without the guard the update fires, `n_episodes`
     * climbs on a sentence the owner refused and the plaintext the dismissal deliberately erased
     * is put back by the COALESCE.
     */
    const episodeThree = await addItem('episode', { body: 'Said it a third time.' });
    const restored = await store.observeMemoryFactCandidate({
      ...key,
      episodeId: episodeThree.id,
      observedAt: at(0),
      draftCiphertext: sealed('the sentence the owner refused')
    });
    expect(restored.draftCiphertext).toBeNull();
    expect(restored.episodeCount).toBe(2);
    expect(restored.dismissedAt).not.toBeNull();

    // And the pass whose job is to age candidates out leaves it alone. Deleting the refusal would
    // put the sentence back in the queue on the first night after the retention horizon.
    const report = await store.consolidateMemory(workspaceId, { candidateRetentionDays: 1 });
    expect(report.candidatesPruned).toBe(0);
    await expect(
      store
        .observeMemoryFactCandidate({ ...key, episodeId: episodeOne.id })
        .then((row) => row.dismissedAt === null)
    ).resolves.toBe(false);
  });

  /*
   * The once-a-day claim on the one model call memory makes. It is in the database rather than in
   * the worker because the worker's own cadence is a `Map` that a restart clears, and the thing
   * being scheduled is a request the owner pays for.
   */
  it('hands the nightly claim to one caller a day and tells it where its window starts', async () => {
    const first = await store.claimMemoryProposalRun(workspaceId, {
      now: '2026-07-30T22:00:00.000Z'
    });
    // No previous run, so no window: the caller takes the clock and reads nothing.
    expect(first).toEqual({ claimed: true, previous: null });
    await expect(
      store.claimMemoryProposalRun(workspaceId, { now: '2026-07-31T20:00:00.000Z' })
    ).resolves.toEqual({ claimed: false, previous: null });

    const second = await store.claimMemoryProposalRun(workspaceId, {
      now: '2026-07-31T23:00:00.000Z'
    });
    // The PREVIOUS value, not the one just written: it is the far end of the window the caller is
    // about to read, so a run 25 hours later reads 25 hours and nothing falls between two passes.
    expect(second).toEqual({ claimed: true, previous: '2026-07-30T22:00:00.000Z' });
    await expect(
      store.claimMemoryProposalRun(workspaceId, { now: '2026-07-31T23:00:01.000Z' })
    ).resolves.toEqual({ claimed: false, previous: null });
  });

  it('holds back two sightings inside the same day, on the default nobody passes', async () => {
    /*
     * The half of the gate that had no case at all.
     *
     * `listPromotableMemoryFactCandidates` defaults `minGapHours ?? 24`, and `store/memory.ts`
     * calls that rule "the single most effective anti-bloat rule in the design". Changing the
     * default to 0 left `store.test.ts` and `memory-eval.test.ts` green at 196 of 196, because the
     * only sightings anywhere were 48 hours apart - so any default in [0, 48) passed. Over a real
     * corpus of 3,950 typed turns that silent zero takes the store from 1 promotion to 37.
     *
     * Both directions: twelve hours apart is refused by the default, and the same pair is admitted
     * once the caller asks for a shorter gap, so the default bounds without refusing real work.
     */
    const morning = await addItem('episode', { body: 'Heard it at breakfast.' });
    const evening = await addItem('episode', { body: 'Heard it again at supper.' });
    const observation = {
      workspaceId,
      subjectKey: 'subject-owner',
      predicate: 'prefers',
      objectKey: 'object-same-day'
    };
    await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: morning.id,
      observedAt: at(1)
    });
    const seen = await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: evening.id,
      observedAt: at(0.5)
    });
    expect(seen.episodeCount).toBe(2);

    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    await expect(
      store
        .listPromotableMemoryFactCandidates(workspaceId, { minGapHours: 6 })
        .then((rows) => rows.map((row) => row.objectKey))
    ).resolves.toEqual(['object-same-day']);
  });

  it('keeps the day whoever said it, and however many conversations they said it in', async () => {
    /*
     * The clause a corroboration pass added here and this one took back out, pinned so it cannot
     * come back by accident.
     *
     * The argument for waiving the day was good and the measurement behind it was real: on this
     * machine's own transcripts the day refused exactly one rule it should have kept - `Remember,
     * this will primarily be an app experience on desktop and mobile, not browser focused.`, said
     * in four conversations six minutes apart - and admitted no corrupt fragment in its place. The
     * proposed bound was two conversations rather than two turns, on the reasoning that a paste
     * twice into one thread is one act and two threads are two.
     *
     * It is not. `docs/design/memory/GATE.md` §3.2 prices the attack this tier has to survive at
     * exactly "the owner pastes one document twice", and opening a fresh conversation on the same
     * subject and pasting the same document again is what a person does, not what an attacker
     * does. Driven end to end through `recordTurnEpisode`, that put five of a vendor's rules into
     * `mem.item`, active and pinned, in five minutes. No count of conversations can stand in for
     * elapsed time, because pasting again is free and waiting is not - so the day applies to
     * everybody, and the rows below differ only in who said them and where.
     */
    const first = await addItem('episode', { body: 'Said it in one conversation.' });
    const second = await addItem('episode', { body: 'Said it again in the next one.' });
    for (const objectKey of ['object-two-threads', 'object-one-thread'] as const) {
      await store.observeMemoryFactCandidate({
        workspaceId,
        subjectKey: 'subject-athanor',
        predicate: 'standing_order',
        objectKey,
        episodeId: first.id,
        observedAt: at(1)
      });
      await store.observeMemoryFactCandidate({
        workspaceId,
        subjectKey: 'subject-athanor',
        predicate: 'standing_order',
        objectKey,
        episodeId: second.id,
        observedAt: at(0.5)
      });
    }
    // Two sightings each, so the count is satisfied and the day is the only thing left refusing.
    const rows = await memory.listPromotableMemoryFactCandidates(workspaceId, { minGapHours: 6 });
    expect(rows.map((row) => row.episodeCount)).toEqual([2, 2]);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    // And the day is what is refusing them, not the count: cleared, both come back.
    await expect(
      store
        .listPromotableMemoryFactCandidates(workspaceId, { minGapHours: 0 })
        .then((promotable) => promotable.map((row) => row.objectKey))
    ).resolves.toEqual(['object-one-thread', 'object-two-threads']);
  });

  it('pins a promoted standing order, so a request that does not name it still gets it', async () => {
    /*
     * `mem.item.pin` is read by the structural recall channel and by the salience formula, and
     * until this wave no production path wrote it. It is the only thing the fused query admits
     * with no lexical grip at all, which is exactly what a rule for the machine needs: "never run
     * git stash" is wanted on the turn where the agent is about to run it, and that turn's request
     * never says "git".
     */
    const episodeOne = await addItem('episode', { body: 'The owner said it once.' });
    const episodeTwo = await addItem('episode', { body: 'The owner said it again.' });
    const content = {
      title: 'Standing instruction',
      body: 'Never run git stash in this checkout.',
      subject: 'athanor',
      object: 'Never run git stash in this checkout.'
    };
    const index = buildMemoryItemIndex(content, key);
    const observation = {
      workspaceId,
      subjectKey: index.subjectKey!,
      predicate: 'standing_order',
      objectKey: index.objectKey!
    };
    for (const [episode, seenAt] of [
      [episodeOne, at(3)],
      [episodeTwo, at(1)]
    ] as const)
      await store.observeMemoryFactCandidate({
        ...observation,
        episodeId: episode.id,
        observedAt: seenAt
      });

    const promoted = await store.promoteMemoryFactCandidates(workspaceId, () => ({
      userId,
      trust: 'stated' as const,
      documentCiphertext: sealed(content.body),
      index,
      pin: true
    }));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.item).toMatchObject({ kind: 'fact', trust: 'stated', pin: true });

    // Not one word of this request reaches the rule, and it comes back anyway.
    const hits = await recall('rewrite the brochure copy for the spring mailing');
    expect(hits.map((hit) => opened(hit.documentCiphertext))).toContain(content.body);

    // The same rule left unpinned is not in that answer, which is what makes the flag the cause.
    const loose = { ...content, body: 'Never format a repo file with the wrong config.' };
    await addItem('fact', loose, { predicate: 'standing_order' });
    const again = await recall('rewrite the brochure copy for the spring mailing');
    expect(again.map((hit) => opened(hit.documentCiphertext))).not.toContain(loose.body);
  });

  it('lands a restated rule on the row that already holds it, and never on a second one', async () => {
    /*
     * What a promotion does to a sentence the workspace already keeps.
     *
     * Promotion deletes the candidate, and `standing_order` is `cardinality: 'many'`, so the
     * supersession in `#recordMemoryFact` never fires on one: the owner saying a rule again
     * re-accumulated a candidate and minted a second identical, active, pinned row beside the
     * first. It is not a bytes problem. `MEMORY_PACK_QUOTAS` caps facts at four per subject and
     * every standing order shares the subject `athanor`, so one rule said three times takes three
     * of the four slots every later turn in the workspace sees - the pack fills with one sentence
     * and the other rules fall out. Restating is also the most natural thing an owner does, so the
     * cost grows with how much they use this.
     *
     * The corroboration still counts: the episodes that vouched for it this time are linked to the
     * row that was already there, which is what keeps "what is this based on" answerable.
     */
    const content = {
      title: 'Standing instruction',
      body: 'Never merge to main without the acceptance run.',
      subject: 'athanor',
      object: 'Never merge to main without the acceptance run.'
    };
    const index = buildMemoryItemIndex(content, key);
    const say = async (episodes: readonly { id: string }[], seenAt: Date) => {
      for (const episode of episodes)
        await store.observeMemoryFactCandidate({
          workspaceId,
          subjectKey: index.subjectKey!,
          predicate: 'standing_order',
          objectKey: index.objectKey!,
          episodeId: episode.id,
          observedAt: seenAt
        });
    };
    const promote = () =>
      store.promoteMemoryFactCandidates(workspaceId, () => ({
        userId,
        trust: 'stated' as const,
        documentCiphertext: sealed(content.body),
        index,
        pin: true
      }));

    const said = await addItem('episode', { body: 'The owner said it.' });
    const saidAgain = await addItem('episode', { body: 'And again, days later.' });
    await say([said], at(3));
    await say([saidAgain], at(1));
    const first = await promote();
    expect(first).toHaveLength(1);
    expect(first[0]!.reattached).toBe(false);

    // Days later, the same rule, twice more, clearing the same gate a second time.
    const repeated = await addItem('episode', { body: 'Said it again this week.' });
    const repeatedAgain = await addItem('episode', { body: 'And once more.' });
    await say([repeated], at(2));
    await say([repeatedAgain], at(0));
    const second = await promote();
    expect(second).toHaveLength(1);
    expect(second[0]!.reattached).toBe(true);
    expect(second[0]!.item.id).toBe(first[0]!.item.id);

    // One row, still the only one, and the candidate did not survive to be promoted a third time.
    const stored = await store.listMemoryItems(workspaceId, { kind: 'fact' });
    expect(stored.filter((item) => item.predicate === 'standing_order')).toHaveLength(1);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);

    // All four episodes vouch for the one row.
    const vouching = await database.query<{ dst_id: string }>(
      `SELECT dst_id FROM mem.link WHERE src_id=$1 AND rel='derived_from' ORDER BY dst_id`,
      [first[0]!.item.id]
    );
    expect(vouching.rows.map((row) => row.dst_id).sort()).toEqual(
      [said.id, saidAgain.id, repeated.id, repeatedAgain.id].sort()
    );
  });

  /*
   * The carve-outs on a rule, which are counted on different terms from the rule itself.
   *
   * `mem.fact_qualification` is keyed on the rule and on a blind hash of the clause, so the store
   * dedupes exceptions it cannot read; the bound is taken in the statement rather than around it;
   * and a sentence the owner has dismissed accumulates nothing beside its refusal.
   */
  it('accumulates a rule’s carve-outs, deduped, bounded, and never past a refusal', async () => {
    const episode = await addItem('episode', { body: 'The owner said it.' });
    const rule = {
      workspaceId,
      subjectKey: 'subject-athanor',
      predicate: 'standing_order',
      objectKey: 'object-approvals'
    };
    const clause = (name: string) => ({ key: `q-${name}`, ciphertext: sealed(name) });
    await store.observeMemoryFactCandidate({
      ...rule,
      episodeId: episode.id,
      observedAt: at(3),
      qualifications: [clause('purchases'), clause('purchases'), clause('credentials')]
    });
    const held = async () =>
      (
        await store.listPromotableMemoryFactCandidates(workspaceId, {
          minEpisodes: 1,
          minGapHours: 0
        })
      )
        .flatMap((candidate) => candidate.qualifications ?? [])
        .map((qualification) => opened(qualification.ciphertext));
    // The same clause twice in one sighting is one row: the key is the identity, and the store is
    // the only place that can hold that opinion, because it is the only place both spellings meet.
    expect(await held()).toEqual(['credentials', 'purchases']);

    // Past the bound, taken in the INSERT rather than by a count read first and enforced after -
    // two statements are two statements a concurrent turn fits between.
    const laterEpisode = await addItem('episode', { body: 'And again, days later.' });
    await store.observeMemoryFactCandidate({
      ...rule,
      episodeId: laterEpisode.id,
      observedAt: at(1),
      qualifications: ['publishing', 'destructive', 'pushes', 'branches'].map(clause)
    });
    expect(await held()).toHaveLength(MemoryStore.maxQualifications);

    // And the owner's refusal takes the clauses with the draft. They are their words about a rule
    // they have just said they do not want; keeping them would leave clauses of a sentence nothing
    // may ever store.
    await expect(
      store.dismissMemoryFactCandidate(workspaceId, rule.subjectKey, rule.predicate, rule.objectKey)
    ).resolves.toBe(true);
    await expect(
      database
        .query('SELECT count(*)::int AS n FROM mem.fact_qualification')
        .then((result) => (result.rows[0] as { n: number }).n)
    ).resolves.toBe(0);
    // A refused sentence accumulates nothing afterwards either, and that is the same statement
    // doing it rather than a second guard somewhere else.
    await store.observeMemoryFactCandidate({
      ...rule,
      episodeId: episode.id,
      observedAt: at(0),
      qualifications: [clause('purchases')]
    });
    await expect(
      database
        .query('SELECT count(*)::int AS n FROM mem.fact_qualification')
        .then((result) => (result.rows[0] as { n: number }).n)
    ).resolves.toBe(0);
  });

  /*
   * A rule that promoted in June, given its exception in August.
   *
   * This is the half of the design that cannot live in the worker. The accumulator survives
   * promotion - it belongs to the rule, not to the nomination that filled it - so a later sighting
   * carrying a clause the live row does not have mints the fuller sentence and retires the thinner
   * one, instead of reattaching to a row that still reads as the bare rule. Because rows are only
   * ever inserted there, the set can only grow: **a rule's carve-outs never shrink.**
   *
   * Both directions on one fixture. The second promotion below carries a new clause and supersedes;
   * the third carries nothing new and reattaches, which is the control that stops this passing
   * against a store that simply minted a row every time.
   */
  it('gives a promoted rule the exception stated after it, and retires the sentence without one', async () => {
    const bare = 'Ease of use is paramount and approvals should not be heavy-handed.';
    const qualified =
      'Ease of use is paramount and approvals should not be heavy-handed, but always ask before purchases and git pushes.';
    const core = 'Ease of use is paramount and approvals should not be heavy-handed';
    const indexFor = (body: string) =>
      buildMemoryItemIndex(
        { title: 'Standing instruction', body, subject: 'athanor', object: core },
        key
      );
    const rule = {
      workspaceId,
      subjectKey: indexFor(bare).subjectKey!,
      predicate: 'standing_order',
      objectKey: indexFor(bare).objectKey!
    };
    const say = async (
      episodes: readonly { id: string }[],
      seenAt: Date,
      qualifications: readonly { key: string; ciphertext: EncryptedEnvelope }[] = []
    ) => {
      for (const episode of episodes)
        await store.observeMemoryFactCandidate({
          ...rule,
          episodeId: episode.id,
          observedAt: seenAt,
          qualifications
        });
    };
    // The worker's own composer, in one line: the body is the rule and every clause the store has.
    const promote = (body: string) =>
      store.promoteMemoryFactCandidates(workspaceId, (candidate) => ({
        userId,
        trust: 'derived' as const,
        documentCiphertext: sealed(body),
        index: indexFor(body),
        qualificationKeys: (candidate.qualifications ?? []).map((one) => one.key),
        pin: true
      }));

    await say([await addItem('episode', { body: 'Said it.' })], at(6));
    await say([await addItem('episode', { body: 'Said it again.' })], at(4));
    const first = await promote(bare);
    expect(first).toHaveLength(1);
    expect(opened(first[0]!.item.documentCiphertext)).toBe(bare);

    // August. The same rule, twice more, and one of the two sightings carries the floor.
    const floor = [
      { key: 'q-floor', ciphertext: sealed('but always ask before purchases and git pushes') }
    ];
    await say([await addItem('episode', { body: 'Said it in August.' })], at(3), floor);
    await say([await addItem('episode', { body: 'And once more.' })], at(1));
    // The accumulator outlived the first promotion, which is what makes any of this reachable.
    const promotable = await store.listPromotableMemoryFactCandidates(workspaceId);
    expect(promotable[0]?.qualifications?.map((one) => one.key)).toEqual(['q-floor']);

    const second = await promote(qualified);
    expect(second).toHaveLength(1);
    expect(second[0]!.reattached).toBe(false);
    expect(second[0]!.supersededIds).toEqual([first[0]!.item.id]);
    const live = (await store.listMemoryItems(workspaceId, { kind: 'fact', limit: 50 })).filter(
      (item) => item.predicate === 'standing_order' && item.status === 'active'
    );
    expect(live.map((item) => opened(item.documentCiphertext))).toEqual([qualified]);

    // The accumulator is not consumed by the promotion that used it. That is the whole reason it
    // is keyed on the rule instead of on the candidate: the candidate is deleted here, and a store
    // that took the clauses with it would be back to a rule that cannot pick up an exception
    // stated after it - which is this case, one promotion later.
    await expect(
      database
        .query('SELECT qualification_key FROM mem.fact_qualification')
        .then((result) => result.rows.map((row) => String(row.qualification_key)))
    ).resolves.toEqual(['q-floor']);

    // The control: a restatement with nothing new lands on the row that already says it. Without
    // this the case above would pass against a store that minted a second row every time.
    await say([await addItem('episode', { body: 'September.' })], at(1.5));
    await say([await addItem('episode', { body: 'And again.' })], at(0.4));
    const third = await promote(qualified);
    expect(third).toHaveLength(1);
    expect(third[0]!.reattached).toBe(true);
    expect(third[0]!.item.id).toBe(second[0]!.item.id);
  });

  it('does not bring back a rule the owner retracted, and does bring back one they deleted', async () => {
    /*
     * The owner's undo has to outlast the next corroboration, or it is not an undo.
     *
     * Retracting is this product's "stop believing this": the row stays for the audit trail and
     * leaves recall. If saying the thing twice more re-mints it, the machine has overruled the one
     * instruction in the whole tier that was given deliberately, about the tier itself - and it is
     * a pinned row, so what comes back is obeyed on every later turn. The candidate is dropped
     * rather than held, so the answer is the same on the next turn and the one after.
     *
     * The other direction is why `DELETE` and `retract` are two verbs. Deleting removes the row and
     * every trace of it, which is what an owner means when they say a line is gone - and a rule
     * that is gone can be learned again, from evidence, exactly as it was the first time. Without
     * this half, a refusal that only ever accumulates would slowly make the store unteachable.
     */
    const content = {
      title: 'Standing instruction',
      body: 'Never open a pull request from the release branch.',
      subject: 'athanor',
      object: 'Never open a pull request from the release branch.'
    };
    const index = buildMemoryItemIndex(content, key);
    let episodes = 0;
    const corroborate = async () => {
      for (const days of [3, 1]) {
        const episode = await addItem('episode', { body: `Sighting ${(episodes += 1)}.` });
        await store.observeMemoryFactCandidate({
          workspaceId,
          subjectKey: index.subjectKey!,
          predicate: 'standing_order',
          objectKey: index.objectKey!,
          episodeId: episode.id,
          observedAt: at(days)
        });
      }
      return store.promoteMemoryFactCandidates(workspaceId, () => ({
        userId,
        trust: 'stated' as const,
        documentCiphertext: sealed(content.body),
        index,
        pin: true
      }));
    };

    const promoted = await corroborate();
    expect(promoted).toHaveLength(1);
    await expect(store.retractMemoryItem(workspaceId, promoted[0]!.item.id)).resolves.toBe(true);

    // Said twice more, on two more days. Nothing is minted, and nothing is waiting to be.
    await expect(corroborate()).resolves.toEqual([]);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    await expect(
      store
        .listMemoryItems(workspaceId, { kind: 'fact' })
        .then((rows) => rows.map((row) => row.status))
    ).resolves.toEqual(['retracted']);

    // Deleted instead, the same evidence teaches it again.
    await expect(store.forgetMemoryItem(workspaceId, promoted[0]!.item.id)).resolves.toBe(true);
    const relearned = await corroborate();
    expect(relearned).toHaveLength(1);
    expect(relearned[0]!.reattached).toBe(false);
    expect(relearned[0]!.item.id).not.toBe(promoted[0]!.item.id);
  });

  it('still tells the owner their own facts after sixty rules of theirs are pinned', async () => {
    /*
     * The defect the tier's own comment said could not happen, measured.
     *
     * `pin` has exactly one production writer - a promoted standing order - and standing orders all
     * share the subject `athanor`, so the more rules the owner states the more pinned rows one
     * subject holds. The comment beside that writer read "four is what a rendered pack shows
     * however many rows exist", on the reasoning that the per-subject cap bounds them at four. It
     * does. What it does not do is bound what those rows cost on the way to being cut: the kind cap
     * and the token share were computed over rows the per-subject cap was about to discard, so
     * sixty `athanor` rows spent sixty of the fact slot's twenty-five ranks and the whole 35% share
     * before one `owner` row was considered. Taking the per-subject cap first is the whole repair.
     *
     * Measured here, on this statement, one workspace, four owner facts - three that share words
     * with the request and one reachable only because the request names its subject - against a
     * growing shelf of pinned rules (before this fix -> after):
     *
     *   pinned |  0  |  1  |  4  | 10  |  40   |  60
     *   orders |  0  |  1  |  4  |  4  |   4   |   4
     *   facts  |  4  |  4  |  4  |  4  | 0->4  | 0->4
     *
     * The fourth fact is what makes this two mechanisms rather than one. It shares no content word
     * with the request, so the only route it has is the structural ladder - and that ladder was
     * `ORDER BY pr ... LIMIT 40` with pinned rows first, which at forty pins is forty pins. With
     * the cap moved and the ladder left alone, three of these four come back at sixty and that one
     * never does, on any request, including one about its own subject. So the ladder now deals its
     * forty rungs by turns across the three admissibility classes.
     *
     * That has a cost of its own, which is measured where it bites rather than here: dealing by
     * turns leaves the pin class ceil(40 / classes) rungs, and filling those by recency threw away
     * the rule a request was actually about. The ladder therefore deals a row the request's words
     * match before one they do not, and `apps/worker/src/memory-runtime.test.ts` holds that at both
     * shipped call sites.
     *
     * Both directions are asserted, because a fix that starved the orders to feed the facts would
     * be the same defect facing the other way: the rules keep their four at every step, and the
     * request below reaches them without naming one.
     */
    const ownerFacts = [
      ['default shell', 'The owner uses fish on this computer.', 'fish', 'default_shell'],
      ['preferred search', 'The owner prefers ripgrep everywhere.', 'ripgrep', 'prefers'],
      ['working language', 'The owner writes TypeScript daily.', 'typescript', 'knows_language'],
      // Not one content word of the request below. Only the subject it names reaches this row, so
      // it is the probe for the structural ladder specifically.
      ['travel', 'Flights are booked through Cathay.', 'cathay', 'related_to']
    ] as const;
    for (const [title, body, object, predicate] of ownerFacts)
      await addItem('fact', { title, body, subject: 'owner', object }, { predicate });

    const isOrder = (body: string) => body.startsWith('Never do forbidden');
    const isOwnerFact = (body: string) => ownerFacts.some(([, factBody]) => factBody === body);

    let pinned = 0;
    const ladder: string[] = [];
    for (const target of [0, 1, 4, 10, 40, 60]) {
      for (; pinned < target; pinned += 1)
        await addItem(
          'fact',
          {
            title: 'Standing instruction',
            body: `Never do forbidden thing number ${pinned} in this checkout.`,
            subject: 'athanor',
            object: `Never do forbidden thing number ${pinned} in this checkout.`
          },
          {
            predicate: 'standing_order',
            pin: true,
            observedAt: at(pinned / 24),
            validFrom: at(pinned / 24)
          }
        );
      await store.rebuildMemoryCorpusStats(workspaceId);
      const bodies = (await recall('which shell does the owner use')).map((hit) =>
        opened(hit.documentCiphertext)
      );
      ladder.push(
        `pinned=${target} orders=${bodies.filter(isOrder).length} facts=${bodies.filter(isOwnerFact).length}`
      );
    }
    expect(ladder).toEqual([
      'pinned=0 orders=0 facts=4',
      'pinned=1 orders=1 facts=4',
      'pinned=4 orders=4 facts=4',
      'pinned=10 orders=4 facts=4',
      'pinned=40 orders=4 facts=4',
      'pinned=60 orders=4 facts=4'
    ]);

    // The other direction, at the number that used to break the first one: sixty rules deep, a
    // request that names none of them and shares no word with any of them still reaches them.
    const unrelated = (await recall('rewrite the brochure copy for the spring mailing')).map(
      (hit) => opened(hit.documentCiphertext)
    );
    expect(unrelated.filter(isOrder)).toHaveLength(4);
  });

  it('promotes an observation that cleared the gate and never promotes it twice', async () => {
    const episodeOne = await addItem('episode', { body: 'Noticed the agent using ripgrep.' });
    const episodeTwo = await addItem('episode', { body: 'Noticed ripgrep again.' });
    const content = {
      title: 'preferred search tool',
      body: 'The owner prefers ripgrep.',
      subject: 'owner',
      object: 'ripgrep'
    };
    const index = buildMemoryItemIndex(content, key);
    const observation = {
      workspaceId,
      subjectKey: index.subjectKey!,
      predicate: 'prefers',
      objectKey: index.objectKey!
    };
    await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeOne.id,
      observedAt: at(3),
      draftCiphertext: sealed('owner prefers ripgrep')
    });
    await store.observeMemoryFactCandidate({
      ...observation,
      episodeId: episodeTwo.id,
      observedAt: at(1)
    });

    // A caller that cannot open the draft leaves the candidate exactly where it was.
    await expect(store.promoteMemoryFactCandidates(workspaceId, () => null)).resolves.toEqual([]);
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toHaveLength(1);

    // What gets minted has to be what was observed twice, not something else.
    await expect(
      store.promoteMemoryFactCandidates(workspaceId, () => ({
        userId,
        documentCiphertext: sealed(content.body),
        index: buildMemoryItemIndex({ ...content, subject: 'somebody else' }, key)
      }))
    ).rejects.toThrow(/subject and object/);

    const promoted = await store.promoteMemoryFactCandidates(workspaceId, (candidate) => {
      expect(opened(candidate.draftCiphertext!)).toBe('owner prefers ripgrep');
      return { userId, documentCiphertext: sealed(content.body), index };
    });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.item).toMatchObject({ kind: 'fact', trust: 'derived', status: 'active' });

    // The candidate is consumed, so the same observation cannot be minted a second time...
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
    await expect(store.promoteMemoryFactCandidates(workspaceId, () => null)).resolves.toEqual([]);

    // ...and the episodes that vouched for it are cited, which is also what exempts them from
    // the archive sweep that would otherwise take the evidence away from a live fact.
    const links = await memory.listMemoryLinks(promoted[0]!.item.id);
    expect(links.map((link) => link.rel)).toEqual(['derived_from', 'derived_from']);
    expect(links.map((link) => link.dstId).sort()).toEqual([episodeOne.id, episodeTwo.id].sort());

    const hits = await recall('what does the owner prefer');
    expect(hits.map((hit) => opened(hit.documentCiphertext))).toContain(
      'The owner prefers ripgrep.'
    );
  });

  it('drops a candidate whose predicate has left the vetted registry', async () => {
    const episode = await addItem('episode', { body: 'Noticed something.' });
    await database.query(
      `INSERT INTO mem.fact_candidate(
         workspace_id,subject_key,predicate,object_key,n_episodes,first_seen,last_seen,episode_ids)
       VALUES ($1,'subject-owner','retired_predicate','object-thing',2,$2,$3,ARRAY[$4::uuid])`,
      [workspaceId, at(3), at(1), episode.id]
    );

    await expect(store.promoteMemoryFactCandidates(workspaceId, () => null)).resolves.toEqual([]);
    // It can never become a fact, so it is not held for a review that will never come.
    await expect(store.listPromotableMemoryFactCandidates(workspaceId)).resolves.toEqual([]);
  });

  it('rebuilds drifted corpus statistics on its own cadence, not on every pass', async () => {
    await addItem('episode', { body: 'The owner uses fish and fish and fish.' });
    await addItem('episode', { body: 'The owner uses fish for scripting.' });

    await expect(store.consolidateMemory(workspaceId, { now })).resolves.toMatchObject({
      corpusStatsRebuilt: false
    });

    // The AFTER INSERT trigger only ever adds, so document frequency drifts high over time and
    // the full rebuild is the only thing that corrects it.
    await database.query(
      'UPDATE mem.corpus_stats SET n_docs=999, refreshed_at=$2 WHERE workspace_id=$1',
      [workspaceId, at(45)]
    );
    await expect(store.consolidateMemory(workspaceId, { now })).resolves.toMatchObject({
      corpusStatsRebuilt: true
    });
    const stats = await database.query<{ n_docs: string }>(
      'SELECT n_docs FROM mem.corpus_stats WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(stats.rows[0]?.n_docs)).toBe(2);

    // Having just been rebuilt, the next nightly pass leaves it alone.
    await expect(store.consolidateMemory(workspaceId, { now })).resolves.toMatchObject({
      corpusStatsRebuilt: false
    });
  });

  it('scores a bounded slice of the corpus in the fuzzy channel however large it grows', async () => {
    // Every stored row shares every query trigram, which is the shape the GIN overlap probe is
    // useless against and the reason the channel needs a cap of its own.
    const grams = Array.from({ length: 40 }, (_, index) => `trg${String(index).padStart(4, '0')}`);
    const grow = async (rows: number, tag: string): Promise<void> => {
      await database.query(
        `INSERT INTO mem.item(id,user_id,workspace_id,kind,trust,document_ciphertext,title_tokens,
                              tag_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,observed_at,
                              valid_from,tokens_est,indexed)
         SELECT gen_random_uuid(), $1, $2, 'episode', 'stated',
                '{"v":1,"iv":"i","tag":"t","ciphertext":"YQ=="}'::jsonb, '', '', '', '{}',
                $4::text[], $5 || '-' || g, NOW(), NOW(), 10, TRUE
         FROM generate_series(1, $3::int) g`,
        [userId, workspaceId, rows, grams, tag]
      );
      await database.exec('ANALYZE mem.item');
    };

    const plan = { ...planMemoryQuery('irrelevant', key), lexemes: [], trigrams: grams };
    /** Runs the real recall statement and returns EXPLAIN ANALYZE for it, params and all. */
    const explainRecall = async (): Promise<string> => {
      let captured: { sql: string; params: unknown[] } | null = null;
      const probe: Database = {
        query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          if (sql.includes('trg_cand')) captured = { sql, params };
          return database.query<T>(sql, params);
        },
        exec: (sql: string) => database.exec(sql),
        transaction: (callback) => database.transaction(callback),
        withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
          database.withAdvisoryLock(lock, callback),
        notify: (channel, payload) => database.notify(channel, payload),
        listen: (channel, handler) => database.listen(channel, handler),
        close: async () => undefined
      };
      await new DataStore(probe).recallMemoryCandidates({ workspaceId, plan, now });
      const explained = await database.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${captured!.sql}`,
        captured!.params
      );
      return explained.rows.map((row) => row['QUERY PLAN']).join('\n');
    };
    const scored = (plan: string): number =>
      Number(/on unnest g \(actual[^)]*loops=(\d+)\)/.exec(plan)?.[1] ?? -1);
    const overlapping = async (): Promise<number> => {
      const rows = await database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM mem.item WHERE workspace_id=$1 AND trigrams && $2::text[]',
        [workspaceId, grams]
      );
      return Number(rows.rows[0]!.count);
    };

    await grow(800, 'small');
    expect(await overlapping()).toBe(800);
    const small = scored(await explainRecall());

    await grow(2400, 'large');
    expect(await overlapping()).toBe(3200);
    const large = scored(await explainRecall());

    // Four times the corpus, the same amount of exact-similarity work.
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(600);
  }, 120_000);

  it('still returns a kind the quota table has never heard of', async () => {
    // The recall query used to inner-join the quota table by kind, so a row whose kind had no quota
    // entry was scored, ranked and then dropped with no error and no log line. 'entity' is the
    // specimen because it is real at the database level and unknown to everything above it: it was
    // a declared kind that nothing ever wrote, and removing it from TypeScript left the enum value
    // behind, which is the exact shape of the row this join must not discard.
    await addItem('entity' as MemoryKind, {
      title: 'athanor-relay',
      body: 'The SNI relay that fronts every published service on this computer.'
    });
    const hits = await recall('what is the relay');
    expect(hits.map((hit) => hit.kind)).toContain('entity');
  });

  it('cuts to maxItems by fused score, not alphabetically by row id', async () => {
    await addItem('episode', {
      title: 'Restarted athanor.target',
      body: 'Ran systemctl restart athanor.target after the deploy and watched journalctl for it.'
    });
    await addItem('episode', { body: 'Mentioned athanor.target once while writing the brief.' });
    await addItem('episode', { body: 'A note that only mentions the deploy in passing.' });

    const all = await recall('systemctl restart athanor.target after a deploy');
    expect(all.length).toBeGreaterThan(1);
    const best = [...all].sort((left, right) => right.score - left.score)[0]!;
    // The item cap used to be a trailing LIMIT after the (kind, id) sort, so what it discarded was
    // the alphabetically last row rather than the least relevant one.
    const capped = await recall('systemctl restart athanor.target after a deploy', { maxItems: 1 });
    expect(capped.map((hit) => hit.id)).toEqual([best.id]);
  });

  it('returns an interactive recall in relevance order and dereferences only real ids', async () => {
    await addItem('episode', {
      title: 'Rotated the certificate',
      body: 'Renewed the TLS certificate with acme.sh and reloaded nginx afterwards.'
    });
    await addItem('episode', { body: 'The nginx access log filled the disk once.' });

    const question = 'renewed the TLS certificate and reloaded nginx';
    const ranked = await recall(question, { order: 'relevance' });
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked.map((hit) => hit.score)).toEqual(
      [...ranked.map((hit) => hit.score)].sort((left, right) => right - left)
    );
    // Same rows either way: only the order the caller reads them in changes.
    const stable = await recall(question);
    expect(stable.map((hit) => hit.id).sort()).toEqual(ranked.map((hit) => hit.id).sort());

    const itemHit = ranked.find((hit) => hit.layer === 'item')!;
    const fetched = await memory.getMemoryItems(workspaceId, [itemHit.id, 'not-a-uuid', '']);
    expect(fetched.map((item) => item.id)).toEqual([itemHit.id]);
    // An id the model quoted back imprecisely must be an empty result, never a failed turn.
    await expect(memory.getMemoryItems(workspaceId, ['mem.item#3'])).resolves.toEqual([]);
  });

  it('stops injecting a procedure that keeps failing without ever deleting it', async () => {
    const procedure = await addItem('procedure', {
      title: 'Rebuild the search index',
      tags: ['search'],
      body: 'Run the reindex script against the search index.'
    });
    await expect(recall('rebuild the search index')).resolves.toHaveLength(1);

    for (const outcome of ['fail', 'fail', 'ok'] as const)
      await store.recordMemoryUse({ workspaceId, itemIds: [procedure.id], outcome });

    await expect(recall('rebuild the search index')).resolves.toEqual([]);
    // Listed, and with the reason it is listed. "Nobody has confirmed this in a season" and "it
    // lost more than it won across its last five uses" are different things to tell an owner
    // deciding whether to keep a remembered command, and the statement has always computed both
    // and returned neither - so the queue could be listed and not explained.
    await expect(store.listStaleMemoryProcedures(workspaceId, { now })).resolves.toMatchObject([
      {
        id: procedure.id,
        status: 'active',
        reason: 'failing',
        recentOkCount: 1,
        recentGradedCount: 3,
        lastVerified: null,
        okCount: 1,
        failCount: 2
      }
    ]);
    // Verifying it is the owner's other answer, and it moves it out of the queue.
    await expect(store.verifyMemoryProcedure(workspaceId, procedure.id, now)).resolves.toBe(true);
    await expect(
      store
        .listStaleMemoryProcedures(workspaceId, { now })
        .then((rows) => rows.map((row) => row.reason))
    ).resolves.toEqual(['failing']);

    // It comes back the moment it succeeds again - nothing was thrown away.
    for (const outcome of ['ok', 'ok', 'ok', 'ok'] as const)
      await store.recordMemoryUse({ workspaceId, itemIds: [procedure.id], outcome });
    await expect(recall('rebuild the search index')).resolves.toHaveLength(1);
  });

  /*
   * The two halves of "this item was used" are read by two different things: procedure health
   * counts the mem.item_use rows, and salience is recomputed from the counters on the item. They
   * were written as two statements with nothing holding them together, so a crash or a dropped
   * connection between them left an item_use row whose counters were never incremented - and the
   * two views of the same event then disagreed permanently, because nothing ever recomputes either
   * from the other.
   */
  it('records neither half of a use when the counters it belongs with cannot be written', async () => {
    const procedure = await addItem('procedure', {
      title: 'Roll the log files',
      body: 'Run logrotate against the nginx logs.'
    });
    /** The store's database with the counter update taken out from under it. */
    const failingOn = (real: Database, statement: RegExp): Database => ({
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        if (statement.test(sql)) throw new Error('connection terminated unexpectedly');
        return real.query<T>(sql, params);
      },
      exec: (sql: string) => real.exec(sql),
      transaction: (callback) =>
        real.transaction((scoped) => callback(failingOn(scoped, statement))),
      withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
        real.withAdvisoryLock(lock, callback),
      notify: (channel, payload) => real.notify(channel, payload),
      listen: (channel, handler) => real.listen(channel, handler),
      close: async () => undefined
    });
    const dropped = new DataStore(failingOn(database, /SET\s+\n?\s*use_count=use_count\+1/));

    await expect(
      dropped.recordMemoryUse({ workspaceId, itemIds: [procedure.id], outcome: 'ok' })
    ).rejects.toThrow(/connection terminated/);

    const uses = await database.query('SELECT id FROM mem.item_use WHERE item_id=$1', [
      procedure.id
    ]);
    expect(uses.rows).toEqual([]);
    const counters = await database.query<{ use_count: number; ok_count: number }>(
      'SELECT use_count, ok_count FROM mem.item WHERE id=$1',
      [procedure.id]
    );
    expect(counters.rows[0]).toMatchObject({ use_count: 0, ok_count: 0 });
  });

  /**
   * The other half of what an acceptance check teaches. A passing command becomes a procedure; a
   * failing one used to become nothing at all, so the box walked back into the same wall.
   */
  it('keeps what the harness watched fail, and takes it back when the same command passes', async () => {
    const command = 'pytest -q tests/importer';
    const failure = deadEndFromCheck(
      {
        label: 'the importer test passes',
        command,
        cwd: '/srv/importer',
        detail: 'exit 1 (expected 0): AssertionError: expected 3 rows'
      },
      now,
      key
    );
    const written = await store.recordMemoryDeadEnds({
      workspaceId,
      markerTag: memoryDeadEndTagKey(key),
      failed: [
        {
          userId,
          workspaceId,
          trust: 'derived',
          documentCiphertext: sealed(failure.content.body),
          index: failure.index,
          observedAt: now,
          validFrom: now,
          validTo: failure.validTo
        }
      ]
    });
    expect(written.recorded).toHaveLength(1);
    // Admitted to recall like any other procedure, which is the entire point of writing it down.
    await expect(recall('the importer test')).resolves.toHaveLength(1);

    const cleared = await store.recordMemoryDeadEnds({
      workspaceId,
      markerTag: memoryDeadEndTagKey(key),
      passed: [memorySubjectKey(command, key)],
      at: now
    });
    expect(cleared.retired).toEqual(written.recorded);
    // Gone from recall, still on the row: "what was wrong with this last month" stays answerable.
    await expect(recall('the importer test')).resolves.toEqual([]);
    await expect(store.getMemoryItem(workspaceId, written.recorded[0]!)).resolves.toMatchObject({
      status: 'superseded'
    });
  });

  /**
   * Two checks can name one command - one answered by a run athanor already watched succeed, one it
   * ran again - and a caution written out of that turn would be contradicted by the same turn.
   */
  it('writes nothing about a command the same turn also watched pass', async () => {
    const command = 'pnpm build';
    const failure = deadEndFromCheck(
      { label: 'it builds', command, cwd: '/srv', detail: 'exit 1 (expected 0): no such file' },
      now,
      key
    );
    await expect(
      store.recordMemoryDeadEnds({
        workspaceId,
        markerTag: memoryDeadEndTagKey(key),
        passed: [memorySubjectKey(command, key)],
        failed: [
          {
            userId,
            workspaceId,
            trust: 'derived',
            documentCiphertext: sealed(failure.content.body),
            index: failure.index,
            observedAt: now,
            validFrom: now,
            validTo: failure.validTo
          }
        ]
      })
    ).resolves.toEqual({ recorded: [], retired: [] });
    await expect(recall('pnpm build')).resolves.toEqual([]);
  });

  /**
   * A procedure written by the passing half carries no dead-end tag, so a later pass must leave it
   * exactly where it is. Retiring it would delete the box's memory of how this project is built.
   */
  it('leaves the procedure for the same command standing when it retires the caution', async () => {
    const command = 'pytest -q tests/importer';
    const procedure = await addItem('procedure', {
      title: 'the importer test passes',
      subject: command,
      body: `In /srv/importer, \`${command}\` succeeds.`
    });
    const failure = deadEndFromCheck(
      { label: 'the importer test passes', command, cwd: '/srv/importer', detail: 'exit 1' },
      now,
      key
    );
    await store.recordMemoryDeadEnds({
      workspaceId,
      markerTag: memoryDeadEndTagKey(key),
      failed: [
        {
          userId,
          workspaceId,
          trust: 'derived',
          documentCiphertext: sealed(failure.content.body),
          index: failure.index,
          observedAt: now,
          validFrom: now,
          validTo: failure.validTo
        }
      ]
    });
    const cleared = await store.recordMemoryDeadEnds({
      workspaceId,
      markerTag: memoryDeadEndTagKey(key),
      passed: [memorySubjectKey(command, key)],
      at: now
    });
    expect(cleared.retired).not.toContain(procedure.id);
    await expect(store.getMemoryItem(workspaceId, procedure.id)).resolves.toMatchObject({
      status: 'active'
    });
  });

  it('drops a procedure that has not been verified inside the staleness window', async () => {
    const procedure = await addItem(
      'procedure',
      { title: 'Rotate the keys', tags: ['keys'], body: 'Rotate the signing keys yearly.' },
      { observedAt: at(400), validFrom: at(400), lastVerified: at(400) }
    );
    await expect(recall('rotate the signing keys')).resolves.toEqual([]);
    await expect(
      recall('rotate the signing keys', { procedureStaleDays: 500 })
    ).resolves.toHaveLength(1);

    // The queue's own docstring: a procedure that stops being injected is never deleted for the
    // owner, it is listed as "verify or delete". This one is only old - it has never failed - so
    // saying it still works is enough to take it out of the queue and put it back in recall.
    await expect(store.listStaleMemoryProcedures(workspaceId, { now })).resolves.toMatchObject([
      {
        id: procedure.id,
        reason: 'unverified',
        recentGradedCount: 0,
        lastVerified: at(400).toISOString()
      }
    ]);
    await expect(store.verifyMemoryProcedure(workspaceId, procedure.id, now)).resolves.toBe(true);
    await expect(store.listStaleMemoryProcedures(workspaceId, { now })).resolves.toEqual([]);
    await expect(recall('rotate the signing keys')).resolves.toHaveLength(1);
  });

  it('packs to a fixed budget with per-kind quotas instead of taking the top scores', async () => {
    const body = (label: string) => `Encrypted archive rotation note ${label}`;
    for (let index = 0; index < 12; index += 1)
      await addItem(
        'fact',
        {
          title: `archive ${index}`,
          body: body(`fact-${index}`),
          subject: `archive-${index}`,
          object: `value-${index}`
        },
        { predicate: 'located_at' }
      );
    for (let index = 0; index < 12; index += 1)
      await addItem('episode', { title: `rotation ${index}`, body: body(`episode-${index}`) });

    const generous = await recall('encrypted archive rotation', { budgetTokens: 6_000 });
    expect(generous.length).toBeGreaterThan(8);
    expect(new Set(generous.map((hit) => hit.kind))).toEqual(new Set(['fact', 'episode']));
    // Episodes are capped at eight even when they would otherwise sweep the ranking.
    expect(generous.filter((hit) => hit.kind === 'episode')).toHaveLength(8);

    const tight = await recall('encrypted archive rotation', { budgetTokens: 40 });
    expect(tight.length).toBeLessThan(generous.length);
    expect(tight.reduce((total, hit) => total + hit.tokensEst, 0)).toBeLessThanOrEqual(40);
  });

  it('caps how much of the fact slot a single loud subject can take', async () => {
    for (let index = 0; index < 8; index += 1)
      await addItem(
        'fact',
        {
          title: `nginx note ${index}`,
          body: `The nginx config sets header number ${index}.`,
          subject: 'nginx',
          object: `header-${index}`
        },
        { predicate: 'related_to' }
      );
    const hits = await recall('nginx config header');
    expect(hits).toHaveLength(4);
  });

  it('returns the same order twice, which is what keeps the cached prefix alive', async () => {
    await addItem(
      'fact',
      {
        title: 'shell',
        body: 'The owner uses fish.',
        subject: 'owner',
        object: 'fish'
      },
      { predicate: 'default_shell' }
    );
    await addItem('episode', { title: 'shell change', body: 'Switched the login shell to fish.' });
    await addSource('$ chsh -s /usr/bin/fish');

    const first = await recall('which shell does the owner use');
    const second = await recall('which shell does the owner use');
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id));

    const pack = renderMemoryPack(
      first.map((hit) => ({
        id: hit.id,
        kind: hit.kind,
        trust: hit.trust,
        observedAt: hit.observedAt,
        validFrom: hit.validFrom,
        validTo: hit.validTo,
        title: null,
        tags: [],
        body: opened(hit.documentCiphertext)
      }))
    );
    const stored = await store.saveMemoryPack({
      taskId: (await store.createTask(taskInput(userId, workspaceId))).id,
      workspaceId,
      bodyCiphertext: sealed(pack.body),
      sha256: pack.sha256,
      itemIds: pack.itemIds,
      tokensEst: pack.tokensEst
    });

    // A worker that restarts mid-task must re-read the bytes it already emitted, not re-rank.
    const rewritten = await store.saveMemoryPack({
      taskId: stored.taskId,
      workspaceId,
      bodyCiphertext: sealed('a different pack'),
      sha256: 'different',
      itemIds: [],
      tokensEst: 0
    });
    expect(rewritten.sha256).toBe(pack.sha256);
    await expect(store.getMemoryPack(stored.taskId)).resolves.toMatchObject({
      sha256: pack.sha256,
      itemIds: pack.itemIds
    });
  });

  it('hands back the words behind a citation, not only the pointer', async () => {
    const body = 'owner: I always deploy with pnpm, never npm.';
    const source = await addSource(body);
    const fact = await addItem(
      'fact',
      {
        title: 'deploy tool',
        body: 'The owner deploys with pnpm.',
        subject: 'owner',
        object: 'pnpm'
      },
      { predicate: 'uses_tool' }
    );
    await expect(
      store.attachMemoryEvidence(fact.id, [{ sourceId: source.id, span: [7, 40] }])
    ).resolves.toBe(1);
    const [evidence] = await store.listMemoryEvidence(fact.id);
    expect(evidence).toMatchObject({
      sourceId: source.id,
      span: '[7,40)',
      occurredAt: now.toISOString(),
      channel: 'terminal',
      chunkIndex: 0
    });
    /*
     * The whole of what this method was missing, and the reason it had no caller anywhere.
     *
     * It selected the id, the range and the instant and NOT `body_ciphertext`, so athanor could
     * name the exact character range of the exact stored turn behind a remembered fact and hand
     * back a reference nothing could follow. The row now carries the sealed body, and the span
     * addresses the plaintext the key holder opens - which is why the cut is asserted here on the
     * opened text rather than expected from the store, which cannot read it.
     */
    expect(opened(evidence!.bodyCiphertext)).toBe(body);
    expect(opened(evidence!.bodyCiphertext).slice(7, 40)).toBe('I always deploy with pnpm, never ');
  });

  it('cites the tool call behind a memory, and refuses to fetch anything else with it', async () => {
    const task = await store.createTask({
      userId,
      workspaceId,
      titleCiphertext: sealed('deploy'),
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'vendor/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: sealed('deploy the gateway')
    });
    const result = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'tool_result',
      summary: 'Encrypted tool result event',
      payloadCiphertext: sealed('{"toolCallId":"call-1","result":"exit 0"}')
    });
    // A second row of a different kind, filed against the same conversation. The reach may never
    // return one of these, whatever a citation says, and the assertion below is what says so.
    const warning = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'warning',
      summary: 'Encrypted warning event',
      payloadCiphertext: sealed('{"toolCallId":"call-2","result":"a hostile page"}')
    });
    const episode = await addItem(
      'episode',
      { body: 'Deployed the gateway.' },
      { taskId: task.id }
    );

    await expect(
      store.attachMemoryCitedCalls(episode.id, [
        { toolCallId: 'call-1', eventId: result.id },
        { toolCallId: 'call-2', eventId: warning.id }
      ])
    ).resolves.toBe(2);
    const cited = await store.listMemoryCitedCalls(episode.id);
    expect(cited.map((call) => call.toolCallId)).toEqual(['call-1']);
    expect(cited[0]).toMatchObject({ eventId: result.id, taskId: task.id });
    expect(opened(cited[0]!.payloadCiphertext)).toContain('exit 0');

    // Deleting the conversation takes the pointer with it, which is what makes "reversible" true
    // of the reach as well as of the memory: the row cannot outlive the result it names.
    await store.deleteTask(userId, task.id);
    await expect(store.listMemoryCitedCalls(episode.id)).resolves.toEqual([]);
  });

  /**
   * Consolidation demotes and de-indexes; it does not drop, and it does not exempt.
   *
   * This case used to assert that a cited old row stayed in the lexical index, which was the
   * behaviour of a pass whose `indexed=FALSE` also erased `body_tokens`: an exemption was the only
   * thing standing between a curated fact and provenance nobody could ever search for again.
   * Measured against the only production writer of `mem.source`, that exemption did not narrow the
   * pass, it switched it off - `recordTurnEpisode` cites every chunk it writes - so the horizon had
   * never once run and the verbatim index was bounded by nothing.
   *
   * The pass erases nothing now, so both old rows leave the index and both keep every byte they
   * were written with. The assertions below are the new contract in full: what leaves is index
   * membership, what stays is the sealed body, the keyed tokens and the vector those tokens make.
   */
  it('consolidates by de-indexing old verbatim text and keeping every byte of it', async () => {
    const cited = await addSource('$ nginx -t\nconfiguration file test is successful', at(900));
    const uncited = await addSource('$ ls /tmp\nnothing interesting here', at(900));
    const recent = await addSource('$ uptime\nup 3 days', at(1));
    const fact = await addItem(
      'fact',
      {
        title: 'nginx config',
        body: 'The nginx config passes its own test.',
        subject: 'nginx',
        object: 'valid'
      },
      { predicate: 'related_to', observedAt: at(900), validFrom: at(900) }
    );
    await store.attachMemoryEvidence(fact.id, [{ sourceId: cited.id }]);
    const pinned = await addItem(
      'fact',
      { title: 'owner name', body: 'The owner is Ada.', subject: 'owner', object: 'ada' },
      { predicate: 'related_to', observedAt: at(900), validFrom: at(900), pin: true }
    );
    await store.recordMemoryUse({ workspaceId, itemIds: [fact.id], cited: true, outcome: 'ok' });

    const report = await store.consolidateMemory(workspaceId, { now });
    expect(report.itemsArchived).toBeGreaterThan(0);
    // Both old rows, the cited one included. Under the exemption this was 1 and the pass could
    // never reach a row production had written.
    expect(report.sourcesUnindexed).toBe(2);

    const indexedNow = await database.query<{
      id: string;
      indexed: boolean;
      tokens: string;
      tsv: string | null;
    }>(
      'SELECT id, indexed, body_tokens AS tokens, tsv::text AS tsv FROM mem.source ORDER BY occurred_at'
    );
    const rows = new Map(indexedNow.rows.map((row) => [row.id, row]));
    expect(rows.size).toBe(3);
    expect(rows.get(cited.id)?.indexed).toBe(false);
    expect(rows.get(uncited.id)?.indexed).toBe(false);
    expect(rows.get(recent.id)?.indexed).toBe(true);
    // And nothing that cannot be got back was touched: the keyed lexemes and the vector they make
    // are on every row, archived or not, which is what makes de-indexing a tier rather than a loss.
    for (const row of rows.values()) {
      expect(row.tokens.length).toBeGreaterThan(0);
      expect(row.tsv).not.toBeNull();
    }
    // The citation the exemption existed to protect opens exactly as it did before.
    const evidence = await store.listMemoryEvidence(fact.id);
    expect(evidence.map((edge) => edge.sourceId)).toEqual([cited.id]);
    expect(opened(evidence[0]!.bodyCiphertext)).toContain('configuration file test is successful');

    // A pinned fact is exempt, and salience reflects use rather than a stored decayed score.
    await expect(store.getMemoryItem(workspaceId, pinned.id)).resolves.toMatchObject({
      status: 'active'
    });
    const scored = await store.getMemoryItem(workspaceId, fact.id);
    expect(scored!.salience).toBeGreaterThan(0);
    expect(scored!.useCount).toBe(1);
    expect(scored!.citedCount).toBe(1);
  });

  it('seals provenance and still reaches a compacted source by where it came from', async () => {
    const locator = '/srv/athanor/deploy.log';
    const source = await addSource('deploy finished in 41s', at(900), locator);
    await addSource('unrelated output', at(900), '/tmp/other.log');

    // Compaction takes the row out of the lexical index without deleting a byte of it.
    await store.consolidateMemory(workspaceId, { now });
    const compacted = await memory.listMemorySourcesByOrigin(
      workspaceId,
      memoryOriginKey(locator, key)
    );
    expect(compacted).toHaveLength(1);
    expect(compacted[0]!.id).toBe(source.id);
    expect(compacted[0]!.indexed).toBe(false);
    expect(opened(compacted[0]!.bodyCiphertext)).toBe('deploy finished in 41s');
    expect(opened(compacted[0]!.originCiphertext!)).toBe(locator);

    // The path itself is never written in the clear, only its keyed handle.
    const stored = await database.query<{ origin_ciphertext: unknown; origin_key: string }>(
      'SELECT origin_ciphertext, origin_key FROM mem.source WHERE id=$1',
      [source.id]
    );
    expect(JSON.stringify(stored.rows[0])).not.toContain('srv');
    expect(stored.rows[0]?.origin_key).toBe(memoryOriginKey(locator, key));
  });

  it('rebuilds corpus statistics from the stored index without touching plaintext', async () => {
    await addItem(
      'fact',
      {
        title: 'shell',
        body: 'The owner uses fish and fish and fish.',
        subject: 'owner',
        object: 'fish'
      },
      { predicate: 'default_shell' }
    );
    await addItem('episode', { body: 'The owner uses fish for scripting.' });
    await store.rebuildMemoryCorpusStats(workspaceId);

    const stats = await database.query<{ n_docs: string; sum_len: string }>(
      'SELECT n_docs, sum_len FROM mem.corpus_stats WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(stats.rows[0]?.n_docs)).toBe(2);
    expect(Number(stats.rows[0]?.sum_len)).toBeGreaterThan(0);

    // Every lexeme is kept, including the ones that occur once. A term in exactly one document is
    // the most discriminative term there is; a term in none cannot match at all. Dropping the df=1
    // rows made those two cases indistinguishable, and the query planner has to tell them apart to
    // choose which of a long request's terms to search on.
    const df = await database.query<{ lexeme: string; df: string }>(
      'SELECT lexeme, df FROM mem.lexeme_df WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(df.rows.length).toBeGreaterThan(0);
    expect(df.rows.some((row) => Number(row.df) === 1)).toBe(true);
    expect(df.rows.some((row) => Number(row.df) > 1)).toBe(true);
    // The statistics table holds keyed tokens, never words.
    expect(df.rows.every((row) => /^[a-p]{16}$/.test(row.lexeme))).toBe(true);
  });

  /*
   * The monthly rebuild empties mem.lexeme_df for the workspace and fills it again, and the AFTER
   * INSERT trigger on every memory write writes to the same table with the same key. A single
   * memory landing between the two - the agent recording one episode during the rebuild - put a
   * row back, and the unguarded INSERT met a unique violation that rolled the whole transaction
   * back, leaving the workspace with **no** document frequencies at all until the next monthly
   * attempt. Every term's df then defaults to 1, BM25 IDF goes uniform, and recall ranking is
   * silently flat for a month with nothing anywhere reporting it.
   *
   * The competing write is injected through the rebuild's own handle because PGlite is one backend
   * and cannot hold a second session; what reaches the INSERT is the row, which is the whole test.
   */
  it('survives a memory landing between emptying the corpus statistics and refilling them', async () => {
    await addItem('episode', { body: 'The owner uses fish and fish for scripting.' });
    await addItem('episode', { body: 'A second episode mentioning fish once.' });
    const lexeme = (
      await database.query<{ lexeme: string }>(
        'SELECT lexeme FROM mem.lexeme_df WHERE workspace_id=$1 ORDER BY df DESC, lexeme LIMIT 1',
        [workspaceId]
      )
    ).rows[0]!.lexeme;

    /** The rebuild's database, with one memory write committing in the gap after the DELETE. */
    const raced = (real: Database): Database => ({
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const result = await real.query<T>(sql, params);
        if (sql.includes('DELETE FROM mem.lexeme_df'))
          await real.query('INSERT INTO mem.lexeme_df(workspace_id, lexeme, df) VALUES ($1,$2,1)', [
            workspaceId,
            lexeme
          ]);
        return result;
      },
      exec: (sql: string) => real.exec(sql),
      transaction: (callback) => real.transaction((scoped) => callback(raced(scoped))),
      withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
        real.withAdvisoryLock(lock, callback),
      notify: (channel, payload) => real.notify(channel, payload),
      listen: (channel, handler) => real.listen(channel, handler),
      close: async () => undefined
    });

    await new DataStore(raced(database)).rebuildMemoryCorpusStats(workspaceId);

    const df = await database.query<{ lexeme: string; df: string }>(
      'SELECT lexeme, df FROM mem.lexeme_df WHERE workspace_id=$1 AND lexeme=$2',
      [workspaceId, lexeme]
    );
    // The counted value, not the 1 the racing write left behind, and above all not an empty table.
    expect(Number(df.rows[0]?.df)).toBe(2);
    const all = await database.query('SELECT lexeme FROM mem.lexeme_df WHERE workspace_id=$1', [
      workspaceId
    ]);
    expect(all.rows.length).toBeGreaterThan(1);
  });

  it('returns what the caller does not already hold, not a second copy of it', async () => {
    // The whole point of a mid-task recall: the pack is frozen and already in the prompt, so the
    // rows it printed are the one set the agent gains nothing by being sent again.
    const held = await addItem(
      'fact',
      {
        title: 'relay listen address',
        body: 'athanor-relay binds 0.0.0.0:8443.',
        subject: 'athanor-relay',
        object: '0.0.0.0:8443'
      },
      { predicate: 'runs_on' }
    );
    const other = await addItem('episode', {
      title: 'relay would not start',
      body: 'athanor-relay was not enabled at boot, so a reboot left it stopped.'
    });

    const everything = await recall('what do we know about athanor-relay');
    expect(everything.map((row) => row.id).sort()).toEqual([held.id, other.id].sort());

    const remaining = await recall('what do we know about athanor-relay', {
      excludeIds: [held.id]
    });
    expect(remaining.map((row) => row.id)).toEqual([other.id]);

    // A pack id the model quoted back imprecisely must narrow nothing rather than fail the turn.
    const garbled = await recall('what do we know about athanor-relay', {
      excludeIds: ['not-a-uuid']
    });
    expect(garbled.map((row) => row.id).sort()).toEqual([held.id, other.id].sort());
  });

  it('excludes a verbatim row by id as well as a curated one', async () => {
    const source = await addSource('athanor-relay is listening on 0.0.0.0:8443 again.');
    expect((await recall('is athanor-relay listening')).map((row) => row.id)).toContain(source.id);
    expect(
      (await recall('is athanor-relay listening', { excludeIds: [source.id] })).map((row) => row.id)
    ).not.toContain(source.id);
  });

  it('spreads a verbatim search across conversations instead of returning one thread', async () => {
    // Turns inside one thread share its vocabulary, so raw BM25 over a transcript returns the same
    // conversation several times over and the other threads that also answer never appear.
    // Real task rows: mem.source.task_id is a foreign key, so deleting a conversation deletes the
    // verbatim turns it produced. Invented ids can no longer stand in for one.
    const conversations: string[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const conversation = await store.createTask({
        userId,
        workspaceId,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        titleCiphertext: sealed(`thread ${suffix}`),
        nameIndex: UNINDEXED_NAME,
        promptCiphertext: sealed(`thread ${suffix}`)
      });
      conversations.push(conversation.id);
    }
    let minute = 0;
    for (const taskId of conversations)
      for (const line of [
        'the certificate renewal failed validation again last night',
        'acme.sh asked for validation before the record had propagated',
        'the renewal went through after a wait was added before validation',
        'validation succeeded on the retry'
      ]) {
        const index = buildMemorySourceIndex(line, key);
        minute += 1;
        await store.createMemorySource({
          userId,
          workspaceId,
          channel: 'chat',
          taskId,
          bodyCiphertext: sealed(line),
          bodyTokens: index.bodyTokens,
          tokensEst: index.tokensEst,
          indexed: index.indexed,
          occurredAt: new Date(now.getTime() - minute * 60_000)
        });
      }
    await store.rebuildMemoryCorpusStats(workspaceId);

    const spread = await store.searchMemorySources({
      workspaceId,
      plan: planMemoryQuery('why did the certificate renewal fail validation', key),
      limit: 6
    });
    expect(spread).toHaveLength(6);
    expect(new Set(spread.map((hit) => hit.taskId)).size).toBe(conversations.length);
    for (const taskId of conversations)
      expect(spread.filter((hit) => hit.taskId === taskId).length).toBeLessThanOrEqual(
        MEMORY_SOURCE_SEARCH_PER_TASK
      );
    // Score order still decides; the cap only ever moves a row down.
    expect(spread.map((hit) => hit.score)).toEqual(
      [...spread.map((hit) => hit.score)].sort((left, right) => right - left)
    );

    // Inside one conversation there is no second thread to make room for, so the cap lifts.
    const inside = await store.searchMemorySources({
      workspaceId,
      plan: planMemoryQuery('why did the certificate renewal fail validation', key),
      taskId: conversations[0]!,
      limit: 6
    });
    expect(inside.length).toBeGreaterThan(MEMORY_SOURCE_SEARCH_PER_TASK);
    expect(inside.every((hit) => hit.taskId === conversations[0])).toBe(true);
  });

  it('reports how far back the verbatim layer reaches, so an empty search can be honest', async () => {
    await expect(store.memorySourceCoverage(workspaceId)).resolves.toEqual({
      turns: 0,
      conversations: 0,
      earliest: null,
      archived: { turns: 0, earliest: null }
    });

    // A real task row, because mem.source.task_id now cascades from it.
    const conversation = await store.createTask({
      userId,
      workspaceId,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      titleCiphertext: sealed('reach'),
      nameIndex: UNINDEXED_NAME,
      promptCiphertext: sealed('reach')
    });
    const taskId = conversation.id;
    for (const [line, days] of [
      ['the relay stopped after the reboot', 40],
      ['I enabled it at boot', 40]
    ] as const) {
      const index = buildMemorySourceIndex(line, key);
      await store.createMemorySource({
        userId,
        workspaceId,
        channel: 'chat',
        taskId,
        bodyCiphertext: sealed(line),
        bodyTokens: index.bodyTokens,
        tokensEst: index.tokensEst,
        indexed: index.indexed,
        occurredAt: at(days)
      });
    }
    await expect(store.memorySourceCoverage(workspaceId)).resolves.toEqual({
      turns: 2,
      conversations: 1,
      earliest: at(40).toISOString(),
      // Nothing has been past the horizon yet, and the two tiers are counted separately so that a
      // search which found nothing can say which of them it looked in.
      archived: { turns: 0, earliest: null }
    });
  });

  it('carries no embedding surface, because nothing ever wrote one', async () => {
    // Migration 35 created halfvec columns, two HNSW indexes and an embed_state enum for a queue
    // that was never built; migration 54 removes them. A dead index is worse than no index - it
    // reads as a component the retrieval path depends on, and no query has ever had a branch for
    // it. This asserts the removal actually ran rather than being described in a comment.
    const columns = await database.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='mem' AND column_name IN ('embedding','embed_state')`
    );
    expect(columns.rows).toEqual([]);
    const type = await database.query<{ typname: string }>(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname='mem' AND t.typname='embed_state'`
    );
    expect(type.rows).toEqual([]);
  });

  /**
   * The delete an owner is promised, asserted where the statements live rather than where the
   * route happened to hold them.
   *
   * This repository's own record of the incident is that *a delete must find every copy -
   * including `mem.pack`, the copy that actually reaches the model*, and until this test there was
   * nothing anywhere that would notice if one of the six statements stopped running. Retirement is
   * a status; this is removal, and the four things it has to reach are all things the row was
   * copied into: the verbatim chunks that hang off the episode, the links pointing at it from
   * either side, every sealed bundle quoting the row *or one of its chunks*, and the vote the
   * episode cast for a fact nothing has promoted yet.
   *
   * The bundle is the one that decides whether any of this is true from where the agent stands: a
   * parked conversation re-uses those bytes for weeks without reading a row again, so a delete that
   * leaves the bundle is a computer that goes on reciting the line the owner just deleted.
   */
  it('forgets an episode everywhere the box had copied it', async () => {
    const addChunk = async (body: string, episodeId: string | null) => {
      const index = buildMemorySourceIndex(body, key);
      return store.createMemorySource({
        userId,
        workspaceId,
        channel: 'chat',
        bodyCiphertext: sealed(body),
        bodyTokens: index.bodyTokens,
        tokensEst: index.tokensEst,
        indexed: index.indexed,
        occurredAt: now,
        episodeId
      });
    };
    const packFor = async (itemIds: string[]) => {
      const task = await store.createTask(taskInput(userId, workspaceId));
      await store.saveMemoryPack({
        taskId: task.id,
        workspaceId,
        bodyCiphertext: sealed('rendered brief'),
        sha256: `sha-${itemIds.join('-')}`,
        itemIds,
        tokensEst: 12
      });
      return task.id;
    };

    const episode = await addItem('episode', {
      title: 'the deploy',
      body: 'owner: deploy this with pnpm, never npm.',
      subject: 'owner',
      object: 'pnpm'
    });
    const survivor = await addItem('episode', {
      title: 'the other deploy',
      body: 'owner: the staging box is deployed the same way.',
      subject: 'owner',
      object: 'pnpm'
    });
    const keeper = await addItem(
      'fact',
      {
        title: 'deploy tool',
        body: 'The owner deploys with pnpm.',
        subject: 'owner',
        object: 'pnpm'
      },
      { predicate: 'uses_tool' }
    );

    const chunkA = await addChunk('owner: deploy this with pnpm', episode.id);
    const chunkB = await addChunk('assistant: deploying with pnpm', episode.id);
    const looseChunk = await addChunk('owner: unrelated, about the printer', null);

    // Both directions, because only one of them is reached by the foreign key: `src_id` cascades
    // from `mem.item` and `dst_id` does not reference anything at all.
    await memory.linkMemoryItems({ srcId: episode.id, dstId: keeper.id, rel: 'about' });
    await memory.linkMemoryItems({ srcId: keeper.id, dstId: episode.id, rel: 'derived_from' });
    await memory.linkMemoryItems({ srcId: keeper.id, dstId: looseChunk.id, rel: 'about' });

    const packCitingItem = await packFor([episode.id]);
    const packCitingChunk = await packFor([chunkA.id]);
    const packCitingNeither = await packFor([keeper.id, looseChunk.id]);

    const candidate = {
      workspaceId,
      subjectKey: memorySubjectKey('owner', key),
      predicate: 'uses_tool',
      objectKey: memorySubjectKey('pnpm', key)
    };
    // Two turns vouched for this one, so forgetting one leaves a draft with a turn behind it.
    await store.observeMemoryFactCandidate({ ...candidate, episodeId: episode.id });
    await store.observeMemoryFactCandidate({ ...candidate, episodeId: survivor.id });
    // This one is the deleted turn's word alone: a draft with nothing behind it is not a draft.
    const soleWitness = {
      workspaceId,
      subjectKey: memorySubjectKey('owner', key),
      predicate: 'default_shell',
      objectKey: memorySubjectKey('fish', key)
    };
    await store.observeMemoryFactCandidate({ ...soleWitness, episodeId: episode.id });
    const untouched = {
      workspaceId,
      subjectKey: memorySubjectKey('staging box', key),
      predicate: 'located_at',
      objectKey: memorySubjectKey('rack 3', key)
    };
    await store.observeMemoryFactCandidate({ ...untouched, episodeId: survivor.id });

    await expect(store.forgetMemoryItem(workspaceId, episode.id)).resolves.toBe(true);

    // The item itself, and nothing beside it.
    await expect(store.getMemoryItem(workspaceId, episode.id)).resolves.toBeNull();
    await expect(store.getMemoryItem(workspaceId, survivor.id)).resolves.not.toBeNull();
    await expect(store.getMemoryItem(workspaceId, keeper.id)).resolves.not.toBeNull();

    // The verbatim chunks that hung off it, and only those.
    const sources = await database.query<{ id: string }>(
      'SELECT id FROM mem.source WHERE workspace_id=$1 ORDER BY id',
      [workspaceId]
    );
    expect(sources.rows.map((row) => row.id)).toEqual([looseChunk.id]);
    expect([chunkA.id, chunkB.id]).not.toContain(looseChunk.id);

    // Every link that named it, from either end.
    await expect(memory.listMemoryLinks(episode.id)).resolves.toEqual([]);
    await expect(memory.listMemoryLinks(keeper.id)).resolves.toMatchObject([
      { srcId: keeper.id, dstId: looseChunk.id, rel: 'about' }
    ]);

    // Every sealed bundle that quoted the row or one of its chunks - and no other.
    await expect(store.getMemoryPack(packCitingItem)).resolves.toBeNull();
    await expect(store.getMemoryPack(packCitingChunk)).resolves.toBeNull();
    await expect(store.getMemoryPack(packCitingNeither)).resolves.not.toBeNull();

    // The votes: one decremented, one emptied and swept, one never touched.
    const candidates = await database.query<{
      predicate: string;
      n_episodes: number;
      episode_ids: string[];
    }>(
      'SELECT predicate,n_episodes,episode_ids FROM mem.fact_candidate WHERE workspace_id=$1 ORDER BY predicate',
      [workspaceId]
    );
    expect(candidates.rows).toEqual([
      { predicate: 'located_at', n_episodes: 1, episode_ids: [survivor.id] },
      { predicate: 'uses_tool', n_episodes: 1, episode_ids: [survivor.id] }
    ]);

    // Removal reports what it removed, so a second attempt is not a silent success.
    await expect(store.forgetMemoryItem(workspaceId, episode.id)).resolves.toBe(false);
  });

  /**
   * The pair above is one machine, and this is the assertion that says so out loud.
   *
   * `forgetMemoryItem` drops the sole-witness drafts first and only then decrements the survivors.
   * Written the other way round - decrement first, sweep the emptied rows a line later - the two
   * statements produce exactly the same final state, so no test of the outcome can tell them apart.
   * What differs is the state *between* them: a draft whose only witness was just deleted, floored
   * at `n_episodes = 1` by `GREATEST(n_episodes - 1, 1)` with an EMPTY `episode_ids`, which is
   * precisely what `listPromotableMemoryFactCandidates(minEpisodes: 1)` selects for.
   *
   * So the property under test is not the outcome but the guard: with the decrement standing alone,
   * `CHECK (n_episodes > 0)` refuses it. The floor was never a safety net; it was the thing that
   * kept the constraint quiet. Remove the DELETE from `forgetMemoryItem` and this is what happens
   * instead of a silent promotion.
   */
  it('lets the column constraint refuse the vote-removal that is not preceded by the sweep', async () => {
    const witness = await addItem('episode', {
      title: 'the shell',
      body: 'owner: my shell is fish',
      subject: 'owner',
      object: 'fish'
    });
    const draft = {
      workspaceId,
      subjectKey: memorySubjectKey('owner', key),
      predicate: 'default_shell',
      objectKey: memorySubjectKey('fish', key)
    };
    await store.observeMemoryFactCandidate({ ...draft, episodeId: witness.id });

    // The decrement on its own, which is what statement 5 would be if statement 4 were removed.
    await expect(
      database.query(
        `UPDATE mem.fact_candidate
            SET episode_ids = array_remove(episode_ids, $2::uuid),
                n_episodes = n_episodes - 1
          WHERE workspace_id=$1 AND $2::uuid = ANY(episode_ids)`,
        [workspaceId, witness.id]
      )
    ).rejects.toThrow(/n_episodes/);

    // And through the real path the draft is gone rather than left at one with nothing behind it.
    await expect(store.forgetMemoryItem(workspaceId, witness.id)).resolves.toBe(true);
    const left = await database.query<{ n_episodes: number; episode_ids: string[] }>(
      'SELECT n_episodes,episode_ids FROM mem.fact_candidate WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(left.rows).toEqual([]);
  });
});

/**
 * Which of mem.item's indexes the recall statement can actually reach.
 *
 * Not which ones it chooses on a fixture this size - a planner takes a sequential scan over a couple
 * of hundred rows whatever indexes exist, and a test asserting the choice would be committing a cost
 * estimate that moves with the corpus. `enable_seqscan = off` takes the choice away, and what is
 * left is the property worth holding: given no alternative, can the plan reach the index at all?
 *
 * Until migration 67 the answer was no, in every channel and for every caller. `MEMORY_ITEM_ADMISSIBLE`
 * reaches status through a disjunction whose other two arms are bound parameters arriving from a CTE,
 * so PostgreSQL cannot prove `status = 'active'` of any row the statement might want and pushes the
 * relaxation of the whole disjunction down to the scan instead. Three partial indexes carried that
 * predicate and none of them was usable - including for a plain recall with no widening option set,
 * which is the one every task does. Measured on 50,000 items the lexical channel sequentially
 * scanned all of them, at 296 ms a call against 80 ms once the predicate came off.
 */
describe('the indexes the recall statement can reach', () => {
  let database: Database;
  let store: DataStore;
  let workspaceId: string;
  const recallCalls: Array<{ sql: string; params: unknown[] }> = [];

  const key = memoryIndexKey(Buffer.alloc(32, 9));
  const now = new Date('2026-07-31T08:00:00.000Z');

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    // Every statement the store issues, kept so the recall can be replayed under EXPLAIN with the
    // parameters it was actually given. A hand-written imitation of the query is exactly what let
    // this defect be measured as innocent: the audit's own probe used one, saw a bitmap index scan,
    // and concluded only the two widening options were paying for a table scan.
    const recorded: Database = {
      query: (sql, params) => {
        if (sql === MEMORY_RECALL_SQL) recallCalls.push({ sql, params: params ?? [] });
        return database.query(sql, params);
      },
      exec: (sql) => database.exec(sql),
      transaction: (callback) => database.transaction(callback),
      withAdvisoryLock: (lock, callback) => database.withAdvisoryLock(lock, callback),
      notify: (channel, payload) => database.notify(channel, payload),
      listen: (channel, handler) => database.listen(channel, handler),
      close: () => database.close()
    };
    store = new DataStore(recorded);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'computer'));
    workspaceId = workspace.id;

    // Enough rows, and enough spread between a common word and a rare one, that a GIN probe is a
    // meaningfully different plan from a scan. The retirements are named rather than derived from
    // the same modulus that decides the rare word: two rows carrying it are superseded and two are
    // archived, so each widened arm has something of its own to find instead of agreeing with the
    // default one by having nowhere else to look.
    // Facts, deliberately: the per-kind quota fills its episode slots from the active rows before a
    // retired one is reached, so retiring episodes here would have proved only that the quota works.
    const retired = new Map<number, 'superseded' | 'archived'>([
      [24, 'superseded'],
      [72, 'superseded'],
      [48, 'archived'],
      [96, 'archived'],
      [7, 'superseded'],
      [21, 'archived']
    ]);
    for (let index = 0; index < 160; index += 1) {
      const body =
        `deploy pipeline log entry ${index} routine chatter ` +
        (index % 8 === 0 ? 'chinstrap' : 'ordinary');
      const item = await store.createMemoryItem({
        userId: user.id,
        workspaceId,
        kind: index % 3 === 0 ? 'fact' : 'episode',
        trust: 'stated',
        documentCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: 'x' },
        index: buildMemoryItemIndex(
          {
            title: `entry ${index}`,
            tags: ['pipeline'],
            body,
            subject: `service-${index}`,
            object: 'somewhere'
          },
          key
        ),
        observedAt: now,
        validFrom: now,
        ...(index % 3 === 0 ? { predicate: 'related_to' } : {})
      });
      const status = retired.get(index);
      if (status)
        await database.query(`UPDATE mem.item SET status=$2::mem.status, valid_to=$3 WHERE id=$1`, [
          item.id,
          status,
          now
        ]);
    }
    await store.rebuildMemoryCorpusStats(workspaceId);
    await database.exec('VACUUM ANALYZE mem.item');
  });

  afterEach(async () => database.close());

  /** The plan the real statement takes with a sequential scan ruled out. */
  const planFor = async (options: Partial<RecallMemoryInput> = {}): Promise<string> => {
    recallCalls.length = 0;
    await store.recallMemoryCandidates({
      workspaceId,
      plan: planMemoryQuery('chinstrap service-3', key),
      now,
      order: 'relevance',
      ...options
    });
    expect(recallCalls).toHaveLength(1);
    const actual = recallCalls[0]!;
    await database.exec('SET enable_seqscan = off');
    try {
      const explained = await database.query<Record<string, unknown>>(
        `EXPLAIN (COSTS OFF) ${actual.sql}`,
        actual.params
      );
      return explained.rows.map((row) => String(Object.values(row)[0])).join('\n');
    } finally {
      await database.exec('SET enable_seqscan = on');
    }
  };

  it('drives an ordinary recall from the indexes rather than reading every memory the box holds', async () => {
    const plan = await planFor();
    expect(plan).toContain('mem_item_tsv_gin');
    expect(plan).toContain('mem_item_subject_idx');
    expect(plan).not.toMatch(/Seq Scan on item\b/);
  });

  it('reaches them just the same when the caller asks for what a later observation replaced', async () => {
    // The two switches the tool hands the model. The audit read these as the cause of the scan; they
    // are not, and the point of asserting them is that no arm may be the one that loses the index.
    const plan = await planFor({ includeSuperseded: true });
    expect(plan).toContain('mem_item_tsv_gin');
    expect(plan).not.toMatch(/Seq Scan on item\b/);
  });

  it('reaches them just the same when the caller opens the archive', async () => {
    const plan = await planFor({ scope: 'archive' });
    expect(plan).toContain('mem_item_tsv_gin');
    expect(plan).not.toMatch(/Seq Scan on item\b/);
  });

  it('returns the same rows it always did, because an index predicate decides storage and not results', async () => {
    // The whole safety argument for widening three indexes in one migration, stated as a test: the
    // status filter is still in the statement, so the archived and superseded rows stay out of a
    // default recall exactly as before, and only the widened arms see them.
    const query = { workspaceId, plan: planMemoryQuery('chinstrap', key), now };
    const statusOf = async (options: Partial<RecallMemoryInput>) => {
      const rows = await store.recallMemoryCandidates({ ...query, ...options });
      return [...new Set(rows.map((row) => row.status))].sort();
    };
    expect(await statusOf({})).toEqual(['active']);
    expect(await statusOf({ includeSuperseded: true })).toEqual(['active', 'superseded']);
    expect(await statusOf({ scope: 'archive' })).toEqual(['active', 'archived']);
  });
});

describe('spending caps in real currency', () => {
  let database: Database;
  let store: DataStore;
  let billing: BillingStore;
  let userId: string;
  let workspaceId: string;

  const envelope: EncryptedEnvelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' };
  const now = new Date('2026-07-15T12:00:00.000Z');
  const bounds = spendWindowBounds('UTC', now);

  /** One settled model call, backdated so the window arithmetic can be asserted exactly. */
  const bill = async (input: {
    key: string;
    costUsd: number;
    taskId?: string;
    at?: Date;
    modelRef?: string;
  }) => {
    await store.recordUsage({
      userId,
      workspaceId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 1_000,
      unit: 'tokens',
      credits: 0.25,
      state: 'settled',
      idempotencyKey: input.key,
      providerRef: input.modelRef ?? 'openrouter:z-ai/glm-5.2',
      costUsd: input.costUsd
    });
    await database.query('UPDATE usage_entries SET created_at=$2 WHERE idempotency_key=$1', [
      input.key,
      (input.at ?? now).toISOString()
    ]);
  };

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    billing = new BillingStore(database);
    const user = await store.createUser({ username: 'payer', displayName: 'Payer' });
    userId = user.id;
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Spending'));
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  it('aggregates what the provider actually billed per task, per day and per month', async () => {
    const task = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 5 });
    const other = await store.createTask(taskInput(userId, workspaceId));
    await bill({ key: 'call-1', costUsd: 0.5, taskId: task.id });
    await bill({ key: 'call-2', costUsd: 0.25, taskId: task.id });
    await bill({
      key: 'call-3',
      costUsd: 2,
      taskId: other.id,
      modelRef: 'openrouter:anthropic/claude'
    });
    // Earlier in the same month but a different day, so it counts monthly and not daily.
    await bill({
      key: 'call-4',
      costUsd: 4,
      taskId: other.id,
      at: new Date('2026-07-02T09:00:00Z')
    });
    // Last month, so it counts in neither window.
    await bill({ key: 'call-5', costUsd: 90, at: new Date('2026-06-30T09:00:00Z') });

    await expect(store.taskSpend(task.id)).resolves.toBeCloseTo(0.75, 6);
    await expect(
      store.spendTotal(userId, bounds.daily.start, bounds.daily.end)
    ).resolves.toBeCloseTo(2.75, 6);
    await expect(
      store.spendTotal(userId, bounds.monthly.start, bounds.monthly.end)
    ).resolves.toBeCloseTo(6.75, 6);

    await expect(
      store.spendByModel(userId, bounds.monthly.start, bounds.monthly.end)
    ).resolves.toEqual([
      { key: 'z-ai/glm-5.2', costUsd: 4.75, calls: 3 },
      { key: 'anthropic/claude', costUsd: 2, calls: 1 }
    ]);
    await expect(
      billing.spendByTask(userId, bounds.monthly.start, bounds.monthly.end)
    ).resolves.toEqual([
      { key: other.id, costUsd: 6, calls: 2 },
      { key: task.id, costUsd: 0.75, calls: 2 }
    ]);
    await expect(
      billing.spendByDay(userId, bounds.monthly.start, bounds.monthly.end, 'UTC')
    ).resolves.toEqual([
      { key: '2026-07-02', costUsd: 4, calls: 1 },
      { key: '2026-07-15', costUsd: 2.75, calls: 3 }
    ]);
  });

  it('refuses to start work that would take the day past its cap, and warns before that', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5, warnAtPercent: 60 });
    await bill({ key: 'spent-today', costUsd: 2 });

    await expect(store.spendGuard({ userId, estimateUsd: 0.5, now })).resolves.toMatchObject({
      outcome: 'allow'
    });
    const warned = await store.spendGuard({ userId, estimateUsd: 1, now });
    expect(warned).toMatchObject({ outcome: 'warn', warnedBy: ['daily'], blockedBy: null });
    const denied = await store.spendGuard({ userId, estimateUsd: 4, now });
    expect(denied).toMatchObject({ outcome: 'deny', blockedBy: 'daily' });
    expect(denied.windows.find((window) => window.name === 'daily')).toMatchObject({
      spentUsd: 2,
      capUsd: 5,
      warnAtUsd: 3,
      projectedUsd: 6
    });
  });

  it('stops a task at its own ceiling even when the account caps are unset', async () => {
    const task = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 2 });
    await bill({ key: 'task-spend', costUsd: 1.95, taskId: task.id });
    // Close to the ceiling is a warning, not a refusal: the work still runs.
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 0.02, now })
    ).resolves.toMatchObject({ outcome: 'warn', blockedBy: null });
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 0.5, now })
    ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'task' });
  });

  it('counts the unspent headroom of open work against something else starting', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5 });
    const running = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 4 });
    await bill({ key: 'partial', costUsd: 1, taskId: running.id });

    // $4 promised minus $1 already billed leaves $3 that this task may still spend.
    await expect(billing.openSpendCommitment(userId)).resolves.toBeCloseTo(3, 6);
    await expect(
      store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
    ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'daily' });

    // The running task must not be blocked by its own reservation.
    await expect(
      store.spendGuard({
        userId,
        taskId: running.id,
        estimateUsd: 2,
        includeOpenCommitments: true,
        now
      })
    ).resolves.toMatchObject({ outcome: 'allow' });

    // A finished task releases what it never spent.
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [running.id]);
    await expect(billing.openSpendCommitment(userId)).resolves.toBe(0);
    await expect(
      store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
    ).resolves.toMatchObject({ outcome: 'allow' });
  });

  /**
   * A conversation the owner left open overnight has no worker and will spend nothing until they
   * come back to it, at which point the ceiling is priced again. Holding its whole ceiling against
   * the day would have them sitting down to a limit reached by work that never ran.
   */
  it('reserves only what a worker is about to spend, not what a parked conversation might', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5 });
    const task = await store.createTask({ ...taskInput(userId, workspaceId), maxSpendUsd: 4 });
    await bill({ key: 'partial', costUsd: 1, taskId: task.id });

    for (const status of ['awaiting_user', 'awaiting_resource', 'paused']) {
      await database.query('UPDATE tasks SET status=$2 WHERE id=$1', [task.id, status]);
      await expect(billing.openSpendCommitment(userId)).resolves.toBe(0);
      await expect(
        store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
      ).resolves.toMatchObject({ outcome: 'allow' });
    }

    // Back in the queue, and the rest of the ceiling is committed again: a worker is about to
    // spend it, and two starts in the same second must not both fit under the same cap.
    for (const status of ['queued', 'planning', 'running']) {
      await database.query('UPDATE tasks SET status=$2 WHERE id=$1', [task.id, status]);
      await expect(billing.openSpendCommitment(userId)).resolves.toBeCloseTo(3, 6);
      await expect(
        store.spendGuard({ userId, estimateUsd: 2, includeOpenCommitments: true, now })
      ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'daily' });
    }
  });

  it('will not materialise a scheduled run that would breach the cap', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 1 });
    const schedule = await store.createTaskSchedule({
      userId,
      workspaceId,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 5,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    expect(schedule.maxSpendUsd).toBe(5);
    await database.query("UPDATE task_schedules SET next_run_at=NOW()-INTERVAL '1 minute'");
    await store.leaseDueTaskSchedule('scheduler-spend');
    const blocked = await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-spend',
      taskId: '00000000-0000-4000-8000-0000000000a1',
      nextRunAt: null,
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    expect(blocked).toMatchObject({ outcome: 'failed', errorCode: 'spend_cap_reached' });
    expect(blocked?.task.status).toBe('failed');
    expect(blocked?.task.maxSpendUsd).toBe(5);
    // Nothing was reserved for a run that never started.
    await expect(billing.reservedUsageForTask(blocked!.task.id)).resolves.toBe(0);

    // Raising the cap lets the very same schedule through.
    await store.setSpendLimits({ userId, dailyCapUsd: 50 });
    await database.query(
      "UPDATE task_schedules SET enabled=TRUE,next_run_at=NOW()-INTERVAL '1 minute'"
    );
    await store.leaseDueTaskSchedule('scheduler-spend');
    const allowed = await store.materializeTaskSchedule({
      scheduleId: schedule.id,
      workerId: 'scheduler-spend',
      taskId: '00000000-0000-4000-8000-0000000000a2',
      nextRunAt: null,
      resourceClass: 'medium',
      preparingEventCiphertext: envelope,
      failureEventCiphertext: envelope
    });
    expect(allowed).toMatchObject({ outcome: 'queued', errorCode: null });
    expect(allowed?.task.maxSpendUsd).toBe(5);
  });

  it('raises one alert per window occurrence rather than one per model call', async () => {
    const claim = (level: 'warning' | 'exceeded', windowStart: Date) =>
      store.claimSpendAlert({
        userId,
        windowName: 'daily',
        windowStart,
        level,
        spentUsd: 4,
        capUsd: 5
      });
    await expect(claim('warning', bounds.daily.start)).resolves.toBe(true);
    await expect(claim('warning', bounds.daily.start)).resolves.toBe(false);
    // Crossing the hard cap on the same day is a separate thing worth saying.
    await expect(claim('exceeded', bounds.daily.start)).resolves.toBe(true);
    // Tomorrow starts over.
    await expect(claim('warning', bounds.daily.end)).resolves.toBe(true);
    await expect(billing.listSpendAlerts(userId)).resolves.toHaveLength(3);
  });

  it('updates only the caps it was given and validates the zone the windows roll over in', async () => {
    await store.setSpendLimits({
      userId,
      dailyCapUsd: 3,
      monthlyCapUsd: 40,
      timeZone: 'Asia/Tokyo'
    });
    await store.setSpendLimits({ userId, dailyCapUsd: null });
    await expect(store.getSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: null,
      monthlyCapUsd: 40,
      warnAtPercent: 80,
      timeZone: 'Asia/Tokyo'
    });
    await store.setSpendLimits({ userId, warnAtPercent: 50 });
    await expect(store.getSpendLimits(userId)).resolves.toMatchObject({
      monthlyCapUsd: 40,
      warnAtPercent: 50,
      timeZone: 'Asia/Tokyo'
    });
    await expect(store.setSpendLimits({ userId, timeZone: 'Mars/Olympus' })).rejects.toThrow(
      /Unknown IANA time zone/
    );
  });

  /*
   * The pre-flight half of the brake. The three caps above stop a task that is already spending;
   * these stop an over-priced route being chosen at all, which is the only one of the two that
   * works while the owner is asleep. They carry the same contract as the caps for the same reason
   * the caps have it: a ceiling is set once and a cap is adjusted when a run gets away from you, so
   * "I did not mention it" and "remove it" cannot be the same message.
   */
  it('leaves a price ceiling alone when the key is omitted and clears it on an explicit null', async () => {
    await store.setSpendLimits({
      userId,
      maxInputUsdPerMillionTokens: 1.5,
      maxOutputUsdPerMillionTokens: 7.5
    });
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      maxInputUsdPerMillionTokens: 1.5,
      maxOutputUsdPerMillionTokens: 7.5
    });

    // A daily cap edit that says nothing about the ceilings must not remove them.
    await store.setSpendLimits({ userId, dailyCapUsd: 3 });
    await expect(store.getSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: 3,
      maxInputUsdPerMillionTokens: 1.5,
      maxOutputUsdPerMillionTokens: 7.5
    });

    // One cleared, the other untouched - the two are separate ceilings and are cleared separately.
    await store.setSpendLimits({ userId, maxInputUsdPerMillionTokens: null });
    await expect(store.getSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: 3,
      maxInputUsdPerMillionTokens: null,
      maxOutputUsdPerMillionTokens: 7.5
    });

    // Zero is a ceiling, not an absence: it admits only a route that publishes no charge.
    await store.setSpendLimits({ userId, maxInputUsdPerMillionTokens: 0 });
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      maxInputUsdPerMillionTokens: 0
    });
  });

  it('writes a price ceiling for an owner who has no spend_limits row at all', async () => {
    // The state of the live box: `spend_limits` holds no row, so the first ceiling the owner sets
    // has to arrive through the INSERT arm rather than through the ON CONFLICT arm.
    await expect(store.getSpendLimits(userId)).resolves.toBeNull();
    await store.setSpendLimits({ userId, maxOutputUsdPerMillionTokens: 12 });
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      maxInputUsdPerMillionTokens: null,
      maxOutputUsdPerMillionTokens: 12,
      warnAtPercent: 80,
      timeZone: 'UTC'
    });
  });

  /*
   * Nothing has ever removed a usage_entries row, and `exportAccount` dumps the whole table. The
   * horizon is the easy half; which rows it may take is the half with a trap in it.
   *
   * Three reads sum this table with no window at all, all per task: `taskSpend`, the `spent_usd`
   * every conversation carries into the sidebar, and the `COALESCE(max_spend_usd, SUM(...))` that
   * re-baselines a follow-up's ceiling. Pruning a settled row that still belongs to a conversation
   * would make the first two under-report and the third *raise* a spend ceiling - a retention sweep
   * that loosens a brake. So the cut is the rows whose conversation is already gone, which is what
   * a null task_id means here: the column is ON DELETE SET NULL.
   */
  it('takes the ledger of conversations that are gone and leaves the ones still being counted', async () => {
    const task = await store.createTask(taskInput(userId, workspaceId));
    const older = "NOW()-INTERVAL '500 days'";
    const age = async (key: string) =>
      database.query(`UPDATE usage_entries SET created_at=${older} WHERE idempotency_key=$1`, [
        key
      ]);

    await bill({ key: 'ancient-and-still-open', costUsd: 4, taskId: task.id });
    await age('ancient-and-still-open');
    await bill({ key: 'ancient-and-orphaned', costUsd: 9 });
    await age('ancient-and-orphaned');
    await bill({ key: 'recent-and-orphaned', costUsd: 2 });

    // A reservation nothing settled. Old, unattached, and deliberately not this sweep's business:
    // an open reservation is a claim on the allowance and releasing it is a different decision.
    await store.recordUsage({
      userId,
      kind: 'model_call',
      resourceClass: 'medium',
      quantity: 1,
      unit: 'call',
      credits: 1,
      state: 'reserved',
      idempotencyKey: 'ancient-reservation'
    });
    await age('ancient-reservation');

    await store.cleanupExpired();

    const left = await database.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM usage_entries ORDER BY idempotency_key'
    );
    expect(left.rows.map((row) => row.idempotency_key)).toEqual([
      'ancient-and-still-open',
      'ancient-reservation',
      'recent-and-orphaned'
    ]);
    // The figure the owner reads on that conversation is untouched, which is the point.
    await expect(store.taskSpend(task.id)).resolves.toBeCloseTo(4, 6);
  });

  it('forgets that it warned about a window that closed more than a year ago', async () => {
    const bounds = spendWindowBounds('UTC', now);
    await expect(
      store.claimSpendAlert({
        userId,
        windowName: 'daily',
        windowStart: bounds.daily.start,
        level: 'warning',
        spentUsd: 4,
        capUsd: 5
      })
    ).resolves.toBe(true);
    await store.cleanupExpired();
    // Still there while it could still matter: the row is how a second warning about the same day
    // is refused, and the sweep must not hand the owner a duplicate.
    await expect(billing.listSpendAlerts(userId)).resolves.toHaveLength(1);

    await database.query(`UPDATE spend_alerts SET created_at=NOW()-INTERVAL '500 days'`);
    await store.cleanupExpired();
    await expect(billing.listSpendAlerts(userId)).resolves.toEqual([]);
  });

  it('carries the ceiling this box supplies for an owner who never opened the settings', async () => {
    await expect(store.getSpendLimits(userId)).resolves.toBeNull();
    await expect(store.effectiveSpendLimits(userId)).resolves.toMatchObject({
      dailyCapUsd: null,
      monthlyCapUsd: DEFAULT_MONTHLY_CAP_USD,
      defaultTaskCapUsd: null,
      warnAtPercent: 80,
      timeZone: 'UTC'
    });
    // This used to assert the opposite - that with no cap anywhere nothing is ever refused - and it
    // was a behaviour pin on the defect, not an asset: a self-hosted box whose key arrives as an
    // environment variable is never asked the ceiling question, so "no cap anywhere" was the
    // documented install rather than an edge case. The day and the conversation are still the
    // owner's to set; the month is no longer unlimited by default.
    await expect(store.spendGuard({ userId, estimateUsd: 10_000, now })).resolves.toMatchObject({
      outcome: 'deny',
      blockedBy: 'monthly'
    });
  });

  it('anchors a follow-up ceiling to what the task already spent', async () => {
    const task = await store.createTask(taskInput(userId, workspaceId));
    expect(task.maxSpendUsd).toBeNull();
    await bill({ key: 'first-turn', costUsd: 1.5, taskId: task.id });
    await database.query("UPDATE tasks SET status='completed' WHERE id=$1", [task.id]);
    const continued = await store.continueTask({
      id: task.id,
      userId,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      additionalSpendUsd: 2,
      agentStateCiphertext: envelope,
      reservationKey: `task:${task.id}:turn-2`,
      resourceClass: 'medium',
      userMessageCiphertext: envelope
    });
    // $1.50 already gone plus the $2 this follow-up was granted.
    expect(continued?.maxSpendUsd).toBeCloseTo(3.5, 6);
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 1.9, now })
    ).resolves.toMatchObject({ blockedBy: null });
    await expect(
      store.spendGuard({ userId, taskId: task.id, estimateUsd: 2.1, now })
    ).resolves.toMatchObject({ outcome: 'deny', blockedBy: 'task' });
  });

  it('serves the whole spend surface from one call', async () => {
    await store.setSpendLimits({ userId, dailyCapUsd: 5, monthlyCapUsd: 50 });
    const task = await store.createTask(taskInput(userId, workspaceId));
    await bill({ key: 'summary-1', costUsd: 1.25, taskId: task.id });
    const summary = await store.spendSummary(userId, now);
    expect(summary.limits).toMatchObject({ dailyCapUsd: 5, monthlyCapUsd: 50 });
    expect(summary.windows.map((window) => window.name)).toEqual(['daily', 'monthly']);
    expect(summary.windows[0]).toMatchObject({ spentUsd: 1.25, capUsd: 5 });
    expect(summary.byDay).toEqual([{ key: '2026-07-15', costUsd: 1.25, calls: 1 }]);
    expect(summary.byModel).toEqual([{ key: 'z-ai/glm-5.2', costUsd: 1.25, calls: 1 }]);
    expect(summary.byTask).toEqual([{ key: task.id, costUsd: 1.25, calls: 1 }]);
  });
});

describe('schema migrations against a populated database', () => {
  let database: Database;
  let store: DataStore;

  const envelope: EncryptedEnvelope = { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' };
  const key = memoryIndexKey(Buffer.alloc(32, 3));

  /**
   * Every table a migration deletes from, rewrites or re-constrains, plus the encrypted bodies,
   * ordered so the comparison is stable. This is the thing a replay must not change.
   */
  const snapshot = async () => {
    const rows = async (sql: string) => (await database.query(sql)).rows;
    return {
      users: await rows('SELECT id,username,display_name FROM users ORDER BY username'),
      workspaces: await rows('SELECT id,name,security_mode,region FROM workspaces ORDER BY name'),
      workspaceKeys: await rows(
        'SELECT workspace_id,wrapping_mode,wrapped_key FROM workspace_keys ORDER BY workspace_id'
      ),
      tasks: await rows(
        `SELECT id,title,status,privacy_route,max_compute_credits,max_spend_usd,prompt_ciphertext
         FROM tasks ORDER BY created_at,id`
      ),
      taskEvents: await rows(
        'SELECT task_id,sequence,kind,payload_ciphertext FROM task_events ORDER BY task_id,sequence'
      ),
      schedules: await rows(
        'SELECT id,privacy_route,max_compute_credits,max_spend_usd,spec FROM task_schedules ORDER BY id'
      ),
      models: await rows(
        'SELECT id,privacy_route,provider_model_id,usage_class FROM model_releases ORDER BY id'
      ),
      providers: await rows(
        'SELECT user_id,provider,status,external_ref FROM managed_provider_credentials ORDER BY user_id,provider'
      ),
      challenges: await rows('SELECT id,kind,challenge FROM auth_challenges ORDER BY challenge'),
      usage: await rows(
        'SELECT idempotency_key,kind,credits,cost_usd,model_id,state FROM usage_entries ORDER BY idempotency_key'
      ),
      spendLimits: await rows(
        'SELECT user_id,daily_cap_usd,monthly_cap_usd,time_zone FROM spend_limits ORDER BY user_id'
      ),
      connectors: await rows('SELECT id,kind,auth_mode,label FROM connectors ORDER BY id'),
      previews: await rows('SELECT id,slug,visibility FROM workspace_previews ORDER BY slug'),
      memoryItems: await rows(
        'SELECT id,kind,status,document_ciphertext,tsv_len FROM mem.item ORDER BY created_at,id'
      ),
      memorySources: await rows(
        'SELECT id,channel,body_ciphertext,tsv_len FROM mem.source ORDER BY created_at,id'
      ),
      corpusStats: await rows(
        'SELECT workspace_id,n_docs,sum_len FROM mem.corpus_stats ORDER BY workspace_id'
      )
    };
  };

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();

    const user = await store.createUser({ username: 'resident', displayName: 'Resident' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Long lived'));
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      maxSpendUsd: 3
    });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'user_message',
      summary: 'Encrypted user_message event',
      payloadCiphertext: envelope
    });
    await store.createTaskSchedule({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      maxSpendUsd: 2,
      spec: { kind: 'interval', everyMinutes: 30 },
      nextRunAt: new Date(Date.now() + 60_000)
    });
    await store.upsertModels([
      {
        id: 'openrouter/z-ai/glm-5.2',
        providerModelId: 'z-ai/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'openrouter',
        revision: 'openrouter-live',
        availability: 'available',
        openness: 'permissive_open_weight',
        license: 'MIT',
        commercialUse: true,
        privacyRoute: 'provider_zdr',
        contextTokens: 200_000,
        modalities: ['text'],
        capabilities: ['chat', 'tools'],
        usageClass: 'high',
        recommendationTags: ['Tools'],
        measuredQuality: 0.7,
        measuredLatencyMs: 900
      }
    ]);
    await store.upsertManagedProviderCredential({
      userId: user.id,
      provider: 'inference',
      secretCiphertext: envelope,
      externalRef: 'self-hosted',
      monthlyLimitUsd: 0,
      status: 'active'
    });
    // Live challenges of the two kinds that were added after the constraint was first written:
    // an earlier, narrower version of that constraint cannot be re-applied over either of them.
    await store.createChallenge({
      username: 'resident',
      challenge: 'recover-me',
      kind: 'recovery'
    });
    await store.createChallenge({
      username: 'resident',
      challenge: 'add-a-key',
      kind: 'passkey_add'
    });
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'high',
      quantity: 2_000,
      unit: 'tokens',
      credits: 0.5,
      state: 'settled',
      idempotencyKey: 'replay-usage-1',
      providerRef: 'openrouter:z-ai/glm-5.2',
      costUsd: 1.5
    });
    await store.setSpendLimits({ userId: user.id, dailyCapUsd: 7, monthlyCapUsd: 70 });
    await store.createConnector({
      id: '00000000-0000-4000-8000-0000000000c1',
      userId: user.id,
      kind: 'mcp_http',
      authMode: 'bearer',
      label: 'Docs',
      baseUrl: 'https://mcp.example.test',
      scopes: ['mcp:tools.execute'],
      secretCiphertext: envelope
    });
    await store.createWorkspacePreview({
      userId: user.id,
      workspaceId: workspace.id,
      label: 'Site',
      port: 5173,
      slug: 'site-slug',
      accessTokenHash: 'preview-hash',
      maxPreviews: 2
    });
    const sourceIndex = buildMemorySourceIndex('the owner runs athanor on one server', key);
    const source = await store.createMemorySource({
      userId: user.id,
      workspaceId: workspace.id,
      channel: 'chat',
      bodyCiphertext: envelope,
      bodyTokens: sourceIndex.bodyTokens,
      tokensEst: sourceIndex.tokensEst,
      indexed: sourceIndex.indexed,
      occurredAt: new Date()
    });
    const item = await store.createMemoryItem({
      userId: user.id,
      workspaceId: workspace.id,
      kind: 'episode',
      trust: 'stated',
      documentCiphertext: envelope,
      index: buildMemoryItemIndex(
        { title: 'set up the server', body: 'installed athanor on the box' },
        key
      ),
      observedAt: new Date(),
      validFrom: new Date()
    });
    await store.attachMemoryEvidence(item.id, [{ sourceId: source.id }]);
  });

  afterEach(async () => database.close());

  it('survives every migration being re-applied over live data, twice', async () => {
    const before = await snapshot();
    expect(before.tasks).toHaveLength(1);
    expect(before.models).toHaveLength(1);
    expect(before.memoryItems).toHaveLength(1);

    for (let pass = 0; pass < 2; pass += 1)
      for (const migration of migrations)
        await database.transaction(async (transaction) => transaction.exec(migration.sql));

    expect(await snapshot()).toEqual(before);
  });

  /*
   * The box this update lands on already has the runs. A watcher that has been firing every fifteen
   * minutes for a month is thousands of conversations that would stay uncollapsed if the column only
   * ever filled for runs made after the update, so the migration reads the pairing out of
   * task_schedule_runs, which has carried it since version 11.
   */
  it('gives a run that already exists the schedule it came from', async () => {
    // The state of a live box before this version: no column, and the pairing only in the run row.
    await database.exec('ALTER TABLE tasks DROP COLUMN schedule_id');
    const owner = await database.query<{ id: string; user_id: string; workspace_id: string }>(
      'SELECT id,user_id,workspace_id FROM tasks LIMIT 1'
    );
    const existing = owner.rows[0]!;
    const scheduleId = '00000000-0000-4000-8000-0000000000f1';
    await database.query(
      `INSERT INTO task_schedules(id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,
         model_id,privacy_route,max_compute_credits,spec)
       VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,'qwen','provider_zdr',1,$5::jsonb)`,
      [
        scheduleId,
        existing.user_id,
        existing.workspace_id,
        JSON.stringify(envelope),
        JSON.stringify({ kind: 'interval', everyMinutes: 15 })
      ]
    );
    await database.query(
      `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome)
       VALUES ($1,NOW(),$2,'queued')`,
      [scheduleId, existing.id]
    );

    const arrival = migrations.find((migration) => migration.version === 62)!;
    await database.transaction(async (transaction) => transaction.exec(arrival.sql));

    const filed = await database.query<{ id: string; schedule_id: string | null }>(
      'SELECT id,schedule_id FROM tasks ORDER BY id'
    );
    expect(filed.rows.find((row) => row.id === existing.id)?.schedule_id).toBe(scheduleId);
    // Nothing the owner started is claimed by a schedule it never came from.
    expect(
      filed.rows.filter((row) => row.id !== existing.id).every((row) => row.schedule_id === null)
    ).toBe(true);
  });

  it('is a no-op when a second start migrates the same populated database', async () => {
    const before = await snapshot();
    await migrateDatabase(database);
    await migrateDatabase(database);
    expect(await snapshot()).toEqual(before);
    const applied = await database.query<{ version: number; applications: string }>(
      'SELECT version,COUNT(*) AS applications FROM schema_migrations GROUP BY version'
    );
    expect(applied.rows).toHaveLength(migrations.length);
    expect(applied.rows.filter((row) => Number(row.applications) !== 1)).toEqual([]);
  });
});

/*
 * The describe above replays the whole chain over rows written in today's shape, which is what
 * proves the migrations are idempotent. It is not the path `athanor update` takes at three in the
 * morning. That path is rows an older build wrote, in the shape that build's schema had, meeting a
 * migration that has never seen them - and a backfill can only ever be wrong there, because on a
 * replay every column it fills is already filled: the statement matches nothing and passes whatever
 * it says. Twenty of the twenty-one row-rewriting statements in the migration list had only ever
 * been run that way, against a database that was already at the newest version when they ran.
 *
 * Each of these therefore applies the migrations below N and nothing above, writes the rows the way
 * the box wrote them at that version - raw SQL against the columns that existed then, never the
 * store, which would write them in the shape the migration is trying to produce - applies N on its
 * own, and reads back what the owner is left holding.
 */
describe('the upgrade path onto rows an older athanor wrote', () => {
  let database: Database;

  const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
  const SPACE_ID = '00000000-0000-4000-8000-0000000000b1';
  const sealed = JSON.stringify({ v: 1, iv: 'a', tag: 'b', ciphertext: 'c' });

  /** One migration, applied and recorded the way `migrateDatabase` applies and records it. */
  const apply = async (version: number) => {
    const migration = migrations.find((entry) => entry.version === version)!;
    await database.transaction(async (transaction) => {
      await transaction.exec(migration.sql);
      await transaction.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name
      ]);
    });
  };

  /**
   * The box as it stood the moment before version N shipped. The recording matters as much as the
   * applying: migration 18 reads schema_migrations to decide whether to stand down, so a fixture
   * that applied the SQL without filing it would be testing an arm no live database takes.
   */
  const migrateBelow = async (version: number) => {
    for (const migration of migrations.filter((entry) => entry.version < version))
      await apply(migration.version);
  };

  /**
   * Asked of the schema in front of us rather than of the one this file was written against - both
   * to write a row the old way, and to state before each migration runs that the thing it is about
   * to fill is genuinely not there yet. A test that only reads the column afterwards passes just as
   * happily against a database that already had it, which is the whole defect being paid off here.
   */
  const hasColumn = async (table: string, column: string) => {
    const [schema, name] = table.includes('.') ? table.split('.') : ['public', table];
    const found = await database.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
      [schema, name, column]
    );
    return found.rows.length > 0;
  };

  /** `workspaces.shape` was NOT NULL until migration 44 dropped it. */
  const addWorkspace = async (id: string, name: string) =>
    database.query(
      (await hasColumn('workspaces', 'shape'))
        ? `INSERT INTO workspaces(id,user_id,name,shape,status,storage_limit_bytes,image_revision,region)
           VALUES ($1,$2,$3,'standard','running',1073741824,'dev','auto')`
        : `INSERT INTO workspaces(id,user_id,name,status,storage_limit_bytes,image_revision,region)
           VALUES ($1,$2,$3,'running',1073741824,'dev','auto')`,
      [id, OWNER_ID, name]
    );

  const seedOwner = async () => {
    await database.query('INSERT INTO users(id,username,display_name) VALUES ($1,$2,$3)', [
      OWNER_ID,
      'resident',
      'Resident'
    ]);
    await addWorkspace(SPACE_ID, 'Long lived');
  };

  const addTask = async (id: string, route: string, title = 'A conversation') =>
    database.query(
      `INSERT INTO tasks(id,user_id,workspace_id,title,status,model_id,privacy_route,
         max_compute_credits,prompt_ciphertext)
       VALUES ($1,$2,$3,$4,'queued','qwen',$5,1,$6::jsonb)`,
      [id, OWNER_ID, SPACE_ID, title, route, sealed]
    );

  /** `provider_model_id` arrives, and becomes NOT NULL, at migration 21. */
  const addModel = async (id: string, route: string) => {
    const named = await hasColumn('model_releases', 'provider_model_id');
    await database.query(
      `INSERT INTO model_releases(id,display_name,provider,revision,availability,openness,license,
         commercial_use,privacy_route,context_tokens,modalities,capabilities,usage_class,
         recommendation_tags${named ? ',provider_model_id' : ''})
       VALUES ($1,'A model','openrouter','live','available','permissive_open_weight','MIT',TRUE,
         $2,200000,'["text"]'::jsonb,'["chat"]'::jsonb,'high','[]'::jsonb${named ? ',$1' : ''})`,
      [id, route]
    );
  };

  const routes = async (table: string) =>
    (
      await database.query<{ id: string; privacy_route: string }>(
        `SELECT id,privacy_route FROM ${table} ORDER BY id`
      )
    ).rows;

  beforeEach(() => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  });

  afterEach(async () => database.close());

  /*
   * A statement that writes rows the migration did not create, as opposed to one that only reshapes
   * the table around them. Function bodies come out first - what a trigger does runs when the
   * application writes, not when the migration does - and `setval` counts, because a sequence left
   * behind the rows it numbers is the same class of half-finished upgrade as an unfilled column.
   */
  const backfills = (sql: string) =>
    sql
      .replace(/CREATE OR REPLACE FUNCTION[\s\S]*?(\$[a-zA-Z_]*\$)[\s\S]*?\1;/g, '')
      .split(';')
      .filter(
        (statement) =>
          /^\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b/i.test(statement) ||
          /^\s*WITH\s+RECURSIVE[\s\S]*\)\s*UPDATE\b/i.test(statement) ||
          /\bsetval\s*\(/i.test(statement)
      );

  /*
   * Every migration that rewrites existing rows, and how many statements it does it with. Each has
   * a test below, and a new one arriving with no entry here fails this rather than shipping with a
   * replay - which reaches a backfill only after the column it fills is already filled - as the
   * only proof it works. That is the state twenty of these twenty-one statements were in.
   */
  const REWRITING_MIGRATIONS = {
    17: 1,
    18: 4,
    21: 5,
    36: 1,
    37: 1,
    42: 1,
    51: 1,
    53: 3,
    55: 1,
    57: 2,
    62: 1,
    76: 1,
    78: 1,
    84: 1,
    95: 1,
    98: 1,
    105: 5
  };

  it('migration 105 groups conversations explicitly and keeps project identity after its first conversation is deleted', async () => {
    await migrateBelow(105);
    await seedOwner();
    const root = randomUUID(),
      child = randomUUID(),
      unrelated = randomUUID();
    await addTask(root, 'external');
    await addTask(child, 'external');
    await addTask(unrelated, 'external');
    await database.query('UPDATE tasks SET parent_task_id=$1 WHERE id=$2', [root, child]);
    expect(await hasColumn('tasks', 'project_id')).toBe(false);
    await apply(105);
    expect(
      (await database.query('SELECT project_id FROM tasks WHERE id=$1', [child])).rows[0]
        ?.project_id
    ).toBe(root);
    expect((await database.query('SELECT id FROM projects')).rows).toHaveLength(2);
    await database.query('DELETE FROM tasks WHERE id=$1', [root]);
    expect((await database.query('SELECT id FROM projects WHERE id=$1', [root])).rows).toHaveLength(
      1
    );
    expect(
      (await database.query('SELECT project_id FROM tasks WHERE id=$1', [child])).rows[0]
        ?.project_id
    ).toBe(root);
  });

  /**
   * Migration 76 gives an archived verbatim row back the vector that finds it.
   *
   * The shape it has to meet is one an older build left behind: `indexed` false, `tsv` null,
   * `body_tokens` still there - a turn past its archive horizon on a build whose trigger nulled the
   * vector when the flag went down. On a replay this statement matches nothing, because the trigger
   * it ships beside has already written the vector on every insert since; the only way to see it
   * work is to put a row in the old shape in front of it.
   *
   * Both directions, because the wrong backfill here is a generous one: a row whose tokens the old
   * pass ERASED must stay unfindable rather than being handed an empty vector that reads like an
   * indexed row with nothing in it. Those lexemes were keyed in the worker and nothing in the
   * database can rebuild them; inventing an empty answer for them would be the one thing worse than
   * saying the memory is gone.
   */
  it('gives an archived turn back the vector it is found by, and invents none for an erased one', async () => {
    await migrateBelow(76);
    await seedOwner();
    const kept = '00000000-0000-4000-8000-0000000000d1';
    const erased = '00000000-0000-4000-8000-0000000000d2';
    const live = '00000000-0000-4000-8000-0000000000d3';
    // Written the way the old build wrote them: straight SQL, and the trigger in force at 75 nulls
    // the vector on any row whose flag is down.
    for (const [id, indexed, tokens] of [
      [kept, false, 'abcdabcdabcdabcd efghefghefghefgh'],
      [erased, false, ''],
      [live, true, 'ijklijklijklijkl']
    ] as const)
      await database.query(
        `INSERT INTO mem.source(id,user_id,workspace_id,channel,body_ciphertext,indexed,body_tokens)
         VALUES ($1,$2,$3,'chat',$4::jsonb,$5,$6)`,
        [id, OWNER_ID, SPACE_ID, sealed, indexed, tokens]
      );
    const vectors = async () =>
      Object.fromEntries(
        (
          await database.query<{ id: string; tsv: string | null; len: number }>(
            'SELECT id, tsv::text AS tsv, tsv_len AS len FROM mem.source ORDER BY id'
          )
        ).rows.map((row) => [row.id, { tsv: row.tsv, len: Number(row.len) }])
      );

    // The state the migration has to find, asserted first so this cannot pass against a database
    // that was already at 76 when the rows went in.
    const before = await vectors();
    expect(before[kept]?.tsv).toBeNull();
    expect(before[erased]?.tsv).toBeNull();
    expect(before[live]?.tsv).not.toBeNull();

    await apply(76);

    const after = await vectors();
    expect(after[kept]?.tsv).toContain('abcdabcdabcdabcd');
    expect(after[kept]?.len).toBe(2);
    // Nothing to rebuild from, so nothing is claimed.
    expect(after[erased]?.tsv).toBeNull();
    expect(after[erased]?.len).toBe(0);
    // And the row that was never archived is untouched, to the byte.
    expect(after[live]).toEqual(before[live]);
  });

  /**
   * Migration 78 teaches the folded tail which of its uses were graded.
   *
   * `mem.item_use_fold` arrived at 75 holding `uses`, `cites` and `fails`, and the salience
   * statement recovered the positive block from it as `uses - fails`. The per-use rows behind a
   * folded block are gone, so which of those uses the harness actually watched is unrecoverable
   * from anything the database holds - and the backfill is therefore deliberately the OLD meaning,
   * `uses - fails`, so a block that folded before this applied scores exactly what it scored the
   * day before. Zero would have been the other choice and it would have deleted the positive
   * history of every already-folded row on no evidence at all, at the moment of an upgrade.
   *
   * Both directions, because a backfill that overshoots is as wrong as one that undershoots: a
   * block whose every use failed must come out at `oks = 0` rather than at its own `uses`.
   */
  it('gives a folded block the graded count it was written before there was one', async () => {
    await migrateBelow(78);
    await seedOwner();
    const item = async (id: string) =>
      database.query(
        `INSERT INTO mem.item(id,user_id,workspace_id,kind,trust,document_ciphertext,dedupe_key)
         VALUES ($1,$2,$3,'episode','stated',$4::jsonb,$5)`,
        [id, OWNER_ID, SPACE_ID, sealed, `dedupe-${id}`]
      );
    const mixed = '00000000-0000-4000-8000-0000000000e1';
    const allFailed = '00000000-0000-4000-8000-0000000000e2';
    const none = '00000000-0000-4000-8000-0000000000e3';
    for (const id of [mixed, allFailed, none]) await item(id);
    // Written the way the box at 75 wrote them: the three columns that existed then, and no
    // fourth. Asserted rather than assumed, so this cannot pass against a database already at 78.
    expect(await hasColumn('mem.item_use_fold', 'oks')).toBe(false);
    for (const [id, uses, cites, fails] of [
      [mixed, 40, 9, 6],
      [allFailed, 12, 0, 12],
      [none, 5, 0, 0]
    ] as const)
      await database.query(
        `INSERT INTO mem.item_use_fold(item_id,uses,cites,fails,first_at,last_at)
         VALUES ($1,$2,$3,$4,NOW() - INTERVAL '400 days',NOW() - INTERVAL '200 days')`,
        [id, uses, cites, fails]
      );

    await apply(78);

    const folds = await database.query<{ item_id: string; uses: number; oks: number }>(
      'SELECT item_id, uses, oks FROM mem.item_use_fold ORDER BY item_id'
    );
    const byId = new Map(folds.rows.map((row) => [row.item_id, row]));
    // What the score read before this migration, now written down where the score can keep
    // reading it: the graded-positive block is what is left after the failures.
    expect(byId.get(mixed)!.oks).toBe(34);
    // And nothing is invented for a block that has no positives to recover.
    expect(byId.get(allFailed)!.oks).toBe(0);
    expect(byId.get(none)!.oks).toBe(5);

    // The constraint arrives with the column and it is the partition, not a bound on one count:
    // `ok`, `fail` and `unknown` are the three outcomes, so the two graded counts cannot together
    // exceed the total and the slack between them is the ungraded tail.
    await expect(
      database.query('UPDATE mem.item_use_fold SET oks = uses - fails + 1 WHERE item_id=$1', [
        mixed
      ])
    ).rejects.toThrow();
  });

  it('binds existing coding missions to their original workspace before a project moves', async () => {
    await migrateBelow(95);
    await seedOwner();
    const secondSource = randomUUID(),
      movedSource = randomUUID();
    await addWorkspace(secondSource, 'Another computer');
    await addWorkspace(movedSource, 'Independent execution');
    const expected = new Map<string, string>();
    const parents: string[] = [];
    for (const source of [SPACE_ID, secondSource]) {
      const parent = randomUUID(),
        child = randomUUID(),
        childWorkspace = randomUUID(),
        mission = randomUUID();
      await addWorkspace(childWorkspace, 'Isolated specialist');
      await addTask(parent, 'provider_zdr');
      await addTask(child, 'provider_zdr');
      await database.query('UPDATE tasks SET workspace_id=$2 WHERE id=$1', [parent, source]);
      await database.query('UPDATE tasks SET workspace_id=$2 WHERE id=$1', [child, childWorkspace]);
      await database.query(
        `INSERT INTO coding_missions(id,user_id,parent_task_id,child_task_id,child_workspace_id,
          request_key,request_hash,manifest_ciphertext,phase,allocated_credits)
         VALUES($1,$2,$3,$4,$5,$6,'exact-request',$7::jsonb,'active',2)`,
        [mission, OWNER_ID, parent, child, childWorkspace, `mission:${mission}`, sealed]
      );
      parents.push(parent);
      expected.set(mission, source);
    }
    expect(await hasColumn('coding_missions', 'parent_workspace_id')).toBe(false);
    const unchanged = () =>
      database.query(
        'SELECT id,parent_task_id,child_task_id,child_workspace_id,manifest_ciphertext,phase,allocated_credits FROM coding_missions ORDER BY id'
      );
    const before = (await unchanged()).rows;
    expect(before).toHaveLength(2);
    await apply(95);
    const origins = async () =>
      new Map(
        (await database.query('SELECT id,parent_workspace_id FROM coding_missions')).rows.map(
          (row) => [String(row.id), String(row.parent_workspace_id)]
        )
      );
    expect(await origins()).toEqual(expected);
    expect((await unchanged()).rows).toEqual(before);
    await database.query('UPDATE tasks SET workspace_id=$2 WHERE id=ANY($1::uuid[])', [
      parents,
      movedSource
    ]);
    await database.exec(migrations.find((entry) => entry.version === 95)!.sql);
    expect(await origins()).toEqual(expected);
    expect((await unchanged()).rows).toEqual(before);
  });

  /**
   * Migration 98 gives every catalogue row the connection that reaches it.
   *
   * Before it, `provider` was doing two jobs: naming the id namespace a model lives in, and naming
   * the credential that can call it. That is why a box could hold one provider - every
   * non-OpenRouter endpoint shared the bucket called `custom`. The backfill has to seed the new
   * column from the old one for rows an older athanor wrote, and it has to leave the ids alone: a
   * finished task names its model by id, and a rewritten id is a history that stops resolving.
   */
  it('gives an older catalogue its connection without touching the ids tasks name', async () => {
    await migrateBelow(98);
    await seedOwner();
    expect(await hasColumn('model_releases', 'connection_id')).toBe(false);
    const insert = async (id: string, provider: string) =>
      database.query(
        `INSERT INTO model_releases(
           id,provider_model_id,display_name,provider,revision,availability,openness,license,
           commercial_use,privacy_route,context_tokens,modalities,capabilities,usage_class,
           recommendation_tags
         ) VALUES ($1,$1,$1,$2,'r1','available','permissive_open_weight','apache-2.0',true,
           'provider_zdr',128000,'[]'::jsonb,'[]'::jsonb,'light','[]'::jsonb)`,
        [id, provider]
      );
    await insert('openrouter/vendor/one', 'openrouter');
    await insert('custom/glm-5.3-flash', 'custom');
    const before = (await database.query('SELECT id FROM model_releases ORDER BY id')).rows.map(
      (row) => String(row.id)
    );

    await apply(98);

    const rows = await database.query(
      'SELECT id,provider,connection_id FROM model_releases ORDER BY id'
    );
    expect(rows.rows.map((row) => String(row.id))).toEqual(before);
    expect(
      Object.fromEntries(rows.rows.map((row) => [String(row.id), String(row.connection_id)]))
    ).toEqual({
      'custom/glm-5.3-flash': 'custom',
      'openrouter/vendor/one': 'openrouter'
    });

    // Idempotent: the backfill only fills what is still null, so a row a later write has already
    // claimed for a different connection is not dragged back to its namespace by a re-run.
    await database.query(
      `UPDATE model_releases SET connection_id='ollama-cloud' WHERE id='custom/glm-5.3-flash'`
    );
    await database.exec(migrations.find((entry) => entry.version === 98)!.sql);
    expect(
      String(
        (
          await database.query(
            `SELECT connection_id FROM model_releases WHERE id='custom/glm-5.3-flash'`
          )
        ).rows[0]!.connection_id
      )
    ).toBe('ollama-cloud');
  });

  it('has an upgrade test for every migration that rewrites rows rather than reshaping them', () => {
    const rewriting = Object.fromEntries(
      migrations
        .map((migration) => [migration.version, backfills(migration.sql).length] as const)
        .filter(([, statements]) => statements > 0)
    );
    expect(rewriting).toEqual(REWRITING_MIGRATIONS);
  });

  /*
   * Migration 17 narrows wrapping_mode to two values and normalises whatever else is in the column
   * first. The key material itself must come through untouched: a migration that rewrote a wrapped
   * key would lock the owner out of every workspace it touched, and no later statement could tell.
   */
  it('settles a key wrapped under a mode the narrowed constraint has never heard of', async () => {
    await migrateBelow(17);
    await seedOwner();
    const second = '00000000-0000-4000-8000-0000000000b2';
    const third = '00000000-0000-4000-8000-0000000000b3';
    await addWorkspace(second, 'Second');
    await addWorkspace(third, 'Third');
    await database.exec(`
      INSERT INTO workspace_keys(workspace_id,wrapped_key,wrapping_mode) VALUES
        ('${SPACE_ID}','wrapped-a','hosted'),
        ('${second}','wrapped-b','attested'),
        ('${third}','wrapped-c','hardware');
    `);
    // The state the migration has to find. Asserting it first is what stops this passing against a
    // database where nothing needed doing.
    const modes = async () =>
      (
        await database.query<{ wrapping_mode: string }>(
          'SELECT wrapping_mode FROM workspace_keys ORDER BY workspace_id'
        )
      ).rows.map((row) => row.wrapping_mode);
    expect(await modes()).toEqual(['hosted', 'attested', 'hardware']);

    await apply(17);

    const keys = await database.query<{ workspace_id: string; wrapping_mode: string }>(
      'SELECT workspace_id,wrapping_mode,wrapped_key FROM workspace_keys ORDER BY workspace_id'
    );
    expect(keys.rows).toEqual([
      { workspace_id: SPACE_ID, wrapping_mode: 'hosted', wrapped_key: 'wrapped-a' },
      { workspace_id: second, wrapping_mode: 'attested', wrapped_key: 'wrapped-b' },
      { workspace_id: third, wrapping_mode: 'hosted', wrapped_key: 'wrapped-c' }
    ]);
    // And the constraint the backfill was clearing the way for is now actually on the table.
    await expect(
      database.query(`UPDATE workspace_keys SET wrapping_mode='hardware' WHERE workspace_id=$1`, [
        third
      ])
    ).rejects.toThrow();
  });

  /*
   * Migration 18 is the one that deletes rows rather than rewriting them, and writing this test is
   * what showed that it cannot: all four of its data statements look for a privacy_route outside
   * ('ollama_zdr','external'), and migration 4 put exactly that CHECK on tasks, model_releases and
   * provider_connections while migration 11 declared it on task_schedules. Nothing between 4 and 18
   * can store a value any of them would match, so the two UPDATEs and the two DELETEs are reached
   * on every upgrade and select nothing on all of them.
   *
   * That is recorded here rather than removed. The statements are harmless where they stand, the
   * constraint half of the migration is not, and the thing worth holding is the proof that no box
   * taking this update can lose its catalogue to them - which is what the inserts below establish
   * by being refused.
   */
  it('cannot reach the rows migration 18 rewrites: the check it enforces has been on since 4', async () => {
    await migrateBelow(18);
    await seedOwner();
    await addTask('00000000-0000-4000-8000-0000000000e1', 'ollama_zdr');
    await addTask('00000000-0000-4000-8000-0000000000e2', 'external');
    await addModel('openrouter/kept', 'ollama_zdr');
    await database.query(
      `INSERT INTO provider_connections(id,user_id,provider,label,secret_ciphertext,privacy_route)
       VALUES ($1,$2,'openrouter','Kept',$3::jsonb,'external')`,
      ['00000000-0000-4000-8000-0000000000c1', OWNER_ID, sealed]
    );
    // The state the four statements were written for, on all three tables that still accept a
    // route today. A version-17 database refuses to hold any of it.
    await expect(addTask('00000000-0000-4000-8000-0000000000e3', 'hosted_zdr')).rejects.toThrow(
      /tasks_cloud_privacy_route/
    );
    await expect(addModel('openrouter/dropped', 'hosted_zdr')).rejects.toThrow(
      /models_cloud_privacy_route/
    );
    await expect(
      database.query(
        `INSERT INTO provider_connections(id,user_id,provider,label,secret_ciphertext,privacy_route)
         VALUES ($1,$2,'hosted','Dropped',$3::jsonb,'hosted_zdr')`,
        ['00000000-0000-4000-8000-0000000000c2', OWNER_ID, sealed]
      )
    ).rejects.toThrow(/providers_cloud_privacy_route/);

    await apply(18);

    expect(await routes('tasks')).toEqual([
      { id: '00000000-0000-4000-8000-0000000000e1', privacy_route: 'ollama_zdr' },
      { id: '00000000-0000-4000-8000-0000000000e2', privacy_route: 'external' }
    ]);
    expect(await routes('model_releases')).toEqual([
      { id: 'openrouter/kept', privacy_route: 'ollama_zdr' }
    ]);
    expect(await routes('provider_connections')).toEqual([
      { id: '00000000-0000-4000-8000-0000000000c1', privacy_route: 'external' }
    ]);
  });

  /*
   * The stand-down arm, tested from the state it was written for: a database that has already been
   * past 21, where every route reads 'provider_zdr' and the un-guarded statements would rewrite
   * every task to 'external' and empty the catalogue. This is the one re-application in the file
   * whose cost is measured in the owner's data rather than in wasted work.
   */
  it('stands down rather than emptying a catalogue a later migration already renamed', async () => {
    await migrateDatabase(database);
    await seedOwner();
    await addTask('00000000-0000-4000-8000-0000000000e1', 'provider_zdr');
    await addModel('openrouter/kept', 'provider_zdr');

    const eighteen = migrations.find((entry) => entry.version === 18)!;
    await database.transaction(async (transaction) => transaction.exec(eighteen.sql));

    expect(await routes('tasks')).toEqual([
      { id: '00000000-0000-4000-8000-0000000000e1', privacy_route: 'provider_zdr' }
    ]);
    expect(await routes('model_releases')).toEqual([
      { id: 'openrouter/kept', privacy_route: 'provider_zdr' }
    ]);
  });

  /*
   * Five backfilling statements in one migration: the rename across four tables, and the column
   * that becomes NOT NULL immediately after being filled - which is the statement that decides
   * whether the update completes at all, because a single unfilled row aborts it.
   */
  it('renames the route every row already carried and gives each model an id at the provider', async () => {
    await migrateBelow(21);
    await seedOwner();
    await addTask('00000000-0000-4000-8000-0000000000e1', 'ollama_zdr');
    await addTask('00000000-0000-4000-8000-0000000000e2', 'external');
    await addModel('openrouter/z-ai/glm-5.2', 'ollama_zdr');
    await database.query(
      `INSERT INTO provider_connections(id,user_id,provider,label,secret_ciphertext,privacy_route)
       VALUES ($1,$2,'openrouter','Owner key',$3::jsonb,'ollama_zdr')`,
      ['00000000-0000-4000-8000-0000000000c1', OWNER_ID, sealed]
    );
    await database.query(
      `INSERT INTO task_schedules(id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,
         model_id,privacy_route,max_compute_credits,spec)
       VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,'qwen','ollama_zdr',1,$5::jsonb)`,
      [
        '00000000-0000-4000-8000-0000000000f1',
        OWNER_ID,
        SPACE_ID,
        sealed,
        JSON.stringify({ kind: 'interval', everyMinutes: 15 })
      ]
    );

    expect(await hasColumn('model_releases', 'provider_model_id')).toBe(false);
    expect((await routes('tasks')).map((row) => row.privacy_route)).toContain('ollama_zdr');

    await apply(21);

    expect(await routes('tasks')).toEqual([
      { id: '00000000-0000-4000-8000-0000000000e1', privacy_route: 'provider_zdr' },
      { id: '00000000-0000-4000-8000-0000000000e2', privacy_route: 'external' }
    ]);
    expect(await routes('model_releases')).toEqual([
      { id: 'openrouter/z-ai/glm-5.2', privacy_route: 'provider_zdr' }
    ]);
    expect(await routes('provider_connections')).toEqual([
      { id: '00000000-0000-4000-8000-0000000000c1', privacy_route: 'provider_zdr' }
    ]);
    expect(await routes('task_schedules')).toEqual([
      { id: '00000000-0000-4000-8000-0000000000f1', privacy_route: 'provider_zdr' }
    ]);
    // The id at the provider, for a catalogue that predates athanor ever recording one separately.
    const models = await database.query<{ id: string; provider_model_id: string }>(
      'SELECT id,provider_model_id FROM model_releases'
    );
    expect(models.rows).toEqual([
      { id: 'openrouter/z-ai/glm-5.2', provider_model_id: 'openrouter/z-ai/glm-5.2' }
    ]);
  });

  /*
   * The per-model spend breakdown is a GROUP BY over a column that did not exist when the ledger
   * rows were written, so every figure the owner is shown for the months before the update comes
   * out of this one statement's reading of provider_ref.
   */
  it('reads the model out of a provider reference the ledger wrote before the column existed', async () => {
    await migrateBelow(36);
    await seedOwner();
    const entry = (key: string, providerRef: string | null) =>
      database.query(
        `INSERT INTO usage_entries(id,user_id,workspace_id,kind,resource_class,quantity,unit,
           credits,state,provider_ref,idempotency_key)
         VALUES ($1,$2,$3,'model_inference','high',1000,'tokens',0.5,'settled',$4,$5)`,
        [randomUUID(), OWNER_ID, SPACE_ID, providerRef, key]
      );
    await entry('split-1', 'openrouter:z-ai/glm-5.2');
    // A model id with its own colon in it: the split is on the first one, not the last.
    await entry('split-2', 'openrouter:vendor/model:free');
    // Two shapes the statement is written to leave alone rather than to mangle into a model id.
    await entry('no-colon', 'local-inference');
    await entry('no-ref', null);

    expect(await hasColumn('usage_entries', 'model_id')).toBe(false);

    await apply(36);

    const priced = await database.query<{ idempotency_key: string; model_id: string | null }>(
      'SELECT idempotency_key,model_id FROM usage_entries ORDER BY idempotency_key'
    );
    expect(priced.rows).toEqual([
      { idempotency_key: 'no-colon', model_id: null },
      { idempotency_key: 'no-ref', model_id: null },
      { idempotency_key: 'split-1', model_id: 'z-ai/glm-5.2' },
      { idempotency_key: 'split-2', model_id: 'vendor/model:free' }
    ]);
  });

  /*
   * trigram_len is the cheap bound that decides whether a stored entry could clear the Jaccard
   * threshold at all. A row left at the column default of zero is one the fuzzy channel can never
   * return, so an unfilled backfill here reads as memory the agent has quietly lost.
   */
  it('counts the trigrams on memory entries written before the count was stored', async () => {
    await migrateBelow(37);
    await seedOwner();
    const remember = async (id: string, trigrams: string) =>
      database.query(
        `INSERT INTO mem.item(id,user_id,workspace_id,kind,trust,document_ciphertext,dedupe_key,
           trigrams)
         VALUES ($1,$2,$3,'episode'::mem.kind,'stated'::mem.trust,$4::jsonb,$5,$6::text[])`,
        [id, OWNER_ID, SPACE_ID, sealed, id, trigrams]
      );
    await remember('00000000-0000-4000-8000-0000000000d1', '{ath,tha,han,ano,nor}');
    await remember('00000000-0000-4000-8000-0000000000d2', '{}');

    expect(await hasColumn('mem.item', 'trigram_len')).toBe(false);

    await apply(37);

    const counted = await database.query<{ id: string; trigram_len: number }>(
      'SELECT id,trigram_len FROM mem.item ORDER BY id'
    );
    expect(counted.rows).toEqual([
      { id: '00000000-0000-4000-8000-0000000000d1', trigram_len: 5 },
      { id: '00000000-0000-4000-8000-0000000000d2', trigram_len: 0 }
    ]);
  });

  /*
   * expires_at stopped being a countdown from creation and started being an idle window, which
   * means the number already in the column measures a different thing on either side of the update.
   * The owner's live private links are handed the full window rather than whatever minutes were
   * left of the old one - and the ones that had already lapsed stay lapsed, because restoring a
   * bearer token the owner has already lost is not a repair.
   */
  it('hands a live private preview the idle window instead of the minutes left of its countdown', async () => {
    await migrateBelow(42);
    await seedOwner();
    const publish = async (slug: string, visibility: string, status: string, expiresIn: string) =>
      database.query(
        `INSERT INTO workspace_previews(id,user_id,workspace_id,label,port,slug,access_token_hash,
           visibility,status,expires_at)
         VALUES ($1,$2,$3,'Site',5173,$4,'preview-hash',$5,$6,NOW() + $7::interval)`,
        [randomUUID(), OWNER_ID, SPACE_ID, slug, visibility, status, expiresIn]
      );
    await publish('live-private', 'private', 'active', '10 minutes');
    await publish('live-public', 'public', 'active', '10 minutes');
    await publish('revoked-private', 'private', 'revoked', '10 minutes');
    await publish('lapsed-private', 'private', 'active', '-1 day');

    await apply(42);

    const windows = await database.query<{ slug: string; extended: boolean; live: boolean }>(
      `SELECT slug, expires_at > NOW() + INTERVAL '29 days' AS extended, expires_at > NOW() AS live
       FROM workspace_previews ORDER BY slug`
    );
    expect(windows.rows).toEqual([
      // Already gone before the update, and still gone after it.
      { slug: 'lapsed-private', extended: false, live: false },
      { slug: 'live-private', extended: true, live: true },
      // A published site never had the countdown, and a revoked link is not brought back.
      { slug: 'live-public', extended: false, live: true },
      { slug: 'revoked-private', extended: false, live: true }
    ]);
  });

  /*
   * Migration 51 narrows wrapping_mode to the single value the code can mint. The rows it has to
   * settle first are the ones migration 17 deliberately left alone, so this is the only statement
   * standing between an owner who once ran attested key release and a failed constraint at 3am.
   */
  it('settles an attested key before the mode is narrowed to the one thing that mints it', async () => {
    await migrateBelow(51);
    await seedOwner();
    await database.query(
      `INSERT INTO workspace_keys(workspace_id,wrapped_key,wrapping_mode)
       VALUES ($1,'wrapped-a','attested')`,
      [SPACE_ID]
    );

    expect(await hasColumn('tasks', 'reserved_compute_credits')).toBe(true);

    await apply(51);

    // Five columns nothing ever wrote go with it, one of which was served on every task as a
    // measured reservation of zero.
    expect(await hasColumn('tasks', 'reserved_compute_credits')).toBe(false);
    const keys = await database.query<{ wrapping_mode: string; wrapped_key: string }>(
      'SELECT wrapping_mode,wrapped_key FROM workspace_keys'
    );
    expect(keys.rows).toEqual([{ wrapping_mode: 'hosted', wrapped_key: 'wrapped-a' }]);
    await expect(
      database.query(`UPDATE workspace_keys SET wrapping_mode='attested' WHERE workspace_id=$1`, [
        SPACE_ID
      ])
    ).rejects.toThrow();
  });

  /*
   * The order two checkpoints were taken in, made into a fact. The backfill has to reproduce what
   * the old query answered - created_at, then id - or an owner's existing undo points silently
   * change which one an undo picks, which is the defect the migration exists to stop.
   */
  it('numbers existing checkpoints the way the old query read them and carries on above them', async () => {
    await migrateBelow(53);
    await seedOwner();
    const taken = async (id: string, at: string) =>
      database.query(
        `INSERT INTO workspace_checkpoints(id,user_id,workspace_id,mechanism,created_at)
         VALUES ($1,$2,$3,'btrfs',$4::timestamptz)`,
        [id, OWNER_ID, SPACE_ID, at]
      );
    // Written out of order, and two of them share a timestamp, which is the tie the sequence exists
    // to break: a clock at transaction resolution gives two checkpoints in one turn the same NOW().
    await taken('00000000-0000-4000-8000-000000000c03', '2026-01-03T00:00:00Z');
    await taken('00000000-0000-4000-8000-000000000c02', '2026-01-01T00:00:00Z');
    await taken('00000000-0000-4000-8000-000000000c01', '2026-01-01T00:00:00Z');

    expect(await hasColumn('workspace_checkpoints', 'taken_seq')).toBe(false);

    await apply(53);

    const ordered = await database.query<{ id: string; taken_seq: string }>(
      'SELECT id,taken_seq FROM workspace_checkpoints ORDER BY taken_seq'
    );
    expect(ordered.rows.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000c01',
      '00000000-0000-4000-8000-000000000c02',
      '00000000-0000-4000-8000-000000000c03'
    ]);
    expect(ordered.rows.map((row) => Number(row.taken_seq))).toEqual([1, 2, 3]);

    // setval is the half that decides whether the box works after the update: a sequence left at 1
    // hands the next checkpoint a number an existing one already holds, and the undo picks between
    // them by id again.
    await database.query(
      `INSERT INTO workspace_checkpoints(id,user_id,workspace_id,mechanism)
       VALUES ($1,$2,$3,'btrfs')`,
      ['00000000-0000-4000-8000-000000000c04', OWNER_ID, SPACE_ID]
    );
    const next = await database.query<{ taken_seq: string }>(
      'SELECT taken_seq FROM workspace_checkpoints WHERE id=$1',
      ['00000000-0000-4000-8000-000000000c04']
    );
    expect(Number(next.rows[0]!.taken_seq)).toBeGreaterThan(3);
  });

  /*
   * Every undo point the owner already has, re-pointed at the message whose turn it holds. Getting
   * this wrong on existing rows is the whole finding: rewinding resolves on
   * `event_sequence <= the message you picked`, so a point left where it was taken is one the
   * client can offer and never match.
   */
  it('moves an existing undo point back to the message whose turn it holds', async () => {
    await migrateBelow(55);
    await seedOwner();
    const conversation = '00000000-0000-4000-8000-0000000000e1';
    const scheduled = '00000000-0000-4000-8000-0000000000e2';
    await addTask(conversation, 'provider_zdr', 'Asked for something');
    await addTask(scheduled, 'provider_zdr', 'Ran on a timer');
    const event = async (taskId: string, sequence: number, kind: string) =>
      database.query(
        `INSERT INTO task_events(id,task_id,sequence,kind,summary) VALUES ($1,$2,$3,$4,'')`,
        [randomUUID(), taskId, sequence, kind]
      );
    await event(conversation, 1, 'user_message');
    await event(conversation, 2, 'agent_message');
    await event(conversation, 3, 'user_message');
    await event(conversation, 4, 'tool_call');
    // A scheduled run opens without a message, which is the row the COALESCE is there for.
    await event(scheduled, 1, 'status');
    await event(scheduled, 2, 'tool_call');

    const taken = async (id: string, taskId: string | null, sequence: number | null) =>
      database.query(
        `INSERT INTO workspace_checkpoints(id,user_id,workspace_id,task_id,mechanism,event_sequence)
         VALUES ($1,$2,$3,$4,'btrfs',$5)`,
        [id, OWNER_ID, SPACE_ID, taskId, sequence]
      );
    await taken('00000000-0000-4000-8000-000000000c01', conversation, 4);
    await taken('00000000-0000-4000-8000-000000000c02', conversation, 2);
    await taken('00000000-0000-4000-8000-000000000c03', scheduled, 2);
    await taken('00000000-0000-4000-8000-000000000c04', null, 9);

    const sequences = async () =>
      (
        await database.query<{ event_sequence: number }>(
          'SELECT event_sequence FROM workspace_checkpoints ORDER BY id'
        )
      ).rows.map((row) => row.event_sequence);
    // Where the checkpoints were taken, which is the position the client could never match.
    expect(await sequences()).toEqual([4, 2, 2, 9]);

    await apply(55);

    const anchored = await database.query<{ id: string; event_sequence: number }>(
      'SELECT id,event_sequence FROM workspace_checkpoints ORDER BY id'
    );
    expect(anchored.rows).toEqual([
      // Taken after the second turn's tool call; moves back to the message that started it.
      { id: '00000000-0000-4000-8000-000000000c01', event_sequence: 3 },
      { id: '00000000-0000-4000-8000-000000000c02', event_sequence: 1 },
      // No user message before it, and no user message anywhere: it keeps the number it has.
      { id: '00000000-0000-4000-8000-000000000c03', event_sequence: 2 },
      // A checkpoint on no conversation is outside the WHERE and must not be touched at all.
      { id: '00000000-0000-4000-8000-000000000c04', event_sequence: 9 }
    ]);
  });

  /*
   * "Delete this conversation" has to have meant it, retrospectively. The rows this removes are the
   * owner's own words held verbatim in mem.source for conversations they deleted before the foreign
   * key existed, which is the half of the promise that had already been broken by the time the
   * migration was written.
   */
  it('takes memory of a conversation the owner already deleted with it', async () => {
    await migrateBelow(57);
    await seedOwner();
    const living = '00000000-0000-4000-8000-0000000000e1';
    const gone = '00000000-0000-4000-8000-0000000000e9';
    await addTask(living, 'provider_zdr');
    const remember = async (id: string, taskId: string | null) => {
      await database.query(
        `INSERT INTO mem.item(id,user_id,workspace_id,kind,trust,document_ciphertext,dedupe_key,
           task_id)
         VALUES ($1,$2,$3,'episode'::mem.kind,'stated'::mem.trust,$4::jsonb,$5,$6)`,
        [id, OWNER_ID, SPACE_ID, sealed, id, taskId]
      );
      await database.query(
        `INSERT INTO mem.source(id,user_id,workspace_id,channel,body_ciphertext,task_id)
         VALUES ($1,$2,$3,'chat',$4::jsonb,$5)`,
        [id, OWNER_ID, SPACE_ID, sealed, taskId]
      );
    };
    await remember('00000000-0000-4000-8000-0000000000d1', living);
    await remember('00000000-0000-4000-8000-0000000000d2', gone);
    // A promoted fact carries no conversation and survives the deletion of the one that saw it.
    await remember('00000000-0000-4000-8000-0000000000d3', null);

    const surviving = async (table: string) =>
      (await database.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).rows.map(
        (row) => row.id
      );
    // The verbatim chunk of an already-deleted conversation, still on the box.
    expect(await surviving('mem.source')).toContain('00000000-0000-4000-8000-0000000000d2');

    await apply(57);

    expect(await surviving('mem.item')).toEqual([
      '00000000-0000-4000-8000-0000000000d1',
      '00000000-0000-4000-8000-0000000000d3'
    ]);
    expect(await surviving('mem.source')).toEqual([
      '00000000-0000-4000-8000-0000000000d1',
      '00000000-0000-4000-8000-0000000000d3'
    ]);

    // And the foreign key the migration installed means the next deletion needs no sweep at all.
    await database.query('DELETE FROM tasks WHERE id=$1', [living]);
    expect(await surviving('mem.item')).toEqual(['00000000-0000-4000-8000-0000000000d3']);
    expect(await surviving('mem.source')).toEqual(['00000000-0000-4000-8000-0000000000d3']);
  });

  /*
   * The last statement in the chain, checked the same way as the rest: migration 62 read the
   * pairing out of task_schedule_runs, and the describe above already proves it on a database that
   * was dropped back a column by hand. This one proves it from a database that never had the
   * column, which is the state a box two versions behind is actually in.
   */
  it('gives a run that already existed the schedule it came from', async () => {
    await migrateBelow(62);
    await seedOwner();
    const fromSchedule = '00000000-0000-4000-8000-0000000000e1';
    const fromOwner = '00000000-0000-4000-8000-0000000000e2';
    await addTask(fromSchedule, 'provider_zdr', 'Ran on a timer');
    await addTask(fromOwner, 'provider_zdr', 'Asked for something');
    const scheduleId = '00000000-0000-4000-8000-0000000000f1';
    await database.query(
      `INSERT INTO task_schedules(id,user_id,workspace_id,title_ciphertext,prompt_ciphertext,
         model_id,privacy_route,max_compute_credits,spec)
       VALUES ($1,$2,$3,$4::jsonb,$4::jsonb,'qwen','provider_zdr',1,$5::jsonb)`,
      [
        scheduleId,
        OWNER_ID,
        SPACE_ID,
        sealed,
        JSON.stringify({ kind: 'interval', everyMinutes: 15 })
      ]
    );
    await database.query(
      `INSERT INTO task_schedule_runs(schedule_id,scheduled_for,task_id,outcome)
       VALUES ($1,NOW(),$2,'queued')`,
      [scheduleId, fromSchedule]
    );

    expect(await hasColumn('tasks', 'schedule_id')).toBe(false);

    await apply(62);

    const filed = await database.query<{ id: string; schedule_id: string | null }>(
      'SELECT id,schedule_id FROM tasks ORDER BY id'
    );
    expect(filed.rows).toEqual([
      { id: fromSchedule, schedule_id: scheduleId },
      { id: fromOwner, schedule_id: null }
    ]);
  });

  /*
   * Migration 66 rewrites no rows, so what it has to be tested against is the state it changes: a
   * box that already has conversations, approvals and checkpoints on it, where six referencing
   * columns have no index and one index is a duplicate of another. Asserting that before applying
   * it is the part that matters - every one of these CREATE INDEX statements is IF NOT EXISTS and
   * would pass just as happily against a database that already had them.
   */
  it('gives the cascades their indexes and takes away the checkpoint index that was a duplicate', async () => {
    await migrateBelow(66);
    await seedOwner();
    const conversation = '00000000-0000-4000-8000-0000000000f1';
    await addTask(conversation, 'external');
    await database.query(
      `INSERT INTO approvals(id,user_id,task_id,action,side_effect,preview_ciphertext,preview_hash,
         expires_at)
       VALUES ($1,$2,$3,'browser.click','write',$4::jsonb,'hash',NOW()+INTERVAL '1 hour')`,
      ['00000000-0000-4000-8000-0000000000f2', OWNER_ID, conversation, sealed]
    );
    await database.query(
      `INSERT INTO workspace_checkpoints(id,user_id,workspace_id,task_id,event_sequence,mechanism)
       VALUES ($1,$2,$3,$4,1,'content')`,
      ['00000000-0000-4000-8000-0000000000f3', OWNER_ID, SPACE_ID, conversation]
    );

    const indexes = async (): Promise<string[]> =>
      (
        await database.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname IN ('public','mem') ORDER BY indexname`
        )
      ).rows.map((row) => row.indexname);
    const arriving = [
      'approvals_task_idx',
      'mem_item_task_idx',
      'mem_source_task_cascade_idx',
      'tasks_branched_from_idx',
      'tasks_restored_checkpoint_idx',
      'tasks_workspace_idx'
    ];
    const before = await indexes();
    expect(arriving.filter((name) => before.includes(name))).toEqual([]);
    expect(before).toContain('workspace_checkpoints_task_idx');
    expect(before).toContain('workspace_checkpoints_undo_idx');

    await apply(66);

    const after = await indexes();
    expect(arriving.filter((name) => after.includes(name))).toEqual(arriving);
    expect(after).not.toContain('workspace_checkpoints_task_idx');
    // The one that made it redundant is still there, which is the whole reason it could go.
    expect(after).toContain('workspace_checkpoints_undo_idx');

    // And the constraints those indexes are read through still mean what migration 57 made them
    // mean: deleting the conversation takes its approvals with it and detaches the checkpoint.
    await database.query('DELETE FROM tasks WHERE id=$1', [conversation]);
    await expect(
      database.query('SELECT id FROM approvals').then((result) => result.rows)
    ).resolves.toEqual([]);
    const checkpoint = await database.query<{ task_id: string | null }>(
      'SELECT task_id FROM workspace_checkpoints'
    );
    expect(checkpoint.rows).toEqual([{ task_id: null }]);
  });

  /*
   * Migration 67 drops and re-creates three indexes on a table that already holds the owner's
   * memory, so the risk it carries is not the definitions - it is the rows. The DROP and the CREATE
   * are two statements inside one transaction, and anything that fell out between them would fall
   * out silently: a GIN index re-created from a table whose tsv column had been touched would come
   * back missing exactly the entries nothing else can find.
   *
   * The rows are therefore written the way a version-66 box holds them, before the migration runs,
   * and read back afterwards through the index itself rather than through a sequential scan - which
   * is what `SET enable_seqscan = off` is here for. A test that only read them back would pass on a
   * database whose new index was empty.
   */
  it('re-indexes the memory that was already on the box without losing an entry', async () => {
    await migrateBelow(67);
    await seedOwner();

    const predicates = async (): Promise<string[]> =>
      (
        await database.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname='mem' AND indexname IN
             ('mem_item_tsv_gin','mem_item_subject_idx','mem_item_pin_idx')
           ORDER BY indexname`
        )
      ).rows.map((row) => `${row.indexname}: ${/WHERE (.+)$/.exec(row.indexdef)?.[1] ?? 'none'}`);

    // The state the migration has to find, asserted rather than assumed: three partial indexes, all
    // three predicated on a status the recall statement can never prove.
    expect(await predicates()).toEqual([
      "mem_item_pin_idx: (pin AND (status = 'active'::mem.status))",
      "mem_item_subject_idx: ((kind = 'fact'::mem.kind) AND (status = 'active'::mem.status))",
      "mem_item_tsv_gin: (status = 'active'::mem.status)"
    ]);

    // The registry row a real box has by the time it holds any facts at all; nothing here reads it
    // except the foreign key, and `many` keeps pred_functional false so the unique index stays out
    // of a test that is about three other indexes.
    await database.query(
      `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
       VALUES ('related_to','many',FALSE,'An untyped association between two entities.')`
    );
    /*
     * A hundred and twenty rows rather than three, because the assertion below is about which plan
     * the database can afford, and over three rows every plan costs the same. A fifth of them carry
     * the term the lookup asks for, spread across all three statuses.
     */
    const rowId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const wanted: string[] = [];
    for (let index = 1; index <= 120; index += 1) {
      // Every seventh row is retired and every fifth carries the term, so every thirty-fifth is
      // both - a row the old index could not hold and the lookup below insists on finding.
      const status =
        index % 7 === 0 ? (index % 14 === 0 ? 'archived' : 'superseded') : ('active' as const);
      const carries = index % 5 === 0;
      if (carries) wanted.push(rowId(index));
      await database.query(
        `INSERT INTO mem.item(id,user_id,workspace_id,kind,status,trust,document_ciphertext,
           title_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,subject_key,predicate,
           object_key,pin,indexed)
         VALUES ($1,$2,$3,'fact',$4::mem.status,'stated',$5::jsonb,'aaaa',$6,'{}'::text[],
           '{}'::text[],$7,$8,'related_to','oooo',$9,TRUE)`,
        [
          rowId(index),
          OWNER_ID,
          SPACE_ID,
          status,
          sealed,
          carries ? 'bbbb cccc' : 'dddd cccc',
          `dedupe-${index}`,
          `subj-${index}`,
          index === 1
        ]
      );
    }
    await database.exec('VACUUM ANALYZE mem.item');

    /**
     * A lexical lookup with no status predicate of its own, reported as both the rows it found and
     * whether it reached the lexical index to find them. The rows alone would say nothing: a
     * sequential scan answers the same question correctly and more slowly, which is exactly how a
     * partial index that fits no query goes unnoticed for eight migrations.
     */
    const indexed = async (): Promise<{ ids: string[]; viaIndex: boolean }> => {
      const sql = `SELECT id FROM mem.item WHERE tsv @@ to_tsquery('simple', 'bbbb') ORDER BY id`;
      const found = await database.query<{ id: string }>(sql);
      // Both scan kinds that can answer this without an index predicate are switched off, so what
      // is left is a question about applicability rather than about cost: the only bitmap qual on
      // offer is the tsvector match, and the plan reaches it or falls back to the scan it was told
      // not to take. Asserting the planner's unconstrained choice instead would be committing a
      // cost estimate that moves with the size of the fixture.
      await database.exec('SET enable_seqscan = off; SET enable_indexscan = off');
      try {
        const explained = await database.query<Record<string, unknown>>(
          `EXPLAIN (COSTS OFF) ${sql}`
        );
        return {
          ids: found.rows.map((row) => row.id),
          viaIndex: explained.rows.some((row) =>
            String(Object.values(row)[0]).includes('mem_item_tsv_gin')
          )
        };
      } finally {
        await database.exec('SET enable_seqscan = on; SET enable_indexscan = on');
      }
    };
    // The state the migration has to find: the right answer, read the long way round.
    expect(await indexed()).toEqual({ ids: wanted, viaIndex: false });

    /** Every column the migration could disturb, including the one the index is built over. */
    const everyRow = async () =>
      (
        await database.query<Record<string, unknown>>(
          `SELECT id, status::text AS status, body_tokens, tsv::text AS tsv, tsv_len, pin,
                  subject_key, predicate, pred_functional
           FROM mem.item ORDER BY id`
        )
      ).rows;
    const before = await everyRow();
    expect(before).toHaveLength(120);

    await apply(67);
    await database.exec('VACUUM ANALYZE mem.item');

    expect(await predicates()).toEqual([
      'mem_item_pin_idx: pin',
      "mem_item_subject_idx: (kind = 'fact'::mem.kind)",
      'mem_item_tsv_gin: none'
    ]);
    // The same answer, now through the index the migration rebuilt - including the retired rows the
    // old predicate had kept out of it, which is the entry a DROP-then-CREATE could have lost.
    expect(await indexed()).toEqual({ ids: wanted, viaIndex: true });
    // Nothing was rewritten on the way past: this migration reshapes storage and touches no row.
    expect(await everyRow()).toEqual(before);
    // And the unique index the recall's correctness rests on is untouched by all three swaps.
    const unique = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname='mem_fact_current_one'`
    );
    expect(unique.rows).toHaveLength(1);
  });

  /*
   * Migration 68 is the one the owner has been waiting two releases for, and the row it has to
   * meet is the awkward one: a `spend_limits` row an older athanor wrote, with three caps set and
   * no notion of a price ceiling. What must survive is the caps - a migration that touched them
   * would silently raise or remove the brake the owner is relying on - and what must arrive is two
   * columns that are NULL, because NULL is "no ceiling" and any other value would be this box
   * refusing routes nobody asked it to refuse.
   */
  it('gives an owner who already set three caps two price ceilings they have not set', async () => {
    await migrateBelow(68);
    await seedOwner();
    expect(await hasColumn('spend_limits', 'max_input_usd_per_million_tokens')).toBe(false);
    await database.query(
      `INSERT INTO spend_limits(user_id,daily_cap_usd,monthly_cap_usd,default_task_cap_usd,
         warn_at_percent,time_zone)
       VALUES ($1,5,60,2.5,65,'Europe/Berlin')`,
      [OWNER_ID]
    );

    await apply(68);

    const stored = await new DataStore(database).getSpendLimits(OWNER_ID);
    expect(stored).toMatchObject({
      dailyCapUsd: 5,
      monthlyCapUsd: 60,
      defaultTaskCapUsd: 2.5,
      warnAtPercent: 65,
      timeZone: 'Europe/Berlin',
      maxInputUsdPerMillionTokens: null,
      maxOutputUsdPerMillionTokens: null
    });

    // And the constraint the column carries is on the table, not just in the comment: a ceiling
    // cannot be negative, while zero is a real ceiling that admits only a free route.
    await expect(
      database.query(
        'UPDATE spend_limits SET max_input_usd_per_million_tokens=-1 WHERE user_id=$1',
        [OWNER_ID]
      )
    ).rejects.toThrow();
    await expect(
      database.query(
        'UPDATE spend_limits SET max_input_usd_per_million_tokens=0 WHERE user_id=$1',
        [OWNER_ID]
      )
    ).resolves.toBeTruthy();
  });

  /*
   * The three indexes 68 adds, against a table an older athanor filled. Nothing is rewritten, so
   * what is worth proving is that the reads they exist for actually reach them afterwards - an
   * index that is registered and never chosen is the defect this whole band is made of.
   *
   * `tasks_unindexed_name_idx` is the one with a trap in it. Its predicate holds a constant, so the
   * planner has to prove the statement's predicate is covered by it - and bound as a parameter that
   * proof holds only while the plan is a custom one. Both arms are asserted below, because they are
   * different failures: the plan assertion catches a stamp bump that forgot this migration, and the
   * generic-plan assertion catches the day something names a prepared statement here.
   */
  it('leaves the conversations alone and lets the three reads that scanned them use an index', async () => {
    await migrateBelow(68);
    await seedOwner();
    for (let index = 0; index < 40; index += 1)
      await addTask(
        `00000000-0000-4000-8000-0000000${(index + 100).toString().padStart(5, '0')}`,
        'external',
        `Conversation ${index}`
      );
    const rows = async () =>
      (
        await database.query<{ id: string; title: string }>(
          'SELECT id,title FROM tasks ORDER BY id'
        )
      ).rows;
    const before = await rows();
    expect(before).toHaveLength(40);

    await apply(68);
    await database.exec('VACUUM ANALYZE tasks');

    // A schema change, not a rewrite: every conversation is exactly as it was.
    expect(await rows()).toEqual(before);

    const store = new DataStore(database);
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    const probe: Database = {
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        captured.push({ sql, params });
        return database.query<T>(sql, params);
      },
      exec: (sql: string) => database.exec(sql),
      transaction: (callback) => database.transaction(callback),
      withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
        database.withAdvisoryLock(lock, callback),
      notify: (channel, payload) => database.notify(channel, payload),
      listen: (channel, handler) => database.listen(channel, handler),
      close: async () => undefined
    };
    await new DataStore(probe).listTasksMissingNameIndex(500);
    const statement = captured.find((entry) => entry.sql.includes('name_tsv'))!;
    expect(statement.params).toEqual([500]);
    expect(statement.sql).toContain(CONVERSATION_NAME_INDEX_STAMP);

    // Asked with sequential scans disabled, like the sibling assertion on tasks_activity_idx: what
    // is being measured is whether the predicate can be proven covered at all, not which plan is
    // cheapest on a fixture of forty rows.
    await database.exec('SET enable_seqscan = off');
    const planOf = async (sql: string, params: unknown[]) =>
      (await database.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params)).rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');

    const plan = await planOf(statement.sql, statement.params);
    expect(plan).toContain('Index Scan using tasks_unindexed_name_idx');
    // Which is also the assertion that the migration's copy of the stamp is the live one: a bump
    // that forgot the migration leaves the predicate unprovable and this plan falls back to a sort.
    expect(plan).not.toContain('Sort Key');

    // And it holds when the server plans without the values in hand. Bound as a parameter the same
    // read cannot reach this index at all under a generic plan - it falls back to the sort over
    // every conversation it did before the migration, and would do again the day anything here is
    // prepared by name. Both are asked with sequential scans still disabled, so the difference is
    // provability rather than cost.
    await database.exec('SET plan_cache_mode = force_generic_plan');
    await database.exec(`PREPARE drain(int) AS ${statement.sql}`);
    await database.exec(
      `PREPARE drain_bound(int, text) AS
       SELECT id, workspace_id, title, prompt_ciphertext FROM tasks
       WHERE name_tsv IS NULL OR NOT (name_tsv @@ $2::text::tsquery)
       ORDER BY created_at, id LIMIT $1`
    );
    expect(await planOf('EXECUTE drain(500)', [])).toContain(
      'Index Scan using tasks_unindexed_name_idx'
    );
    expect(
      await planOf(`EXECUTE drain_bound(500, '${CONVERSATION_NAME_INDEX_STAMP}')`, [])
    ).not.toContain('tasks_unindexed_name_idx');
    await database.exec('DEALLOCATE drain; DEALLOCATE drain_bound');
    await database.exec('SET plan_cache_mode = auto');

    // The other two, on the statements they were built for. The notifier's arm enumerated every
    // terminal conversation the owner has ever had, once per subscribed device, every two seconds;
    // the sidebar's fold counted every run of every schedule on every page load.
    const terminal = await planOf(
      `SELECT t.id FROM tasks t
       WHERE t.user_id=$1 AND t.status IN ('completed','failed','cancelled')
         AND COALESCE(t.completed_at,t.updated_at) > NOW() - INTERVAL '14 days'
         AND (t.status='failed' OR t.schedule_id IS NULL)`,
      [OWNER_ID]
    );
    expect(terminal).toContain('tasks_recent_terminal_idx');

    const fold = await planOf(
      `SELECT r.schedule_id, COUNT(*)::int FROM tasks r
       WHERE r.user_id=$1 AND r.schedule_id IS NOT NULL AND NOT r.pinned
         AND r.archived_at IS NULL
       GROUP BY r.schedule_id`,
      [OWNER_ID]
    );
    expect(fold).toContain('tasks_schedule_fold_idx');
    // Index-only, which is the whole of why it is worth having: the fold reads no heap page at all.
    expect(fold).toContain('Index Only Scan');
    await database.exec('SET enable_seqscan = on');

    // The rows the drain has to reach are still all of them - the index changed the plan and not
    // the answer.
    await expect(store.listTasksMissingNameIndex(500)).resolves.toHaveLength(40);
  });

  /*
   * Migration 69 drops five columns and one unique index. A drop has no backfill, so the upgrade
   * test cannot be "did the statement fill this in" - it is "did the owner lose anything", and the
   * only way to ask that honestly is to put something in the columns first.
   *
   * A replay could not ask it at all. Every row this file's other describes write is written in
   * today's shape, where these columns do not exist to be filled, so a dropped column is dropped
   * from an empty place and the test passes whatever the rest of the row does. Here the columns are
   * written the way a box that ran migration 25 could have had them written - by hand, since no
   * code path ever did - and the assertion after the drop is that everything beside them survived.
   *
   * The unique index is checked separately from the column, because `DROP COLUMN` takes its indexes
   * with it silently: a migration that dropped only the index, or only the column, would leave the
   * other half standing and this is the pair of assertions that can tell those apart.
   */
  it('drops five columns nothing ever wrote without disturbing the rows that carried them', async () => {
    await migrateBelow(69);
    await seedOwner();

    const indexNames = async (table: string) =>
      (
        await database.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename=$1 ORDER BY indexname`,
          [table]
        )
      ).rows.map((row) => row.indexname);

    // Every one of them is there to be lost, and the index is there to police one of them.
    expect(await hasColumn('workspace_previews', 'custom_domain')).toBe(true);
    expect(await hasColumn('workspace_previews', 'domain_status')).toBe(true);
    expect(await hasColumn('workspace_previews', 'domain_verification_hash')).toBe(true);
    expect(await hasColumn('mem.item', 'trigger_key')).toBe(true);
    expect(await indexNames('workspace_previews')).toContain(
      'workspace_previews_custom_domain_idx'
    );

    await database.query(
      `INSERT INTO workspace_previews(id,user_id,workspace_id,label,port,slug,access_token_hash,
         visibility,status,custom_domain,domain_status,domain_verification_hash)
       VALUES ($1,$2,$3,'Agent app',3000,$4,'hash-a','public','active',
         'notes.example',  'active','sha-of-a-txt-record')`,
      ['00000000-0000-4000-8000-0000000000c1', OWNER_ID, SPACE_ID, 'a'.repeat(32)]
    );
    await database.query(
      `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
       VALUES ('related_to','many',FALSE,'An untyped association between two entities.')`
    );
    await database.query(
      `INSERT INTO mem.item(id,user_id,workspace_id,kind,status,trust,document_ciphertext,
         title_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,subject_key,predicate,object_key,
         trigger_key,indexed)
       VALUES ($1,$2,$3,'procedure','active','stated',$4::jsonb,'aaaa','bbbb','{}'::text[],
         '{}'::text[],'dedupe-a','subj-a','related_to','oooo','a-trigger-nobody-minted',TRUE)`,
      ['00000000-0000-4000-8000-0000000000d1', OWNER_ID, SPACE_ID, sealed]
    );

    await apply(69);

    expect(await hasColumn('workspace_previews', 'custom_domain')).toBe(false);
    expect(await hasColumn('workspace_previews', 'domain_status')).toBe(false);
    expect(await hasColumn('workspace_previews', 'domain_verification_hash')).toBe(false);
    expect(await hasColumn('mem.item', 'trigger_key')).toBe(false);
    expect(await indexNames('workspace_previews')).not.toContain(
      'workspace_previews_custom_domain_idx'
    );

    // The published site is still published, still reachable by its slug, and still the owner's.
    const previews = await database.query<{
      slug: string;
      label: string;
      visibility: string;
      status: string;
      port: number;
      user_id: string;
    }>('SELECT slug,label,visibility,status,port,user_id FROM workspace_previews');
    expect(previews.rows).toEqual([
      {
        slug: 'a'.repeat(32),
        label: 'Agent app',
        visibility: 'public',
        status: 'active',
        port: 3000,
        user_id: OWNER_ID
      }
    ]);

    // And the remembered procedure is still remembered, still indexed, still on its predicate.
    const items = await database.query<{ id: string; kind: string; predicate: string }>(
      'SELECT id,kind,predicate FROM mem.item'
    );
    expect(items.rows).toEqual([
      {
        id: '00000000-0000-4000-8000-0000000000d1',
        kind: 'procedure',
        predicate: 'related_to'
      }
    ]);

    // The store agrees with the schema: a record built from the row after the drop no longer
    // carries the three fields that used to be served as nulls.
    const store = new DataStore(database);
    const [preview] = await store.listWorkspacePreviews(OWNER_ID, SPACE_ID);
    expect(preview).toBeDefined();
    expect(Object.keys(preview!)).not.toContain('customDomain');
    expect(Object.keys(preview!)).not.toContain('domainStatus');
    expect(Object.keys(preview!)).not.toContain('domainVerificationHash');
  });
});

describe('task spend on the owner-facing reads', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  it('carries the task ceiling and what it has cost so far', async () => {
    const user = await store.createUser({ username: 'reader', displayName: 'Reader' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Reading'));
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      maxSpendUsd: 2.5
    });
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 500,
      unit: 'tokens',
      credits: 0.1,
      state: 'settled',
      idempotencyKey: 'read-1',
      providerRef: 'openrouter:z-ai/glm-5.2',
      costUsd: 0.4
    });
    await expect(store.getTask(user.id, task.id)).resolves.toMatchObject({
      maxSpendUsd: 2.5,
      spentUsd: 0.4
    });
    // The sidebar reads across every workspace and is paged; listTasks is the unpaged whole-set
    // read for one workspace, which is what the "is anything still running here" checks need.
    await expect(store.listTaskPage(user.id)).resolves.toMatchObject({
      tasks: [{ id: task.id, maxSpendUsd: 2.5, spentUsd: 0.4 }],
      hasMore: false
    });
    await expect(store.listTasks(user.id, workspace.id)).resolves.toMatchObject([
      { id: task.id, spentUsd: 0.4 }
    ]);
  });

  /*
   * Pinning, filing and renaming return the conversation, and the client writes what comes back
   * straight into the sidebar row. Both statements used to answer `0 AS queued_message_count` and
   * to not select spend at all, so `mapTask` produced a record that said no follow-ups were waiting
   * and nothing had been spent - which the sidebar then believed until the next full reload. The
   * assertion is against `getTask` rather than against literals, because getTask is where the
   * correct shape was already written down.
   */
  it('answers a pin, a filing and a rename with the counts getTask would give', async () => {
    const user = await store.createUser({ username: 'filer', displayName: 'Filer' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Filing'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 900,
      unit: 'tokens',
      credits: 0.2,
      state: 'settled',
      idempotencyKey: 'filed-1',
      costUsd: 3.4
    });
    for (const messageId of [
      '2c0b3b7e-3d4c-4c1e-9f52-2b0f8b9a1d01',
      '2c0b3b7e-3d4c-4c1e-9f52-2b0f8b9a1d02'
    ])
      await store.enqueueTaskMessage({
        id: messageId,
        taskId: task.id,
        userId: user.id,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        resourceClass: 'medium',
        reservationKey: `task:${task.id}:message:${messageId}:reservation`,
        promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
        queuedEventCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
      });
    // What the owner is actually looking at, established before anything is asked to reproduce it.
    await expect(store.getTask(user.id, task.id)).resolves.toMatchObject({
      queuedMessageCount: 2,
      spentUsd: 3.4
    });

    await expect(store.updateTaskFiling(user.id, task.id, { pinned: true })).resolves.toMatchObject(
      {
        pinned: true,
        queuedMessageCount: 2,
        spentUsd: 3.4
      }
    );
    await expect(
      store.renameTask(
        user.id,
        task.id,
        { v: 1, iv: 'a', tag: 'b', ciphertext: 'renamed' },
        UNINDEXED_NAME
      )
    ).resolves.toMatchObject({ titleSource: 'owner', queuedMessageCount: 2, spentUsd: 3.4 });

    // Two more statements the same client writes into the same row. The audit named three; these
    // were found by asking which other statements hand a task back to a caller who then treats it
    // as the whole record - the security-mode toggle is written into the sidebar list by id, and
    // the follow-up route returns the row the queue statement produced.
    await expect(
      store.updateTaskSecurityMode(user.id, task.id, 'autonomous')
    ).resolves.toMatchObject({
      securityMode: 'autonomous',
      queuedMessageCount: 2,
      spentUsd: 3.4
    });
    const messageId = '2c0b3b7e-3d4c-4c1e-9f52-2b0f8b9a1d03';
    await expect(
      store.enqueueTaskMessage({
        id: messageId,
        taskId: task.id,
        userId: user.id,
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        resourceClass: 'medium',
        reservationKey: `task:${task.id}:message:${messageId}:reservation`,
        promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
        queuedEventCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
      })
    ).resolves.toMatchObject({ queuedMessageCount: 3, spentUsd: 3.4 });
  });

  /*
   * The same defect on the third statement, which the owner reaches by writing again to a finished
   * conversation. Its follow-up queue is empty by construction - a completed task cannot hold one -
   * so what it has to carry forward is the spend, and it carried zero.
   */
  it('answers a follow-up on a finished conversation with the spend it already has', async () => {
    const user = await store.createUser({ username: 'resumer', displayName: 'Resumer' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Resuming'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.recordUsage({
      userId: user.id,
      workspaceId: workspace.id,
      taskId: task.id,
      kind: 'model_inference',
      resourceClass: 'medium',
      quantity: 400,
      unit: 'tokens',
      credits: 0.1,
      state: 'settled',
      idempotencyKey: 'resumed-1',
      costUsd: 1.25
    });
    await store.updateTask({ id: task.id, status: 'completed', clearLease: true });

    const continued = await store.continueTask({
      id: task.id,
      userId: user.id,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      additionalComputeCredits: 1,
      agentStateCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'state' },
      reservationKey: `task:${task.id}:turn:1:reservation`,
      resourceClass: 'medium',
      userMessageCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'message' }
    });
    expect(continued).toMatchObject({ status: 'queued', queuedMessageCount: 0, spentUsd: 1.25 });
    await expect(store.getTask(user.id, task.id)).resolves.toMatchObject({
      queuedMessageCount: continued!.queuedMessageCount,
      spentUsd: continued!.spentUsd
    });
  });

  /*
   * The cursor is a position in an ordering, and it has to be able to express that position
   * exactly. PostgreSQL keeps microseconds; the cursor was built from the mapped ISO string, which
   * keeps milliseconds - so every conversation sharing a millisecond with the last row of a page
   * sorted "after" a cursor that had been rounded up past it, and vanished from the list. Nothing
   * about it was visible: the page came back short, and the conversation was still there.
   */
  it('pages the conversation list without losing one that shares a millisecond', async () => {
    const user = await store.createUser({ username: 'pager', displayName: 'Pager' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Paging'));
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1)
      ids.push((await store.createTask(taskInput(user.id, workspace.id))).id);
    // The same millisecond, a hundred microseconds apart, which is a perfectly ordinary way for
    // three conversations to be touched by one turn of work.
    const stamps = [
      '2026-08-01T09:00:00.123456+00',
      '2026-08-01T09:00:00.123400+00',
      '2026-08-01T09:00:00.123100+00'
    ];
    for (const [index, id] of ids.entries())
      await database.query(
        'UPDATE tasks SET updated_at=$2::timestamptz, created_at=$2::timestamptz WHERE id=$1',
        [id, stamps[index]]
      );

    const first = await store.listTaskPage(user.id, { limit: 2 });
    expect(first.tasks.map((task) => task.id)).toEqual([ids[0], ids[1]]);
    expect(first.hasMore).toBe(true);
    const second = await store.listTaskPage(user.id, { cursor: first.nextCursor! });
    expect(second.tasks.map((task) => task.id)).toEqual([ids[2]]);
    expect(second.hasMore).toBe(false);
  });

  /**
   * A fifteen-minute watcher is ninety-six conversations a day, and the list is ordered by
   * activity, so the schedule the owner set up once used to take the whole first page inside two
   * days. What fell off the end was the only thing on it they had done themselves.
   */
  it('keeps one schedule from taking the list the owner finds their own work in', async () => {
    const user = await store.createUser({ username: 'watched', displayName: 'Watched' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Watched'));
    const scheduleId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf2';
    const mine = await store.createTask(taskInput(user.id, workspace.id));
    await database.query(
      'UPDATE tasks SET created_at=$2::timestamptz, updated_at=$2::timestamptz WHERE id=$1',
      [mine.id, '2026-08-01T09:00:00+00']
    );
    const runs: string[] = [];
    for (let fired = 0; fired < 12; fired += 1) {
      const run = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        `UPDATE tasks SET schedule_id=$2, created_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id=$1`,
        [run.id, scheduleId, new Date(Date.UTC(2026, 7, 2, fired)).toISOString()]
      );
      runs.push(run.id);
    }
    const newest = [...runs].reverse();

    const page = await store.listTaskPage(user.id, { limit: 10 });
    expect(page.tasks.filter((task) => task.scheduleId).map((task) => task.id)).toEqual(
      newest.slice(0, 5)
    );
    // The whole point: the owner's own conversation is still on the page they read.
    expect(page.tasks.map((task) => task.id)).toContain(mine.id);
    // And the folded line can say how many runs there are rather than how many it is holding.
    expect(page.scheduleRunCounts).toEqual({ [scheduleId]: 12 });

    // Nothing is hidden by this, only kept out of the way: the schedule's own list is all of them.
    const history = await store.listTaskPage(user.id, { scheduleId });
    expect(history.tasks.map((task) => task.id)).toEqual(newest);

    // A run the owner pinned is theirs now, so it is neither capped away nor counted as the
    // schedule's - which is exactly what the client does with a pinned run.
    await store.updateTaskFiling(user.id, runs[0]!, { pinned: true });
    const pinned = await store.listTaskPage(user.id, { limit: 10 });
    expect(pinned.tasks.map((task) => task.id)).toContain(runs[0]);
    expect(pinned.scheduleRunCounts).toEqual({ [scheduleId]: 11 });
  });

  /*
   * `tasks_activity_idx` carries the sidebar's exact ordering, GREATEST() expression and all, and
   * migration 51 says in as many words that because of it "the owner's first page never sorts the
   * whole table". It could not: the index leads on `tasks.user_id` and the statement bound the
   * owner on the *joined* `workspaces.user_id`, so nothing ever fixed the index's leading column
   * and the ordering was never satisfiable from it. Page one read and sorted every row the owner
   * had to return fifty-one of them.
   *
   * The plan is asked for with sequential scans disabled, so what is being measured is whether the
   * ordering can come out of the index at all rather than which plan is cheapest on a table of
   * twelve rows.
   */
  /*
   * The scoping and the fold index both change how page one is *found* and neither may change what
   * it *returns*. The owner has conversations in more than one workspace, some of them runs of a
   * schedule, some pinned, some archived - which is the fixture where an owner filter asked of the
   * conversation rather than of the workspace it sits in could quietly differ from one asked of the
   * join, and where an index-only fold could count a different set than the sequential scan did.
   *
   * So the page is read once the way the planner wants to read it and once with every index taken
   * out of its hands, and the two must be the same rows in the same order with the same run counts.
   */
  it('returns the same page in the same order however the planner chooses to find it', async () => {
    const user = await store.createUser({ username: 'spread', displayName: 'Spread' });
    const other = await store.createUser({ username: 'neighbour', displayName: 'Neighbour' });
    const spaces = [
      await store.createWorkspace(workspaceInput(user.id, 'First')),
      await store.createWorkspace(workspaceInput(user.id, 'Second'))
    ];
    const theirs = await store.createWorkspace(workspaceInput(other.id, 'Theirs'));
    const envelope = { v: 1 as const, iv: 'a', tag: 'b', ciphertext: 'c' };
    const schedule = await store.createTaskSchedule({
      userId: user.id,
      workspaceId: spaces[0]!.id,
      titleCiphertext: envelope,
      promptCiphertext: envelope,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      spec: { kind: 'interval', everyMinutes: 15 },
      nextRunAt: new Date(Date.now() + 60_000)
    });

    const mine: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const workspace = spaces[index % 2]!;
      const task = await store.createTask(taskInput(user.id, workspace.id));
      mine.push(task.id);
      if (index % 3 === 0)
        await database.query('UPDATE tasks SET schedule_id=$2 WHERE id=$1', [task.id, schedule.id]);
      if (index === 5) await store.updateTaskFiling(user.id, task.id, { pinned: true });
      if (index === 7) await store.updateTaskFiling(user.id, task.id, { archived: true });
    }
    // A neighbour's conversation, which must not appear in either reading.
    const notMine = await store.createTask(taskInput(other.id, theirs.id));

    const page = async () => {
      const read = await store.listTaskPage(user.id, { limit: 10 });
      return {
        ids: read.tasks.map((task) => task.id),
        counts: read.scheduleRunCounts,
        cursor: read.nextCursor !== null
      };
    };
    const planned = await page();
    await database.exec('SET enable_indexscan = off; SET enable_bitmapscan = off');
    const scanned = await page();
    await database.exec('SET enable_indexscan = on; SET enable_bitmapscan = on');

    expect(planned.ids).toHaveLength(10);
    expect(planned.ids).not.toContain(notMine.id);
    expect(scanned).toEqual(planned);
    // And the second page agrees too, because the cursor is a position in this exact ordering.
    const first = await store.listTaskPage(user.id, { limit: 10 });
    const second = await store.listTaskPage(user.id, { limit: 10, cursor: first.nextCursor });
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(20);
  });

  it('draws the first page of the sidebar from the index that was built for it', async () => {
    const user = await store.createUser({ username: 'planner', displayName: 'Planner' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Planning'));
    for (let index = 0; index < 12; index += 1)
      await store.createTask(taskInput(user.id, workspace.id));
    await database.exec('ANALYZE tasks');

    let captured: { sql: string; params: unknown[] } | null = null;
    const probe: Database = {
      query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        if (sql.includes('schedule_ceiling')) captured = { sql, params };
        return database.query<T>(sql, params);
      },
      exec: (sql: string) => database.exec(sql),
      transaction: (callback) => database.transaction(callback),
      withAdvisoryLock: <T>(lock: number, callback: () => Promise<T>) =>
        database.withAdvisoryLock(lock, callback),
      notify: (channel, payload) => database.notify(channel, payload),
      listen: (channel, handler) => database.listen(channel, handler),
      close: async () => undefined
    };
    await new DataStore(probe).listTaskPage(user.id, { limit: 50 });

    await database.exec('SET enable_seqscan = off');
    const explained = await database.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) ${captured!.sql}`,
      captured!.params
    );
    await database.exec('SET enable_seqscan = on');
    const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).toMatch(
      /Index Scan using tasks_activity_idx on tasks t\n\s+Index Cond: \(user_id/
    );
    // And the half that costs the owner their opening second: with the ordering coming out of the
    // index there is nothing left to sort. Before the scope was fixed this plan carried
    // "Sort Key: t.pinned DESC, (GREATEST(t.updated_at, t.created_at)) DESC, t.id DESC" over a
    // sequential scan of every conversation on the box.
    expect(plan).not.toContain('Sort Key: t.pinned');
  });

  /**
   * The ceiling has to rank over the rows the page is drawn from and not over every run there has
   * ever been, or filing a run away hides the ones behind it.
   *
   * An owner who archives the newest few runs of a noisy watcher - the most ordinary thing anyone
   * does with one - was setting the boundary with rows that were then not on the page to occupy it,
   * and the schedule disappeared from the list while the count beside it still said hundreds.
   * Pinning the newest few did the same thing, and the client leaves pinned runs out of the fold,
   * so the folded line was left with nothing behind it at all.
   */
  it('does not hide a schedule behind the runs of it the owner has filed or pinned', async () => {
    const user = await store.createUser({ username: 'filed', displayName: 'Filed' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Filed'));
    const scheduleId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf4';
    const runs: string[] = [];
    for (let fired = 0; fired < 20; fired += 1) {
      const run = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        `UPDATE tasks SET schedule_id=$2, created_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id=$1`,
        [run.id, scheduleId, new Date(Date.UTC(2026, 7, 4, fired)).toISOString()]
      );
      runs.push(run.id);
    }
    const newest = [...runs].reverse();

    for (const id of newest.slice(0, 5))
      await store.updateTaskFiling(user.id, id, { pinned: true });
    const withPinned = await store.listTaskPage(user.id, { limit: 50 });
    expect(
      withPinned.tasks.filter((task) => task.scheduleId === scheduleId && !task.pinned)
    ).toHaveLength(5);
    expect(withPinned.scheduleRunCounts).toEqual({ [scheduleId]: 15 });

    for (const id of newest.slice(0, 5))
      await store.updateTaskFiling(user.id, id, { pinned: false });
    for (const id of newest.slice(0, 5))
      await store.updateTaskFiling(user.id, id, { archived: true });
    const active = await store.listTaskPage(user.id, { limit: 50, include: 'active' });
    expect(active.tasks.filter((task) => task.scheduleId === scheduleId)).toHaveLength(5);
    expect(active.scheduleRunCounts).toEqual({ [scheduleId]: 15 });
  });

  /**
   * The ceiling is a fact about each run rather than about the page, which is the only way it can
   * live alongside a cursor: a page boundary that fell inside a schedule's runs would otherwise
   * show one twice or step over one.
   */
  it('pages a capped list without showing a run twice or stepping over one', async () => {
    const user = await store.createUser({ username: 'capped', displayName: 'Capped' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Capped'));
    const scheduleId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf3';
    for (let fired = 0; fired < 8; fired += 1) {
      const run = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        `UPDATE tasks SET schedule_id=$2, created_at=$3::timestamptz, updated_at=$3::timestamptz
         WHERE id=$1`,
        [run.id, scheduleId, new Date(Date.UTC(2026, 7, 3, fired)).toISOString()]
      );
      const mine = await store.createTask(taskInput(user.id, workspace.id));
      await database.query(
        'UPDATE tasks SET created_at=$2::timestamptz, updated_at=$2::timestamptz WHERE id=$1',
        [mine.id, new Date(Date.UTC(2026, 7, 3, fired, 30)).toISOString()]
      );
    }
    const whole = await store.listTaskPage(user.id, { limit: 100 });
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10 && (page === 0 || cursor); page += 1) {
      const next: Awaited<ReturnType<typeof store.listTaskPage>> = await store.listTaskPage(
        user.id,
        { limit: 2, ...(cursor ? { cursor } : {}) }
      );
      walked.push(...next.tasks.map((task) => task.id));
      cursor = next.nextCursor;
    }
    expect(walked).toEqual(whole.tasks.map((task) => task.id));
    expect(whole.tasks.filter((task) => task.scheduleId)).toHaveLength(5);
  });

  it('finds a conversation by a name the owner gave it, however old the conversation is', async () => {
    const user = await store.createUser({ username: 'namer', displayName: 'Namer' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Naming'));
    const key = memoryIndexKey(generateDataKey());
    const named = (title: string, prompt: string) => buildConversationNameIndex(title, prompt, key);

    // Renamed by the owner, and then buried under two thousand conversations. Its new name shares
    // no word with the request it started from, so nothing about it is in the verbatim corpus.
    const renamed = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Check the thing', 'Check the thing')
    });
    await store.renameTask(
      user.id,
      renamed.id,
      { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      named('Kitchen rewire', 'Check the thing')
    );
    // Only mentions the words in its opening request, so it must lose to the one called that.
    const mentioned = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Weekend jobs', 'Get a quote for the kitchen rewire before the holiday')
    });
    for (let index = 0; index < 20; index += 1)
      await store.createTask({
        ...taskInput(user.id, workspace.id),
        nameIndex: named(`Unrelated ${index}`, 'Something else entirely')
      });
    await database.query(
      `UPDATE tasks SET created_at='2026-03-02T09:00:00Z', updated_at='2026-03-02T09:00:00Z'
       WHERE id = ANY($1::uuid[])`,
      [[renamed.id, mentioned.id]]
    );

    const hits = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('kitchen rewire', key).lexemes,
      limit: 10
    });
    expect(hits.map((hit) => hit.id)).toEqual([renamed.id, mentioned.id]);
    expect(hits[0]).toMatchObject({ wholeName: true, inName: true });
    // Nothing of the query is in this one's name, so it is carried entirely by the opening.
    expect(hits[1]).toMatchObject({ wholeName: false, inName: false });

    // Stemming reaches a name because the name went through the corpus tokenizer, not because
    // anything here reimplemented it.
    const restarted = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Relay restart', 'Look at the relay')
    });
    const stemmed = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('restarted the relays', key).lexemes,
      limit: 10
    });
    expect(stemmed.map((hit) => hit.id)).toEqual([restarted.id]);
    expect(stemmed[0]).toMatchObject({ wholeName: true });

    const other = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    await expect(
      store.searchTaskNames(other.id, { lexemes: planMemoryQuery('kitchen rewire', key).lexemes })
    ).resolves.toEqual([]);
  });

  /**
   * How a person actually searches: the first few letters of a word they half remember, with the
   * list narrowing as they type. The client covers the conversations this device has already
   * loaded - two hundred of them - by matching their titles as substrings, and then throws that
   * list away for whatever the box says. So a conversation past the loaded band was unreachable by
   * a prefix, and one inside it appeared while the request was in flight and then vanished.
   */
  it('finds a conversation by the first letters of a word in its name, past the loaded band', async () => {
    const user = await store.createUser({ username: 'prefix', displayName: 'Prefix' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Prefixing'));
    const key = memoryIndexKey(generateDataKey());
    const named = (title: string, prompt: string) => buildConversationNameIndex(title, prompt, key);

    const audit = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Grimbolder audit', 'Go through the ledger for the quarter')
    });
    // The conversation actually called that, so the tiers can be told apart: an exact name must
    // still outrank a name that merely starts with what was typed.
    const exact = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: named('Grimbold', 'Ask about the estate')
    });
    // Two hundred and ten conversations on top, which is more than the client ever holds, so the
    // only thing that can answer this is the index.
    for (let index = 0; index < 210; index += 1)
      await store.createTask({
        ...taskInput(user.id, workspace.id),
        nameIndex: named(`Unrelated ${index}`, 'Something else entirely')
      });

    const typed = async (query: string) =>
      store.searchTaskNames(user.id, {
        lexemes: planMemoryQuery(query, key).lexemes,
        prefixes: conversationNamePrefixTokens(query, key),
        limit: 10
      });

    // The case from the commit that disclosed this: the index matches whole stemmed lexemes, and
    // `grimbold` is not one of the lexemes of "Grimbolder audit".
    const hits = await typed('grimbold');
    expect(hits.map((hit) => hit.id)).toEqual([exact.id, audit.id]);
    expect(hits[0]).toMatchObject({ wholeName: true, namePrefix: true });
    expect(hits[1]).toMatchObject({ wholeName: false, inName: false, namePrefix: true });

    // Narrowing as the word is typed out, and stopping when it stops being a prefix of anything.
    await expect(typed('gri').then((rows) => rows.length)).resolves.toBe(2);
    await expect(typed('grimbolder').then((rows) => rows.map((hit) => hit.id))).resolves.toEqual([
      audit.id
    ]);
    await expect(typed('grimbolt')).resolves.toEqual([]);

    // A finished word before the one being typed is still matched as a word, not as a prefix, so
    // both conversations are carried by a word of their name and the prefix. Nothing separates
    // them but which was touched last, which is what the clock is there for.
    const both = await typed('audit grimbold');
    expect(both.map((hit) => hit.id).sort()).toEqual([audit.id, exact.id].sort());
    expect(both.every((hit) => hit.inName && hit.namePrefix)).toBe(true);
    // And a search with nothing half-typed in it answers exactly as it did before.
    const whole = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('grimbolder', key).lexemes,
      limit: 10
    });
    expect(whole.map((hit) => hit.id)).toEqual([audit.id]);
    expect(whole[0]).toMatchObject({ namePrefix: false });
  });

  it('leaves a conversation written before the index existed for the boot pass to pick up', async () => {
    const user = await store.createUser({ username: 'backfill', displayName: 'Backfill' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Backfill'));
    const key = memoryIndexKey(generateDataKey());
    const task = await store.createTask(taskInput(user.id, workspace.id));
    // What every row on a box that predates the column looks like.
    await database.query('UPDATE tasks SET name_tsv = NULL WHERE id=$1', [task.id]);

    const waiting = await store.listTasksMissingNameIndex();
    expect(waiting.map((row) => row.id)).toEqual([task.id]);
    await store.setTaskNameIndex(
      task.id,
      buildConversationNameIndex('Sailing trip', 'Plan the crossing', key)
    );

    await expect(store.listTasksMissingNameIndex()).resolves.toEqual([]);
    const hits = await store.searchTaskNames(user.id, {
      lexemes: planMemoryQuery('sailing trip', key).lexemes
    });
    expect(hits.map((hit) => hit.id)).toEqual([task.id]);
  });

  /**
   * The other half of the same pass, and the one an update actually meets: a row indexed by the
   * previous shape of the vector is not NULL, so nothing would ever have looked at it again and
   * the whole history would have kept the loss the new column was written to remove.
   */
  it('re-reads a conversation whose name was indexed by an older shape of the vector', async () => {
    const user = await store.createUser({ username: 'restamp', displayName: 'Restamp' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Restamp'));
    const key = memoryIndexKey(generateDataKey());
    const task = await store.createTask({
      ...taskInput(user.id, workspace.id),
      nameIndex: buildConversationNameIndex('Grimbolder audit', 'Go through the ledger', key)
    });
    // Exactly what the previous build wrote: the name at A, the request at D, no prefixes and no
    // stamp. A row nobody would have looked at twice.
    const previous = buildConversationNameIndex('Grimbolder audit', 'Go through the ledger', key);
    await database.query(
      `UPDATE tasks SET name_tsv = setweight(to_tsvector('simple', $2::text), 'A')
         || setweight(to_tsvector('simple', $3::text), 'D') WHERE id=$1`,
      [task.id, previous.nameTokens, previous.openingTokens]
    );
    const typed = () =>
      store.searchTaskNames(user.id, {
        lexemes: planMemoryQuery('grimbold', key).lexemes,
        prefixes: conversationNamePrefixTokens('grimbold', key)
      });
    await expect(typed()).resolves.toEqual([]);

    const waiting = await store.listTasksMissingNameIndex();
    expect(waiting.map((row) => row.id)).toEqual([task.id]);
    await store.setTaskNameIndex(task.id, previous);
    // Re-indexed once and then left alone, however many times the box is restarted.
    await expect(store.listTasksMissingNameIndex()).resolves.toEqual([]);
    expect((await typed()).map((hit) => hit.id)).toEqual([task.id]);
  });

  it('anchors a turn checkpoint to the point in the transcript it was taken at', async () => {
    const user = await store.createUser({ username: 'rewind', displayName: 'Rewind' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Rewind'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Build it' });

    const first = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be1',
      workspaceId: workspace.id,
      taskId: task.id,
      turn: 0,
      mechanism: 'content',
      fileCount: 120,
      totalBytes: 4096,
      storedBytes: 512,
      durationMs: 180
    });
    expect(first).toMatchObject({ eventSequence: 1, mechanism: 'content', storedBytes: 512 });

    const midpoint = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'tool_started',
      summary: 'Running shell'
    });
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Actually...' });
    const second = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be2',
      workspaceId: workspace.id,
      taskId: task.id,
      turn: 1,
      mechanism: 'btrfs',
      fileCount: null,
      totalBytes: null,
      storedBytes: 0,
      durationMs: 12
    });
    const last = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Done'
    });

    // A checkpoint sits in front of the work its turn is about to do, so the one that answers
    // "put the computer back to this event" is the newest at or before it - never a later one.
    await expect(
      store.checkpointForTaskEvent(user.id, task.id, midpoint.id)
    ).resolves.toMatchObject({ id: first.id });
    await expect(store.checkpointForTaskEvent(user.id, task.id, last.id)).resolves.toMatchObject({
      id: second.id,
      fileCount: null,
      totalBytes: null
    });

    // The shape a real turn has: the message, the status lines the worker writes before it does
    // anything, and only then the undo point. Anchoring on the message the owner sent has to find
    // the point for the work that message caused - recording where the checkpoint happened to be
    // taken put it beyond that anchor, so a first turn reported nothing to undo and a later one
    // silently handed back the previous turn's point, discarding a turn nobody asked to undo.
    const thirdMessage = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'user_message',
      summary: 'One more thing'
    });
    await store.appendTaskEvent({
      taskId: task.id,
      kind: 'status',
      summary: 'Agent started work'
    });
    const third = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be3',
      workspaceId: workspace.id,
      taskId: task.id,
      turn: 2,
      mechanism: 'content',
      fileCount: 3,
      totalBytes: 64,
      storedBytes: 64,
      durationMs: 5
    });
    await expect(
      store.checkpointForTaskEvent(user.id, task.id, thirdMessage.id)
    ).resolves.toMatchObject({ id: third.id });

    // Another account's identifier answers nothing, and neither does an event of another task.
    const other = await store.createUser({ username: 'other', displayName: 'Other' });
    await expect(store.getWorkspaceCheckpoint(other.id, first.id)).resolves.toBeNull();
    await expect(store.checkpointForTaskEvent(other.id, task.id, last.id)).resolves.toBeNull();
    const otherTask = await store.createTask(taskInput(user.id, workspace.id));
    const strayEvent = await store.appendTaskEvent({
      taskId: otherTask.id,
      kind: 'user_message',
      summary: 'Elsewhere'
    });
    await expect(store.checkpointForTaskEvent(user.id, task.id, strayEvent.id)).resolves.toBeNull();

    await expect(
      store.deleteWorkspaceCheckpoints(workspace.id, [first.id, second.id, third.id])
    ).resolves.toBe(3);
    await expect(store.checkpointForTaskEvent(user.id, task.id, last.id)).resolves.toBeNull();
  });

  it('rewinds to the checkpoint in front of the work when two share a transcript position', async () => {
    const user = await store.createUser({ username: 'tied', displayName: 'Tied' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Tied'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Change it' });

    /**
     * A checkpoint's `event_sequence` is the transcript position at the moment it was taken, so a
     * turn that checkpoints twice before writing an event produces two rows carrying the same
     * number. Only the first of them is in front of all the work at that position; the second
     * already contains whatever happened in between - the very changes an undo is asking to drop.
     */
    const write = async (id: string) =>
      store.recordWorkspaceCheckpoint({
        id,
        workspaceId: workspace.id,
        taskId: task.id,
        turn: 0,
        mechanism: 'content',
        fileCount: 1,
        totalBytes: 10,
        storedBytes: 10,
        durationMs: 1
      });
    // Deliberately descending ids: the answer must come from when each was taken, not from which
    // identifier happens to sort first.
    const inFront = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ff9');
    const afterSomeWork = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ff1');
    expect([inFront.eventSequence, afterSomeWork.eventSequence]).toEqual([1, 1]);

    const target = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Changed it'
    });
    /**
     * Which of the two the undo lands on, and that the answer cannot depend on anything but when
     * each was taken. The ids above descend deliberately: the ordering used to fall through to
     * them whenever two rows shared a created_at, which is a wrong restore that only appears on a
     * machine that has been lived in. The order is now a sequence, which cannot tie.
     */
    await expect(store.checkpointForTaskEvent(user.id, task.id, target.id)).resolves.toMatchObject({
      id: inFront.id
    });
    // The same answer from a later point in the transcript: the tiebreaker is a property of the
    // two checkpoints, not of where the question was asked from.
    const later = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Later still'
    });
    await expect(store.checkpointForTaskEvent(user.id, task.id, later.id)).resolves.toMatchObject({
      id: inFront.id
    });
  });

  it('orders two checkpoints taken in the same instant by which was taken first', async () => {
    // The failure this removes is invisible: give two rows the same created_at and the old ordering
    // fell through to the identifier, so an undo restored the checkpoint that already contained the
    // work it was asked to drop. A sequence cannot tie, so the wrong answer is no longer reachable.
    const user = await store.createUser({ username: 'tied-clock', displayName: 'Tied clock' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Tied clock'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Change it' });
    const write = async (id: string) =>
      store.recordWorkspaceCheckpoint({
        id,
        workspaceId: workspace.id,
        taskId: task.id,
        turn: 0,
        mechanism: 'content',
        fileCount: 1,
        totalBytes: 10,
        storedBytes: 10,
        durationMs: 1
      });
    const inFront = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ffa');
    const afterSomeWork = await write('018f3dd3-8a2a-7d8b-8d3c-a2f4c8317ff2');
    // Force the collision the clock only produces occasionally, so this is a property of the
    // ordering rather than of how fast the machine happened to be.
    await database.query(
      'UPDATE workspace_checkpoints SET created_at = $1 WHERE id = ANY($2::uuid[])',
      [new Date('2026-01-01T00:00:00.000Z'), [inFront.id, afterSomeWork.id]]
    );
    const target = await store.appendTaskEvent({
      taskId: task.id,
      kind: 'assistant_message',
      summary: 'Changed it'
    });
    await expect(store.checkpointForTaskEvent(user.id, task.id, target.id)).resolves.toMatchObject({
      id: inFront.id
    });
  });

  it('records which of the two a fork rewound, and survives its checkpoint being pruned', async () => {
    const user = await store.createUser({ username: 'forked', displayName: 'Forked' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Forked'));
    const parent = await store.createTask(taskInput(user.id, workspace.id));
    const anchor = await store.appendTaskEvent({
      taskId: parent.id,
      kind: 'user_message',
      summary: 'Start'
    });
    const checkpoint = await store.recordWorkspaceCheckpoint({
      id: '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316bf1',
      workspaceId: workspace.id,
      taskId: parent.id,
      turn: 0,
      mechanism: 'content',
      fileCount: 10,
      totalBytes: 100,
      storedBytes: 100,
      durationMs: 5
    });

    // The default is what the product has always done: a new conversation path, machine untouched.
    const conversationOnly = await store.createTaskBranch({
      userId: user.id,
      workspaceId: workspace.id,
      parentTaskId: parent.id,
      branchedFromEventId: anchor.id,
      forkKind: 'branch',
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      agentStateCiphertext: null
    });
    expect(conversationOnly).toMatchObject({
      rewindScope: 'conversation',
      restoredCheckpointId: null
    });

    const both = await store.createTaskBranch({
      userId: user.id,
      workspaceId: workspace.id,
      parentTaskId: parent.id,
      branchedFromEventId: anchor.id,
      forkKind: 'edit',
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: UNINDEXED_NAME,
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      agentStateCiphertext: null,
      status: 'queued',
      rewindScope: 'both',
      restoredCheckpointId: checkpoint.id
    });
    expect(both).toMatchObject({ rewindScope: 'both', restoredCheckpointId: checkpoint.id });
    await expect(store.getTask(user.id, both.id)).resolves.toMatchObject({
      rewindScope: 'both',
      restoredCheckpointId: checkpoint.id
    });

    // Checkpoints are pruned on a retention policy; the fork that used one must outlive it.
    await store.deleteWorkspaceCheckpoints(workspace.id, [checkpoint.id]);
    await expect(store.getTask(user.id, both.id)).resolves.toMatchObject({
      rewindScope: 'both',
      restoredCheckpointId: null
    });
  });
});

/**
 * Media is the one thing the agent can start on its own that spends money outside a model call, so
 * the owner's list and the owner's stop are the whole of their control over it.
 */

/**
 * A query that orders by a column with repeats and then cuts the result off has two legal answers,
 * and PostgreSQL is free to give either. It normally gives the friendly one - rows come back in the
 * order they were written, so a fresh table looks deterministic and a test written against it
 * passes. The order only changes once the table has been lived in: a row updated in place moves to
 * the end of the heap, the planner switches from a sequential scan to an index scan as the table
 * grows, or a second worker reads a different snapshot. That is why this is checked by reading the
 * statements rather than by running them - the failure cannot be reproduced on a small table, which
 * is exactly what makes it expensive to find later.
 *
 * The rule is narrow on purpose: only orderings that feed a LIMIT, because those are the ones where
 * a tie changes which rows the caller is given rather than only what order they arrive in.
 */
describe('the statements themselves', () => {
  it('never cuts off an ordering that could resolve two ways', async () => {
    const source = await readFile(new URL('./store.ts', import.meta.url), 'utf8');
    /**
     * A term that can hold only one value per row. Reaching one breaks every remaining tie, so its
     * position in the clause does not matter - `1` is the ordinal a GROUP BY collapsed the rows to.
     */
    const decisive = /(^|[\s.(])(id|[a-z_]+_id|sequence|version|1)\b/i;
    /**
     * Orderings whose totality comes from a composite natural key instead of a surrogate id. Each
     * one is listed rather than pattern-matched, because whether a set of columns is a key is a
     * fact about the schema that no amount of reading the clause can establish.
     */
    const totalByNaturalKey = new Map([
      [
        'COALESCE(d.df, 1) ASC, t.lexeme ASC',
        'the rows are the query lexemes, so two that tie on df and lexeme are the same row twice'
      ],
      [
        'n_episodes DESC, last_seen DESC, subject_key, predicate, object_key',
        'mem.fact_candidate is keyed on (workspace_id, subject_key, predicate, object_key), and the workspace is fixed by the WHERE'
      ],
      [
        'created_at DESC, window_name, window_start DESC, level',
        'spend_alerts is keyed on (user_id, window_name, window_start, level), and the user is fixed by the WHERE'
      ],
      [
        'c.event_sequence DESC, c.taken_seq ASC',
        'workspace_checkpoints.taken_seq is NOT NULL and defaults from a sequence, so no two rows carry the same value'
      ]
    ]);
    const ambiguous: string[] = [];
    for (const match of source.matchAll(/ORDER BY\s+([^`]+?)(?:FOR UPDATE[^\n]*?)?\bLIMIT\b/gs)) {
      const clause = match[1]!.replace(/\s+/g, ' ').trim();
      // Anything this long has run past the end of its own statement into the next one.
      if (clause.length > 200) continue;
      if (totalByNaturalKey.has(clause)) continue;
      const terms = clause
        .split(',')
        .map((term) => term.replace(/\b(ASC|DESC|NULLS (FIRST|LAST))\b/gi, '').trim());
      if (!terms.some((term) => decisive.test(term)))
        ambiguous.push(
          `line ${source.slice(0, match.index).split('\n').length}: ORDER BY ${clause}`
        );
    }
    expect(ambiguous).toEqual([]);
  });
});

/**
 * The wake-up path between processes.
 *
 * On a real box the API, the worker and the notifier are separate units, and "a reply just arrived"
 * reaches all three over LISTEN/NOTIFY. None of that is exercised by the suites above: they run on
 * PGlite, which is a single backend in a single process, so its `listen` and `notify` are no-ops
 * and every signal is delivered locally. What can be tested without a server is the store's own
 * half - which channels it subscribes to, and what it does when subscribing fails partway.
 */
describe('the cross-process signal bridge', () => {
  const stubDatabase = (listen: (channel: string) => Promise<() => Promise<void>>): Database => {
    const database: Database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      exec: async () => undefined,
      transaction: async (callback) => callback(database),
      withAdvisoryLock: async (_key, callback) => callback(),
      notify: async () => undefined,
      listen,
      close: async () => undefined
    };
    return database;
  };

  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  it('retries only the channels a failed subscription never reached', async () => {
    const subscribed: string[] = [];
    let allowed = 2;
    const store = new DataStore(
      stubDatabase(async (channel) => {
        if (subscribed.length >= allowed) throw new Error('listener connection dropped');
        subscribed.push(channel);
        return async () => undefined;
      })
    );

    // The first subscriber starts the bridge; the third channel fails, which clears the retry flag.
    store.onTaskEvent('a-task', () => undefined);
    await settle();
    expect(subscribed).toHaveLength(2);

    // The next subscriber retries. It must pick up where the first left off: subscribing to the
    // first two channels again would deliver every task event twice, then three times, and so on
    // for as long as the connection kept flapping.
    allowed = 99;
    store.onTaskEvent('another-task', () => undefined);
    await settle();
    expect(subscribed).toHaveLength(3);
    expect(new Set(subscribed).size).toBe(3);
  });
});

/*
 * The read behind the open-rate instrument.
 *
 * `docs/design/organs/PREAMBLE.md` §10.4 gates the tool catalogue's deferral tier on one production
 * measurement: the share of TURNS that reach each tool at least once. Everything the decision needs
 * that a database can answer without a key is answered here - which turn a call happened in, and
 * how many turns there were to divide by. The names themselves are ciphertext and are opened by the
 * route that already holds the workspace key.
 *
 * Its own describe with its own database, so it can be run alone: this file is nine thousand lines
 * and the suite around it is not what these four assertions are about.
 */
describe('the turns a tool was reached in', () => {
  let database: Database;
  let tasks: TaskStore;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    tasks = new TaskStore(database, new TaskSignals(database));
  });

  afterEach(async () => database.close());

  /** A conversation whose events are written in the order a real turn writes them. */
  const conversation = async (): Promise<string> => {
    const user = await store.createUser({ username: 'opens', displayName: 'Opens' });
    const workspace = await store.createWorkspace(workspaceInput(user.id, 'Opens'));
    const task = await store.createTask(taskInput(user.id, workspace.id));
    return task.id;
  };

  const append = async (
    taskId: string,
    kind: 'user_message' | 'tool_started' | 'assistant_delta' | 'assistant_message',
    summary: string
  ): Promise<void> => {
    await store.appendTaskEvent({
      taskId,
      kind,
      summary,
      payloadCiphertext: { v: 1, iv: 'iv', tag: 'tag', ciphertext: `${kind}:${summary}` }
    });
  };

  it('numbers the opening request as turn one and every follow-up after it', async () => {
    const taskId = await conversation();
    // `createTask` writes no `user_message` for the opening request - the text is the task's own
    // prompt - so a conversation nobody followed up has to read as one turn and not as zero.
    await append(taskId, 'tool_started', 'a');
    await append(taskId, 'tool_started', 'b');
    await append(taskId, 'user_message', 'and now this');
    await append(taskId, 'tool_started', 'c');
    await append(taskId, 'user_message', 'and this');
    await append(taskId, 'user_message', 'and this too');
    await append(taskId, 'tool_started', 'd');

    const page = await tasks.listTurnToolStarts(taskId);
    expect(page.rows.map((row) => [row.kind, row.turn])).toEqual([
      ['tool_started', 1],
      ['tool_started', 1],
      ['user_message', 2],
      ['tool_started', 2],
      ['user_message', 3],
      ['user_message', 4],
      ['tool_started', 4]
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('reports a turn that called nothing, because it is in the denominator', async () => {
    const taskId = await conversation();
    await append(taskId, 'tool_started', 'a');
    await append(taskId, 'user_message', 'a question with an answer and no work in it');
    await append(taskId, 'assistant_message', 'here you go');

    // The rate this instrument exists to produce is per turn, so a turn in which the model answered
    // without reaching for anything still divides. Returning only `tool_started` rows would drop
    // this turn from the count entirely and make every share too large - which is the one error in
    // this arithmetic that biases the deferral decision toward shipping.
    const page = await tasks.listTurnToolStarts(taskId);
    expect(page.rows.map((row) => [row.kind, row.turn])).toEqual([
      ['tool_started', 1],
      ['user_message', 2]
    ]);
  });

  it('gives a paged read the same turn numbers as an unpaged one', async () => {
    const taskId = await conversation();
    await append(taskId, 'tool_started', 'a');
    await append(taskId, 'user_message', 'second');
    await append(taskId, 'tool_started', 'b');
    await append(taskId, 'user_message', 'third');
    await append(taskId, 'tool_started', 'c');

    const whole = await tasks.listTurnToolStarts(taskId);
    const paged: Array<[string, number]> = [];
    let cursor = 0;
    for (;;) {
      const page = await tasks.listTurnToolStarts(taskId, { after: cursor, limit: 2 });
      for (const row of page.rows) paged.push([row.kind, row.turn]);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    // The window function is numbered inside a subquery for exactly this. Postgres applies a
    // query level's WHERE before its window functions, so a cursor predicate written beside the
    // running SUM restarts the count at the top of each page: the second page of this conversation
    // would call its own rows turn 1, and a week of long conversations would report far more turns
    // than happened and far lower rates than are real.
    expect(paged).toEqual(whole.rows.map((row) => [row.kind, row.turn]));
    expect(paged).toEqual([
      ['tool_started', 1],
      ['user_message', 2],
      ['tool_started', 2],
      ['user_message', 3],
      ['tool_started', 3]
    ]);
  });

  it('carries no ciphertext this reader has no business opening', async () => {
    const taskId = await conversation();
    await append(taskId, 'tool_started', 'a');
    await append(taskId, 'user_message', 'what the owner typed');
    await append(taskId, 'assistant_delta', 'one frame of the answer');
    await append(taskId, 'assistant_message', 'the answer');

    const page = await tasks.listTurnToolStarts(taskId);
    // Two things at once. The message the owner typed comes back as a boundary with its payload
    // dropped - a reader holding the workspace key cannot open by accident what it was never sent.
    // And the delta frames, which are most of a trajectory's rows and nearly all of its bytes, are
    // not carried out of the database at all; that narrowing is the whole reason this statement
    // exists rather than a filter over `listTaskEventPage`.
    expect(page.rows.map((row) => row.kind)).toEqual(['tool_started', 'user_message']);
    expect(page.rows[0]?.payloadCiphertext).toMatchObject({ ciphertext: 'tool_started:a' });
    expect(page.rows[1]?.payloadCiphertext).toBeNull();
  });

  it('selects one owner conversations, and only where a turn opened inside the window', async () => {
    /*
     * The selection half of the read, which had no assertion of its own until this was written.
     *
     * Added by the verifying pass rather than by the lane: with `w.user_id = $1` replaced by a
     * tautology, every route test over this query still passed, because the route harness has one
     * owner and one workspace. A second owner's turns would then land in this owner's DENOMINATOR
     * while their tool names stayed unreadable - the key map holds only the asking owner's - so the
     * failure is not a leak, it is every share on the report silently too small, which is the one
     * direction that argues for deferring a tool that is actually hot.
     *
     * The three window cases are here for the same reason and are the three the SQL's two arms are
     * made of: a conversation created in the window that wrote NO event at all is a turn (the model
     * answered without reaching for anything, and `createTask` writes no `user_message` for the
     * opening request); a conversation older than the window with a follow-up inside it is read, so
     * that follow-up can be counted; and one whose every row is older is not read at all.
     */
    const owner = await store.createUser({ username: 'owner', displayName: 'Owner' });
    const other = await store.createUser({ username: 'other', displayName: 'Other' });
    const ownerSpace = await store.createWorkspace(workspaceInput(owner.id, 'Owner'));
    const otherSpace = await store.createWorkspace(workspaceInput(other.id, 'Other'));

    const quiet = await store.createTask(taskInput(owner.id, ownerSpace.id));
    const straddler = await store.createTask(taskInput(owner.id, ownerSpace.id));
    const stale = await store.createTask(taskInput(owner.id, ownerSpace.id));
    const theirs = await store.createTask(taskInput(other.id, otherSpace.id));
    await append(straddler.id, 'user_message', 'a follow-up today');
    await append(stale.id, 'tool_started', 'a');
    await append(theirs.id, 'tool_started', 'a');

    const ageTask = async (id: string): Promise<void> => {
      await database.query(`UPDATE tasks SET created_at = NOW() - INTERVAL '40 days' WHERE id=$1`, [
        id
      ]);
    };
    await ageTask(straddler.id);
    await ageTask(stale.id);
    await database.query(
      `UPDATE task_events SET created_at = NOW() - INTERVAL '40 days' WHERE task_id=$1`,
      [stale.id]
    );

    const until = new Date();
    const week = new Date(until.getTime() - 7 * 86_400_000);
    const found = await tasks.listTasksWithTurnsInWindow(owner.id, week, until);
    // Newest first, so a truncated answer loses the oldest end of the window rather than an
    // arbitrary end of it.
    expect(found.tasks.map((task) => task.id)).toEqual([quiet.id, straddler.id]);
    expect(found.hasMore).toBe(false);

    // And a window that reaches all of it finds the stale conversation too, which is what proves
    // the week's answer dropped a conversation that exists rather than one this test failed to
    // write. The other owner's is absent from both.
    const quarter = await tasks.listTasksWithTurnsInWindow(
      owner.id,
      new Date(until.getTime() - 90 * 86_400_000),
      until
    );
    expect(quarter.tasks.map((task) => task.id).sort()).toEqual(
      [quiet.id, straddler.id, stale.id].sort()
    );
    expect(quarter.tasks.map((task) => task.id)).not.toContain(theirs.id);
  });
});

/**
 * A column nothing writes is a column nothing can rely on.
 *
 * Migration 98 backfilled `connection_id`, and the very next catalogue refresh wrote rows with a
 * null in it, because no writer had been taught to fill it. The default belongs in the statement
 * rather than in every caller: the namespace and the connection are the same string for every
 * provider that exists today, and the column is what lets them stop being.
 */
describe('the connection a catalogue row belongs to', () => {
  it('is filled on every write, whether or not the caller named one', async () => {
    const own = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(own);
    const store = new DataStore(own);
    const row = (id: string, provider: string, extra: Record<string, unknown> = {}) => ({
      id,
      providerModelId: id,
      displayName: id,
      provider,
      revision: 'r1',
      availability: 'available',
      openness: 'permissive_open_weight',
      license: 'apache-2.0',
      commercialUse: true,
      privacyRoute: 'provider_zdr',
      contextTokens: 128_000,
      modalities: ['text'],
      capabilities: ['chat'],
      usageClass: 'light',
      recommendationTags: [],
      measuredQuality: null,
      measuredLatencyMs: null,
      metadata: {},
      ...extra
    });
    await store.upsertModels([
      row('custom/unnamed', 'custom'),
      row('custom/named', 'custom', { connectionId: 'ollama-cloud' })
    ]);
    const written = await own.query(
      `SELECT id,connection_id FROM model_releases WHERE id LIKE 'custom/%named' ORDER BY id`
    );
    expect(
      Object.fromEntries(
        written.rows.map((entry) => [String(entry.id), String(entry.connection_id)])
      )
    ).toEqual({ 'custom/named': 'ollama-cloud', 'custom/unnamed': 'custom' });
    await own.close();
  });
});

/**
 * How long a published page stays up, which depends on what the run was for.
 *
 * Every publication got the same month of idle life whatever it was for, so a ten-minute mock-up
 * left a website serving until somebody remembered to remove it — which is how a box ends up
 * hosting a list of pages nobody asked for. A run that declared itself brief says so at the moment
 * it publishes, rather than leaving something later to guess.
 */
describe('how long a published preview lives', () => {
  const seed = async (own: Database) => {
    const store = new DataStore(own);
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Computer',
      storageLimitBytes: 1024 ** 3,
      imageRevision: 'fixture',
      region: 'auto',
      wrappedKey: 'fixture'
    });
    return { store, user, workspace };
  };

  it('gives a brief run a day and everything else the ordinary window', async () => {
    const own = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(own);
    const { store, user, workspace } = await seed(own);
    const make = (slug: string, idleInterval?: string) =>
      store.createWorkspacePreview({
        userId: user.id,
        workspaceId: workspace.id,
        label: slug,
        port: 8080,
        slug,
        accessTokenHash: slug,
        ...(idleInterval ? { idleInterval } : {})
      });
    const ordinary = await make('ordinary');
    const brief = await make('brief', '24 hours');
    const hours = (value: string | null) =>
      value === null ? null : Math.round((Date.parse(value) - Date.now()) / 3_600_000);
    expect(hours(ordinary.expiresAt)).toBeGreaterThan(24 * 25);
    expect(hours(brief.expiresAt)).toBeGreaterThan(20);
    expect(hours(brief.expiresAt)).toBeLessThanOrEqual(24);
    await own.close();
  });
});
