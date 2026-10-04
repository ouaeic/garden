/**
 * Where a notice goes, and which kinds are allowed to make the trip.
 *
 * A push endpoint is a URL this box will POST to unattended, so it is checked against the
 * deployment's allowed relay hosts before it is stored - credential-free HTTPS, no odd port, and a
 * hostname on the list.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentNotification } from '@garden/contracts';
import { GardenError, encryptJson, sha256 } from '@garden/core';
import { notificationDestinationAad, type NotificationDestinationRecord } from '@garden/data';
import { z } from 'zod';
import { UNREADABLE_AGENT_MESSAGE, clockToMinutes, minutesToClock } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { recordSecurityEvent } from '../security-events.js';
import { sessionCookieName } from '../session.js';

/** A bot token: the bot's numeric id, a colon, and a secret in the URL-safe alphabet. */
const BOT_TOKEN = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;

/** The one real address of the bot API; the config key exists so a test can point at a stub. */
const BOT_API_BASE_URL = 'https://api.telegram.org';

/** How long a pairing link is good for. Long enough to find the phone, short enough to be one try. */
const PAIRING_TTL_MS = 10 * 60_000;

/**
 * The loopback API token an answer typed on the phone is posted with. It outlives any session
 * because the phone is paired once and answers for years; it is revoked the moment the phone is
 * unpaired or the bot replaced, so its life is the pairing's and not the calendar's.
 */
const PHONE_TOKEN_LIFETIME_MS = 10 * 365 * 24 * 60 * 60_000;

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(20).max(512),
    auth: z.string().min(8).max(256)
  })
});

const validatePushEndpoint = (endpoint: string, suffixes: string[]): string => {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new GardenError('invalid_push_endpoint', 'Push endpoints must use credential-free HTTPS');
  }
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => {
    const value = suffix.trim().toLowerCase();
    return value.startsWith('.') ? host.endsWith(value) : host === value;
  });
  if (!allowed)
    throw new GardenError('invalid_push_endpoint', 'This browser push relay is not allowed');
  return url.toString();
};

export const registerNotificationRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    masterKey,
    secure,
    pushEndpointSuffixes,
    config,
    idempotent,
    requireRecentStepUp
  } = context;
  app.get('/v1/notifications/config', async () => ({
    enabled: Boolean(config.PUSH_VAPID_PUBLIC_KEY),
    publicKey: config.PUSH_VAPID_PUBLIC_KEY ?? null
  }));

  app.post('/v1/notifications/subscriptions', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      if (!config.PUSH_VAPID_PUBLIC_KEY) {
        throw new GardenError(
          'push_unavailable',
          'Push notifications are not configured for this deployment'
        );
      }
      const input = pushSubscriptionSchema.parse(request.body);
      const endpoint = validatePushEndpoint(input.endpoint, pushEndpointSuffixes);
      const sessionToken = request.cookies[sessionCookieName(secure)];
      const sessionPublicId = sessionToken
        ? await store.getSessionPublicId(user.id, sha256(sessionToken))
        : null;
      if (!sessionPublicId)
        throw new GardenError('authentication_required', 'Active device session is required');
      const subscription = await store.upsertPushSubscription({
        userId: user.id,
        sessionPublicId,
        endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth
      });
      reply.status(201);
      return { id: subscription.id, enabled: true };
    });
  });

  app.delete('/v1/notifications/subscriptions', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = z.object({ endpoint: z.string().url().max(2048) }).parse(request.body);
      const endpoint = validatePushEndpoint(input.endpoint, pushEndpointSuffixes);
      await store.deletePushSubscription(user.id, endpoint);
      return { enabled: false };
    });
  });

  /**
   * The owner's notification preferences.
   *
   * Quiet hours are stored as minutes past local midnight and travel as "HH:MM", because the owner
   * thinks in a clock and the notifier thinks in a comparison. The zone is echoed read-only from
   * the spending caps: there is one answer on this box to when the owner's day rolls over, and a
   * second copy of it would eventually disagree.
   */
  const notificationSettingsResponse = async (userId: string) => {
    const stored = (await store.notificationSettings(userId)) ?? {
      kinds: {
        approval_required: true,
        task_finished: true,
        spend_paused: true,
        agent_message: true,
        takeover_needed: true
      },
      quietHours: null,
      quietHoursAllowApprovals: true
    };
    const limits = await store.effectiveSpendLimits(userId);
    return {
      kinds: {
        approvalRequired: stored.kinds.approval_required,
        taskFinished: stored.kinds.task_finished,
        spendPaused: stored.kinds.spend_paused,
        agentMessage: stored.kinds.agent_message,
        takeoverNeeded: stored.kinds.takeover_needed
      },
      quietHoursStart: stored.quietHours ? minutesToClock(stored.quietHours.startMinute) : null,
      quietHoursEnd: stored.quietHours ? minutesToClock(stored.quietHours.endMinute) : null,
      quietHoursAllowApprovals: stored.quietHoursAllowApprovals,
      timeZone: limits.timeZone
    };
  };

  app.get('/v1/notifications/settings', async (request) =>
    notificationSettingsResponse(requireUser(request.user).id)
  );

  /**
   * Every kind that can reach a device has a switch here, the two the agent raises included. They
   * arrived without one, on the reasoning that the agent asking for the owner is not the box
   * reporting on itself - but that made the one notification the owner explicitly asked for also
   * the only one they could not turn down, short of unsubscribing the device entirely.
   */
  const UpdateNotificationSettingsRequest = z.object({
    kinds: z.object({
      approvalRequired: z.boolean(),
      taskFinished: z.boolean(),
      spendPaused: z.boolean(),
      agentMessage: z.boolean(),
      takeoverNeeded: z.boolean()
    }),
    quietHoursStart: z.string().nullable(),
    quietHoursEnd: z.string().nullable(),
    quietHoursAllowApprovals: z.boolean()
  });

  app.put('/v1/notifications/settings', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = UpdateNotificationSettingsRequest.parse(request.body);
      // Both ends or neither: half a window is not a window, and it would silently never be quiet.
      if (Boolean(input.quietHoursStart) !== Boolean(input.quietHoursEnd))
        throw new GardenError(
          'invalid_quiet_hours',
          'Quiet hours need both a start and an end time'
        );
      const quietHours =
        input.quietHoursStart && input.quietHoursEnd
          ? {
              startMinute: clockToMinutes(input.quietHoursStart),
              endMinute: clockToMinutes(input.quietHoursEnd)
            }
          : null;
      if (quietHours && quietHours.startMinute === quietHours.endMinute)
        throw new GardenError(
          'invalid_quiet_hours',
          'Quiet hours that start and end at the same minute would never be quiet'
        );
      await store.setNotificationSettings(user.id, {
        kinds: {
          approval_required: input.kinds.approvalRequired,
          task_finished: input.kinds.taskFinished,
          spend_paused: input.kinds.spendPaused,
          agent_message: input.kinds.agentMessage,
          takeover_needed: input.kinds.takeoverNeeded
        },
        quietHours,
        quietHoursAllowApprovals: input.quietHoursAllowApprovals
      });
      return notificationSettingsResponse(user.id);
    });
  });

  /**
   * Everything the agent has told this owner, across every conversation, newest first.
   *
   * A push is one moment on whichever devices happened to be subscribed. This is the standing
   * record of the same decisions, so a watcher's week can be read in one place by an owner whose
   * phone was off - and so a notice is still recoverable when the push was dropped for quiet hours
   * or because they were already at the keyboard.
   */
  app.get<{ Querystring: { limit?: string } }>('/v1/notifications/agent', async (request) => {
    const user = requireUser(request.user);
    const limit = z.coerce.number().int().min(1).max(200).default(50).parse(request.query.limit);
    return (await store.listAgentNotifications(user.id, limit, masterKey)).map(
      (row): AgentNotification => ({
        id: row.id,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        kind: row.kind,
        /**
         * A notice the workspace key will not unwrap says so, in the field a client renders. A row
         * with nothing to read is dropped rather than drawn, so served as null, the one notice that
         * reports a conversation has become unreadable would be the one notice that vanished
         * silently. This is a rare row and a serious one: it means a key this box
         * holds no longer opens what it sealed.
         */
        message: row.message ?? UNREADABLE_AGENT_MESSAGE,
        createdAt: row.createdAt
      })
    );
  });

  /*
   * The phone transport: a bot on a messaging service, paired to exactly one sender.
   *
   * The token is checked against the bot API once, sealed under the master key with the row's own
   * id in the context, and never served again by any route. Pairing is a one-time secret whose
   * hash is stored for ten minutes; the phone that presents it becomes the one sender every
   * inbound decision is checked against. The service in between is not end-to-end encrypted, so a
   * card is sent as title and link only unless the owner says otherwise.
   */
  const botApi = async <T>(
    method: string,
    token: string,
    body: Record<string, unknown>
  ): Promise<T> => {
    let response: Response;
    try {
      const base = config.TELEGRAM_API_BASE_URL ?? BOT_API_BASE_URL;
      response = await fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      // No detail from the failure itself: a fetch error quotes the URL, and the URL is the token.
      throw new GardenError(
        'destination_unreachable',
        'The bot API could not be reached from this box',
        502
      );
    }
    const envelope = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
    } | null;
    if (!response.ok || !envelope?.ok)
      throw new GardenError(
        'destination_refused',
        envelope?.error_code === 401 || envelope?.error_code === 404
          ? 'That bot token was not accepted'
          : 'The bot API refused the request',
        400
      );
    return envelope.result as T;
  };

  const destinationResponse = (row: NotificationDestinationRecord) => ({
    kind: row.kind,
    botUsername: row.botUsername,
    paired: row.verifiedAt !== null && row.senderId !== null,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
    redact: row.redact,
    pairingPending: row.pairingPending,
    pairingExpiresAt: row.pairingPending ? row.pairingExpiresAt : null
  });

  /**
   * A fresh secret, its hash stored, the link served once and never again.
   *
   * "Never again" includes the idempotency ledger: the wrapper the other write routes use keeps a
   * route's answer in `api_operations` for a day so a retried request can be served the same one,
   * and this answer is the secret. So the two routes that mint one run outside it, as the routes
   * that hand out an API token or a recovery code do, and a retry mints a fresh link that
   * supersedes the first rather than reading the first back off the database.
   */
  const mintPairing = async (id: string, botUsername: string) => {
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await store.startDestinationPairing(id, sha256(secret), expiresAt);
    return {
      botUsername,
      pairingUrl: `https://t.me/${botUsername}?start=${secret}`,
      expiresAt: expiresAt.toISOString()
    };
  };

  app.get('/v1/notifications/destinations', async (request) => {
    const user = requireUser(request.user);
    const row = await store.getNotificationDestination(user.id, 'telegram', masterKey);
    return row ? [destinationResponse(row)] : [];
  });

  app.post('/v1/notifications/destinations/telegram', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const input = z.object({ botToken: z.string().regex(BOT_TOKEN) }).parse(request.body);
    const me = await botApi<{ username?: string; is_bot?: boolean }>('getMe', input.botToken, {});
    if (!me.username || me.is_bot === false)
      throw new GardenError('destination_refused', 'That token does not belong to a bot', 400);
    const existing = await store.getNotificationDestination(user.id, 'telegram', masterKey);
    // The row keeps its id on replacement and the envelope's context carries the id, so the
    // existing id is what a replacement is sealed under.
    const id = existing?.id ?? randomUUID();
    if (existing?.config?.apiTokenId)
      await store.revokeApiToken(user.id, existing.config.apiTokenId).catch(() => false);
    const value = `oc_live_${randomBytes(32).toString('base64url')}`;
    let apiTokenId: string;
    try {
      apiTokenId = (
        await store.createApiToken({
          userId: user.id,
          label: 'Phone transport',
          tokenHash: sha256(value),
          prefix: value.slice(0, 16),
          scopes: ['tasks:read', 'tasks:write'],
          expiresAt: new Date(Date.now() + PHONE_TOKEN_LIFETIME_MS)
        })
      ).id;
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'api_token_limit')
        throw new GardenError(
          'api_token_limit',
          'Revoke an existing API token before pairing a phone; answering from it needs one',
          409
        );
      throw cause;
    }
    await store.upsertNotificationDestination({
      id,
      userId: user.id,
      kind: 'telegram',
      configCiphertext: encryptJson(
        { botToken: input.botToken, botUsername: me.username, apiToken: value, apiTokenId },
        masterKey,
        notificationDestinationAad(user.id, id)
      )
    });
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: existing ? 'notification_destination_replaced' : 'notification_destination_created',
      outcome: 'completed',
      metadata: { destinationId: id, kind: 'telegram' }
    });
    reply.status(201);
    return mintPairing(id, me.username);
  });

  app.post('/v1/notifications/destinations/telegram/pairing', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const existing = await store.getNotificationDestination(user.id, 'telegram', masterKey);
    if (!existing?.botUsername)
      throw new GardenError('destination_not_found', 'Add a bot token first', 404);
    return mintPairing(existing.id, existing.botUsername);
  });

  app.patch('/v1/notifications/destinations/telegram', async (request, reply) => {
    const user = requireUser(request.user);
    const input = z
      .object({ redact: z.boolean().optional(), disabled: z.boolean().optional() })
      .parse(request.body);
    // Switching redaction off is the one setting that widens what leaves this box for a service
    // that can read it, so it wants the same recent passkey as binding the phone did. Narrowing
    // it, and pausing or resuming sends, change nothing about the secrecy boundary and do not.
    if (input.redact === false) await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      if (input.redact !== undefined)
        await store.setDestinationRedact(user.id, 'telegram', input.redact);
      if (input.disabled !== undefined)
        await store.setDestinationDisabled(user.id, 'telegram', input.disabled);
      const row = await store.getNotificationDestination(user.id, 'telegram', masterKey);
      if (!row) throw new GardenError('destination_not_found', 'No phone is set up', 404);
      return destinationResponse(row);
    });
  });

  app.delete('/v1/notifications/destinations/telegram', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const existing = await store.getNotificationDestination(user.id, 'telegram', masterKey);
      if (existing?.config?.apiTokenId)
        await store.revokeApiToken(user.id, existing.config.apiTokenId).catch(() => false);
      const removed = await store.deleteNotificationDestination(user.id, 'telegram');
      if (removed)
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'notification_destination_removed',
          outcome: 'completed',
          metadata: { destinationId: existing?.id ?? null, kind: 'telegram' }
        });
      return { removed };
    });
  });

  app.post('/v1/notifications/destinations/telegram/test', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const row = await store.getNotificationDestination(user.id, 'telegram', masterKey);
      if (!row?.config) throw new GardenError('destination_not_found', 'No phone is set up', 404);
      if (!row.senderId || row.verifiedAt === null)
        throw new GardenError('destination_unpaired', 'Pair your phone first', 409);
      await botApi('sendMessage', row.config.botToken, {
        chat_id: row.senderId,
        text: '<b>garden</b>\nNotifications reach this phone. Approvals and questions will arrive here.',
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        protect_content: true,
        reply_markup: {
          inline_keyboard: [[{ text: 'Open in garden', url: config.PUBLIC_APP_URL }]]
        }
      });
      return { sent: true };
    });
  });
};
