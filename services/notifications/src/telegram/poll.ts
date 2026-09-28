import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DataStore, NotificationDestinationRecord } from '@garden/data';
import { backoffMs } from '../retry.js';
import { createTelegramClient, type TelegramClient } from './client.js';
import {
  handleUpdate,
  type DestinationState,
  type InboundOutcome,
  type TelegramUpdate
} from './inbound.js';

/**
 * How long one long-poll call may go without completing before it is abandoned and started again.
 * A request the far end has silently dropped never returns on its own; without this the poller
 * would sit on a dead socket for as long as the kernel allows, which is the whole outage.
 */
export const WATCHDOG_MS = 120_000;

/** How often the set of destinations is re-read, so a pairing minted in Settings gets a poller. */
export const REFRESH_MS = 10_000;

const bestEffort = (work: Promise<unknown>): Promise<void> =>
  work.then(
    () => undefined,
    () => undefined
  );

export interface PollerInput {
  store: DataStore;
  client: TelegramClient;
  destination: DestinationState;
  lastUpdateId: number | null;
  timeoutS: number;
  signal: AbortSignal;
  handle: (update: TelegramUpdate) => Promise<unknown>;
  now?: () => number;
}

/**
 * One loop per destination, which is one loop per token: the service allows one consumer of a
 * bot's updates, and a second would steal half of them. The cursor is persisted after every batch
 * so a restart resumes where it left off rather than replaying a day of taps.
 */
export const createPoller = (input: PollerInput) => {
  const { client, signal } = input;
  const now = input.now ?? (() => Date.now());
  let lastUpdateId = input.lastUpdateId;
  let lastPollAt: number | null = null;
  let attempts = 0;
  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      const watchdog = AbortSignal.timeout(WATCHDOG_MS);
      try {
        const updates = await client.call<TelegramUpdate[]>(
          'getUpdates',
          {
            ...(lastUpdateId === null ? {} : { offset: lastUpdateId + 1 }),
            timeout: input.timeoutS,
            allowed_updates: ['message', 'callback_query']
          },
          {
            signal: AbortSignal.any([signal, watchdog]),
            // Longer than the long poll itself, which is the one call meant to take this long.
            timeoutMs: (input.timeoutS + 15) * 1000
          }
        );
        lastPollAt = now();
        attempts = 0;
        for (const update of Array.isArray(updates) ? updates : []) {
          if (typeof update.update_id !== 'number') continue;
          try {
            await input.handle(update);
          } catch (error) {
            client.warn(
              `garden-notifications: notification.destination_inbound_failed destination=${input.destination.id} ${error instanceof Error ? error.message : String(error)}\n`
            );
          }
          // Advanced whether or not handling succeeded: an update that cannot be handled once
          // cannot be handled on the next poll either, and would otherwise be polled for ever.
          lastUpdateId = Math.max(lastUpdateId ?? update.update_id, update.update_id);
        }
        if (updates.length && lastUpdateId !== null)
          await bestEffort(
            input.store.setDestinationLastUpdateId(input.destination.id, lastUpdateId)
          );
      } catch (error) {
        if (signal.aborted) break;
        if (watchdog.aborted) {
          // A stall, not a refusal: the far end went quiet. Started again at once.
          client.warn(
            `garden-notifications: notification.destination_poll_stalled destination=${input.destination.id} no answer in ${WATCHDOG_MS / 1000}s; polling again\n`
          );
          continue;
        }
        attempts += 1;
        if (attempts === 1)
          client.warn(
            `garden-notifications: notification.destination_poll_failed destination=${input.destination.id} ${error instanceof Error ? error.message : String(error)}; trying again in ${Math.round(backoffMs(attempts) / 1000)}s\n`
          );
        await delay(backoffMs(attempts), undefined, { signal }).catch(() => undefined);
      }
    }
  };
  return { run, lastPollAt: (): number | null => lastPollAt };
};

export interface DestinationHealth {
  /** Whether any destination on the box has completed pairing. */
  paired: boolean;
  /** Whether every paired destination has a poller that completed a call recently. */
  polling: boolean;
  /** Age of the oldest paired destination's last completed poll, in ms; null when never. */
  pollAgeMs: number | null;
}

export interface SupervisorInput {
  store: DataStore;
  /** Absent on a box with no DATA_MASTER_KEY: the destinations are still listed, and none polled. */
  masterKey: Uint8Array | undefined;
  baseUrl: string;
  appUrl: string;
  apiBaseUrl: string;
  timeoutS: number;
  signal: AbortSignal;
  onInbound: (outcome: InboundOutcome) => void;
  fetch?: typeof fetch;
  warn?: (line: string) => void;
  refreshMs?: number;
  now?: () => number;
}

interface Running {
  controller: AbortController;
  tokenHash: string;
  state: DestinationState;
  poller: ReturnType<typeof createPoller>;
  client: TelegramClient;
  finished: Promise<void>;
}

/**
 * Keeps one poller per active destination, and re-reads the set every few seconds: a destination
 * created in Settings needs a poller before its pairing link is tapped, a replaced token needs a
 * new one, and an unpaired or switched-off destination needs its poller stopped.
 */
export const superviseDestinationPollers = (input: SupervisorInput) => {
  const { store, signal } = input;
  const warn = input.warn ?? ((line: string) => void process.stderr.write(line));
  const now = input.now ?? (() => Date.now());
  const running = new Map<string, Running>();
  const unreadable = new Set<string>();
  let listing: NotificationDestinationRecord[] = [];

  const clientFor = (destinationId: string): TelegramClient | null =>
    running.get(destinationId)?.client ?? null;

  const start = (
    destination: NotificationDestinationRecord,
    tokenHash: string,
    masterKey: Uint8Array
  ): void => {
    const config = destination.config!;
    const controller = new AbortController();
    const client = createTelegramClient({
      baseUrl: input.baseUrl,
      token: config.botToken,
      ...(input.fetch ? { fetch: input.fetch } : {}),
      warn
    });
    const state: DestinationState = {
      id: destination.id,
      userId: destination.userId,
      senderId: destination.senderId,
      config
    };
    const poller = createPoller({
      store,
      client,
      destination: state,
      lastUpdateId: destination.lastUpdateId,
      timeoutS: input.timeoutS,
      signal: AbortSignal.any([signal, controller.signal]),
      now,
      handle: async (update) => {
        const outcome = await handleUpdate(
          {
            store,
            client,
            destination: state,
            masterKey,
            appUrl: input.appUrl,
            apiBaseUrl: input.apiBaseUrl,
            ...(input.fetch ? { fetch: input.fetch } : {}),
            warn
          },
          update
        );
        input.onInbound(outcome);
      }
    });
    running.set(destination.id, {
      controller,
      tokenHash,
      state,
      poller,
      client,
      finished: poller.run().catch((error: unknown) => {
        warn(
          `garden-notifications: notification.destination_poll_ended destination=${destination.id} ${error instanceof Error ? error.message : String(error)}\n`
        );
      })
    });
  };

  const reconcile = async (): Promise<void> => {
    const destinations = await store
      .listActiveNotificationDestinations(input.masterKey)
      .catch(() => null);
    if (!destinations) return;
    listing = destinations;
    const { masterKey } = input;
    if (!masterKey) return;
    const seen = new Set<string>();
    for (const destination of destinations) {
      if (!destination.config) {
        if (!unreadable.has(destination.id)) {
          unreadable.add(destination.id);
          warn(
            `garden-notifications: notification.destination_unreadable destination=${destination.id} its configuration does not open under DATA_MASTER_KEY; nothing is sent to it and nothing is read from it. Unpair and pair again in Settings\n`
          );
        }
        continue;
      }
      unreadable.delete(destination.id);
      seen.add(destination.id);
      const tokenHash = createHash('sha256').update(destination.config.botToken).digest('hex');
      const current = running.get(destination.id);
      if (current && current.tokenHash === tokenHash) {
        // The row's own view of the sender wins, so a re-pair completed at the keyboard side or a
        // pairing this poller itself completed both end up agreeing here.
        current.state.senderId = destination.senderId;
        continue;
      }
      if (current) current.controller.abort();
      start(destination, tokenHash, masterKey);
    }
    for (const [id, entry] of running)
      if (!seen.has(id)) {
        entry.controller.abort();
        running.delete(id);
      }
  };

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      await reconcile();
      await delay(input.refreshMs ?? REFRESH_MS, undefined, { signal }).catch(() => undefined);
    }
    for (const entry of running.values()) entry.controller.abort();
    await Promise.all([...running.values()].map((entry) => entry.finished));
  };

  const health = (): DestinationHealth => {
    const paired = listing.filter((destination) => destination.verifiedAt !== null);
    if (!paired.length) return { paired: false, polling: false, pollAgeMs: null };
    // A poll is "recent" if it completed inside one long poll plus the watchdog: the longest a
    // healthy loop goes between completed calls.
    const horizon = input.timeoutS * 1000 + WATCHDOG_MS;
    const ages = paired.map((destination) => {
      const at = running.get(destination.id)?.poller.lastPollAt() ?? null;
      return at === null ? null : now() - at;
    });
    return {
      paired: true,
      polling: ages.every((age) => age !== null && age <= horizon),
      pollAgeMs: ages.some((age) => age === null) ? null : Math.max(...ages.map((age) => age ?? 0))
    };
  };

  return { run, health, clientFor };
};
