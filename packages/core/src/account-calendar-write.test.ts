import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AccountApi } from './account-api.js';
import { createAccountCalendarEvent } from './account-calendar-write.js';
import type { AccountOperation } from './account-operation.js';
import type { ConnectorTransport } from './connector-transport.js';

const input = {
  summary: 'Analysis review',
  allDay: false as const,
  start: '2026-10-25T01:30:00+02:00',
  end: '2026-10-25T02:30:00+01:00',
  attendees: [{ address: 'colleague@example.org', name: 'Colleague' }]
};
const response = (body: unknown, status = 200) => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
  durationMs: 1
});
function fixture(provider: 'google' | 'microsoft', transport: ConnectorTransport) {
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
  const api = new AccountApi(
    {
      version: 1,
      provider,
      clientId: 'client',
      clientSecret: 'private',
      redirectUrl: 'https://garden.example/callback',
      requestedScopes: ['calendar'],
      tokens: {
        accessToken: 'token',
        refreshToken: 'refresh',
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
    controller,
    state,
    run: () => createAccountCalendarEvent(api, input, operation, ['calendar:events.write'])
  };
}

describe('recoverable account calendar creation', () => {
  it.each(['google', 'microsoft'] as const)(
    'checkpoints before sending and reuses a completed %s receipt',
    async (provider) => {
      const transport = vi.fn<ConnectorTransport>();
      const f = fixture(provider, transport);
      transport.mockImplementation(async (request) => {
        expect(f.state.recovery).toMatchObject({
          operationId: f.operation.id,
          kind: 'calendar_create'
        });
        expect(request.signal).toBe(f.operation.signal);
        expect(request.method).toBe('POST');
        const body = JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>;
        if (provider === 'google') {
          expect(request.url.searchParams.get('sendUpdates')).toBe('all');
          expect(body.start).toEqual({ dateTime: input.start });
          expect((body.attendees as unknown[])[0]).toEqual({
            email: 'colleague@example.org',
            displayName: 'Colleague'
          });
        } else {
          expect(body.transactionId).toBe(f.operation.id);
          expect(body.start).toEqual({ dateTime: '2026-10-24T23:30:00.000', timeZone: 'UTC' });
          expect(body.end).toEqual({ dateTime: '2026-10-25T01:30:00.000', timeZone: 'UTC' });
        }
        return response({ ...body, id: body.id ?? 'event-1', providerNoise: 'not needed' }, 201);
      });
      const result = await f.run();
      expect(result).toMatchObject({ status: 'created', recovered: false });
      expect(JSON.stringify(result)).not.toContain('providerNoise');
      await expect(f.run()).resolves.toEqual(result);
      expect(transport).toHaveBeenCalledOnce();
    }
  );

  it.each(['google', 'microsoft'] as const)(
    'recovers a %s event after a lost creation reply without another mutation',
    async (provider) => {
      let saved: Record<string, unknown>;
      const transport = vi.fn<ConnectorTransport>(async (request) => {
        if (request.method === 'POST') {
          saved = JSON.parse(Buffer.from(request.body!).toString()) as Record<string, unknown>;
          saved!.id ??= 'event-2';
          throw new Error('connection closed after remote commit');
        }
        expect(request.method).toBe('GET');
        if (provider === 'microsoft') {
          expect(request.url.searchParams.get('$filter')).toContain(f.operation.id);
          expect(request.url.searchParams.get('$top')).toBe('2');
          return response({ value: [saved] });
        }
        expect(request.url.pathname).toContain(String(saved!.id));
        return response(saved);
      });
      const f = fixture(provider, transport);
      await expect(f.run()).rejects.toThrow('after remote commit');
      await expect(f.run()).resolves.toMatchObject({ status: 'created', recovered: true });
      expect(transport.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET']);
    }
  );

  it.each(['google', 'microsoft'] as const)(
    'leaves eventual absence uncertain for %s instead of resending or claiming success',
    async (provider) => {
      const transport = vi
        .fn<ConnectorTransport>()
        .mockRejectedValueOnce(new Error('lost reply'))
        .mockResolvedValue(provider === 'google' ? response({}, 404) : response({ value: [] }));
      const f = fixture(provider, transport);
      await expect(f.run()).rejects.toThrow('lost reply');
      await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
      await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
      expect(f.operation.complete).not.toHaveBeenCalled();
      expect(transport.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET', 'GET']);
    }
  );

  it('does not equate a mismatched or cancelled resource with a completed operation', async () => {
    const transport = vi.fn<ConnectorTransport>().mockRejectedValueOnce(new Error('lost reply'));
    const f = fixture('google', transport);
    await expect(f.run()).rejects.toThrow('lost reply');
    transport.mockResolvedValue(
      response({ id: 'wrong', extendedProperties: { private: { gardenOperation: 'other' } } })
    );
    await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
    transport.mockResolvedValue(
      response({
        id: 'garden' + f.operation.id.replaceAll('-', ''),
        status: 'cancelled',
        extendedProperties: { private: { gardenOperation: f.operation.id } }
      })
    );
    await expect(f.run()).resolves.toMatchObject({ status: 'uncertain' });
    expect(f.operation.complete).not.toHaveBeenCalled();
  });

  it('preserves all-day exclusive dates and zone; refuses malformed dates and missing grants before checkpointing', async () => {
    const transport = vi
      .fn<ConnectorTransport>()
      .mockResolvedValue(response({ id: 'all-day' }, 201));
    const f = fixture('microsoft', transport);
    const day = {
      ...input,
      allDay: true as const,
      start: '2026-10-25',
      end: '2026-10-26',
      timeZone: 'Europe/Berlin'
    };
    await expect(createAccountCalendarEvent(f.api, day, f.operation, [])).rejects.toMatchObject({
      code: 'connector_scope_denied'
    });
    await expect(
      createAccountCalendarEvent(f.api, { ...day, end: '2026-02-30' }, f.operation, [
        'calendar:events.write'
      ])
    ).rejects.toThrow();
    expect(f.operation.checkpoint).not.toHaveBeenCalled();
    await createAccountCalendarEvent(f.api, day, f.operation, ['calendar:events.write']);
    const body = JSON.parse(Buffer.from(transport.mock.calls[0]![0].body!).toString()) as Record<
      string,
      unknown
    >;
    expect(body.start).toEqual({ dateTime: '2026-10-25T00:00:00', timeZone: 'Europe/Berlin' });
    expect(body.end).toEqual({ dateTime: '2026-10-26T00:00:00', timeZone: 'Europe/Berlin' });
    expect(body.isAllDay).toBe(true);
  });

  it('sends nothing when checkpoint persistence fails or the session is cancelled', async () => {
    const transport = vi.fn<ConnectorTransport>();
    const f = fixture('google', transport);
    vi.mocked(f.operation.checkpoint).mockRejectedValue(new Error('database unavailable'));
    await expect(f.run()).rejects.toThrow('database unavailable');
    expect(transport).not.toHaveBeenCalled();
    vi.mocked(f.operation.checkpoint).mockImplementation(async () => {
      f.controller.abort(new Error('session lost'));
    });
    await expect(f.run()).rejects.toThrow('session lost');
    expect(transport).not.toHaveBeenCalled();
  });

  it('retries a definitive rate-limit rejection with the same identity but never treats a server error as proof of failure', async () => {
    const transport = vi.fn<ConnectorTransport>().mockResolvedValueOnce(response({}, 429));
    const f = fixture('microsoft', transport);
    await expect(f.run()).rejects.toMatchObject({ code: 'connector_rate_limited' });
    expect(f.state.recovery).toMatchObject({ phase: 'ready' });
    transport.mockResolvedValueOnce(response({ id: 'accepted-event' }, 201));
    await expect(f.run()).resolves.toMatchObject({ status: 'created' });
    const bodies = transport.mock.calls.map(
      ([call]) => JSON.parse(Buffer.from(call.body!).toString()) as Record<string, unknown>
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.transactionId).toBe(bodies[1]?.transactionId);
    const failed = fixture(
      'microsoft',
      vi.fn<ConnectorTransport>().mockResolvedValue(response({}, 503))
    );
    await expect(failed.run()).rejects.toMatchObject({ code: 'connector_request_failed' });
    expect(failed.state.recovery).toMatchObject({ phase: 'submitted' });
  });
});
