import { randomUUID } from 'node:crypto';
import { encryptJson, sha256 } from '@garden/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { DataStore } from '../store.js';
import { notificationDestinationAad } from './notifications.js';

/**
 * The candidate set, asked the one question its four original branches could not answer: what
 * happens to a conversation whose approval nobody answered.
 *
 * The whole path is exercised rather than the branch alone. `cleanupExpired` is what marks a lapsed
 * approval 'expired'; the API's approval sweep is what then moves the task to 'paused'. Standing
 * that pair up in order is the check that the new branch lands on the path that already runs, and
 * not one step early - a task whose approval has expired but which the sweep has not reached yet is
 * still `awaiting_user`, and telling the owner it gave up before the credits are back would be a
 * notice about a state the box has not finished leaving.
 */
describe('a candidate for an approval that expired unanswered', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  /** User, workspace, a device registered two days ago, a conversation, and one approval. */
  const stranded = async () => {
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
    // The device was here before the approval ran out, which is what makes this its news. Every
    // branch of the candidate set is bounded by the subscription's own age so that registering a
    // phone today does not deliver a fortnight of history to it, and this one is bounded by the
    // expiry rather than by the approval's creation: the expiry is when the thing happened.
    await database.query(
      "UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '2 days'",
      []
    );
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'private-title', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'shell',
      sideEffect: 'external_consequential',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      // Written 24 hours before it lapsed, in the past, which is the state the sweep finds.
      expiresAt: new Date(Date.now() - 60 * 60 * 1000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'awaiting_user');
    return { user, task, approvalId, subscription };
  };

  it('says nothing until the sweep has actually paused the conversation', async () => {
    const { user, task } = await stranded();
    // Past its deadline and still `pending`: the approval branch requires `expires_at > NOW()`, so
    // there is nothing to send even though the card on screen has stopped working.
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await store.cleanupExpired();
    // Marked expired, and the task is still `awaiting_user` because the API sweep has not run. The
    // credits are still reserved; this is not yet a conversation the owner can restart.
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind))
    ).resolves.toEqual(['takeover_needed']);
  });

  it('names the approval, the conversation and the hour it lapsed', async () => {
    const { user, task, approvalId } = await stranded();
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    const pending = await store.listPendingNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'takeover_needed',
      resourceId: approvalId,
      taskId: task.id,
      taskStatus: 'paused'
    });
    // The expiry, not the task's last write. The staleness horizon in the notifier is measured
    // against exactly this, and the task row was touched again when the sweep paused it.
    expect(Date.parse(pending[0]!.eventAt)).toBeLessThan(Date.now() - 59 * 60 * 1000);
    // No key was handed in, so nothing encrypted may be readable on the row.
    expect(JSON.stringify(pending)).not.toContain('private-title');
  });

  it('is not settled by the ledger row the original approval push wrote', async () => {
    const { user, task, approvalId, subscription } = await stranded();
    // What the owner was told when the agent first asked. Same approval id, different news.
    await store.recordNotificationDelivery(subscription.id, 'approval_required', approvalId);
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'takeover_needed', resourceId: approvalId }
    ]);
    await store.recordNotificationDelivery(subscription.id, 'takeover_needed', approvalId);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('stops offering it once the owner restarts the conversation', async () => {
    const { user, task } = await stranded();
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await expect(store.listPendingNotifications()).resolves.toHaveLength(1);
    // Resumed. The news was "it gave up and is waiting for you", and it is not waiting any more.
    await store.setTaskStatusForUser(user.id, task.id, 'queued');
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('does not hand a device a stranding that happened before it was registered', async () => {
    const { user, task } = await stranded();
    await store.cleanupExpired();
    await store.setTaskStatusForUser(user.id, task.id, 'paused');
    await database.query('UPDATE push_subscriptions SET created_at = NOW()', []);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('lets durable media report delivery without a premature or duplicate task completion notice', async () => {
    const { user, task } = await stranded();
    await store.setTaskStatusForUser(user.id, task.id, 'completed');
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'task_finished' }
    ]);
    const jobId = randomUUID();
    await database.query(
      `INSERT INTO provider_media_jobs(id,user_id,workspace_id,task_id,request_key,request_hash,request_ciphertext,model_id,status,reservation_usd,retention_approved_at)
      VALUES($1,$2,$3,$4,$5,'sealed-hash','{}','video-model','pending',1,NOW())`,
      [jobId, user.id, task.workspaceId, task.id, jobId]
    );
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await database.query("UPDATE provider_media_jobs SET status='completed' WHERE id=$1", [jobId]);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await store.appendTaskEvent({ taskId: task.id, kind: 'user_message', summary: 'Next request' });
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'task_finished', taskStatus: 'completed' }
    ]);
    await store.setTaskStatusForUser(user.id, task.id, 'failed');
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'task_finished', taskStatus: 'failed' }
    ]);
    await store.setTaskStatusForUser(user.id, task.id, 'cancelled');
    await expect(store.listPendingNotifications()).resolves.toMatchObject([
      { kind: 'task_finished', taskStatus: 'cancelled' }
    ]);
  });
});

/**
 * What this box can tell an owner who has registered nothing: no device, no paired destination.
 *
 * The candidate set selects on the owner's events and joins them to the owner's targets, and an
 * owner with no target of either kind is offered nothing, for every kind. That is the shape of the
 * product rather than a defect in the query, and it is worth an executable statement of it because
 * the owners it silences are the ones the feature exists for: an iPhone in a Safari tab has no
 * `PushManager` and so has no subscription to register, a browser that refused a self-signed
 * certificate runs no service worker, and a retired endpoint is deleted outright by the notifier
 * after a day of refusals. The describe after this one is the other half: a paired destination is
 * a target in its own right, and the same events reach it with no device registered at all.
 */
describe('an owner with no subscribed device', () => {
  let database: Database;
  let store: DataStore;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  /** Two live things the owner would want: an approval it is stopped on, and a notice it raised. */
  const waiting = async () => {
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Cloud',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'shell',
      sideEffect: 'external_consequential',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'awaiting_user');
    await store.createAgentNotification({
      userId: user.id,
      taskId: task.id,
      kind: 'agent_message',
      messageCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    return { user, task, approvalId };
  };

  it('is offered nothing at all, however much is waiting for them', async () => {
    await waiting();
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  /*
   * The other direction, so the case above is evidence about subscriptions rather than about a
   * fixture that never had anything to report. Same rows, one device, two notifications.
   */
  it('is offered all of it the moment one device is registered', async () => {
    const { user } = await waiting();
    await store.upsertPushSubscription({
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
    // Registered before the events it is being offered, which every branch requires.
    await database.query("UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '1 day'", []);
    await expect(
      store.listPendingNotifications().then((rows) => rows.map((row) => row.kind).sort())
    ).resolves.toEqual(['agent_message', 'approval_required']);
  });

  /*
   * The path that takes the channel away from an owner who did everything right. The notifier
   * deletes an endpoint that has refused every notification for a day (`sweep.ts`, the `exhausted`
   * arm), and deleting the row cascades the ledger with it - so the queue does not merely stop
   * draining, it stops existing, and the approval below is waiting for a person who will not be
   * told. Nothing here is wrong; there is simply no second place for it to go.
   */
  it('is offered nothing again once its last endpoint is retired', async () => {
    const { user } = await waiting();
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
    await database.query("UPDATE push_subscriptions SET created_at = NOW() - INTERVAL '1 day'", []);
    await expect(store.listPendingNotifications()).resolves.toHaveLength(2);
    await expect(store.deletePushSubscriptionById(subscription.id)).resolves.toBe(true);
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });
});

/**
 * The second transport's half of the candidate set: a paired destination is a target with no
 * device behind it, its ledger is its own, and the pairing link that binds it can be used once.
 */
describe('an owner with a paired destination and no device', () => {
  let database: Database;
  let store: DataStore;
  const masterKey = new Uint8Array(32).fill(3);

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
  });

  afterEach(async () => database.close());

  const sealed = (userId: string, id: string, key: Uint8Array = masterKey) =>
    encryptJson(
      { botToken: '123456:token-of-the-bot', botUsername: 'garden_test_bot' },
      key,
      notificationDestinationAad(userId, id)
    );

  /** An owner, a conversation stopped on an approval, and one destination in the given state. */
  const seeded = async (
    state: 'verified' | 'unverified' | 'disabled',
    key: Uint8Array = masterKey
  ) => {
    const user = await store.createUser({ username: 'ada', displayName: 'Ada' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'Cloud',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    const id = randomUUID();
    const destination = await store.upsertNotificationDestination({
      id,
      userId: user.id,
      kind: 'telegram',
      configCiphertext: sealed(user.id, id, key)
    });
    if (state !== 'unverified') {
      const hash = sha256('one-time-secret');
      await store.startDestinationPairing(destination.id, hash, new Date(Date.now() + 600_000));
      expect(await store.completeDestinationPairing(destination.id, hash, '4242', key)).toBe(1);
      // Paired before the approval was raised, which is what makes the approval its news.
      await database.query(
        "UPDATE notification_destinations SET verified_at = NOW() - INTERVAL '1 day'",
        []
      );
    }
    if (state === 'disabled') await store.setDestinationDisabled(user.id, 'telegram', true);
    const task = await store.createTask({
      userId: user.id,
      workspaceId: workspace.id,
      titleCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      nameIndex: { nameTokens: '', openingTokens: '' },
      modelId: 'qwen',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      promptCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' }
    });
    const approvalId = await store.createApproval({
      userId: user.id,
      taskId: task.id,
      action: 'shell',
      sideEffect: 'external_consequential',
      previewCiphertext: { v: 1, iv: 'a', tag: 'b', ciphertext: 'c' },
      previewHash: 'hash',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    await store.setTaskStatusForUser(user.id, task.id, 'awaiting_user');
    return { user, task, approvalId, destination };
  };

  it('is offered the approval with no push subscription at all', async () => {
    // The whole point of the second transport, as one row: nothing in push_subscriptions, and the
    // approval is still a candidate because the destination is a target in its own right.
    const { approvalId, destination, user } = await seeded('verified');
    const pending = await store.listPendingNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      transport: 'telegram',
      id: destination.id,
      userId: user.id,
      kind: 'approval_required',
      resourceId: approvalId,
      // No key was handed in, so the token and the sender stay sealed and the row says so.
      senderId: null,
      redact: true,
      config: null
    });
    expect(JSON.stringify(pending)).not.toContain('token-of-the-bot');
    expect(JSON.stringify(pending)).not.toContain('4242');
  });

  it('keeps the paired sender sealed at rest and opens it only for the caller holding the key', async () => {
    const { user, destination } = await seeded('verified');
    // Nothing in the table names the sender in the clear: the column that would have is gone and
    // the envelope that replaces it does not contain the digits.
    const columns = await database.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='notification_destinations' ORDER BY column_name`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('sender_id');
    const rows = await database.query(
      'SELECT sender_ciphertext::text AS sealed FROM notification_destinations'
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0]!.sealed)).not.toContain('4242');
    // Every read that hands the sender out takes the key and opens it; without the key, or with
    // the wrong one, each says null rather than guessing.
    const [row] = await store.listPendingNotifications(100, masterKey);
    expect(row?.transport === 'telegram' ? row.senderId : 'not-telegram').toBe('4242');
    expect((await store.getNotificationDestination(user.id, 'telegram', masterKey))?.senderId).toBe(
      '4242'
    );
    expect((await store.getNotificationDestination(user.id, 'telegram'))?.senderId).toBeNull();
    const wrongKey = new Uint8Array(32).fill(9);
    expect(
      (await store.getNotificationDestination(user.id, 'telegram', wrongKey))?.senderId
    ).toBeNull();
    const [active] = await store.listActiveNotificationDestinations(masterKey);
    expect(active?.senderId).toBe('4242');
    await store.recordDestinationDelivery(
      destination.id,
      'approval_required',
      randomUUID(),
      '5',
      'n'
    );
    const ledger = await store.findDestinationDeliveryByExternalRef(destination.id, '5', masterKey);
    expect(ledger?.senderId).toBe('4242');
    expect(
      (await store.findDestinationDeliveryByExternalRef(destination.id, '5'))?.senderId
    ).toBeNull();
    // And the envelope is bound to the row: moved onto another id it does not open. The ledger
    // row goes first, because the id is what it is keyed to.
    await database.query('DELETE FROM notification_destination_deliveries');
    await database.query('UPDATE notification_destinations SET id=$1', [randomUUID()]);
    const [moved] = await store.listActiveNotificationDestinations(masterKey);
    expect(moved?.senderId).toBeNull();
  });

  it('unseals the bot token only for the caller holding the master key, and only under its own context', async () => {
    const { destination } = await seeded('verified');
    const [row] = await store.listPendingNotifications(100, masterKey);
    expect(row?.transport === 'telegram' && row.config?.botToken).toBe('123456:token-of-the-bot');
    expect(row?.transport === 'telegram' && row.config?.botUsername).toBe('garden_test_bot');
    // The wrong key opens nothing and sends nothing: config is null rather than an exception, so
    // the rest of the batch is unaffected.
    const [other] = await store.listPendingNotifications(100, new Uint8Array(32).fill(9));
    expect(other?.transport === 'telegram' ? other.config : 'not-telegram').toBeNull();
    // And the sealed configuration is bound to the row: moved onto another id it does not open.
    const moved = await store.getNotificationDestinationById(destination.id, masterKey);
    expect(moved?.config?.botToken).toBe('123456:token-of-the-bot');
    await database.query('UPDATE notification_destinations SET id=$1', [randomUUID()]);
    const [after] = await store.listActiveNotificationDestinations(masterKey);
    expect(after?.config).toBeNull();
  });

  it('offers nothing to a destination that is not yet paired', async () => {
    await seeded('unverified');
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
  });

  it('offers nothing to a destination the owner switched off, and everything again when it is on', async () => {
    const { user } = await seeded('disabled');
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    await store.setDestinationDisabled(user.id, 'telegram', false);
    await expect(store.listPendingNotifications()).resolves.toHaveLength(1);
  });

  it('is told each thing once: the ledger row stops a second candidate and a second row', async () => {
    const { approvalId, destination } = await seeded('verified');
    await store.recordDestinationDelivery(
      destination.id,
      'approval_required',
      approvalId,
      '77',
      'nonce-one'
    );
    await store.recordDestinationDelivery(
      destination.id,
      'approval_required',
      approvalId,
      '78',
      'nonce-two'
    );
    await expect(store.listPendingNotifications()).resolves.toEqual([]);
    const rows = await database.query(
      'SELECT external_ref, nonce FROM notification_destination_deliveries',
      []
    );
    // The first write wins and the second changes nothing, so a card is never sent twice and the
    // nonce the phone holds is the one the ledger holds.
    expect(rows.rows).toEqual([{ external_ref: '77', nonce: 'nonce-one' }]);
    const ledger = await store.getDestinationDelivery(
      destination.id,
      'approval_required',
      approvalId
    );
    expect(ledger).toMatchObject({ nonce: 'nonce-one', externalRef: '77', outcomeAt: null });
  });

  it('refuses a pairing link that is wrong, that lapsed, or that was already used', async () => {
    const { user, destination } = await seeded('unverified');
    const hash = sha256('the-real-secret');
    await store.startDestinationPairing(destination.id, hash, new Date(Date.now() + 600_000));
    expect(
      await store.completeDestinationPairing(destination.id, sha256('a-guess'), '1', masterKey)
    ).toBe(0);
    expect(await store.completeDestinationPairing(destination.id, hash, '4242', masterKey)).toBe(1);
    // Replay: the same link tapped again, by anyone, binds nobody and changes nothing.
    expect(await store.completeDestinationPairing(destination.id, hash, '9999', masterKey)).toBe(0);
    expect((await store.getNotificationDestination(user.id, 'telegram', masterKey))?.senderId).toBe(
      '4242'
    );
    // Lapsed: a fresh secret whose window has already closed.
    const lapsed = sha256('too-late');
    await store.startDestinationPairing(destination.id, lapsed, new Date(Date.now() - 1_000));
    expect(await store.completeDestinationPairing(destination.id, lapsed, '5', masterKey)).toBe(0);
    const state = await store.getNotificationDestination(user.id, 'telegram', masterKey);
    expect(state).toMatchObject({ senderId: null, verifiedAt: null, pairingPending: false });
  });

  it('lists a sent card whose approval was decided elsewhere until its outcome is written back', async () => {
    const { user, approvalId, destination } = await seeded('verified');
    await store.recordDestinationDelivery(
      destination.id,
      'approval_required',
      approvalId,
      '5',
      'n'
    );
    // Still pending: nothing to write back.
    await expect(store.listDestinationDeliveriesAwaitingOutcome()).resolves.toEqual([]);
    expect(await store.resolveApproval(user.id, approvalId, 'approved')).toBe(true);
    const awaiting = await store.listDestinationDeliveriesAwaitingOutcome(100, masterKey);
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({
      destinationId: destination.id,
      resourceId: approvalId,
      externalRef: '5',
      approvalStatus: 'approved',
      senderId: '4242',
      userId: user.id
    });
    await store.markDestinationDeliveryOutcome(destination.id, 'approval_required', approvalId);
    await expect(store.listDestinationDeliveriesAwaitingOutcome()).resolves.toEqual([]);
  });

  it('opens no outcome for a row settled without a message, so the sweep never edits a card that was not sent', async () => {
    const { user, approvalId, destination } = await seeded('verified');
    await store.recordDestinationDelivery(
      destination.id,
      'approval_required',
      approvalId,
      null,
      null
    );
    expect(await store.resolveApproval(user.id, approvalId, 'denied')).toBe(true);
    await expect(store.listDestinationDeliveriesAwaitingOutcome()).resolves.toEqual([]);
  });

  /*
   * What the health port tells `doctor` exists. The service already reported how many endpoints
   * were refusing, and zero refusing is trivially true of a box nobody has ever subscribed a
   * device to - so `doctor` said push delivery was fine on a box where nothing could be delivered
   * to. The count is of targets that could actually be sent to: a switched-off destination and one
   * still waiting for its pairing link to be tapped are neither.
   */
  it('counts the devices and paired phones a notification could reach, and nothing that it cannot', async () => {
    await expect(store.notificationTargetCounts()).resolves.toEqual({
      pushSubscriptions: 0,
      pairedDestinations: 0
    });
    const { user } = await seeded('disabled');
    await expect(store.notificationTargetCounts()).resolves.toMatchObject({
      pairedDestinations: 0
    });
    expect(await store.setDestinationDisabled(user.id, 'telegram', false)).toBe(true);
    await expect(store.notificationTargetCounts()).resolves.toMatchObject({
      pairedDestinations: 1
    });
    const subscription = await store.upsertPushSubscription({
      userId: user.id,
      sessionPublicId: await store.createSession(user.id, 'hash', new Date(Date.now() + 60_000)),
      endpoint: 'https://push.example/opaque',
      p256dh: 'public-key',
      auth: 'auth-secret'
    });
    await expect(store.notificationTargetCounts()).resolves.toEqual({
      pushSubscriptions: 1,
      pairedDestinations: 1
    });
    expect(await store.deletePushSubscriptionById(subscription.id)).toBe(true);
    await expect(store.notificationTargetCounts()).resolves.toMatchObject({
      pushSubscriptions: 0
    });
  });

  it('takes the ledger with the destination when the owner unpairs', async () => {
    const { user, approvalId, destination } = await seeded('verified');
    await store.recordDestinationDelivery(
      destination.id,
      'approval_required',
      approvalId,
      '5',
      'n'
    );
    expect(await store.deleteNotificationDestination(user.id, 'telegram')).toBe(true);
    const rows = await database.query('SELECT 1 FROM notification_destination_deliveries', []);
    expect(rows.rows).toEqual([]);
    await expect(store.getNotificationDestination(user.id, 'telegram')).resolves.toBeNull();
  });
});
