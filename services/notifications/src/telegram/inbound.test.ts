import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DataStore } from '@garden/data';
import { EndpointHealth } from '../retry.js';
import { TransportError } from '../transport.js';
import type { TelegramClient } from './client.js';
import {
  handleUpdate,
  REJECTION_BURST,
  REJECTION_REFILL_MS,
  sweepCardOutcomes,
  type DestinationState,
  type InboundInput,
  type TelegramUpdate
} from './inbound.js';
import { callbackData } from './render.js';

const approvalId = '6f1a9d2e-4c3b-4e8a-9f0d-1b2c3d4e5f60';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Recorded {
  /** Every store method touched, with its arguments, in order. */
  calls: Array<[string, ...unknown[]]>;
  /** Every bot API method called, with its body, in order. */
  api: Array<[string, Record<string, unknown>]>;
  securityEvents: Array<Record<string, unknown>>;
  posted: Array<{ url: string; init: RequestInit }>;
  warned: string[];
}

const destination = (overrides: Partial<DestinationState> = {}): DestinationState => ({
  id: 'destination-1',
  userId: 'owner',
  senderId: '4242',
  config: { botToken: '1000:bot-secret', botUsername: 'garden_bot', apiToken: 'oc_live_phone' },
  ...overrides
});

const harness = (parts: Record<string, unknown> = {}, state = destination()) => {
  const recorded: Recorded = { calls: [], api: [], securityEvents: [], posted: [], warned: [] };
  let approvalStatus = 'pending';
  let paired = false;
  const methods: Record<string, unknown> = {
    getDestinationDelivery: async () => ({
      destinationId: 'destination-1',
      kind: 'approval_required',
      resourceId: approvalId,
      externalRef: '512',
      nonce: 'abcdefgh',
      outcomeAt: null,
      taskId: 'task-1',
      approvalStatus,
      userId: 'owner',
      senderId: '4242'
    }),
    getApproval: async () => ({
      id: approvalId,
      userId: 'owner',
      taskId: 'task-1',
      action: 'shell',
      status: approvalStatus,
      expiresAt: '2026-08-01T12:00:00.000Z'
    }),
    resolveApproval: async (_userId: string, _id: string, decision: string) => {
      if (approvalStatus !== 'pending') return false;
      approvalStatus = decision;
      return true;
    },
    setTaskStatusForUser: async () => true,
    markDestinationDeliveryOutcome: async () => undefined,
    recordSecurityEvent: async (event: Record<string, unknown>) => {
      recorded.securityEvents.push(event);
    },
    getNotificationDestinationById: async () => ({
      id: 'destination-1',
      pairingHash: sha256('the-real-pairing-secret'),
      pairingPending: !paired
    }),
    completeDestinationPairing: async (_id: string, hash: string) => {
      if (paired || hash !== sha256('the-real-pairing-secret')) return 0;
      paired = true;
      return 1;
    },
    findDestinationDeliveryByExternalRef: async (_id: string, ref: string) =>
      ref === '900'
        ? {
            destinationId: 'destination-1',
            kind: 'agent_message',
            resourceId: 'notice-1',
            externalRef: '900',
            nonce: null,
            taskId: 'task-1',
            userId: 'owner',
            senderId: '4242'
          }
        : null,
    getTask: async () => ({ id: 'task-1', status: 'awaiting_user' }),
    listDestinationDeliveriesAwaitingOutcome: async () => [],
    ...parts
  };
  const store = new Proxy(methods, {
    get: (target, property: string) => {
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        recorded.calls.push([property, ...args]);
        return (value as (...inner: unknown[]) => unknown)(...args);
      };
    }
  }) as unknown as DataStore;
  const client: TelegramClient = {
    call: async <T>(method: string, body: Record<string, unknown>) => {
      recorded.api.push([method, body]);
      return { message_id: 1 } as T;
    },
    warn: () => undefined
  };
  const input: InboundInput = {
    store,
    client,
    destination: state,
    masterKey: new Uint8Array(32),
    appUrl: 'https://ai.example.test',
    apiBaseUrl: 'http://127.0.0.1:4100',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      recorded.posted.push({
        url: url instanceof Request ? url.url : url.toString(),
        init: init ?? {}
      });
      return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
    }) as typeof fetch,
    warn: (line) => void recorded.warned.push(line),
    now: () => new Date('2026-07-31T12:31:00.000Z')
  };
  return { input, recorded, state };
};

const tap = (
  decision: 'y' | 'n',
  overrides: { fromId?: number; chatType?: string; nonce?: string; data?: string } = {}
): TelegramUpdate => ({
  update_id: 10,
  callback_query: {
    id: 'query-1',
    from: { id: overrides.fromId ?? 4242 },
    message: {
      message_id: 512,
      chat: { id: 4242, type: overrides.chatType ?? 'private' },
      text: 'Reconcile the March invoices\nWaiting for you.'
    },
    data: overrides.data ?? callbackData(approvalId, decision, overrides.nonce ?? 'abcdefgh')
  }
});

const storeCalls = (recorded: Recorded): string[] => recorded.calls.map(([name]) => name);

describe('a tap on an approval card', () => {
  it('is answered at once and refused when the sender is not the paired phone, touching no approval', async () => {
    const { input, recorded } = harness();
    const outcome = await handleUpdate(input, tap('y', { fromId: 9999 }));
    expect(outcome).toBe('rejected');
    // The spinner on the phone is cleared whatever happens next; the query id lasts ten seconds.
    expect(recorded.api[0]?.[0]).toBe('answerCallbackQuery');
    expect(storeCalls(recorded)).toEqual(['recordSecurityEvent']);
    expect(recorded.securityEvents).toEqual([
      {
        userId: 'owner',
        kind: 'destination_inbound_rejected',
        outcome: 'failure',
        metadata: { reason: 'unpaired_sender', destinationId: 'destination-1', fromId: 9999 }
      }
    ]);
  });

  it('is refused from a destination nobody has paired yet, whoever taps', async () => {
    const { input, recorded } = harness({}, destination({ senderId: null }));
    expect(await handleUpdate(input, tap('y'))).toBe('rejected');
    expect(storeCalls(recorded)).toEqual(['recordSecurityEvent']);
  });

  it('is dropped from anything but a private chat', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, tap('y', { chatType: 'group' }))).toBe('rejected');
    expect(storeCalls(recorded)).toEqual(['recordSecurityEvent']);
    expect(recorded.securityEvents[0]?.metadata).toMatchObject({ reason: 'not_private_chat' });
  });

  it('is refused when the nonce is not the one the ledger holds, before the approval is read', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, tap('y', { nonce: 'zzzzzzzz' }))).toBe('rejected');
    expect(storeCalls(recorded)).toEqual(['getDestinationDelivery', 'recordSecurityEvent']);
    expect(recorded.securityEvents[0]?.metadata).toMatchObject({ reason: 'bad_nonce' });
  });

  it('is refused when the approval belongs to somebody else, before anything is resolved', async () => {
    const { input, recorded } = harness({
      getApproval: async () => ({ id: approvalId, userId: 'somebody-else', taskId: 'task-9' })
    });
    expect(await handleUpdate(input, tap('y'))).toBe('rejected');
    expect(storeCalls(recorded)).not.toContain('resolveApproval');
    expect(storeCalls(recorded)).not.toContain('setTaskStatusForUser');
    expect(recorded.securityEvents[0]?.metadata).toMatchObject({ reason: 'foreign_approval' });
  });

  it('settles approval through the shared store without a separate task-state write', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, tap('y'))).toBe('decided');
    const decision = recorded.calls.filter(
      ([name]) => !['getDestinationDelivery', 'markDestinationDeliveryOutcome'].includes(name)
    );
    expect(decision).toEqual([
      ['getApproval', approvalId],
      ['resolveApproval', 'owner', approvalId, 'approved']
    ]);
    // The card: buttons gone, the decision on it, the ledger row closed.
    const edit = recorded.api.find(([method]) => method === 'editMessageText');
    expect(edit?.[1]).toMatchObject({ chat_id: 4242, message_id: 512 });
    expect(String(edit?.[1].text)).toContain('✅ Approved from your phone at 12:31');
    expect(JSON.stringify(edit?.[1].reply_markup)).not.toContain('callback_data');
    expect(recorded.calls.at(-1)).toEqual([
      'markDestinationDeliveryOutcome',
      'destination-1',
      'approval_required',
      approvalId
    ]);
  });

  it('denies the same way', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, tap('n'))).toBe('decided');
    expect(recorded.calls).toContainEqual(['resolveApproval', 'owner', approvalId, 'denied']);
    expect(storeCalls(recorded)).not.toContain('setTaskStatusForUser');
  });

  it('answers a second tap "Already decided" and writes nothing to the task', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, tap('y'))).toBe('decided');
    const before = recorded.calls.length;
    expect(await handleUpdate(input, tap('n'))).toBe('already_decided');
    const second = recorded.calls.slice(before).map(([name]) => name);
    expect(second).not.toContain('setTaskStatusForUser');
    expect(second).toContain('resolveApproval');
    expect(recorded.api).toContainEqual([
      'answerCallbackQuery',
      { callback_query_id: 'query-1', text: 'Already decided', show_alert: true }
    ]);
  });

  it('ignores button data that is not a decision at all', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, tap('y', { data: 'x:not-a-decision' }))).toBe('rejected');
    expect(storeCalls(recorded)).toEqual(['recordSecurityEvent']);
  });

  it('is refused by the row once the owner has minted a new pairing link, whatever the poller last read', async () => {
    // Minting a link in Settings unpairs at the row immediately; the poller's snapshot of the
    // sender is refreshed on a timer. This is the lost-phone case the re-pair exists for, so the
    // sender the row holds now is the one that decides, and the snapshot is brought into line.
    const { input, recorded, state } = harness({
      getDestinationDelivery: async () => ({
        destinationId: 'destination-1',
        kind: 'approval_required',
        resourceId: approvalId,
        externalRef: '512',
        nonce: 'abcdefgh',
        outcomeAt: null,
        taskId: 'task-1',
        approvalStatus: 'pending',
        userId: 'owner',
        senderId: null
      })
    });
    expect(state.senderId).toBe('4242');
    expect(await handleUpdate(input, tap('y'))).toBe('rejected');
    expect(storeCalls(recorded)).not.toContain('resolveApproval');
    expect(storeCalls(recorded)).not.toContain('setTaskStatusForUser');
    expect(recorded.securityEvents[0]?.metadata).toMatchObject({
      reason: 'unpaired_sender',
      fromId: 4242
    });
    expect(state.senderId).toBeNull();
  });

  it('closes a card whose deadline passed before the expiry sweep reached it as expired, not as decided', async () => {
    const { input, recorded } = harness({
      getApproval: async () => ({
        id: approvalId,
        userId: 'owner',
        taskId: 'task-1',
        action: 'shell',
        status: 'pending',
        expiresAt: '2026-07-31T12:30:00.000Z'
      }),
      // The store refuses a decision on a lapsed approval whether or not its row says so yet.
      resolveApproval: async () => false
    });
    expect(await handleUpdate(input, tap('y'))).toBe('already_decided');
    expect(recorded.api).toContainEqual([
      'answerCallbackQuery',
      { callback_query_id: 'query-1', text: 'Expired unanswered', show_alert: true }
    ]);
    const edit = recorded.api.find(([method]) => method === 'editMessageText');
    expect(String(edit?.[1].text)).toContain('Expired unanswered');
    expect(String(edit?.[1].text)).not.toContain('Decided');
    expect(storeCalls(recorded)).not.toContain('setTaskStatusForUser');
    // Closed here: the sweep would only write the same words onto it again.
    expect(recorded.calls.at(-1)).toEqual([
      'markDestinationDeliveryOutcome',
      'destination-1',
      'approval_required',
      approvalId
    ]);
  });
});

describe('refusals from strangers', () => {
  it("are all refused, and written to the owner's record up to a ceiling that refills on the clock", async () => {
    const { input, recorded } = harness({}, destination({ senderId: null }));
    let outcomes: string[] = [];
    for (let stranger = 1; stranger <= 100; stranger += 1) {
      outcomes.push(
        await handleUpdate(input, start('/start a-guess-at-the-pairing-secret', stranger))
      );
      outcomes.push(await handleUpdate(input, tap('y', { fromId: stranger })));
    }
    expect(outcomes).toHaveLength(200);
    expect(new Set(outcomes)).toEqual(new Set(['rejected']));
    expect(recorded.securityEvents).toHaveLength(REJECTION_BURST);
    expect(
      recorded.warned.filter((line) => line.includes('destination_inbound_flood'))
    ).toHaveLength(1);
    // Five minutes on: one more is admitted, and it says how many went unrecorded before it.
    const later = new Date(input.now!().getTime() + REJECTION_REFILL_MS);
    input.now = () => later;
    outcomes = [await handleUpdate(input, tap('y', { fromId: 4242 }))];
    expect(outcomes).toEqual(['rejected']);
    expect(recorded.securityEvents).toHaveLength(REJECTION_BURST + 1);
    expect(recorded.securityEvents.at(-1)?.metadata).toMatchObject({
      reason: 'unpaired_sender',
      unrecordedBefore: 200 - REJECTION_BURST
    });
    expect(await handleUpdate(input, tap('y', { fromId: 4242 }))).toBe('rejected');
    expect(recorded.securityEvents).toHaveLength(REJECTION_BURST + 1);
  });
});

const start = (text: string, fromId = 4242, chatType = 'private'): TelegramUpdate => ({
  update_id: 11,
  message: { message_id: 3, from: { id: fromId }, chat: { id: fromId, type: chatType }, text }
});

describe('the pairing link', () => {
  it('binds the sender who presents the right secret, once', async () => {
    const { input, recorded, state } = harness({}, destination({ senderId: null }));
    expect(await handleUpdate(input, start('/start the-real-pairing-secret', 7777))).toBe('paired');
    expect(recorded.calls).toContainEqual([
      'completeDestinationPairing',
      'destination-1',
      sha256('the-real-pairing-secret'),
      '7777',
      input.masterKey
    ]);
    // The very next tap from that phone is accepted without waiting for anything to be re-read.
    expect(state.senderId).toBe('7777');
    expect(recorded.api).toContainEqual([
      'sendMessage',
      expect.objectContaining({
        chat_id: 7777,
        text: expect.stringContaining('Paired') as string
      })
    ]);
    // Presented again - the link forwarded, or tapped twice - it binds nobody.
    expect(await handleUpdate(input, start('/start the-real-pairing-secret', 8888))).toBe(
      'rejected'
    );
    expect(state.senderId).toBe('7777');
  });

  it('refuses a wrong secret without touching the row', async () => {
    const { input, recorded } = harness({}, destination({ senderId: null }));
    expect(await handleUpdate(input, start('/start a-guess-at-the-pairing-secret', 7777))).toBe(
      'rejected'
    );
    expect(storeCalls(recorded)).not.toContain('completeDestinationPairing');
    expect(recorded.securityEvents[0]?.metadata).toMatchObject({ reason: 'bad_pairing_secret' });
  });

  it('is not honoured from a group', async () => {
    const { input, recorded } = harness({}, destination({ senderId: null }));
    expect(
      await handleUpdate(input, start('/start the-real-pairing-secret', 7777, 'supergroup'))
    ).toBe('rejected');
    expect(storeCalls(recorded)).toEqual(['recordSecurityEvent']);
  });

  it('ignores a bare /start with one journal line', async () => {
    const { input, recorded } = harness({}, destination({ senderId: null }));
    expect(await handleUpdate(input, start('/start', 7777))).toBe('ignored');
    expect(recorded.calls).toEqual([]);
  });
});

describe('a reply to a question', () => {
  const reply = (text: string, replyTo = 900, fromId = 4242): TelegramUpdate => ({
    update_id: 12,
    message: {
      message_id: 4,
      from: { id: fromId },
      chat: { id: fromId, type: 'private' },
      text,
      reply_to_message: { message_id: replyTo }
    }
  });

  it("is posted to the task message route over loopback with the owner's token", async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, reply('Use the savings account'))).toBe('answered');
    expect(recorded.posted).toHaveLength(1);
    const [post] = recorded.posted;
    expect(post!.url).toBe('http://127.0.0.1:4100/v1/tasks/task-1/messages');
    expect(post!.init.method).toBe('POST');
    expect(new Headers(post!.init.headers).get('authorization')).toBe('Bearer oc_live_phone');
    // The update id, so a poll replayed after a crash posts the same words once.
    expect(new Headers(post!.init.headers).get('idempotency-key')).toBe('phone-destination-1-12');
    expect(JSON.parse(post!.init.body as string)).toEqual({ prompt: 'Use the savings account' });
    expect(recorded.api).toContainEqual([
      'sendMessage',
      expect.objectContaining({ text: 'Sent to garden.' })
    ]);
  });

  it('is refused from anyone but the paired sender', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, reply('hello', 900, 9999))).toBe('rejected');
    expect(recorded.posted).toEqual([]);
  });

  it('is refused by the row once the owner has minted a new pairing link', async () => {
    const { input, recorded, state } = harness({
      findDestinationDeliveryByExternalRef: async () => ({
        destinationId: 'destination-1',
        kind: 'agent_message',
        resourceId: 'notice-1',
        externalRef: '900',
        nonce: null,
        taskId: 'task-1',
        userId: 'owner',
        senderId: null
      })
    });
    expect(await handleUpdate(input, reply('Use the savings account'))).toBe('rejected');
    expect(recorded.posted).toEqual([]);
    expect(recorded.securityEvents[0]?.metadata).toMatchObject({ reason: 'unpaired_sender' });
    expect(state.senderId).toBeNull();
  });

  it('is ignored when it does not answer a question this box asked', async () => {
    const { input, recorded } = harness();
    expect(await handleUpdate(input, reply('hello', 123))).toBe('ignored');
    expect(recorded.posted).toEqual([]);
  });

  it('is not posted to a conversation that is no longer waiting', async () => {
    const { input, recorded } = harness({
      getTask: async () => ({ id: 'task-1', status: 'running' })
    });
    expect(await handleUpdate(input, reply('hello'))).toBe('ignored');
    expect(recorded.posted).toEqual([]);
  });

  it('reports a refusal from the route rather than pretending', async () => {
    const { input, recorded } = harness();
    input.fetch = (async () => new Response('{}', { status: 409 })) as typeof fetch;
    expect(await handleUpdate(input, reply('hello'))).toBe('failed');
    expect(recorded.api).toContainEqual([
      'sendMessage',
      expect.objectContaining({ text: expect.stringContaining('409') as string })
    ]);
  });
});

describe('cards decided somewhere else', () => {
  it('lose their buttons and gain the decision, once each', async () => {
    const { input, recorded } = harness({
      listDestinationDeliveriesAwaitingOutcome: async () => [
        {
          destinationId: 'destination-1',
          kind: 'approval_required',
          resourceId: approvalId,
          externalRef: '512',
          nonce: 'abcdefgh',
          outcomeAt: null,
          taskId: 'task-1',
          approvalStatus: 'denied',
          userId: 'owner',
          senderId: '4242'
        }
      ]
    });
    const written = await sweepCardOutcomes({
      store: input.store,
      masterKey: input.masterKey,
      appUrl: input.appUrl,
      clientFor: () => input.client,
      endpoints: new EndpointHealth(),
      now: input.now!
    });
    expect(written).toBe(1);
    expect(recorded.api).toEqual([
      [
        'editMessageReplyMarkup',
        {
          chat_id: '4242',
          message_id: '512',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '❌ Denied in garden at 12:31',
                  url: 'https://ai.example.test/?task=task-1'
                }
              ]
            ]
          }
        }
      ]
    ]);
    expect(recorded.calls).toContainEqual([
      'markDestinationDeliveryOutcome',
      'destination-1',
      'approval_required',
      approvalId
    ]);
  });

  it('leave a row alone when no poller holds its destination, marking nothing', async () => {
    const { input, recorded } = harness({
      listDestinationDeliveriesAwaitingOutcome: async () => [
        {
          destinationId: 'destination-2',
          kind: 'approval_required',
          resourceId: approvalId,
          externalRef: '512',
          nonce: null,
          outcomeAt: null,
          taskId: 'task-1',
          approvalStatus: 'approved',
          userId: 'owner',
          senderId: '4242'
        }
      ]
    });
    expect(
      await sweepCardOutcomes({
        store: input.store,
        masterKey: input.masterKey,
        appUrl: input.appUrl,
        clientFor: () => null,
        endpoints: new EndpointHealth()
      })
    ).toBe(0);
    expect(recorded.api).toEqual([]);
    expect(storeCalls(recorded)).toEqual(['listDestinationDeliveriesAwaitingOutcome']);
  });

  const awaiting = (resourceId: string) => ({
    destinationId: 'destination-1',
    kind: 'approval_required',
    resourceId,
    externalRef: '512',
    nonce: 'abcdefgh',
    outcomeAt: null,
    taskId: 'task-1',
    approvalStatus: 'approved',
    userId: 'owner',
    senderId: '4242'
  });

  it('put a refusing bot API into the same wait a refused send would, and pay one call for it, not one per card per pass', async () => {
    const { input, recorded } = harness({
      listDestinationDeliveriesAwaitingOutcome: async () => [
        awaiting(approvalId),
        awaiting('6f1a9d2e-4c3b-4e8a-9f0d-1b2c3d4e5f61'),
        awaiting('6f1a9d2e-4c3b-4e8a-9f0d-1b2c3d4e5f62')
      ]
    });
    input.client.call = async () => {
      recorded.api.push(['editMessageReplyMarkup', {}]);
      throw new TransportError('editMessageReplyMarkup answered 503', { statusCode: 503 });
    };
    const endpoints = new EndpointHealth();
    const sweep = () =>
      sweepCardOutcomes({
        store: input.store,
        masterKey: input.masterKey,
        appUrl: input.appUrl,
        clientFor: () => input.client,
        endpoints,
        warn: input.warn!,
        now: input.now!
      });
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    // Three cards, three passes, one call: the first refusal started the wait and the rest
    // deferred to it. Nothing is marked that was not written.
    expect(recorded.api).toHaveLength(1);
    expect(storeCalls(recorded)).not.toContain('markDestinationDeliveryOutcome');
    expect(endpoints.waiting('destination-1', input.now!())).toBe(true);
    expect(
      recorded.warned.filter((line) => line.includes('destination_outcome_failed'))
    ).toHaveLength(1);
  });

  it('close a card the far end says cannot be edited, holding nothing against the destination', async () => {
    const { input, recorded } = harness({
      listDestinationDeliveriesAwaitingOutcome: async () => [awaiting(approvalId)]
    });
    input.client.call = async () => {
      throw new TransportError('editMessageReplyMarkup answered 400: message to edit not found', {
        statusCode: 400
      });
    };
    const endpoints = new EndpointHealth();
    expect(
      await sweepCardOutcomes({
        store: input.store,
        masterKey: input.masterKey,
        appUrl: input.appUrl,
        clientFor: () => input.client,
        endpoints,
        warn: input.warn!,
        now: input.now!
      })
    ).toBe(0);
    expect(recorded.calls).toContainEqual([
      'markDestinationDeliveryOutcome',
      'destination-1',
      'approval_required',
      approvalId
    ]);
    expect(endpoints.waiting('destination-1', input.now!())).toBe(false);
    expect(recorded.warned.some((line) => line.includes('destination_outcome_unwritable'))).toBe(
      true
    );
  });
});
