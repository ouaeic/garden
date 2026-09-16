/**
 * Reading the whole of one thing the computer wrote down about its owner.
 *
 * Both memory screens showed `memoryExcerpt(body, '', {maxChars: 200})` and said on screen that an
 * opening was all they had. That is honest, and it is not the promise the product makes — "read
 * the whole of what was remembered about you" — and the difference was not a UI decision: no route
 * served more than the clamp, so no screen could. The rest sat on the owner's own disk, sealed
 * with a key the same request already derives.
 *
 * A separate suite rather than another block in `server.test.ts`, which is eight thousand lines and
 * belongs to nobody in particular. Its own `ApiConfig`, as `event-stream.test.ts` and `relay.test.ts`
 * also keep, because a shared one would be a fifth caller's constraints on every other suite's
 * fixture.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildMemoryItemIndex,
  encryptJson,
  memoryIndexKey,
  unwrapDataKey,
  generateDataKey
} from '@athanor/core';
import type { ApiConfig } from './config.js';
import { UNREADABLE_MEMORY_ITEM } from './context.js';
import { buildServer } from './server.js';

const masterKey = Buffer.alloc(32, 21);

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

/**
 * The workspace runner, answered rather than reached.
 *
 * Creating a workspace calls out to it, and a call that never lands leaves a row with no wrapped
 * key — which is the failure this suite hit first, several layers away from anything it is about.
 */
const stubRunnerFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            storageBytes: 0,
            hostStorageTotalBytes: 1_000_000_000,
            hostStorageAvailableBytes: 900_000_000,
            ok: true
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
  );

const configFor = (directory: string): ApiConfig => ({
  DEPLOYMENT_MODE: 'development',
  MODEL_CATALOG_SCOPE: 'provider_catalog',
  CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
  ATHANOR_STATE_PATH: directory,
  RELAY_STATE_DIR: join(directory, 'relay'),
  RELAY_LOCAL_HOST: '127.0.0.1',
  RELAY_LOCAL_PORT: 443,
  RELAY_LOCAL_HTTP_PORT: 80,
  RELAY_LOCAL_PREVIEW_PORT: 8443,
  PUBLIC_APP_URL: 'http://localhost:5173',
  PREVIEW_BASE_URL: 'http://preview.localhost:4400',
  API_HOST: '127.0.0.1',
  API_PORT: 0,
  PREVIEW_GATEWAY_HOST: '127.0.0.1',
  PREVIEW_GATEWAY_PORT: 0,
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://unused',
  PGLITE_PATH: join(directory, 'database'),
  DATA_MASTER_KEY: masterKey.toString('base64'),
  SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
  RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
  WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  WORKSPACE_IMAGE_REVISION: 'dev',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'athanor Test',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
  ALLOW_INSECURE_DEV_AUTH: true,
  WORKER_ID: 'memory-body-worker',
  WORKER_POLL_MS: 60_000,
  SCHEDULER_POLL_MS: 60_000,
  TASK_MAX_STEPS: 4,
  TASK_MAX_SELF_CONTINUATIONS: 0,
  SECURITY_EVENT_RETENTION_DAYS: 30,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_PROVIDER: 'openrouter',
  AI_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  AI_REQUIRE_ZDR: true,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: false,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
  RESERVED_PREVIEW_PORTS: '4201,4203',
  WORKER_CONCURRENCY: 1,
  LOG_LEVEL: 'silent',
  PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
  PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
});

const sessionCookie = (response: { headers: Record<string, unknown> }): string => {
  const header = response.headers['set-cookie'];
  const value = (Array.isArray(header) ? header[0] : header) as string | undefined;
  if (!value) throw new Error('Expected a session cookie');
  return value.split(';', 1)[0]!;
};

/**
 * A body comfortably past the clamp, whose end is checkable on its own.
 *
 * The tail matters more than the length. A fixture that only got longer would pass against a route
 * that returned 400 characters instead of 200; asserting the last sentence is what makes this a
 * test of "the whole of it" rather than of "more of it".
 */
const LONG_BODY = [
  'Goal: Reconcile the quarterly numbers against the bank export.',
  ...Array.from(
    { length: 12 },
    (_line, index) =>
      `Step ${index}: opened the ledger, matched row ${index} against the statement, and wrote ` +
      `down the difference before moving on.`
  ),
  'Outcome: ok',
  'Result: the last line, which is the one an excerpt can never contain.'
].join('\n');

const seed = async (directory: string) => {
  stubRunnerFetch();
  const { app, store } = await buildServer(configFor(directory), { masterKey });
  disposers.push(() => app.close());
  const cookie = sessionCookie(
    await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: { username: 'owner' } })
  );
  const workspaceId = (
    await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie, 'idempotency-key': 'memory-body-workspace' },
      payload: { name: 'Computer', storageLimitBytes: 10_000_000_000, region: 'auto' }
    })
  ).json<{ id: string }>().id;
  const workspace = await store.getWorkspaceById(workspaceId);
  if (!workspace?.wrappedKey) throw new Error('Expected a workspace with a wrapped key');
  const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspaceId);
  const indexKey = memoryIndexKey(key);
  const write = async (title: string, body: string, sealWith: Buffer = key) => {
    const content = { title, tags: [], body };
    return store.createMemoryItem({
      userId: workspace.userId,
      workspaceId,
      kind: 'episode',
      trust: 'derived',
      documentCiphertext: encryptJson(content, sealWith, `memory-item:${workspaceId}`),
      index: buildMemoryItemIndex(content, indexKey),
      observedAt: '2026-02-01T09:00:00.000Z',
      taskId: null
    });
  };
  return { app, store, cookie, workspaceId, key, write };
};

describe('the whole of a remembered item', () => {
  test('serves the body the excerpt was standing in for', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-memory-body-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, cookie, workspaceId, write } = await seed(directory);
    const item = await write('Reconcile the quarterly numbers', LONG_BODY);

    /*
     * The defect, stated first as the list still states it: 200 characters and an ellipsis. This is
     * not a regression guard on the clamp for its own sake — it is the fact the route below exists
     * to complete, and a list that quietly started serving whole bodies would be the same problem
     * from the other side, on a screen that shows fifty rows.
     */
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/memory-items`,
      headers: { cookie }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const excerpt = listed.json<Array<{ excerpt: string }>>()[0]!.excerpt;
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(201);
    expect(excerpt).not.toContain('the one an excerpt can never contain');

    const whole = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/memory-items/${item.id}`,
      headers: { cookie }
    });
    expect(whole.statusCode, whole.body).toBe(200);
    expect(whole.json()).toEqual({
      id: item.id,
      title: 'Reconcile the quarterly numbers',
      body: LONG_BODY,
      readable: true
    });
  }, 40_000);

  /*
   * A row this key will not open is answered rather than hidden, exactly as the list answers it.
   * The list's own comment gives the reason and it is stronger here: the point is that nothing this
   * computer holds about its owner is invisible to them, and a row dropped for being unreadable is
   * the one row they would most want to reach. `readable` is what lets a screen say which of the
   * two it is looking at without matching on the sentence.
   */
  test('says so plainly where the key no longer opens the row, rather than failing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-memory-body-sealed-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, cookie, workspaceId, write } = await seed(directory);
    // Sealed under a key this workspace has never had, which is what a row restored from another
    // box looks like from in here.
    const item = await write('Sealed elsewhere', LONG_BODY, generateDataKey());

    const whole = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/memory-items/${item.id}`,
      headers: { cookie }
    });
    expect(whole.statusCode, whole.body).toBe(200);
    expect(whole.json()).toEqual({
      id: item.id,
      title: null,
      body: UNREADABLE_MEMORY_ITEM,
      readable: false
    });
  }, 40_000);

  /* A row that is not on this box is a different fact from a row that cannot be read, and the two
     have to be told apart by a screen that removes what it is holding on the first and not the
     second. */
  test('answers 404 for a row this workspace does not have', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-memory-body-missing-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, cookie, workspaceId } = await seed(directory);
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/memory-items/${'0'.repeat(8)}-0000-4000-8000-000000000000`,
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error?: { code?: string } }>().error?.code).toBe('memory_item_not_found');
  }, 40_000);

  /* The whole body is more of the owner's own life than the excerpt was, so the door it opens has
     to be the same door. Signed out is refused before anything is decrypted. */
  test('will not hand a body to a request with no session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-api-memory-body-anon-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const { app, cookie, workspaceId, write } = await seed(directory);
    const item = await write('Reconcile the quarterly numbers', LONG_BODY);
    const url = `/v1/workspaces/${workspaceId}/memory-items/${item.id}`;
    const refused = await app.inject({ method: 'GET', url });
    expect(refused.statusCode).toBe(401);
    // The same address with the owner's own session, so this is a statement about the route rather
    // than about a URL nothing serves — which is what it would have been before the route existed.
    expect((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(200);
  }, 40_000);
});
