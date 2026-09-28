import { randomUUID } from 'node:crypto';
import { GardenError, decryptJson, encryptJson, unwrapDataKey } from '@garden/core';
import type { EncryptedEnvelope } from '@garden/core';
import { MAX_AGENT_NOTIFICATIONS_PER_TASK } from '@garden/contracts';
import type { NotificationKind } from '@garden/contracts';
import type { Database } from '../database.js';
import type {
  AgentNotificationRecord,
  DestinationDeliveryRecord,
  NotificationDestinationConfig,
  NotificationDestinationRecord,
  PendingNotificationRecord,
  PushSubscriptionRecord
} from '../types.js';
import { iso, json, numericOrNull, optionalText } from './rows.js';

/**
 * How far back the notifier still looks for something to say, and how long the ledger row that
 * stops it saying it twice is kept. The second is comfortably longer than the first, so a delivery
 * record is only ever dropped once the thing it settled has fallen out of consideration entirely.
 *
 * The ledger window is exported because the sweep that applies it, `DataStore.cleanupExpired`, is
 * maintenance rather than notification and did not move here in Wave 6.3. Exporting it keeps the
 * pair under one comment, which is the whole point of the sentence above: separate them and the
 * relation between the two numbers stops being written down anywhere.
 */
const NOTIFICATION_CANDIDATE_INTERVAL = '14 days';
export const NOTIFICATION_LEDGER_INTERVAL = '30 days';

/**
 * How stopped the work is, as an ordering key. Written once and aliased, because the notifier states
 * this order twice - once to decide which rows are the page and once to hand the page back in that
 * order after the conversation names are joined on - and two copies of it would be two orders the
 * day somebody edited one.
 */
const notificationUrgency = (alias: string): string => `
         CASE ${alias}.kind
           WHEN 'approval_required' THEN 0
           WHEN 'takeover_needed' THEN 1
           WHEN 'spend_paused' THEN 2
           WHEN 'agent_message' THEN 3
           ELSE 4
         END`;

/**
 * The owner's notification preferences as they are stored: kinds by their wire names, and quiet
 * hours as minutes past local midnight. The zone those minutes are read in is the one on
 * `spend_limits` - there is one answer on this box to when the owner's day rolls over.
 */
export interface StoredNotificationSettings {
  kinds: Record<NotificationKind, boolean>;
  quietHours: { startMinute: number; endMinute: number } | null;
  quietHoursAllowApprovals: boolean;
}

/**
 * A conversation's own name, for a notification that would otherwise have to say "a task".
 *
 * Failure is expected rather than exceptional here: a workspace whose key is held elsewhere, an
 * older row, a title written under a different context. All of those mean "no title", never a
 * notification that does not get sent.
 */
const decryptTaskTitle = (row: Record<string, unknown>, masterKey: Uint8Array): string | null => {
  const workspaceId = optionalText(row.workspace_id);
  const wrappedKey = optionalText(row.wrapped_key);
  if (!row.title_ciphertext || !wrappedKey || !workspaceId) return null;
  try {
    const key = unwrapDataKey(wrappedKey, masterKey, workspaceId);
    const envelope = json<EncryptedEnvelope>(row.title_ciphertext);
    return decryptJson<{ title: string }>(envelope, key, `task-title:${workspaceId}`).title;
  } catch {
    return null;
  }
};

/**
 * The context a destination's sealed configuration is bound to. The API seals with this and the
 * store opens with it, so the two cannot drift apart: a row lifted onto another account's id, or
 * onto another row's id, does not open.
 */
export const notificationDestinationAad = (userId: string, id: string): string =>
  `notification-destination:${userId}:${id}`;

/**
 * The bot token and its companions, unsealed here for the same reason the title is: this is the
 * only layer holding both the envelope and the master key. A row that will not open comes back
 * null, and the sender skips it and counts it - a destination whose token cannot be read is never
 * sent to and never deleted, because the failure is the key's and not the owner's.
 */
const decryptDestinationConfig = (
  row: Record<string, unknown>,
  masterKey: Uint8Array
): NotificationDestinationConfig | null => {
  const id = optionalText(row.id) ?? optionalText(row.target_id);
  const userId = optionalText(row.user_id);
  if (!row.config_ciphertext || !id || !userId) return null;
  try {
    const envelope = json<EncryptedEnvelope>(row.config_ciphertext);
    const config = decryptJson<NotificationDestinationConfig>(
      envelope,
      masterKey,
      notificationDestinationAad(userId, id)
    );
    return typeof config.botToken === 'string' && typeof config.botUsername === 'string'
      ? config
      : null;
  } catch {
    return null;
  }
};

/**
 * The context the paired sender is sealed under: the same two ids as the configuration, so the
 * two halves of one row are bound to the same place and neither opens on any other.
 */
export const notificationDestinationSenderAad = (userId: string, id: string): string =>
  `notification-destination-sender:${userId}:${id}`;

/**
 * The paired sender, sealed. The id is also the private chat every message goes to, which is why
 * it is kept exactly as the token beside it is and not in the clear: a copy of the table names
 * neither the account nor the address.
 */
export const sealDestinationSender = (
  userId: string,
  id: string,
  senderId: string,
  masterKey: Uint8Array
): EncryptedEnvelope =>
  encryptJson({ senderId }, masterKey, notificationDestinationSenderAad(userId, id));

/** Null for a row that has no sender, no key, or a sender that will not open under this key. */
const decryptDestinationSender = (
  row: Record<string, unknown>,
  masterKey: Uint8Array | undefined,
  id: string,
  userId: string
): string | null => {
  if (!masterKey || !row.sender_ciphertext) return null;
  try {
    const envelope = json<EncryptedEnvelope>(row.sender_ciphertext);
    const opened = decryptJson<{ senderId?: unknown }>(
      envelope,
      masterKey,
      notificationDestinationSenderAad(userId, id)
    );
    return typeof opened.senderId === 'string' && opened.senderId ? opened.senderId : null;
  } catch {
    return null;
  }
};

/**
 * The additional data an agent-raised notification is sealed with. Bound to the conversation, so a
 * message lifted onto another task's row will not decrypt rather than being read out under the
 * wrong name.
 */
export const agentNotificationAad = (taskId: string): string => `agent-notification:${taskId}`;

/**
 * The sentence the agent asked to have pushed, unsealed here for the same reason the title is:
 * this is the only layer holding both the envelope and the key that opens it.
 *
 * A message that will not decrypt comes back null, and the notifier words the push from the
 * conversation name alone - a notification the owner can still act on beats one that never arrives.
 */
const decryptAgentMessage = (
  row: Record<string, unknown>,
  masterKey: Uint8Array
): string | null => {
  const workspaceId = optionalText(row.workspace_id);
  const wrappedKey = optionalText(row.wrapped_key);
  const taskId = optionalText(row.task_id);
  if (!row.message_ciphertext || !wrappedKey || !workspaceId || !taskId) return null;
  try {
    const key = unwrapDataKey(wrappedKey, masterKey, workspaceId);
    const envelope = json<EncryptedEnvelope>(row.message_ciphertext);
    return decryptJson<{ message: string }>(envelope, key, agentNotificationAad(taskId)).message;
  } catch {
    return null;
  }
};

/**
 * What reaches the owner while they are not looking: the web-push subscriptions a device
 * registers, the notifications the agent raises against a conversation, the queue the notifier
 * drains, and the settings that decide whether any of it is sent at this hour.
 *
 * The two decrypt helpers above sit here rather than with the other row mappers because this is
 * the only layer holding both the sealed envelope and the key that opens it, and because both of
 * them fail soft on purpose - a notification the owner can still act on beats one that never
 * arrives.
 */
export class NotificationStore {
  constructor(private readonly database: Database) {}

  async upsertPushSubscription(input: {
    userId: string;
    sessionPublicId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<PushSubscriptionRecord> {
    const result = await this.database.query(
      `INSERT INTO push_subscriptions(id,user_id,session_public_id,endpoint,p256dh,auth)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(endpoint) DO UPDATE SET
         session_public_id=EXCLUDED.session_public_id,p256dh=EXCLUDED.p256dh,
         auth=EXCLUDED.auth,updated_at=NOW()
       WHERE push_subscriptions.user_id=EXCLUDED.user_id
       RETURNING *`,
      [randomUUID(), input.userId, input.sessionPublicId, input.endpoint, input.p256dh, input.auth]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Push endpoint is already registered to another account');
    return {
      id: String(row.id),
      userId: String(row.user_id),
      endpoint: String(row.endpoint),
      p256dh: String(row.p256dh),
      auth: String(row.auth),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    };
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',
      [userId, endpoint]
    );
    return result.rowCount === 1;
  }

  async deletePushSubscriptionById(id: string): Promise<boolean> {
    const result = await this.database.query('DELETE FROM push_subscriptions WHERE id=$1', [id]);
    return result.rowCount === 1;
  }

  /**
   * How many targets a notification could reach at all: subscribed devices, and phones whose
   * pairing was completed and not switched off. It exists for the health port, where "no endpoint
   * is refusing" was the only count and is trivially true of a box nobody has ever subscribed a
   * device to. A destination still waiting for its pairing link to be tapped is listed as active
   * for the poller's sake and is not a target, so it is not counted here.
   */
  async notificationTargetCounts(): Promise<{
    pushSubscriptions: number;
    pairedDestinations: number;
  }> {
    const result = await this.database.query(
      `SELECT (SELECT COUNT(*) FROM push_subscriptions) AS push_subscriptions,
              (SELECT COUNT(*) FROM notification_destinations
                WHERE verified_at IS NOT NULL AND disabled_at IS NULL) AS paired_destinations`
    );
    const row = result.rows[0];
    return {
      pushSubscriptions: Number(row?.push_subscriptions ?? 0),
      pairedDestinations: Number(row?.paired_destinations ?? 0)
    };
  }

  /**
   * One notification the agent decided the owner should have.
   *
   * This is the only way a push exists because something chose to send it rather than because a
   * row changed status, and it is what makes a watcher possible: the run itself is silent, and the
   * message arrives on the mornings the page actually moved.
   *
   * The cap is per conversation and enforced inside the transaction, so a model that decides
   * everything is urgent runs out of notifications rather than out of the owner's patience. It
   * throws `agent_notification_limit`, which the caller turns into a tool error the agent can read
   * and keep working through - a refused notification is not a reason to abandon the task.
   */
  async createAgentNotification(input: {
    userId: string;
    taskId: string;
    kind: AgentNotificationRecord['kind'];
    messageCiphertext: EncryptedEnvelope;
  }): Promise<AgentNotificationRecord> {
    return this.database.transaction(async (tx) => {
      const existing = await tx.query(
        `SELECT COUNT(*) AS count FROM agent_notifications
         WHERE task_id=$1 AND user_id=$2`,
        [input.taskId, input.userId]
      );
      if (Number(existing.rows[0]?.count ?? 0) >= MAX_AGENT_NOTIFICATIONS_PER_TASK)
        throw new GardenError(
          'agent_notification_limit',
          `This conversation has already sent its ${MAX_AGENT_NOTIFICATIONS_PER_TASK} notifications`
        );
      const result = await tx.query(
        `INSERT INTO agent_notifications(id,user_id,task_id,kind,message_ciphertext)
         SELECT $1,$2,$3,$4,$5::jsonb FROM tasks WHERE id=$3 AND user_id=$2
         RETURNING *`,
        [
          randomUUID(),
          input.userId,
          input.taskId,
          input.kind,
          JSON.stringify(input.messageCiphertext)
        ]
      );
      const row = result.rows[0];
      if (!row) throw new GardenError('task_not_found', 'Conversation not found', 404);
      return {
        id: String(row.id),
        userId: String(row.user_id),
        taskId: String(row.task_id),
        kind: String(row.kind) as AgentNotificationRecord['kind'],
        messageCiphertext: json<EncryptedEnvelope>(row.message_ciphertext),
        createdAt: iso(row.created_at)
      };
    });
  }

  /**
   * Everything the agent has told this owner, newest first, across every conversation.
   *
   * A push is a moment and a device: it fires once, on whatever was subscribed, and is gone. This
   * is the standing record of the same rows, for the owner who was asleep, whose phone was off, or
   * who wants to read a week of a watcher's findings in one place instead of one conversation at a
   * time. It deliberately ignores the delivery ledger - whether a device was reached says nothing
   * about whether the owner has seen it.
   */
  async listAgentNotifications(
    userId: string,
    limit = 50,
    masterKey?: Uint8Array
  ): Promise<
    Array<AgentNotificationRecord & { taskTitle: string | null; message: string | null }>
  > {
    const result = await this.database.query(
      `SELECT n.*, t.title AS title_ciphertext, t.workspace_id, w.wrapped_key
       FROM agent_notifications n
       JOIN tasks t ON t.id=n.task_id
       LEFT JOIN workspace_keys w ON w.workspace_id=t.workspace_id
       WHERE n.user_id=$1
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(Math.trunc(limit), 200))]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      taskId: String(row.task_id),
      kind: String(row.kind) as AgentNotificationRecord['kind'],
      messageCiphertext: json<EncryptedEnvelope>(row.message_ciphertext),
      createdAt: iso(row.created_at),
      taskTitle: masterKey ? decryptTaskTitle(row, masterKey) : null,
      message: masterKey ? decryptAgentMessage(row, masterKey) : null
    }));
  }

  /**
   * Everything waiting to be told to a target that has not been told it yet.
   *
   * A target is either a device's push subscription or a destination the owner paired, and the
   * question is asked of the owner's events first and of their targets second. It was the other
   * way round - every branch began `FROM push_subscriptions` - which made an owner with no
   * subscribed device an owner with nothing to hear, for every kind, however much was waiting. The
   * `events` set is those same five branches with the subscription lifted out; `targets` is the two
   * kinds of place an event can go; a candidate is an event that happened on or after the target
   * was registered, which is the bound every branch already carried against the subscription's own
   * age so that a phone registered today is not handed a fortnight of history.
   *
   * `masterKey` is optional and buys three things: the conversation's own name, the sentence an
   * agent-raised notification carries, and a destination's sealed bot token. All three are
   * decrypted here rather than by the service that sends them, which is the only layer holding
   * both the envelope and the key. Any one failing to decrypt comes back null.
   */
  async listPendingNotifications(
    limit = 100,
    masterKey?: Uint8Array
  ): Promise<PendingNotificationRecord[]> {
    // The candidate horizon is stated inside the branches that would otherwise scan every finished
    // conversation and every notice the agent ever raised, as well as once more where the page is
    // picked: the branches used to be bounded by the join to a subscription, and are not any longer.
    const result = await this.database.query(
      `WITH events AS (
         SELECT a.user_id, 'approval_required'::text AS kind, a.id AS resource_id, a.task_id,
           NULL::text AS task_status, a.created_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM approvals a
         WHERE a.status='pending' AND a.expires_at>NOW()
         UNION ALL
         -- A conversation the owner started and walked away from is worth a receipt. A scheduled
         -- run is not: it finishes on a timer whether or not anything happened, and pushing that
         -- turns a fifteen-minute watcher into ninety-six identical notifications a day. Those say
         -- nothing unless the agent raises one itself, below - except when the run failed, because
         -- a watcher that has silently stopped watching is exactly what the silence would hide.
         SELECT t.user_id, 'task_finished'::text AS kind, t.id AS resource_id, t.id AS task_id,
           t.status AS task_status, COALESCE(t.completed_at,t.updated_at) AS event_at,
           NULL::jsonb AS message_ciphertext
         FROM tasks t
         WHERE t.status IN ('completed','failed','cancelled')
          -- Asked of the conversation and not of the ledger of due slots. task_schedule_runs is
          -- pruned at the delivery ledger's horizon, so a NOT EXISTS over it says "the owner
          -- started this" about any run old enough to have lost its row. That never fired only
          -- because the candidate window is fourteen days and the prune is thirty - an accident of
          -- two constants rather than a property - and a run that parks after an ask, or at a spend
          -- cap, and is resumed five weeks later completes inside the window with its row already
          -- gone. tasks.schedule_id (migration 62) is on the row itself and cannot be pruned.
          AND (t.status='failed' OR t.schedule_id IS NULL)
          -- Durable media publishes its own ready or failure notice after the text turn ends.
          AND (t.status<>'completed' OR NOT EXISTS (
            SELECT 1 FROM provider_media_jobs m WHERE m.user_id=t.user_id AND m.task_id=t.id
              AND (m.status<>'completed' OR m.created_at >= COALESCE(
                (SELECT e.created_at FROM task_events e WHERE e.task_id=t.id AND e.kind='user_message'
                 ORDER BY e.sequence DESC LIMIT 1),t.created_at))
          ))
          AND COALESCE(t.completed_at,t.updated_at)>NOW()-$2::interval
         UNION ALL
         -- A task the box stopped at a ceiling, which is the one pause nobody chose and which
         -- waits forever if the owner is not told. An ordinary Pause has no spend_paused_at.
         SELECT t.user_id, 'spend_paused'::text AS kind, t.id AS resource_id, t.id AS task_id,
           t.status AS task_status, t.spend_paused_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM tasks t
         WHERE t.status='paused' AND t.spend_paused_at IS NOT NULL
         UNION ALL
         -- The approval nobody answered. cleanupExpired marks a lapsed approval 'expired', and the
         -- API's approval sweep then releases its reserved credits and moves the task to 'paused' -
         -- and that was where the owner's part of it ended. Every branch above requires something
         -- this task is no longer: the approval is not pending, the task is not terminal, and
         -- nothing set spend_paused_at. The agent stopped, asked, waited out its twenty-four hours
         -- and gave up, and the owner found out by opening the conversation.
         --
         -- takeover_needed rather than a sixth kind, because that is already what "stopped, and
         -- only a person starts it again" is called here: it has the owner's switch, its rank in
         -- the ordering above and its place in the notifier's held-while-present set already.
         --
         -- Keyed on the approval id, so the ledger row that settled the approval_required push for
         -- the same approval does not settle this one - two pieces of news about one row, and
         -- the second is the one that says it is over. This does NOT collapse two strandings of
         -- one conversation into a single notice: a task stranded, resumed, asked again and
         -- stranded again carries two expired approvals and is reported twice, which is two true
         -- things, and is not worth a per-row anti-join on a statement that runs every two seconds.
         -- The candidate horizon is repeated inside the branch rather than left to the outer WHERE
         -- so the branch's own scan is bounded to a fortnight of expiries whatever the planner
         -- decides to push down.
         SELECT a.user_id, 'takeover_needed'::text AS kind, a.id AS resource_id, a.task_id,
           t.status AS task_status, a.expires_at AS event_at, NULL::jsonb AS message_ciphertext
         FROM approvals a
         JOIN tasks t ON t.id=a.task_id AND t.status='paused'
         WHERE a.status='expired' AND a.expires_at>NOW()-$2::interval
         UNION ALL
         -- The two the agent raises: something it was asked to watch for, and a wall it cannot get
         -- past on its own. Both carry their own sentence, and both are already the agent's
         -- decision, so nothing here re-derives whether they are worth sending.
         SELECT n.user_id, n.kind, n.id AS resource_id, n.task_id,
           NULL::text AS task_status, n.created_at AS event_at, n.message_ciphertext
         FROM agent_notifications n
         WHERE n.created_at>NOW()-$2::interval
       )
       -- Where an event can go. \`since\` is the moment the target started counting: the device's
       -- registration, or the moment the owner's phone completed pairing. A destination that is
       -- not yet verified or has been switched off is not a target at all.
       , targets AS (
         SELECT 'push'::text AS transport, ps.id AS target_id, ps.user_id, ps.created_at AS since,
           ps.created_at AS target_created_at, ps.updated_at AS target_updated_at,
           ps.endpoint, ps.p256dh, ps.auth,
           NULL::jsonb AS config_ciphertext, NULL::jsonb AS sender_ciphertext,
           NULL::boolean AS redact
         FROM push_subscriptions ps
         UNION ALL
         SELECT nd.kind AS transport, nd.id AS target_id, nd.user_id, nd.verified_at AS since,
           nd.created_at AS target_created_at, nd.updated_at AS target_updated_at,
           NULL::text AS endpoint, NULL::text AS p256dh, NULL::text AS auth,
           nd.config_ciphertext, nd.sender_ciphertext, nd.redact
         FROM notification_destinations nd
         WHERE nd.verified_at IS NOT NULL AND nd.disabled_at IS NULL
       )
       , candidates AS (
         SELECT tg.transport, tg.target_id, e.user_id, tg.endpoint, tg.p256dh, tg.auth,
           tg.target_created_at, tg.target_updated_at, tg.config_ciphertext,
           tg.sender_ciphertext, tg.redact, e.kind, e.resource_id, e.task_id, e.task_status, e.event_at,
           e.message_ciphertext
         FROM events e
         JOIN targets tg ON tg.user_id=e.user_id AND e.event_at>=tg.since
       )
       -- The page is chosen before anything is decorated with the name of the conversation it is
       -- about. Both are one statement's worth of work either way, but not the same amount of it:
       -- joining tasks to the candidate set makes the planner build a hash over every conversation
       -- on the box to answer at most a hundred lookups. Measured on 20,000 conversations of which
       -- 406 were candidates, that hash was 10.6 ms of the statement's 13.1 and 770 of its 810
       -- buffers - on a read that runs every two seconds. Picking first turns it into a hundred
       -- primary-key probes.
       --
       -- The ordering is stated twice on purpose. The inner one decides which rows the page is; the
       -- outer one is what makes the page come back in that order, because a join is not obliged to
       -- preserve its input's.
       , picked AS (
         SELECT c.*
         FROM candidates c
         -- Two ledgers, one anti-join. The push ledger's key carries a foreign key to the
         -- subscription and the destination ledger's to the destination, so neither can hold the
         -- other's rows; read together they are one answer to "was this target told this".
         LEFT JOIN (
           SELECT subscription_id AS target_id, kind, resource_id FROM notification_deliveries
           UNION ALL
           SELECT destination_id AS target_id, kind, resource_id
           FROM notification_destination_deliveries
         ) d ON d.target_id=c.target_id AND d.kind=c.kind AND d.resource_id=c.resource_id
         -- A terminal task stays terminal, so without a horizon every finished conversation is a
         -- candidate forever and the ledger row that stops it firing twice can never be pruned.
         -- Past this age the event has stopped being news anyway.
         WHERE d.target_id IS NULL AND c.event_at > NOW() - $2::interval
         -- Ordered by how stopped the work is. An approval and a takeover are both the agent
         -- waiting on a person; a spend pause is the box refusing to spend more; the rest is news.
         -- The id is the final tiebreaker so a page is stable - without it two rows sharing a
         -- timestamp swap places between reads, which looks to a delivering process like a set it
         -- has not seen.
         ORDER BY c.event_at, ${notificationUrgency('c')}, c.resource_id
         LIMIT $1
       )
       SELECT p.*, t.title AS title_ciphertext, t.workspace_id, w.wrapped_key
       FROM picked p
       LEFT JOIN tasks t ON t.id=p.task_id
       LEFT JOIN workspace_keys w ON w.workspace_id=t.workspace_id
       ORDER BY p.event_at, ${notificationUrgency('p')}, p.resource_id`,
      [limit, NOTIFICATION_CANDIDATE_INTERVAL]
    );
    return result.rows.map((row): PendingNotificationRecord => {
      const event = {
        kind: String(row.kind) as PendingNotificationRecord['kind'],
        resourceId: String(row.resource_id),
        taskId: String(row.task_id),
        taskStatus: optionalText(row.task_status),
        eventAt: iso(row.event_at),
        taskTitle: masterKey ? decryptTaskTitle(row, masterKey) : null,
        message: masterKey ? decryptAgentMessage(row, masterKey) : null
      };
      const target = {
        id: String(row.target_id),
        userId: String(row.user_id),
        createdAt: iso(row.target_created_at),
        updatedAt: iso(row.target_updated_at)
      };
      if (row.transport === 'telegram')
        return {
          transport: 'telegram',
          ...target,
          ...event,
          senderId: decryptDestinationSender(row, masterKey, target.id, target.userId),
          redact: row.redact !== false,
          config: masterKey ? decryptDestinationConfig(row, masterKey) : null
        };
      return {
        transport: 'push',
        ...target,
        ...event,
        endpoint: String(row.endpoint),
        p256dh: String(row.p256dh),
        auth: String(row.auth)
      };
    });
  }

  /** The kinds this owner still wants, and the window the box may not wake them in. */
  async notificationSettings(userId: string): Promise<StoredNotificationSettings | null> {
    const result = await this.database.query(
      'SELECT * FROM notification_settings WHERE user_id=$1',
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const startMinute = numericOrNull(row.quiet_start_minute);
    const endMinute = numericOrNull(row.quiet_end_minute);
    return {
      kinds: {
        approval_required: row.approval_required !== false,
        task_finished: row.task_finished !== false,
        spend_paused: row.spend_paused !== false,
        agent_message: row.agent_message !== false,
        takeover_needed: row.takeover_needed !== false
      },
      quietHours:
        startMinute === null || endMinute === null
          ? null
          : { startMinute: Math.trunc(startMinute), endMinute: Math.trunc(endMinute) },
      quietHoursAllowApprovals: row.quiet_allow_approvals !== false
    };
  }

  /** Upsert. A null window is how quiet hours are turned off; there is no separate flag. */
  async setNotificationSettings(
    userId: string,
    input: StoredNotificationSettings
  ): Promise<StoredNotificationSettings> {
    await this.database.query(
      `INSERT INTO notification_settings(
         user_id,approval_required,task_finished,spend_paused,agent_message,takeover_needed,
         quiet_start_minute,quiet_end_minute,quiet_allow_approvals,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT(user_id) DO UPDATE SET
         approval_required=EXCLUDED.approval_required,
         task_finished=EXCLUDED.task_finished,
         spend_paused=EXCLUDED.spend_paused,
         agent_message=EXCLUDED.agent_message,
         takeover_needed=EXCLUDED.takeover_needed,
         quiet_start_minute=EXCLUDED.quiet_start_minute,
         quiet_end_minute=EXCLUDED.quiet_end_minute,
         quiet_allow_approvals=EXCLUDED.quiet_allow_approvals,
         updated_at=NOW()`,
      [
        userId,
        input.kinds.approval_required,
        input.kinds.task_finished,
        input.kinds.spend_paused,
        input.kinds.agent_message,
        input.kinds.takeover_needed,
        input.quietHours?.startMinute ?? null,
        input.quietHours?.endMinute ?? null,
        input.quietHoursAllowApprovals
      ]
    );
    return (await this.notificationSettings(userId))!;
  }

  async recordNotificationDelivery(
    subscriptionId: string,
    kind: PendingNotificationRecord['kind'],
    resourceId: string
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO notification_deliveries(subscription_id,kind,resource_id)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [subscriptionId, kind, resourceId]
    );
  }

  /*
   * Destinations: the owner-level targets beside the device-level subscriptions above. One per
   * owner per kind, sealed configuration, and a pairing that binds exactly one numeric sender.
   */

  private mapDestination(
    row: Record<string, unknown>,
    masterKey?: Uint8Array
  ): NotificationDestinationRecord {
    const config = masterKey ? decryptDestinationConfig(row, masterKey) : null;
    const pairingExpiresAt = row.pairing_expires_at ? iso(row.pairing_expires_at) : null;
    const id = String(row.id);
    const userId = String(row.user_id);
    return {
      id,
      userId,
      kind: 'telegram',
      config,
      botUsername: config?.botUsername ?? null,
      senderId: decryptDestinationSender(row, masterKey, id, userId),
      pairingHash: optionalText(row.pairing_hash),
      pairingExpiresAt,
      pairingPending:
        Boolean(optionalText(row.pairing_hash)) &&
        pairingExpiresAt !== null &&
        Date.parse(pairingExpiresAt) > Date.now() &&
        !row.verified_at,
      lastUpdateId: numericOrNull(row.last_update_id),
      redact: row.redact !== false,
      createdAt: iso(row.created_at),
      verifiedAt: row.verified_at ? iso(row.verified_at) : null,
      disabledAt: row.disabled_at ? iso(row.disabled_at) : null,
      updatedAt: iso(row.updated_at)
    };
  }

  /**
   * Create or replace the owner's destination of this kind.
   *
   * Replacing the sealed configuration also unpairs: a new bot token is a new bot, and the sender
   * that paired with the old one has no standing with it. The id is kept on conflict, which is why
   * a caller sealing the configuration must look the existing id up first - the context the
   * envelope is bound to carries it.
   */
  async upsertNotificationDestination(input: {
    id: string;
    userId: string;
    kind: 'telegram';
    configCiphertext: EncryptedEnvelope;
  }): Promise<NotificationDestinationRecord> {
    const result = await this.database.query(
      `INSERT INTO notification_destinations(id,user_id,kind,config_ciphertext)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT(user_id,kind) DO UPDATE SET
         config_ciphertext=EXCLUDED.config_ciphertext, sender_ciphertext=NULL, pairing_hash=NULL,
         pairing_expires_at=NULL, last_update_id=NULL, verified_at=NULL, disabled_at=NULL,
         updated_at=NOW()
       RETURNING *`,
      [input.id, input.userId, input.kind, JSON.stringify(input.configCiphertext)]
    );
    return this.mapDestination(result.rows[0]!);
  }

  async getNotificationDestination(
    userId: string,
    kind: 'telegram',
    masterKey?: Uint8Array
  ): Promise<NotificationDestinationRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM notification_destinations WHERE user_id=$1 AND kind=$2',
      [userId, kind]
    );
    const row = result.rows[0];
    return row ? this.mapDestination(row, masterKey) : null;
  }

  /** By id, for the inbound handler re-reading the pairing state at the moment a secret arrives. */
  async getNotificationDestinationById(
    id: string,
    masterKey?: Uint8Array
  ): Promise<NotificationDestinationRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM notification_destinations WHERE id=$1',
      [id]
    );
    const row = result.rows[0];
    return row ? this.mapDestination(row, masterKey) : null;
  }

  /**
   * Every destination the inbound poller should be listening on: verified ones, and ones whose
   * pairing secret is still live - a pairing completes over the same poll, so a destination has to
   * be polled before it is verified. Switched-off ones are left alone entirely.
   */
  async listActiveNotificationDestinations(
    masterKey?: Uint8Array
  ): Promise<NotificationDestinationRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM notification_destinations
       WHERE disabled_at IS NULL
         AND (verified_at IS NOT NULL
              OR (pairing_hash IS NOT NULL AND pairing_expires_at>NOW()))
       ORDER BY created_at, id`
    );
    return result.rows.map((row) => this.mapDestination(row, masterKey));
  }

  /**
   * A fresh one-time secret. Only its hash is stored, and minting one also unpairs: the pairing
   * link is how a phone is replaced, so whoever completes it is the owner from then on and the
   * previous sender is not.
   */
  async startDestinationPairing(id: string, hash: string, expiresAt: Date): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE notification_destinations
       SET pairing_hash=$2, pairing_expires_at=$3, sender_ciphertext=NULL, verified_at=NULL,
         updated_at=NOW()
       WHERE id=$1`,
      [id, hash, expiresAt.toISOString()]
    );
    return result.rowCount === 1;
  }

  /**
   * One UPDATE, and its WHERE is the whole defence: the hash must match, the window must be open,
   * and nothing may have completed it already. The row count is the answer, so a replayed link -
   * the same secret presented twice, or presented after it lapsed - changes nothing and says so.
   *
   * The sender is sealed here, under the master key the caller holds, because the envelope is
   * bound to the owner's id and this is the layer that can read it off the row.
   */
  async completeDestinationPairing(
    id: string,
    hash: string,
    senderId: string,
    masterKey: Uint8Array
  ): Promise<number> {
    const owner = await this.database.query(
      'SELECT user_id FROM notification_destinations WHERE id=$1',
      [id]
    );
    const userId = optionalText(owner.rows[0]?.user_id);
    if (!userId) return 0;
    const result = await this.database.query(
      `UPDATE notification_destinations
       SET sender_ciphertext=$3::jsonb, verified_at=NOW(), pairing_hash=NULL,
         pairing_expires_at=NULL, updated_at=NOW()
       WHERE id=$1 AND pairing_hash=$2 AND pairing_expires_at>NOW() AND verified_at IS NULL`,
      [id, hash, JSON.stringify(sealDestinationSender(userId, id, senderId, masterKey))]
    );
    return result.rowCount ?? 0;
  }

  async setDestinationLastUpdateId(id: string, lastUpdateId: number): Promise<void> {
    await this.database.query(
      'UPDATE notification_destinations SET last_update_id=$2 WHERE id=$1',
      [id, Math.trunc(lastUpdateId)]
    );
  }

  async setDestinationDisabled(
    userId: string,
    kind: 'telegram',
    disabled: boolean
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE notification_destinations
       SET disabled_at=CASE WHEN $3 THEN COALESCE(disabled_at,NOW()) ELSE NULL END,
         updated_at=NOW()
       WHERE user_id=$1 AND kind=$2`,
      [userId, kind, disabled]
    );
    return result.rowCount === 1;
  }

  async setDestinationRedact(userId: string, kind: 'telegram', redact: boolean): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE notification_destinations SET redact=$3, updated_at=NOW()
       WHERE user_id=$1 AND kind=$2`,
      [userId, kind, redact]
    );
    return result.rowCount === 1;
  }

  /** The ledger goes with it, by cascade: an unpaired phone owes no outcome edits. */
  async deleteNotificationDestination(userId: string, kind: 'telegram'): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM notification_destinations WHERE user_id=$1 AND kind=$2',
      [userId, kind]
    );
    return result.rowCount === 1;
  }

  /**
   * The destination ledger's row, written once per target, kind and resource, like the push one.
   *
   * `externalRef` is the message id the service answered with and `nonce` is what the card's
   * buttons carry. Both are null for a row the sender settled without sending - a kind the owner
   * switched off, a stale item - and a row with nothing on the far side has no outcome to wait
   * for, so `outcome_at` is set on the way in. Only a sent approval card leaves it open.
   */
  async recordDestinationDelivery(
    destinationId: string,
    kind: PendingNotificationRecord['kind'],
    resourceId: string,
    externalRef: string | null,
    nonce: string | null
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO notification_destination_deliveries
         (destination_id,kind,resource_id,external_ref,nonce,outcome_at)
       VALUES ($1,$2,$3,$4,$5,
         CASE WHEN $4::text IS NOT NULL AND $2='approval_required' THEN NULL ELSE NOW() END)
       ON CONFLICT DO NOTHING`,
      [destinationId, kind, resourceId, externalRef, nonce]
    );
  }

  private mapDestinationDelivery(
    row: Record<string, unknown>,
    masterKey: Uint8Array | undefined
  ): DestinationDeliveryRecord {
    const destinationId = String(row.destination_id);
    const userId = String(row.user_id);
    return {
      destinationId,
      kind: String(row.kind) as DestinationDeliveryRecord['kind'],
      resourceId: String(row.resource_id),
      externalRef: optionalText(row.external_ref),
      nonce: optionalText(row.nonce),
      deliveredAt: iso(row.delivered_at),
      outcomeAt: row.outcome_at ? iso(row.outcome_at) : null,
      taskId: optionalText(row.task_id),
      approvalStatus: optionalText(row.approval_status),
      userId,
      senderId: decryptDestinationSender(row, masterKey, destinationId, userId)
    };
  }

  /**
   * The ledger row a callback from the phone names, with the nonce to hold it against and the
   * sender the row is paired to right now - the live one, so a phone the owner has since replaced
   * is refused by the row and not by whatever a poller last read.
   */
  async getDestinationDelivery(
    destinationId: string,
    kind: PendingNotificationRecord['kind'],
    resourceId: string,
    masterKey?: Uint8Array
  ): Promise<DestinationDeliveryRecord | null> {
    const result = await this.database.query(
      `SELECT d.*, nd.user_id, nd.sender_ciphertext, a.status AS approval_status, a.task_id
       FROM notification_destination_deliveries d
       JOIN notification_destinations nd ON nd.id=d.destination_id
       LEFT JOIN approvals a ON a.id=d.resource_id AND d.kind='approval_required'
       WHERE d.destination_id=$1 AND d.kind=$2 AND d.resource_id=$3`,
      [destinationId, kind, resourceId]
    );
    const row = result.rows[0];
    return row ? this.mapDestinationDelivery(row, masterKey) : null;
  }

  /**
   * The ledger row a reply on the phone points at, by the message id the reply quotes. An agent's
   * question is an `agent_message` row; its conversation is found through the notification it
   * settled, which is what the answer is posted to.
   */
  async findDestinationDeliveryByExternalRef(
    destinationId: string,
    externalRef: string,
    masterKey?: Uint8Array
  ): Promise<DestinationDeliveryRecord | null> {
    const result = await this.database.query(
      `SELECT d.*, nd.user_id, nd.sender_ciphertext, NULL::text AS approval_status,
         COALESCE(n.task_id, a.task_id) AS task_id
       FROM notification_destination_deliveries d
       JOIN notification_destinations nd ON nd.id=d.destination_id
       LEFT JOIN agent_notifications n ON n.id=d.resource_id AND d.kind='agent_message'
       LEFT JOIN approvals a ON a.id=d.resource_id AND d.kind IN ('approval_required','takeover_needed')
       WHERE d.destination_id=$1 AND d.external_ref=$2
       ORDER BY d.delivered_at DESC
       LIMIT 1`,
      [destinationId, externalRef]
    );
    const row = result.rows[0];
    return row ? this.mapDestinationDelivery(row, masterKey) : null;
  }

  /**
   * Approval cards on a phone whose approval has since been decided somewhere else - the web
   * client, the command line, the deadline - and which still show their buttons. This is how a
   * decision taken at the keyboard reaches the card in the owner's pocket.
   */
  async listDestinationDeliveriesAwaitingOutcome(
    limit = 100,
    masterKey?: Uint8Array
  ): Promise<DestinationDeliveryRecord[]> {
    const result = await this.database.query(
      `SELECT d.*, nd.user_id, nd.sender_ciphertext, a.status AS approval_status, a.task_id
       FROM notification_destination_deliveries d
       JOIN notification_destinations nd ON nd.id=d.destination_id
       JOIN approvals a ON a.id=d.resource_id
       WHERE d.kind='approval_required' AND d.outcome_at IS NULL AND d.external_ref IS NOT NULL
         AND a.status<>'pending'
       ORDER BY d.delivered_at
       LIMIT $1`,
      [Math.max(1, Math.min(Math.trunc(limit), 500))]
    );
    return result.rows.map((row) => this.mapDestinationDelivery(row, masterKey));
  }

  async markDestinationDeliveryOutcome(
    destinationId: string,
    kind: PendingNotificationRecord['kind'],
    resourceId: string
  ): Promise<void> {
    await this.database.query(
      `UPDATE notification_destination_deliveries SET outcome_at=NOW()
       WHERE destination_id=$1 AND kind=$2 AND resource_id=$3 AND outcome_at IS NULL`,
      [destinationId, kind, resourceId]
    );
  }
}
