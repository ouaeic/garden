const SHELL_CACHE = 'garden-shell-__GARDEN_SHELL_BUILD__';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await cache.add('/');
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const previous = names
        .filter((name) => name.startsWith('garden-shell-') && name !== SHELL_CACHE)
        .at(-1);
      await Promise.all(
        names
          .filter((name) => name.startsWith('garden') && name !== SHELL_CACHE && name !== previous)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // These paths carry live state, credentials, shared ciphertext or an independent preview.
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/v1/') ||
    url.pathname.startsWith('/__garden/')
  )
    return;
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          return (
            (await (await caches.open(SHELL_CACHE)).match('/')) ||
            new Response('You are offline. Reconnect to open garden.', {
              status: 503,
              headers: { 'content-type': 'text/plain; charset=utf-8' }
            })
          );
        }
      })()
    );
    return;
  }
  if (!url.pathname.startsWith('/assets/') && request.destination !== 'font') return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })()
  );
});

const taskUrl = (value) => {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== '/') return '/';
    const task = url.searchParams.get('task');
    return task && UUID.test(task) ? `/?task=${encodeURIComponent(task)}` : '/';
  } catch {
    return '/';
  }
};

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json();
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') return;
      const approval =
        payload.kind === 'approval_required' &&
        typeof payload.approvalId === 'string' &&
        UUID.test(payload.approvalId);
      const actions =
        approval && Array.isArray(payload.actions)
          ? payload.actions
              .filter((item) => item && ['approve', 'deny'].includes(item.action))
              .map((item) => ({
                action: item.action,
                title: typeof item.title === 'string' ? item.title.slice(0, 80) : item.action
              }))
              .slice(0, 2)
          : [];
      await self.registration.showNotification(
        typeof payload.title === 'string' ? payload.title : 'garden',
        {
          body: typeof payload.body === 'string' ? payload.body : 'Your work has an update.',
          tag: typeof payload.tag === 'string' ? payload.tag : undefined,
          requireInteraction: payload.requireInteraction === true,
          actions,
          data: {
            url: taskUrl(payload.url),
            ...(approval ? { approvalId: payload.approvalId } : {})
          }
        }
      );
    })()
  );
});

const showTask = async (url) => {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.find((client) => {
    const current = new URL(client.url);
    return current.origin === self.location.origin && current.pathname === '/';
  });
  if (existing) {
    existing.postMessage({ type: 'navigate-task', url });
    return existing.focus();
  }
  return self.clients.openWindow(url);
};

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const data = event.notification.data || {};
      const url = taskUrl(data.url);
      if (
        ['approve', 'deny'].includes(event.action) &&
        typeof data.approvalId === 'string' &&
        UUID.test(data.approvalId)
      ) {
        try {
          const response = await fetch(`/v1/approvals/${data.approvalId}/${event.action}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'Idempotency-Key': `push:${data.approvalId}:${event.action}`
            },
            body: '{}'
          });
          if (response.ok) {
            const windows = await self.clients.matchAll({
              type: 'window',
              includeUncontrolled: true
            });
            for (const client of windows)
              client.postMessage({ type: 'approval-resolved', approvalId: data.approvalId });
            return;
          }
        } catch {
          /* The task remains actionable when a background answer cannot be delivered. */
        }
      }
      await showTask(url);
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
