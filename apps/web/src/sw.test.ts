import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const taskId = 'd032e2d2-bebd-43d6-94bd-c7014c9df39d';
const approvalId = 'f46d9f18-01af-47c6-adfd-55b283d9c1d6';

async function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ resolved: true }));
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const cache = {
    add: vi.fn().mockResolvedValue(undefined),
    put: vi.fn().mockResolvedValue(undefined),
    match: vi.fn().mockResolvedValue(undefined)
  };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    match: vi.fn().mockResolvedValue(undefined)
  };
  const surface = {
    location: { origin: 'https://garden.example' },
    addEventListener: (name: string, callback: (event: unknown) => void) =>
      handlers.set(name, callback),
    registration: { showNotification },
    clients: { matchAll, openWindow, claim: vi.fn().mockResolvedValue(undefined) },
    skipWaiting
  };
  const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  expect(source.length).toBeGreaterThan(0);
  runInNewContext(source, { self: surface, URL, Response, fetch: fetcher, caches });
  const send = async (kind: string, fields: Record<string, unknown>) => {
    let pending: Promise<unknown> | undefined;
    const handler = handlers.get(kind);
    expect(handler).toBeDefined();
    handler!({
      ...fields,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      }
    });
    await pending;
  };
  return {
    handlers,
    fetcher,
    showNotification,
    openWindow,
    matchAll,
    send,
    skipWaiting,
    caches,
    cache
  };
}

describe('service worker boundaries', () => {
  it('stages a new shell until the owner requests a refresh', async () => {
    const { send, skipWaiting, cache } = await worker();
    await send('install', {});
    expect(cache.add).toHaveBeenCalledWith('/');
    expect(skipWaiting).not.toHaveBeenCalled();
    await send('message', { data: { type: 'SKIP_WAITING' } });
    expect(skipWaiting).toHaveBeenCalledOnce();
  });
  it('retains the previous shell assets for another tab still using that build', async () => {
    const { send, caches, handlers, fetcher } = await worker();
    caches.keys.mockResolvedValue([
      'garden-shell-ancient',
      'garden-shell-previous',
      'garden-shell-__GARDEN_SHELL_BUILD__'
    ]);
    await send('activate', {});
    expect(caches.delete).toHaveBeenCalledWith('garden-shell-ancient');
    expect(caches.delete).not.toHaveBeenCalledWith('garden-shell-previous');
    const cached = new Response('previous-build-bytes');
    caches.match.mockResolvedValue(cached);
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: { method: 'GET', url: 'https://garden.example/assets/previous.js', mode: 'cors' },
      respondWith: (value: Promise<Response>) => {
        response = value;
      }
    });
    expect(await response).toBe(cached);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('routes a notification within an existing app without reloading its terminal', async () => {
    const { matchAll, send, openWindow } = await worker();
    const existing = {
      url: 'https://garden.example/?view=computer',
      postMessage: vi.fn(),
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn()
    };
    matchAll.mockResolvedValue([existing]);
    await send('notificationclick', {
      action: '',
      notification: { close: vi.fn(), data: { url: `/?task=${taskId}` } }
    });
    expect(existing.postMessage).toHaveBeenCalledWith({
      type: 'navigate-task',
      url: `/?task=${taskId}`
    });
    expect(existing.focus).toHaveBeenCalledOnce();
    expect(existing.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
  it('cold-starts the task when only a standalone share or another origin is open', async () => {
    const { matchAll, send, openWindow } = await worker();
    const postMessage = vi.fn();
    matchAll.mockResolvedValue([
      { url: 'https://garden.example/v1/shares/example', postMessage },
      { url: 'https://elsewhere.example/', postMessage }
    ]);
    await send('notificationclick', {
      action: '',
      notification: { close: vi.fn(), data: { url: `/?task=${taskId}` } }
    });
    expect(openWindow).toHaveBeenCalledWith(`/?task=${taskId}`);
    expect(postMessage).not.toHaveBeenCalled();
  });
  it('leaves API, public shares, previews and native credentials entirely to the network', async () => {
    const { handlers, fetcher } = await worker();
    const paths = [
      '/v1/tasks',
      '/v1/shares/assets/share.js',
      '/__garden/preview/example',
      '/__garden/client/bootstrap'
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      const respondWith = vi.fn();
      handlers.get('fetch')!({
        request: { method: 'GET', url: `https://garden.example${path}`, mode: 'navigate' },
        respondWith
      });
      expect(respondWith, path).not.toHaveBeenCalled();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves actionable approval payload fields while refusing off-origin notification links', async () => {
    const { send, showNotification } = await worker();
    await send('push', {
      data: {
        json: () => ({
          kind: 'approval_required',
          title: 'Research',
          body: 'Review the proposed action',
          tag: 'approval-1',
          approvalId,
          actions: [
            { action: 'approve', title: 'Approve' },
            { action: 'deny', title: 'Deny' }
          ],
          requireInteraction: true,
          url: 'https://elsewhere.example/'
        })
      }
    });
    expect(showNotification).toHaveBeenCalledWith(
      'Research',
      expect.objectContaining({
        tag: 'approval-1',
        requireInteraction: true,
        actions: [
          { action: 'approve', title: 'Approve' },
          { action: 'deny', title: 'Deny' }
        ],
        data: { url: '/', approvalId }
      })
    );
  });

  it('answers a lock-screen approval through the same idempotent owner route', async () => {
    const { send, fetcher, openWindow } = await worker();
    await send('notificationclick', {
      action: 'approve',
      notification: { close: vi.fn(), data: { approvalId, url: `/?task=${taskId}` } }
    });
    expect(fetcher.mock.calls[0]![0]).toBe(`/v1/approvals/${approvalId}/approve`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: '{}',
      headers: { 'Idempotency-Key': `push:${approvalId}:approve` }
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens the original task when the background decision needs sign-in', async () => {
    const { send, fetcher, openWindow } = await worker();
    fetcher.mockResolvedValue(Response.json({}, { status: 401 }));
    await send('notificationclick', {
      action: 'deny',
      notification: { close: vi.fn(), data: { approvalId, url: `/?task=${taskId}` } }
    });
    expect(openWindow).toHaveBeenCalledWith(`/?task=${taskId}`);
  });
});
