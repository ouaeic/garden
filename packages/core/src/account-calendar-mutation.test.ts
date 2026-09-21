import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AccountApi } from './account-api.js';
import { executeConnectorAction } from './connectors.js';
import {
  mutateAccountCalendarEvent,
  readAccountCalendarEvent
} from './account-calendar-mutation.js';
import type { AccountOperation } from './account-operation.js';
import type { ConnectorTransport } from './connector-transport.js';
import type { ConnectorScope } from '@athanor/contracts';

const response = (body: unknown, status = 200) => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
  durationMs: 1
});
const intent = {
  action: 'update' as const,
  eventId: 'event-1',
  expectedVersion: '"v1"',
  target: 'single' as const,
  changes: { summary: 'Updated review' }
};
const scopes: ConnectorScope[] = [
  'calendar:calendars.read',
  'calendar:events.edit',
  'calendar:events.delete'
];
function fixture(provider: 'google' | 'microsoft' = 'google') {
  const controller = new AbortController();
  const state: { recovery: unknown; result: unknown; completed: boolean } = {
    recovery: null,
    result: null,
    completed: false
  };
  const operation: AccountOperation = {
    id: randomUUID(),
    get recovery() {
      return state.recovery;
    },
    get result() {
      return state.result;
    },
    get completed() {
      return state.completed;
    },
    signal: controller.signal,
    checkpoint: vi.fn(async (value) => {
      state.recovery = structuredClone(value);
    }),
    complete: vi.fn(async (value) => {
      state.result = structuredClone(value);
      state.completed = true;
    })
  };
  let event: Record<string, unknown> = {
    id: intent.eventId,
    etag: '"v1"',
    summary: 'Review',
    description: 'Keep these notes',
    start: { dateTime: '2026-10-20T09:00:00Z' },
    end: { dateTime: '2026-10-20T10:00:00Z' },
    conferenceData: { conferenceId: 'keep-me' },
    attendees: [{ email: 'colleague@example.org', responseStatus: 'accepted' }],
    extendedProperties: { private: { otherApplication: 'keep' } }
  };
  const transport = vi.fn<ConnectorTransport>(async (request) => {
    if (request.method === 'GET') return response(event);
    expect(state.recovery).toMatchObject({ phase: 'submitted', operationId: operation.id });
    expect(request.headers['if-match']).toBe('"v1"');
    expect(request.url.searchParams.get('sendUpdates')).toBe('all');
    if (request.method === 'DELETE') {
      event = { id: intent.eventId, status: 'cancelled' };
      return response(null, 204);
    }
    expect(request.method).toBe('PATCH');
    const body = JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>;
    event = { ...event, ...body, etag: '"v2"' };
    return response(event);
  });
  const api = new AccountApi(
    {
      version: 1,
      provider,
      clientId: 'client',
      clientSecret: 'secret',
      redirectUrl: 'https://garden.example/callback',
      requestedScopes: ['calendar'],
      tokens: {
        accessToken: 'access-canary',
        refreshToken: 'refresh-canary',
        expiresAt: Date.now() + 3600000,
        scopes: ['calendar']
      },
      account: { id: 'owner', address: 'owner@example.org' }
    },
    transport,
    controller.signal
  );
  return {
    api,
    operation,
    state,
    controller,
    transport,
    getEvent: () => event,
    setEvent: (value: Record<string, unknown>) => {
      event = value;
    },
    run: () => mutateAccountCalendarEvent(api, intent, operation, scopes)
  };
}

it('conditionally updates only requested fields and retains meeting data, attendee responses and other private properties', async () => {
  const f = fixture();
  expect(await readAccountCalendarEvent(f.api, { eventId: intent.eventId })).toMatchObject({
    target: 'single',
    version: '"v1"'
  });
  const result = await f.run();
  expect(result).toMatchObject({ status: 'updated', recovered: false, version: '"v2"' });
  expect(f.getEvent()).toMatchObject({
    description: 'Keep these notes',
    conferenceData: { conferenceId: 'keep-me' },
    attendees: [{ responseStatus: 'accepted' }],
    extendedProperties: { private: { otherApplication: 'keep', gardenMutation: f.operation.id } }
  });
  await expect(f.run()).resolves.toEqual(result);
  expect(f.transport.mock.calls.map(([request]) => request.method)).toEqual([
    'GET',
    'GET',
    'PATCH'
  ]);
  expect(JSON.stringify(f.state)).not.toContain('access-canary');
});
it('refuses stale versions, wrong recurrence targets and missing grants before any mutation', async () => {
  const f = fixture();
  await expect(
    mutateAccountCalendarEvent(f.api, intent, f.operation, ['calendar:events.write'])
  ).rejects.toThrow('has not granted');
  expect(f.transport).not.toHaveBeenCalled();
  f.setEvent({ ...f.getEvent(), etag: '"v2"' });
  await expect(f.run()).rejects.toThrow('event changed');
  f.setEvent({ ...f.getEvent(), etag: '"v1"', recurringEventId: 'series-1' });
  await expect(f.run()).rejects.toThrow('explicitly');
  expect(f.transport.mock.calls.map(([request]) => request.method)).toEqual(['GET', 'GET']);
  await expect(
    mutateAccountCalendarEvent(f.api, { ...intent, target: 'occurrence' }, f.operation, scopes)
  ).resolves.toMatchObject({ status: 'updated' });
});
it('dispatches a conditional edit through the connected-service boundary only with a durable operation', async () => {
  const f = fixture();
  const input = {
    kind: 'google' as const,
    baseUrl: 'https://gmail.googleapis.com',
    scopes,
    secret: { accountOAuth: f.api.secret },
    allowedHostSuffixes: ['googleapis.com'],
    action: { ...intent, action: 'account_calendar_update' },
    transport: f.transport
  };
  await expect(executeConnectorAction(input)).rejects.toThrow('durable operation');
  expect(f.transport).not.toHaveBeenCalled();
  await expect(executeConnectorAction({ ...input, operation: f.operation })).resolves.toMatchObject(
    {
      action: 'account_calendar_update',
      result: { status: 'updated', version: '"v2"' }
    }
  );
  expect(f.transport.mock.calls.map(([request]) => request.method)).toEqual(['GET', 'PATCH']);
});
it('preserves the series time zone and clears the alternate date representation when changing event time', async () => {
  const f = fixture();
  f.setEvent({
    ...f.getEvent(),
    recurrence: ['RRULE:FREQ=WEEKLY'],
    start: { dateTime: '2026-10-20T10:00:00+01:00', timeZone: 'Europe/London' },
    end: { dateTime: '2026-10-20T11:00:00+01:00', timeZone: 'Europe/London' }
  });
  await expect(
    mutateAccountCalendarEvent(
      f.api,
      {
        ...intent,
        target: 'series',
        changes: {
          time: { start: '2026-10-20', end: '2026-10-22', allDay: true }
        }
      },
      f.operation,
      scopes
    )
  ).resolves.toMatchObject({ status: 'updated' });
  expect(f.getEvent().start).toEqual({
    date: '2026-10-20',
    dateTime: null,
    timeZone: 'Europe/London'
  });
  expect(f.getEvent().end).toEqual({
    date: '2026-10-22',
    dateTime: null,
    timeZone: 'Europe/London'
  });
});
it('keeps a provider-rejected concurrent edit and requires a newly observed version', async () => {
  const f = fixture();
  f.transport.mockImplementation(async (request) => {
    if (request.method === 'GET') return response(f.getEvent());
    expect(request.headers['if-match']).toBe('"v1"');
    f.setEvent({ ...f.getEvent(), etag: '"v2"', summary: 'Someone else edited' });
    return response({}, 412);
  });
  await expect(f.run()).rejects.toThrow('412');
  expect(f.state.recovery).toMatchObject({ phase: 'ready' });
  await expect(f.run()).rejects.toThrow('event changed');
  expect(f.transport.mock.calls.map(([request]) => request.method)).toEqual([
    'GET',
    'PATCH',
    'GET'
  ]);
  expect(f.getEvent().summary).toBe('Someone else edited');
});
it.each([false, true])(
  'reconciles a lost update reply and checks the values as well as its operation marker (later edit: %s)',
  async (changed) => {
    const f = fixture();
    const native = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (request) => {
      const result = await native(request);
      if (request.method === 'PATCH') {
        if (changed) f.setEvent({ ...f.getEvent(), summary: 'Later edit' });
        throw Error('lost reply');
      }
      return result;
    });
    await expect(f.run()).rejects.toThrow('lost reply');
    await expect(f.run()).resolves.toMatchObject({ status: changed ? 'uncertain' : 'updated' });
    expect(f.transport.mock.calls.map(([request]) => request.method)).toEqual([
      'GET',
      'PATCH',
      'GET'
    ]);
    expect(f.state.completed).toBe(!changed);
  }
);
it('reports absence after an uncertain deletion without attributing its cause or repeating the delete', async () => {
  const f = fixture();
  let removed = false;
  f.transport.mockImplementation(async (request) => {
    if (request.method === 'GET') return removed ? response({}, 404) : response(f.getEvent());
    expect(request.method).toBe('DELETE');
    expect(request.headers['if-match']).toBe('"v1"');
    removed = true;
    throw Error('lost delete reply');
  });
  const input = {
    action: 'delete' as const,
    eventId: intent.eventId,
    expectedVersion: intent.expectedVersion,
    target: intent.target
  };
  await expect(mutateAccountCalendarEvent(f.api, input, f.operation, scopes)).rejects.toThrow(
    'lost delete reply'
  );
  const result = await mutateAccountCalendarEvent(f.api, input, f.operation, scopes);
  expect(result).toMatchObject({ status: 'absent', recovered: true });
  expect(result.message).toContain('does not establish who');
  expect(f.transport.mock.calls.map(([request]) => request.method)).toEqual([
    'GET',
    'DELETE',
    'GET'
  ]);
});
it('refuses scope expansion by path normalization, unsupported conditional providers and cancelled work', async () => {
  const f = fixture();
  for (const id of ['.', '..']) {
    await expect(
      mutateAccountCalendarEvent(f.api, { ...intent, eventId: id }, f.operation, scopes)
    ).rejects.toThrow();
    await expect(
      mutateAccountCalendarEvent(f.api, { ...intent, calendarId: id }, f.operation, scopes)
    ).rejects.toThrow();
  }
  const microsoft = fixture('microsoft');
  await expect(microsoft.run()).rejects.toThrow('unavailable for this provider');
  expect(microsoft.transport).not.toHaveBeenCalled();
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(f.transport).not.toHaveBeenCalled();
});
