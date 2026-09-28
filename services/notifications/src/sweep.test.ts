import { describe, expect, it } from 'vitest';
import type { DataStore } from '@garden/data';
import type { PendingRow } from './context.js';
import { notificationPayload, type PushPayload } from './payload.js';
import { EndpointHealth, RETRY_HORIZON_MS, backoffMs } from './retry.js';
import { runSweep, type SweepInput } from './sweep.js';
import { TransportError, type Delivered, type Transport } from './transport.js';

const now = new Date('2026-07-31T12:00:00.000Z');

const row = (overrides: Partial<PendingRow> = {}): PendingRow =>
  ({
    transport: 'push',
    id: 'subscription-1',
    userId: 'owner',
    endpoint: 'https://push.example/1',
    p256dh: 'p',
    auth: 'a',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    kind: 'task_finished',
    resourceId: 'task-1',
    taskId: 'task-1',
    taskStatus: 'completed',
    eventAt: '2026-07-31T12:00:00.000Z',
    taskTitle: null,
    message: null,
    ...overrides
  }) as PendingRow;

/** A row for the phone transport: a paired destination whose configuration opened. */
const destinationRow = (overrides: Partial<PendingRow> = {}): PendingRow =>
  ({
    transport: 'telegram',
    id: 'destination-1',
    userId: 'owner',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    senderId: '4242',
    redact: true,
    config: { botToken: '1000:bot-secret', botUsername: 'garden_bot' },
    kind: 'task_finished',
    resourceId: 'task-1',
    taskId: 'task-1',
    taskStatus: 'completed',
    eventAt: '2026-07-31T12:00:00.000Z',
    taskTitle: null,
    message: null,
    ...overrides
  }) as PendingRow;

interface Recorded {
  /** Every argument list `listPendingNotifications` was called with, in order. */
  listed: unknown[][];
  settled: Array<[string, string, string]>;
  /** The destination ledger, with what the far end handed back. */
  destinationSettled: Array<[string, string, string, string | null, string | null]>;
  sessions: Array<{ lastSeenAt: string }>;
  /** Every store method touched, in order, so a test can say what was never called. */
  calls: string[];
  securityEvents: Array<{ kind: string; metadata?: Record<string, unknown> }>;
}

const harness = (
  pending: PendingRow[],
  parts: Record<string, unknown> = {},
  sessions: Array<{ lastSeenAt: string }> = []
): { store: DataStore; recorded: Recorded } => {
  const recorded: Recorded = {
    listed: [],
    settled: [],
    destinationSettled: [],
    sessions,
    calls: [],
    securityEvents: []
  };
  const methods: Record<string, unknown> = {
    listPendingNotifications: async (...args: unknown[]) => {
      recorded.listed.push(args);
      return pending;
    },
    recordNotificationDelivery: async (id: string, kind: string, resourceId: string) => {
      recorded.settled.push([id, kind, resourceId]);
    },
    recordDestinationDelivery: async (
      id: string,
      kind: string,
      resourceId: string,
      externalRef: string | null,
      nonce: string | null
    ) => {
      recorded.destinationSettled.push([id, kind, resourceId, externalRef, nonce]);
    },
    effectiveSpendLimits: async () => ({ timeZone: 'UTC' }),
    notificationSettings: async () => null,
    listSessions: async () => recorded.sessions,
    listApprovals: async () => [],
    getTask: async () => null,
    deletePushSubscriptionById: async () => undefined,
    deleteNotificationDestination: async () => undefined,
    recordSecurityEvent: async (event: { kind: string; metadata?: Record<string, unknown> }) => {
      recorded.securityEvents.push(event);
    },
    ...parts
  };
  const store = new Proxy(methods, {
    get: (target, property: string) => {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        recorded.calls.push(property);
        return (value as (...inner: unknown[]) => unknown)(...args);
      };
    }
  }) as unknown as DataStore;
  return { store, recorded };
};

type Send = (row: PendingRow, payload: PushPayload) => Promise<Delivered | void>;

/** Both transports, each handing the payload to one recording `send`. */
const transportsFor = (send: Send): Record<'push' | 'telegram', Transport> => ({
  push: {
    kind: 'push',
    send: async (item, subject) => (await send(item, notificationPayload(subject))) ?? {}
  },
  telegram: {
    kind: 'telegram',
    send: async (item, subject) => (await send(item, notificationPayload(subject))) ?? {}
  }
});

const sweep = (
  store: DataStore,
  overrides: Partial<SweepInput> & { send?: Send } = {}
): { input: SweepInput; sent: PushPayload[]; warned: string[] } => {
  const sent: PushPayload[] = [];
  const warned: string[] = [];
  const { send, ...rest } = overrides;
  return {
    sent,
    warned,
    input: {
      store,
      masterKey: undefined,
      endpoints: new EndpointHealth(),
      batchSize: 100,
      deferredLastSweep: 0,
      transports: transportsFor(send ?? (async (_row, payload) => void sent.push(payload))),
      now: () => now,
      warn: (line) => void warned.push(line),
      ...rest
    }
  };
};

describe('runSweep', () => {
  it('hands the data layer the key, which is the whole difference between a named conversation and "Untitled conversation"', async () => {
    // The service read the same /etc/garden/control.env that carries DATA_MASTER_KEY and never
    // asked for it, so the only production caller of listPendingNotifications passed one argument
    // and every title came back null. This is the assertion that the key gets as far as the query.
    const key = new Uint8Array(32).fill(7);
    const { store, recorded } = harness([row({ taskTitle: 'Reconcile the March invoices' })]);
    const { input, sent } = sweep(store, { masterKey: key });
    await runSweep(input);
    expect(recorded.listed).toEqual([[100, key]]);
    expect(sent[0]?.title).toBe('Reconcile the March invoices');
  });

  it('still sweeps on a box with no key, wording what it can without one', async () => {
    const { store, recorded } = harness([row()]);
    const { input, sent } = sweep(store);
    await runSweep(input);
    expect(recorded.listed).toEqual([[100, undefined]]);
    expect(sent[0]?.title).toBe('Untitled conversation');
  });

  it('delivers, settles and reports one sent notification', async () => {
    const { store, recorded } = harness([row()]);
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(1);
    expect(recorded.settled).toEqual([['subscription-1', 'task_finished', 'task-1']]);
    expect(result).toMatchObject({ pending: 1, delivered: 1, suppressed: 0, held: 0, idle: false });
  });

  it('reports a batch it could only hold as idle, so the caller waits instead of spinning', async () => {
    // A hold writes nothing and is reconsidered next pass, so a sweep that held everything has
    // nothing to show for the candidate UNION it just ran. Only endpoint waits were counted
    // before, so this loop re-issued that query as fast as PostgreSQL would answer it - for as
    // long as the owner kept a tab open, which on this machine can be days.
    const { store, recorded } = harness(
      [row({ kind: 'agent_message', resourceId: 'notification-1', taskStatus: null })],
      {},
      [{ lastSeenAt: '2026-07-31T11:59:30.000Z' }]
    );
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ pending: 1, held: 1, suppressed: 1, idle: true });
  });

  it('is not idle while one row in a held batch is still deliverable', async () => {
    // The owner is at the keyboard, so their own notice holds; the second row belongs to somebody
    // else in the house who is not, and it must not be made to wait for them.
    const { store } = harness(
      [
        row({ kind: 'agent_message', resourceId: 'notification-1', taskStatus: null }),
        row({ id: 'subscription-2', userId: 'other', resourceId: 'task-2', taskId: 'task-2' })
      ],
      {
        listSessions: async (userId: string) =>
          userId === 'owner' ? [{ lastSeenAt: '2026-07-31T11:59:30.000Z' }] : []
      }
    );
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ pending: 2, held: 1, delivered: 1, idle: false });
  });

  it('waits out an endpoint inside its backoff without attempting it, and widens the next page by it', async () => {
    const endpoints = new EndpointHealth();
    endpoints.failed('subscription-1', 500, now);
    const { store, recorded } = harness([row()]);
    const { input, sent } = sweep(store, { endpoints });
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ pending: 1, deferred: 1, held: 0, idle: true });

    const second = sweep(store, { endpoints, deferredLastSweep: result.deferred });
    await runSweep(second.input);
    expect(recorded.listed[1]).toEqual([101, undefined]);
  });

  it('settles a kind the owner switched off, so the server honours it and never reconsiders it', async () => {
    const { store, recorded } = harness([row()], {
      notificationSettings: async () => ({
        kinds: { task_finished: false },
        quietHours: null,
        quietHoursAllowApprovals: true,
        timeZone: 'UTC'
      })
    });
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([['subscription-1', 'task_finished', 'task-1']]);
    // Not idle: a drop settles its ledger row, so the next query returns fewer rows rather than
    // the same ones. Falling straight through is what drains a backlog quickly.
    expect(result).toMatchObject({ suppressed: 1, held: 0, idle: false });
  });

  it('holds a spend pause the owner is sitting in front of rather than dropping it forever', async () => {
    // The box has stopped and waits for a person to raise the ceiling. Dropping it settles the
    // ledger row, which means that notification is never sent to that device again at all.
    const { store, recorded } = harness([row({ kind: 'spend_paused', taskStatus: 'paused' })], {}, [
      { lastSeenAt: '2026-07-31T11:59:30.000Z' }
    ]);
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ held: 1, idle: true });
  });

  it('keeps a database that will not answer from ending the loop', async () => {
    const { store } = harness([], {
      listPendingNotifications: async () => {
        throw new Error('database unavailable');
      }
    });
    const { input } = sweep(store);
    await expect(runSweep(input)).resolves.toMatchObject({ pending: 0, idle: true });
  });

  it('does not put a device into a wait for a failure that was never the device’s', async () => {
    // Everything before the send is a read of the owner's own rows. A failure there says nothing
    // about the far end, and holding it against the endpoint would back off a working phone.
    const endpoints = new EndpointHealth();
    const { store } = harness([row()], {
      getTask: async () => {
        throw new Error('database unavailable');
      },
      recordNotificationDelivery: async () => {
        throw new Error('database unavailable');
      }
    });
    const { input } = sweep(store, { endpoints });
    const result = await runSweep(input);
    expect(result.failed).toBe(1);
    expect(endpoints.waiting('subscription-1', new Date(now.getTime() + 1))).toBe(false);
  });

  it('forgets a subscription the push service says is gone, and never retries it', async () => {
    const deleted: string[] = [];
    const { store, recorded } = harness([row()], {
      deletePushSubscriptionById: async (id: string) => void deleted.push(id)
    });
    const { input } = sweep(store, {
      send: async () => {
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      }
    });
    const result = await runSweep(input);
    expect(deleted).toEqual(['subscription-1']);
    // Nothing is marked delivered that was not: the row goes away with the subscription.
    expect(recorded.settled).toEqual([]);
    expect(result).toMatchObject({ failed: 1, delivered: 0 });
  });

  it('stops between items when told to shut down, never between the push and its record', async () => {
    /*
     * A full batch is a hundred serial sends with a ten-second ceiling each, so a pass that meets a
     * push service which accepts the connection and then says nothing outlives the thirty seconds
     * `garden@.service` allows a stop - and the SIGKILL that follows can land in the gap between a
     * notification that was sent and the ledger row saying it was sent, which is how the owner gets
     * the same push twice on the next start. The item that was in flight when the signal arrived
     * must therefore finish both halves, and the ones behind it must not be started at all.
     */
    const shutdown = new AbortController();
    const { store, recorded } = harness([
      row({ id: 'subscription-1', resourceId: 'task-1', taskId: 'task-1' }),
      row({ id: 'subscription-2', resourceId: 'task-2', taskId: 'task-2' }),
      row({ id: 'subscription-3', resourceId: 'task-3', taskId: 'task-3' })
    ]);
    const attempted: PushPayload[] = [];
    const { input } = sweep(store, {
      signal: shutdown.signal,
      send: async (_row, payload) => {
        attempted.push(payload);
        shutdown.abort();
      }
    });
    const result = await runSweep(input);
    expect(attempted).toHaveLength(1);
    // The one that was in flight is settled. Two and three were never attempted, so they carry no
    // delivery record and the next start considers them again - nothing is lost and nothing repeats.
    expect(recorded.settled).toEqual([['subscription-1', 'task_finished', 'task-1']]);
    expect(result).toMatchObject({ pending: 3, delivered: 1, failed: 0 });
  });
});

/**
 * The same sweep over a row for the phone transport. The decisions are the owner's and the
 * event's, never the transport's, so every rule above applies unchanged; what differs is which
 * ledger a settled row lands in, what the far end hands back, and what a refusal costs.
 */
describe('runSweep over a destination row', () => {
  it('settles into the destination ledger with the message id and the nonce the far end was given', async () => {
    const { store, recorded } = harness([destinationRow({ kind: 'approval_required' })]);
    const { input } = sweep(store, {
      send: async () => ({ externalRef: '512', nonce: 'abcdefgh' })
    });
    const result = await runSweep(input);
    expect(recorded.settled).toEqual([]);
    expect(recorded.destinationSettled).toEqual([
      ['destination-1', 'approval_required', 'task-1', '512', 'abcdefgh']
    ]);
    expect(result).toMatchObject({ delivered: 1, destinationDelivered: 1, destinationFailed: 0 });
  });

  it('drops a kind the owner switched off, transport-blind, into the destination ledger', async () => {
    const { store, recorded } = harness([destinationRow()], {
      notificationSettings: async () => ({
        kinds: { task_finished: false },
        quietHours: null,
        quietHoursAllowApprovals: true,
        timeZone: 'UTC'
      })
    });
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    // Settled with nothing on the far side: no message id, no nonce.
    expect(recorded.destinationSettled).toEqual([
      ['destination-1', 'task_finished', 'task-1', null, null]
    ]);
    expect(result).toMatchObject({ suppressed: 1, idle: false });
  });

  it('holds a notice inside quiet hours on the phone exactly as it would on a browser', async () => {
    const { store, recorded } = harness(
      [destinationRow({ kind: 'agent_message', resourceId: 'notification-1', taskStatus: null })],
      {
        notificationSettings: async () => ({
          kinds: {},
          // Noon UTC is inside a window that covers the whole day.
          quietHours: { startMinute: 0, endMinute: 1439 },
          quietHoursAllowApprovals: true,
          timeZone: 'UTC'
        })
      }
    );
    const { input, sent } = sweep(store);
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.destinationSettled).toEqual([]);
    expect(result).toMatchObject({ held: 1, idle: true });
  });

  it('waits exactly as long as a rate limit asks, not the minute the backoff would have chosen', async () => {
    const endpoints = new EndpointHealth();
    const { store } = harness([destinationRow()]);
    const { input } = sweep(store, {
      endpoints,
      send: async () => {
        throw new TransportError('sendMessage answered 429', {
          statusCode: 429,
          retryAfterMs: 5_000
        });
      }
    });
    const result = await runSweep(input);
    expect(result).toMatchObject({ failed: 1, destinationFailed: 1 });
    expect(endpoints.waiting('destination-1', new Date(now.getTime() + 4_999))).toBe(true);
    expect(endpoints.waiting('destination-1', new Date(now.getTime() + 5_001))).toBe(false);
    expect(backoffMs(1)).toBeGreaterThan(5_000);
  });

  it('never retires a destination, however long it has been refusing', async () => {
    // A device's subscription goes stale on its own and is retired after a day of refusals. A
    // destination is the owner's one phone, paired on purpose; the bot API having a bad day is
    // not a reason to unpair it, and the ceiling keeps the cost of waiting at two attempts an hour.
    const endpoints = new EndpointHealth();
    endpoints.failed('destination-1', 502, new Date(now.getTime() - RETRY_HORIZON_MS - 60_000));
    const { store, recorded } = harness([destinationRow()]);
    const { input, warned } = sweep(store, {
      endpoints,
      send: async () => {
        throw new TransportError('sendMessage answered 502', { statusCode: 502 });
      }
    });
    const result = await runSweep(input);
    expect(result).toMatchObject({ failed: 1, retired: 0 });
    expect(recorded.calls).not.toContain('deleteNotificationDestination');
    expect(recorded.calls).not.toContain('deletePushSubscriptionById');
    expect(recorded.destinationSettled).toEqual([]);
    // Still waiting, at the ceiling, and still a candidate for the next pass after it.
    expect(endpoints.waiting('destination-1', new Date(now.getTime() + 1))).toBe(true);
    expect(warned.join('')).not.toContain('retired');
  });

  it("says once, in the journal and the owner's record, that a destination has started refusing", async () => {
    const { store, recorded } = harness([destinationRow()]);
    const { input, warned } = sweep(store, {
      send: async () => {
        throw new TransportError('sendMessage answered 500', { statusCode: 500 });
      }
    });
    await runSweep(input);
    expect(recorded.securityEvents).toEqual([
      {
        userId: 'owner',
        kind: 'destination_delivery_failing',
        outcome: 'failure',
        metadata: { destinationId: 'destination-1', statusCode: 500 }
      }
    ]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('notification.destination_delivery_failing');
    expect(warned[0]).not.toContain('bot-secret');
  });

  it('leaves a row alone when this box has no transport for it, and counts it', async () => {
    // A destination row on a box with no master key, or a device row on a box with no signing
    // keys: nothing can send it, nothing settles it, and a box that can will.
    const { store, recorded } = harness([destinationRow(), row()]);
    const { input, sent } = sweep(store, { transports: {} });
    const result = await runSweep(input);
    expect(sent).toHaveLength(0);
    expect(recorded.settled).toEqual([]);
    expect(recorded.destinationSettled).toEqual([]);
    expect(result).toMatchObject({ pending: 2, unsendable: 2, idle: true });
  });

  it('skips a destination whose configuration would not open, and says so once', async () => {
    const { store, recorded } = harness([destinationRow({ config: null })]);
    const warnedOnce = new Set<string>();
    const first = sweep(store, { warnedOnce });
    const result = await runSweep(first.input);
    expect(first.sent).toHaveLength(0);
    expect(recorded.destinationSettled).toEqual([]);
    expect(result).toMatchObject({ unsendable: 1, failed: 0, idle: true });
    expect(first.warned).toHaveLength(1);
    expect(first.warned[0]).toContain('notification.destination_unreadable');
    const second = sweep(store, { warnedOnce });
    await runSweep(second.input);
    expect(second.warned).toEqual([]);
  });
});
