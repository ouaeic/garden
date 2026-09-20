import { randomBytes, randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import { AthanorError, sha256 } from '@athanor/core';
import { createDatabase, DataStore, migrateDatabase, type Database } from '@athanor/data';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import type { ApiConfig } from '../config.js';
import { silentLogger } from '../log.js';
import { registerAuthHooks } from './auth-hook.js';
import { registerErrorHandler } from './errors.js';
import type { ServerBase } from './server-context.js';

/**
 * The hooks on their own, with routes written to defeat the layer underneath them.
 *
 * Wave 6 measured that the workspace pre-handler could be deleted and every test in the repository
 * would stay green: `server.test.ts` drives real routes, and every workspace-scoped route in
 * `routes/` re-resolves the workspace through `store.getWorkspace(user.id, ...)` and refuses on its
 * own. So both boundary tests there pass with the hook defeated - they are pinning the handlers,
 * not the hook, and no route that exists today can tell the two layers apart.
 *
 * This file builds the route that can. `/v1/workspaces/:workspaceId/unscoped-probe` reads the
 * workspace by primary key with no owner in the query, which is exactly the mistake the hook is
 * defence in depth against - the GET added later that ships with no check of its own. With that
 * route registered, the pre-handler is the only thing between a signed-in stranger and someone
 * else's workspace, and defeating it turns this file red and nothing else.
 *
 * `ServerBase` is the whole `createApiContext` surface; the hooks read six fields of it and the
 * error handler three. Building those by hand rather than a real server is the point - a test that
 * needs `buildServer` can only reach the hook through routes that already guard themselves.
 */

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

interface Harness {
  app: FastifyInstance;
  store: DataStore;
  /** `${ip}:${path}` for every request the throttle table claimed. */
  throttled: string[];
  /** The address of every request the share viewer's own per-address bucket counted. */
  shareThrottled: string[];
  /** How many times a handler ran despite the hooks; the pre-handler's whole job is to keep it 0. */
  handlerRuns: () => number;
  cookieFor: (userId: string) => Promise<string>;
}

const buildHarness = async (): Promise<Harness> => {
  const database: Database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  await migrateDatabase(database);
  const store = new DataStore(database);
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);
  const throttled: string[] = [];
  const shareThrottled: string[] = [];
  let handlerRuns = 0;

  const context = {
    app,
    store,
    log: silentLogger,
    secure: false,
    requestStarted: new WeakMap<object, number>(),
    checkAuthRate: (key: string) => {
      throttled.push(key);
    },
    checkShareRate: (key: string) => {
      shareThrottled.push(key);
    },
    config: { PUBLIC_APP_URL: 'https://athanor.test' } as ApiConfig
  } as unknown as ServerBase;

  registerErrorHandler(context);
  registerAuthHooks(context);

  /*
   * Registered after the hooks, which is the only order Fastify honours: a route added above
   * `registerAuthHooks` is snapshotted with no hooks at all.
   *
   * The handler deliberately does not re-scope. It reads the row by id, the way a route that
   * forgot would, so the only authorization in the request is the pre-handler's.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/unscoped-probe',
    async (request) => {
      handlerRuns += 1;
      const result = await database.query('SELECT name FROM workspaces WHERE id=$1', [
        request.params.workspaceId
      ]);
      return { name: result.rows[0]?.name ?? null };
    }
  );
  /** The second layer, for contrast: this one refuses on its own and never needs the hook. */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/scoped-probe',
    async (request) => {
      handlerRuns += 1;
      const workspace = await store.getWorkspace(request.user!.id, request.params.workspaceId);
      // The exact two lines every workspace-scoped route in `routes/` opens with.
      if (!workspace) throw new AthanorError('workspace_not_found', 'Workspace not found');
      return { name: workspace.name };
    }
  );
  for (const path of [
    '/v1/auth/register/options',
    '/v1/auth/register/verify',
    '/v1/auth/login/options',
    '/v1/auth/login/verify',
    '/v1/auth/step-up/options',
    '/v1/auth/step-up/verify',
    '/v1/auth/recover/options',
    '/v1/auth/recover/verify',
    '/v1/auth/enroll/options',
    '/v1/auth/enroll/verify'
  ]) {
    app.post(path, async () => ({ ok: true }));
  }
  app.get('/healthz', async () => ({ ok: true }));
  /*
   * The share viewer's four public routes, as probes: each records whether it ran and what
   * `request.user` held when it did. The hook is the only thing between these and a session, so a
   * route here that sees a user is the hook reading a cookie it must not read.
   */
  for (const path of [
    '/v1/shares/:token',
    '/v1/shares/:token/blob',
    '/v1/shares/:token/artifacts/:n',
    '/v1/shares/assets/:file'
  ]) {
    app.get(path, async (request) => {
      handlerRuns += 1;
      return { user: request.user?.id ?? null };
    });
  }
  /** A route that fails the way a handler built from an upstream answer might: with a link in it. */
  app.get('/v1/probe/leaky-error', async () => {
    throw new AthanorError(
      'upstream_refused',
      'could not fetch https://box.example/v1/shares/AbCdEfGhIjKlMnOpQrStUv#1.' + 'k'.repeat(43),
      502
    );
  });

  app.post('/v1/previews/:previewId/rotate-access', async () => {
    handlerRuns++;
    return { rotated: true };
  });
  app.get('/v1/workspaces/:workspaceId/download', async () => {
    handlerRuns++;
    return 'source';
  });
  app.get('/v1/tasks/:taskId/bundle', async () => {
    handlerRuns++;
    return 'zip';
  });
  for (const route of [
    '/v1/tasks/:taskId/directories',
    '/v1/workspaces/:workspaceId/directory',
    '/v1/workspaces/:workspaceId/directory.zip'
  ]) {
    app.get(route, async () => {
      handlerRuns++;
      return 'directory';
    });
  }
  app.get('/v1/workspaces/:workspaceId/processes/history', async () => {
    handlerRuns++;
    return { privateInspection: true };
  });
  for (const kind of ['computation', 'debugger']) {
    app.get(`/v1/workspaces/:workspaceId/${kind}`, async () => {
      handlerRuns++;
      return { privateInspection: true };
    });
    app.post(`/v1/workspaces/:workspaceId/${kind}/:session/control`, async () => {
      handlerRuns++;
      return { stopped: true };
    });
  }
  await app.ready();
  disposers.push(async () => {
    await app.close();
    await database.close();
  });

  return {
    app,
    store,
    throttled,
    shareThrottled,
    handlerRuns: () => handlerRuns,
    cookieFor: async (userId: string) => {
      const token = randomBytes(32).toString('base64url');
      await store.createSession(
        userId,
        sha256(token),
        new Date(Date.now() + 60_000),
        undefined,
        'Test',
        true
      );
      return `athanor_session=${token}`;
    }
  };
};

const seedOwnerWorkspace = async (
  store: DataStore,
  username: string
): Promise<{ userId: string; workspaceId: string }> => {
  const user = await store.createUser({ username, displayName: username });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: `${username}'s computer`,
    storageLimitBytes: 10 * 1024 ** 3,
    imageRevision: 'dev',
    region: 'auto',
    wrappedKey: 'wrapped'
  });
  return { userId: user.id, workspaceId: workspace.id };
};

describe('workspace pre-handler', () => {
  test('requires explicit preview write and file-read scopes for resets and result downloads', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'scope-owner');
    const tokens = new Map<string, string>();
    for (const scope of [
      'tasks:read',
      'workspaces:read',
      'workspaces:write',
      'files:read'
    ] as const) {
      const token = `oc_live_${randomBytes(32).toString('base64url')}`;
      await harness.store.createApiToken({
        userId: owner.userId,
        label: scope,
        tokenHash: sha256(token),
        prefix: token.slice(0, 12),
        scopes: [scope],
        expiresAt: new Date(Date.now() + 60_000)
      });
      tokens.set(scope, `Bearer ${token}`);
    }
    const reset = `/v1/previews/${randomUUID()}/rotate-access`;
    for (const scope of ['tasks:read', 'workspaces:read', 'files:read']) {
      const denied = await harness.app.inject({
        method: 'POST',
        url: reset,
        headers: { authorization: tokens.get(scope)! }
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(harness.handlerRuns()).toBe(0);
    expect(
      (
        await harness.app.inject({
          method: 'POST',
          url: reset,
          headers: { authorization: tokens.get('workspaces:write')! }
        })
      ).statusCode
    ).toBe(200);
    for (const url of [
      `/v1/workspaces/${owner.workspaceId}/download`,
      `/v1/tasks/${randomUUID()}/bundle`,
      `/v1/tasks/${randomUUID()}/directories`,
      `/v1/workspaces/${owner.workspaceId}/directory`,
      `/v1/workspaces/${owner.workspaceId}/directory.zip`,
      `/v1/workspaces/${owner.workspaceId}/computation`,
      `/v1/workspaces/${owner.workspaceId}/processes/history?kind=processes`,
      `/v1/workspaces/${owner.workspaceId}/processes/history?kind=computation`,
      `/v1/workspaces/${owner.workspaceId}/debugger`
    ]) {
      expect(
        (
          await harness.app.inject({
            method: 'GET',
            url,
            headers: { authorization: tokens.get('tasks:read')! }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await harness.app.inject({
            method: 'GET',
            url,
            headers: { authorization: tokens.get('workspaces:read')! }
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await harness.app.inject({
            method: 'GET',
            url,
            headers: { authorization: tokens.get('files:read')! }
          })
        ).statusCode
      ).toBe(200);
    }
  });
  test('reserves live computation and debugger controls for signed-in devices', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'inspection-owner');
    const token = `oc_live_${randomBytes(32).toString('base64url')}`;
    await harness.store.createApiToken({
      userId: owner.userId,
      label: 'automation',
      tokenHash: sha256(token),
      prefix: token.slice(0, 12),
      scopes: ['workspaces:write', 'files:write', 'files:read'],
      expiresAt: new Date(Date.now() + 60_000)
    });
    for (const kind of ['computation', 'debugger']) {
      const url = `/v1/workspaces/${owner.workspaceId}/${kind}/session/control`;
      const denied = await harness.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'stop' }
      });
      expect(denied.statusCode).toBe(403);
    }
    expect(harness.handlerRuns()).toBe(0);
    const cookie = await harness.cookieFor(owner.userId);
    for (const kind of ['computation', 'debugger']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/${kind}/session/control`,
        headers: { cookie, origin: 'https://athanor.test' },
        payload: { action: 'stop' }
      });
      expect(response.statusCode).toBe(200);
    }
    expect(harness.handlerRuns()).toBe(2);
  });
  /**
   * The net Wave 6 said did not exist. Delete the `workspaceBelongsToUser` check in
   * `registerAuthHooks` and this is the assertion that goes red - the handler below has no opinion
   * about who is asking, so a 200 here is a stranger reading someone else's workspace name.
   */
  test('refuses a foreign workspace on a route that does not re-scope', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'owner');
    const stranger = await seedOwnerWorkspace(harness.store, 'stranger');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/unscoped-probe`,
      headers: { cookie: await harness.cookieFor(stranger.userId) }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('workspace_not_found');
    // Not merely "the body was empty": the handler must never have run at all.
    expect(harness.handlerRuns()).toBe(0);
  });

  /** The same route, asked by the owner, so the test above is refusing a caller and not a route. */
  test('serves the owner their own workspace through the same unscoped route', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'owner');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/unscoped-probe`,
      headers: { cookie: await harness.cookieFor(owner.userId) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ name: string }>().name).toBe("owner's computer");
    expect(harness.handlerRuns()).toBe(1);
  });

  /**
   * Why the boundary tests in `server.test.ts` cannot pin the hook: this route answers correctly
   * with the hook working *or* defeated, and every workspace-scoped route in `routes/` is this
   * shape. Kept as the control, so the contrast is written down rather than remembered.
   */
  test('a self-scoping route refuses a stranger without the hook mattering', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'owner');
    const stranger = await seedOwnerWorkspace(harness.store, 'stranger');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/scoped-probe`,
      headers: { cookie: await harness.cookieFor(stranger.userId) }
    });

    expect(response.statusCode).toBe(404);
  });

  /** The request hook runs first, so no session means no workspace question is ever asked. */
  test('refuses an unauthenticated caller before the workspace check is reached', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'owner');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/unscoped-probe`
    });

    expect(response.statusCode).toBe(401);
    expect(harness.handlerRuns()).toBe(0);
  });
});

describe('passkey ceremony throttle', () => {
  /**
   * `authRateLimitedPaths` says in its own comment that it covers passkey ceremonies, and the two
   * registration routes were not on it - unauthenticated by construction, like enroll, and gated on
   * a pairing code presented by a caller with no session. The 128-bit code is not the risk; an
   * unthrottled unauthenticated endpoint on a box with a public address is.
   */
  test('throttles every unauthenticated passkey ceremony, registration included', async () => {
    const harness = await buildHarness();
    const ceremonies = [
      '/v1/auth/register/options',
      '/v1/auth/register/verify',
      '/v1/auth/login/options',
      '/v1/auth/login/verify',
      '/v1/auth/step-up/options',
      '/v1/auth/step-up/verify',
      '/v1/auth/recover/options',
      '/v1/auth/recover/verify',
      '/v1/auth/enroll/options',
      '/v1/auth/enroll/verify'
    ];
    for (const path of ceremonies) {
      await harness.app.inject({ method: 'POST', url: path, payload: {} });
    }
    // The key is per caller address and per path, so one hammered ceremony cannot lock the others.
    expect(harness.throttled.map((key) => key.slice(key.indexOf(':') + 1))).toEqual(ceremonies);
  });

  /** And nothing else: the throttle is for ceremonies, not for every unauthenticated path. */
  test('leaves the unauthenticated health probe unthrottled', async () => {
    const harness = await buildHarness();
    await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(harness.throttled).toEqual([]);
  });
});

describe('the share viewer, which is public in a stronger sense', () => {
  const routes = [
    '/v1/shares/AbCdEfGhIjKlMnOpQrStUv',
    '/v1/shares/AbCdEfGhIjKlMnOpQrStUv/blob',
    '/v1/shares/AbCdEfGhIjKlMnOpQrStUv/artifacts/0',
    '/v1/shares/assets/share.js'
  ];
  const patterns = [
    '/v1/shares/:token',
    '/v1/shares/:token/blob',
    '/v1/shares/:token/artifacts/:n',
    '/v1/shares/assets/:file'
  ];

  /** On `publicPaths`: a caller with no session reaches the handler. Drop an entry and this is a 401. */
  test('reaches every share route with no session at all', async () => {
    const harness = await buildHarness();
    for (const url of routes) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toEqual({ user: null });
    }
    expect(harness.handlerRuns()).toBe(routes.length);
  });

  /**
   * Throttled through the viewer's own per-address bucket, the four routes together, and not
   * through the ceremony table: that one allows twenty a quarter-hour per route pattern, and one
   * open of the largest link this product makes is a page, two assets, the ciphertext and up to
   * fifty artifacts through those same four patterns - so a share route on the ceremony table is a
   * link that cannot be opened.
   */
  test('throttles every share route through one per-address bucket, not the ceremony table', async () => {
    const harness = await buildHarness();
    for (const url of routes)
      await harness.app.inject({ method: 'GET', url, remoteAddress: '203.0.113.9' });
    expect(harness.throttled).toEqual([]);
    expect(harness.shareThrottled).toEqual(routes.map(() => '203.0.113.9'));
    expect(patterns).toHaveLength(routes.length);
  });

  /**
   * The short-circuit before the session lookup. A valid cookie, on a session young enough that
   * `sessionUser` would renew it and re-issue the cookie: the handler must still see no user, and
   * the response must carry no `Set-Cookie`. Remove the early return in the hook and both go red.
   */
  test('neither resolves nor refreshes a session a share request happens to carry', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'owner');
    const cookie = await harness.cookieFor(owner.userId);
    for (const url of routes) {
      const response = await harness.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toEqual({ user: null });
      expect(response.headers['set-cookie'], url).toBeUndefined();
    }
    // The control: the same cookie on an ordinary route is a session, and is renewed.
    const control = await harness.app.inject({
      method: 'GET',
      url: `/v1/workspaces/${owner.workspaceId}/scoped-probe`,
      headers: { cookie }
    });
    expect(control.statusCode).toBe(200);
    expect(control.headers['set-cookie']).toBeDefined();
  });
});

describe('what an error carries onto the wire', () => {
  /** A share link inside an AthanorError message is both halves of a secret; the net takes it whole. */
  test('redacts a share link out of an error message', async () => {
    const harness = await buildHarness();
    const owner = await seedOwnerWorkspace(harness.store, 'owner');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/probe/leaky-error',
      headers: { cookie: await harness.cookieFor(owner.userId) }
    });
    expect(response.statusCode).toBe(502);
    const message = response.json<{ error: { message: string } }>().error.message;
    expect(message).toBe('could not fetch https://box.example[REDACTED]');
    expect(response.body).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
    expect(response.body).not.toContain('kkkkkkkk');
  });
});
