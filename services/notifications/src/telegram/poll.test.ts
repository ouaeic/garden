import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { DataStore, NotificationDestinationRecord } from '@garden/data';
import { backoffMs } from '../retry.js';
import type { TelegramClient } from './client.js';
import type { TelegramUpdate } from './inbound.js';
import { createPoller, superviseDestinationPollers } from './poll.js';

const update = (id: number): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, chat: { id: 4242, type: 'private' }, text: 'hello' }
});

interface Recorded {
  /** Every `getUpdates` body, in order. */
  polls: Array<Record<string, unknown>>;
  /** Every call option the client was handed, so the timeout and the signal can be checked. */
  options: Array<{ timeoutMs?: number; signal?: AbortSignal }>;
  cursors: Array<[string, number]>;
  handled: number[];
  warned: string[];
}

/**
 * A bot API whose `getUpdates` answers from a script: each entry is a batch of updates, or an
 * error to throw. Once the script is exhausted the loop is stopped, which is how a test ends.
 */
const harness = (
  script: Array<TelegramUpdate[] | Error>,
  options: {
    lastUpdateId?: number | null;
    handle?: (item: TelegramUpdate) => Promise<unknown>;
  } = {}
) => {
  const recorded: Recorded = { polls: [], options: [], cursors: [], handled: [], warned: [] };
  const controller = new AbortController();
  const client: TelegramClient = {
    call: async <T>(
      method: string,
      body: Record<string, unknown>,
      callOptions: { timeoutMs?: number; signal?: AbortSignal } = {}
    ): Promise<T> => {
      expect(method).toBe('getUpdates');
      recorded.polls.push(body);
      recorded.options.push(callOptions);
      const next = script.shift();
      // Let the loop's own bookkeeping run before the next answer, then end it when the script
      // is done: an abort is what a real shutdown does, and the loop must stop on it.
      await delay(1);
      if (next === undefined) {
        controller.abort();
        return [] as T;
      }
      if (next instanceof Error) throw next;
      return next as T;
    },
    warn: (line) => void recorded.warned.push(line)
  };
  const store = {
    setDestinationLastUpdateId: async (id: string, cursor: number) => {
      recorded.cursors.push([id, cursor]);
    }
  } as unknown as DataStore;
  const poller = createPoller({
    store,
    client,
    destination: {
      id: 'destination-1',
      userId: 'owner',
      senderId: '4242',
      config: { botToken: '1000:bot-secret', botUsername: 'garden_bot' }
    },
    lastUpdateId: options.lastUpdateId ?? null,
    timeoutS: 50,
    signal: controller.signal,
    handle:
      options.handle ??
      (async (item) => {
        recorded.handled.push(item.update_id);
      }),
    now: () => 1_000_000
  });
  return { poller, recorded, controller };
};

describe('one inbound poller', () => {
  it('asks from the cursor after the last update it saw, for the two kinds of update it handles, and persists the cursor after each batch', async () => {
    const { poller, recorded } = harness([[update(11), update(12)], [update(13)]], {
      lastUpdateId: 10
    });
    await poller.run();
    expect(recorded.polls.map((body) => body.offset)).toEqual([11, 13, 14]);
    expect(recorded.polls[0]).toMatchObject({
      timeout: 50,
      allowed_updates: ['message', 'callback_query']
    });
    expect(recorded.handled).toEqual([11, 12, 13]);
    // Written once per batch that carried something, never for an empty answer.
    expect(recorded.cursors).toEqual([
      ['destination-1', 12],
      ['destination-1', 13]
    ]);
    expect(poller.lastPollAt()).toBe(1_000_000);
  });

  it('starts with no offset when nothing was ever seen, and gives one call longer than the long poll itself', async () => {
    const { poller, recorded } = harness([[]]);
    await poller.run();
    expect(recorded.polls[0]).not.toHaveProperty('offset');
    expect(recorded.options[0]?.timeoutMs).toBe(65_000);
    expect(recorded.options[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('moves past an update its handler could not take, saying so once, rather than polling it for ever', async () => {
    const { poller, recorded } = harness([[update(21), update(22)]], {
      handle: async (item) => {
        if (item.update_id === 21) throw new Error('the handler fell over');
        recorded.handled.push(item.update_id);
      }
    });
    await poller.run();
    expect(recorded.handled).toEqual([22]);
    expect(recorded.cursors).toEqual([['destination-1', 22]]);
    expect(recorded.polls.map((body) => body.offset)).toEqual([undefined, 23]);
    expect(
      recorded.warned.filter((line) => line.includes('destination_inbound_failed'))
    ).toHaveLength(1);
    expect(recorded.warned[0]).toContain('the handler fell over');
  });

  it('backs off after a refusal and stops the moment it is told to, even mid-wait', async () => {
    const { poller, recorded, controller } = harness([new Error('getUpdates answered 502')]);
    const finished = poller.run();
    // The first failure is written to the journal with the wait it chose; the wait is a minute,
    // and an abort during it must end the loop at once rather than after the minute.
    await delay(10);
    expect(recorded.warned).toHaveLength(1);
    expect(recorded.warned[0]).toContain('destination_poll_failed');
    expect(recorded.warned[0]).toContain(`trying again in ${Math.round(backoffMs(1) / 1000)}s`);
    controller.abort();
    await expect(finished).resolves.toBeUndefined();
    expect(recorded.polls).toHaveLength(1);
    expect(poller.lastPollAt()).toBeNull();
  });
});

const destination = (
  overrides: Partial<NotificationDestinationRecord> = {}
): NotificationDestinationRecord => ({
  id: 'destination-1',
  userId: 'owner',
  kind: 'telegram',
  config: { botToken: '1000:bot-secret', botUsername: 'garden_bot' },
  botUsername: 'garden_bot',
  senderId: '4242',
  pairingHash: null,
  pairingExpiresAt: null,
  pairingPending: false,
  lastUpdateId: 40,
  redact: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  verifiedAt: '2026-07-01T00:00:00.000Z',
  disabledAt: null,
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...overrides
});

/** The supervisor over a fake store and a bot API that answers every poll with nothing. */
const supervised = (
  listings: NotificationDestinationRecord[][],
  // Null rather than undefined for "no key": an explicit undefined would select the default.
  key: Uint8Array | null = new Uint8Array(32)
) => {
  const masterKey = key ?? undefined;
  const warned: string[] = [];
  const polled: string[] = [];
  const controller = new AbortController();
  const store = {
    // Each listing is served once and the last one stands, the way a real table would.
    listActiveNotificationDestinations: async () =>
      listings.length > 1 ? listings.shift()! : (listings[0] ?? []),
    setDestinationLastUpdateId: async () => undefined
  } as unknown as DataStore;
  const supervisor = superviseDestinationPollers({
    store,
    masterKey,
    baseUrl: 'https://bot-api.test',
    appUrl: 'https://ai.example.test',
    apiBaseUrl: 'http://127.0.0.1:4100',
    timeoutS: 50,
    signal: controller.signal,
    onInbound: () => undefined,
    warn: (line) => void warned.push(line),
    refreshMs: 5,
    fetch: (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      // The host is also named "bot-something", so the token's own segment is the last `/bot`.
      polled.push(url.slice(url.lastIndexOf('/bot') + 4));
      await delay(2);
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch
  });
  return { supervisor, warned, polled, controller };
};

/** Waits, a few milliseconds at a time, for a condition a loop on its own clock will reach. */
const until = async (condition: () => boolean, limitMs = 2_000): Promise<void> => {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition was not reached in time');
    await delay(5);
  }
};

describe('the supervisor over every destination', () => {
  it('runs one poller per readable destination, reports it polling, and stops it on shutdown', async () => {
    const { supervisor, polled, controller } = supervised([[destination()]]);
    const running = supervisor.run();
    await until(() => supervisor.health().polling);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled.every((path) => path.startsWith('1000:bot-secret/getUpdates'))).toBe(true);
    expect(supervisor.health()).toEqual({
      paired: true,
      polling: true,
      pollAgeMs: expect.any(Number) as number
    });
    expect(supervisor.clientFor('destination-1')).not.toBeNull();
    expect(supervisor.clientFor('destination-2')).toBeNull();
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    const count = polled.length;
    await delay(40);
    // Nothing polls after shutdown.
    expect(polled.length).toBe(count);
  });

  it('polls nothing without a master key, and says so through health rather than through silence', async () => {
    const { supervisor, polled, controller } = supervised([[destination()]], null);
    const running = supervisor.run();
    // Three refresh rounds is long enough for a poller to have started, had one been going to.
    await until(() => supervisor.health().paired);
    await delay(40);
    expect(polled).toEqual([]);
    expect(supervisor.health()).toEqual({ paired: true, polling: false, pollAgeMs: null });
    controller.abort();
    await running;
  });

  it('skips a destination whose configuration would not open, warning once, and reports nothing paired when none is verified', async () => {
    const unreadable = destination({ id: 'destination-2', config: null, botUsername: null });
    const { supervisor, polled, warned, controller } = supervised([
      [unreadable],
      [unreadable],
      [destination({ verifiedAt: null, senderId: null, pairingPending: true })]
    ]);
    const running = supervisor.run();
    // The third listing is a pairing in progress: polled, so the link can be honoured, but not
    // yet a paired phone as far as health is concerned.
    await until(() => polled.length > 0);
    expect(polled.filter((path) => !path.startsWith('1000:bot-secret'))).toEqual([]);
    expect(warned.filter((line) => line.includes('destination_unreadable'))).toHaveLength(1);
    expect(supervisor.clientFor('destination-2')).toBeNull();
    expect(supervisor.clientFor('destination-1')).not.toBeNull();
    expect(supervisor.health()).toEqual({ paired: false, polling: false, pollAgeMs: null });
    controller.abort();
    await running;
  });
});
