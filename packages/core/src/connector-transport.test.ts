import { EventEmitter } from 'node:events';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secureConnectorRequest } from './connector-transport.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
const input = {
  url: new URL('https://account.example/mail'),
  method: 'GET',
  headers: { authorization: 'Bearer PRIVATE_TOKEN' },
  allowedHostSuffixes: ['account.example'],
  timeoutMs: 100,
  maxResponseBytes: 20
};
const publicAddress = [{ address: '8.8.8.8', family: 4 }];

describe('bounded connector transport', () => {
  let outgoing: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let incoming: EventEmitter & {
    headers: Record<string, string>;
    statusCode: number;
    complete: boolean;
    destroy: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.mocked(lookup).mockResolvedValue(publicAddress as never);
    outgoing = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn()
    });
    incoming = Object.assign(new EventEmitter(), {
      headers: {},
      statusCode: 200,
      complete: false,
      destroy: vi.fn()
    });
    vi.mocked(request).mockImplementation(((
      _url: unknown,
      _options: unknown,
      callback: (response: IncomingMessage) => void
    ) => {
      queueMicrotask(() => callback(incoming as unknown as IncomingMessage));
      return outgoing as unknown as ClientRequest;
    }) as typeof request);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const start = async () => {
    await vi.advanceTimersByTimeAsync(0);
  };

  it('times out unresolved DNS and never sends credentials when the lookup finishes late', async () => {
    let resolve!: (value: typeof publicAddress) => void;
    vi.mocked(lookup).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }) as never
    );
    const result = secureConnectorRequest(input);
    const failure = expect(result).rejects.toMatchObject({ code: 'connector_timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    resolve(publicAddress);
    await start();
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ends a trickling response at the total deadline and destroys both streams', async () => {
    const result = secureConnectorRequest(input);
    const failure = expect(result).rejects.toMatchObject({ code: 'connector_timeout' });
    await start();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(40);
      incoming.emit('data', Buffer.from('x'));
    }
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    expect(outgoing.destroy).toHaveBeenCalledOnce();
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels without reflecting private abort reasons and refuses partial or oversized success', async () => {
    const controller = new AbortController();
    const result = secureConnectorRequest({ ...input, signal: controller.signal });
    const failure = expect(result).rejects.toMatchObject({
      code: 'connector_aborted',
      message: 'Connector request was cancelled'
    });
    await start();
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await failure;
    for (const condition of ['aborted', 'end', 'oversized']) {
      const pending = secureConnectorRequest(input);
      const failed = expect(pending).rejects.toMatchObject({
        code:
          condition === 'oversized'
            ? 'connector_response_too_large'
            : 'connector_response_incomplete'
      });
      await start();
      if (condition === 'oversized') incoming.emit('data', Buffer.alloc(21));
      else incoming.emit(condition);
      await failed;
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pins a public address, returns complete bytes and removes its deadline', async () => {
    const result = secureConnectorRequest(input);
    await start();
    const options = vi.mocked(request).mock.calls[0]![1] as {
      lookup: (
        hostname: string,
        options: { all: boolean },
        callback: (...args: unknown[]) => void
      ) => void;
    };
    const resolved = vi.fn();
    options.lookup('account.example', { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, publicAddress);
    incoming.emit('data', Buffer.from('ok'));
    incoming.complete = true;
    incoming.emit('end');
    await expect(result).resolves.toMatchObject({ status: 200, body: Buffer.from('ok') });
    expect(vi.getTimerCount()).toBe(0);
    expect(outgoing.destroy).not.toHaveBeenCalled();
  });
  it('refuses private DNS and redirects without following them', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(secureConnectorRequest(input)).rejects.toMatchObject({
      code: 'connector_address_not_allowed'
    });
    expect(request).not.toHaveBeenCalled();
    vi.mocked(lookup).mockResolvedValue(publicAddress as never);
    const result = secureConnectorRequest(input);
    const failure = expect(result).rejects.toMatchObject({ code: 'connector_redirect_blocked' });
    await start();
    incoming.statusCode = 302;
    incoming.complete = true;
    incoming.emit('end');
    await failure;
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
