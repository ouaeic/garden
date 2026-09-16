/**
 * Share links, driven through `app.inject` against a real `buildServer` over a real database.
 *
 * Every assertion here is about a promise the public side makes to somebody who is not the owner,
 * or a promise the owner's side makes about what leaves the box. The ones that matter most are
 * the ones that would stay green if the wrong thing were built: a 404 that differs by a byte
 * between "revoked" and "unknown" is an enumeration oracle; a `Set-Cookie` on a public answer is a
 * session written by a route that must not read one; a tool result inside the ciphertext is the
 * file the agent read, shipped to whoever holds the link.
 *
 * The events are sealed exactly as `apps/worker/src/tool-recording.ts` seals them - the `event()`
 * shape, under the real workspace key - so what the snapshot builder opens is what production
 * writes, and the decryption on the reading side is done here with the returned key the way the
 * viewer does it: AES-256-GCM over the envelope, then gunzip, then JSON.
 */
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  SHARE_LIMITS,
  type ShareBlob,
  type SharePreviewResponse,
  type ShareSnapshot,
  type TaskEventKind
} from '@athanor/contracts';
import { encryptJson, sha256, unwrapDataKey, type EncryptedEnvelope } from '@athanor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config.js';
import { SHARE_REQUESTS_PER_MINUTE } from '../context.js';
import { buildServer } from '../server.js';
import { shareViewerHeaders } from '../share-viewer.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

/** The bytes the runner hands back for each artifact, keyed by the storage path it is asked for. */
const artifactBytes = new Map<string, Buffer>();

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>['app'];
  store: Awaited<ReturnType<typeof buildServer>>['store'];
  database: Awaited<ReturnType<typeof buildServer>>['database'];
  cookie: string;
  userId: string;
  workspaceId: string;
  key: Buffer;
  /** A conversation with a title and no events yet. */
  task: (title?: string) => Promise<string>;
  /** One event, sealed the way the worker seals one. */
  event: (taskId: string, kind: TaskEventKind, summary: string, payload?: unknown) => Promise<void>;
  /** One artifact row on the task, with bytes the runner stub will serve for it. */
  artifact: (taskId: string, name: string, mimeType: string, bytes: Buffer) => Promise<string>;
  /** A second owner with their own computer, for the boundary. */
  stranger: () => Promise<{ cookie: string; taskId: string }>;
}

const buildHarness = async (overrides: Partial<ApiConfig> = {}): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-shares-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  artifactBytes.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      const marker = '/file?path=';
      if (requestUrl.includes(marker)) {
        const path = decodeURIComponent(
          requestUrl.slice(requestUrl.indexOf(marker) + marker.length)
        );
        const bytes = artifactBytes.get(path);
        return new Response(bytes ? new Uint8Array(bytes) : 'missing', {
          status: bytes ? 200 : 404,
          headers: { 'content-type': 'application/octet-stream' }
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    })
  );
  const config: ApiConfig = {
    DEPLOYMENT_MODE: 'development',
    MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
    CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
    ATHANOR_STATE_PATH: directory,
    RELAY_STATE_DIR: join(directory, 'relay'),
    RELAY_LOCAL_HOST: '127.0.0.1',
    RELAY_LOCAL_PORT: 443,
    RELAY_LOCAL_HTTP_PORT: 80,
    RELAY_LOCAL_PREVIEW_PORT: 8443,
    REGISTRATION_BOOTSTRAP_TOKEN: 'shares-pairing-token-with-at-least-20-chars',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 4139,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 4439,
    RESERVED_PREVIEW_PORTS: '4139,4439',
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: MASTER_KEY,
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'athanor Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'shares-test-worker',
    EMBEDDED_WORKER: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_MS: 60_000,
    SCHEDULER_POLL_MS: 600_000,
    TASK_MAX_STEPS: 3,
    TASK_MAX_SELF_CONTINUATIONS: 0,
    SECURITY_EVENT_RETENTION_DAYS: 30,
    LOG_LEVEL: 'silent',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    AI_PROVIDER: 'openrouter',
    AI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    AI_REQUIRE_ZDR: true,
    AI_FORCE_INHOUSE_WEB: false,
    ALLOW_INSECURE_PROVIDER_URLS: false,
    CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
    PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com',
    ...overrides
  };

  const { app, previewApp, database, store } = await buildServer(config);
  disposers.push(async () => {
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const signIn = async (username: string) => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev',
      payload: { username }
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
    if (!cookie) throw new Error('dev sign-in returned no session cookie');
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
    const userId = me.json<{ user: { id: string } }>().user.id;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie, 'idempotency-key': `shares-workspace-${username}` },
      payload: { name: `${username}'s computer` }
    });
    if (created.statusCode !== 200) throw new Error(`workspace: ${created.body}`);
    const workspaceId = created.json<{ id: string }>().id;
    const workspace = (await store.listWorkspaces(userId)).find((row) => row.id === workspaceId);
    if (!workspace?.wrappedKey) throw new Error('the new workspace has no wrapped key');
    const key = unwrapDataKey(workspace.wrappedKey, Buffer.from(MASTER_KEY, 'base64'), workspaceId);
    return { cookie, userId, workspaceId, key };
  };

  const owner = await signIn('owner');
  let artifacts = 0;
  const task = async (title = 'Quarterly numbers', as = owner) =>
    (
      await store.createTask({
        userId: as.userId,
        workspaceId: as.workspaceId,
        titleCiphertext: encryptJson({ title }, as.key, `task-title:${as.workspaceId}`),
        nameIndex: { nameTokens: '', openingTokens: '' },
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        promptCiphertext: encryptJson({ prompt: title }, as.key, `task-prompt:${as.workspaceId}`)
      })
    ).id;

  return {
    app,
    store,
    database,
    cookie: owner.cookie,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    key: owner.key,
    task,
    event: async (taskId, kind, summary, payload) => {
      await store.appendTaskEvent({
        taskId,
        kind,
        summary: `Encrypted ${kind.replaceAll('_', ' ')} event`,
        payloadCiphertext: encryptJson(
          { __athanorEventVersion: 1, summary, payload },
          owner.key,
          `task-event:${taskId}`
        )
      });
    },
    artifact: async (taskId, name, mimeType, bytes) => {
      artifacts += 1;
      const storageKey = `.athanor/artifacts/${artifacts}-${name}`;
      artifactBytes.set(storageKey, bytes);
      const row = await store.createArtifact({
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        taskId,
        logicalKey: name,
        nameCiphertext: encryptJson({ name }, owner.key, `artifact-name:${owner.workspaceId}`),
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        storageKey
      });
      return String(row.id);
    },
    stranger: async () => {
      const other = await signIn('stranger');
      return { cookie: other.cookie, taskId: await task('Not yours', other) };
    }
  };
};

/** Splits the link the API hands back into the segment the path carries and the key it does not. */
const parseLink = (url: string): { token: string; key: Buffer } => {
  const match = /^\/v1\/shares\/([A-Za-z0-9_-]{22})#1\.([A-Za-z0-9_-]+)$/.exec(url);
  if (!match) throw new Error(`unexpected share url ${url}`);
  return { token: match[1]!, key: Buffer.from(match[2]!, 'base64url') };
};

/** What the viewer does, without the viewer: open the envelope with the key from the fragment. */
const openEnvelope = (envelope: EncryptedEnvelope, key: Buffer, aad: string): Buffer => {
  expect(envelope.aad).toBe(aad);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]);
};

const openSnapshot = (blob: ShareBlob, token: string, key: Buffer): ShareSnapshot =>
  JSON.parse(
    gunzipSync(openEnvelope(blob.envelope, key, `share:${sha256(token)}`)).toString('utf8')
  ) as ShareSnapshot;

const createShare = async (
  harness: Harness,
  taskId: string,
  body: Record<string, unknown> = {},
  cookie = harness.cookie
) =>
  harness.app.inject({
    method: 'POST',
    url: `/v1/tasks/${taskId}/shares`,
    headers: { cookie, 'idempotency-key': `share-${sha256(`${taskId}${JSON.stringify(body)}`)}` },
    payload: body
  });

/** A conversation with one of everything the kind map decides about. */
const seedConversation = async (harness: Harness, taskId: string) => {
  await harness.event(taskId, 'user_message', 'Summarise the numbers', {
    markdown: 'Summarise the **quarterly numbers** for me.'
  });
  await harness.event(taskId, 'plan', 'Plan updated to version 1', {
    planId: 'plan-1',
    version: 1,
    steps: [
      { id: 's1', title: 'Read the spreadsheet', status: 'completed' },
      { id: 's2', title: 'Write the summary', status: 'pending' }
    ]
  });
  await harness.event(taskId, 'assistant_reasoning', 'Thinking about columns', {
    markdown: 'SECRET-REASONING the owner did not ask to share'
  });
  await harness.event(taskId, 'tool_started', 'Running read_file', {
    toolCallId: 'call-1',
    tool: 'read_file',
    arguments: { path: '/home/owner/private/ledger.csv', ARGUMENT_MARKER: 'never-shared' }
  });
  await harness.event(taskId, 'tool_result', 'read_file completed', {
    toolCallId: 'call-1',
    result: { text: 'FILE-DUMP-MARKER account,balance\n1,2' }
  });
  // The shape `recordToolFailure` writes: the summary names the tool, the payload carries the
  // error's own message, which can quote the path or the page that failed.
  await harness.event(taskId, 'error', 'read_file failed', {
    toolCallId: 'call-1',
    message: 'ENOENT: /home/owner/private/ledger.csv ERROR-DETAIL-MARKER'
  });
  await harness.event(taskId, 'approval_requested', 'Allow a command to reach the internet?', {
    approvalId: 'approval-1',
    sideEffect: 'external',
    preview: 'PREVIEW-MARKER curl https://elsewhere.example'
  });
  await harness.event(taskId, 'approval_resolved', 'Approved', { approvalId: 'approval-1' });
  await harness.event(taskId, 'question_asked', 'Which quarter?', {
    question: 'Which quarter did you mean?',
    why: 'Two are in the file',
    options: ['Q1', 'Q2']
  });
  await harness.event(taskId, 'cost', 'Step cost', { usd: 0.02, COST_MARKER: true });
  // The two sentences the spend ceiling writes, with the payload shape it writes them with. Both
  // quote the owner's spend and cap, which no link carries.
  await harness.event(taskId, 'warning', '$0.80 of the $1.00 limit for today has been spent.', {
    windows: [{ name: 'daily', spentUsd: 0.8, capUsd: 1, pendingUsd: 0 }],
    estimateUsd: 0.05
  });
  await harness.event(
    taskId,
    'status',
    'Paused at $0.98 of the $1.00 limit for today. Raise the limit to carry on, or leave it here.',
    {
      blockedBy: 'daily',
      windows: [{ name: 'daily', spentUsd: 0.98, capUsd: 1, pendingUsd: 0 }],
      estimateUsd: 0.05
    }
  );
  await harness.event(taskId, 'preview', 'Preview published', {
    url: 'https://box.example/__athanor/preview/abc?access=PREVIEW-TOKEN-MARKER'
  });
  await harness.event(taskId, 'assistant_message', 'Revenue rose 4%', {
    markdown: 'Revenue rose **4%** quarter on quarter.'
  });
  await harness.event(taskId, 'completed', 'Task completed', {
    summary: 'The summary is written.',
    verification: 'verified'
  });
};

describe('the public side of a share link', () => {
  it('serves the page, the ciphertext and the artifacts to a caller with no session', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task('Quarterly numbers');
    await seedConversation(harness, taskId);
    const artifactId = await harness.artifact(
      taskId,
      'summary.txt',
      'text/plain',
      Buffer.from('ARTIFACT-PLAINTEXT quarterly summary')
    );
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const created = await createShare(harness, taskId, { artifactIds: [artifactId] });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.headers['cache-control']).toBe('no-store');
    const { share, url } = created.json<{ share: Record<string, unknown>; url: string }>();
    const { token, key } = parseLink(url);
    expect(share).not.toHaveProperty('lookupHash');
    expect(share).not.toHaveProperty('lookup_hash');
    // The key is nowhere on the box: not on the row, and not derivable from anything on it.
    const rows = await harness.database.query<{ row: string }>(
      'SELECT row_to_json(task_shares)::text AS row FROM task_shares'
    );
    expect(rows.rows[0]!.row).not.toContain(key.toString('base64url'));
    expect(rows.rows[0]!.row).not.toContain(token);
    expect(rows.rows[0]!.row).toContain(sha256(token));

    const page = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(shareViewerHeaders.length).toBeGreaterThan(0);
    for (const [name, value] of shareViewerHeaders) expect(page.headers[name]).toBe(value);
    const policy = Object.fromEntries<string[]>(
      String(page.headers['content-security-policy'])
        .split(';')
        .map((directive) => {
          const [name, ...sources] = directive.trim().split(/\s+/);
          return [name ?? '', sources];
        })
    );
    expect(policy['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['connect-src']).toEqual(["'self'"]);
    expect(policy['default-src']).toEqual(["'none'"]);
    expect(policy['frame-src']).toEqual(['blob:']);
    expect(policy['form-action']).toEqual(["'none'"]);
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.body).toContain('/v1/shares/assets/share.js');
    expect(page.body).not.toContain('<script>');
    // Nothing of the conversation is on the page.
    expect(page.body).not.toContain('Quarterly');
    expect(page.body).not.toContain('Revenue');

    const blob = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` });
    expect(blob.statusCode, blob.body).toBe(200);
    expect(blob.headers['cache-control']).toBe('no-store');
    expect(blob.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(blob.body).not.toContain('Revenue');
    const snapshot = openSnapshot(blob.json<ShareBlob>(), token, key);
    expect(snapshot.title).toBe('Quarterly numbers');
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      'user_message',
      'plan',
      'tool_started',
      'tool_result',
      'error',
      'approval_requested',
      'approval_resolved',
      'question_asked',
      'warning',
      'status',
      'assistant_message',
      'completed'
    ]);
    expect(snapshot.artifacts).toEqual([
      {
        n: 0,
        name: 'summary.txt',
        mimeType: 'text/plain',
        sizeBytes: 36,
        sha256: sha256(Buffer.from('ARTIFACT-PLAINTEXT quarterly summary'))
      }
    ]);
    // No identifier of any kind made it in.
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(taskId);
    expect(json).not.toContain(harness.workspaceId);
    expect(json).not.toContain(harness.userId);
    expect(json).not.toContain('approval-1');
    expect(json).not.toContain('call-1');

    const manifest = blob.json<ShareBlob>().manifest;
    expect(manifest).toHaveLength(1);
    const bytes = await harness.app.inject({
      method: 'GET',
      url: `/v1/shares/${token}/artifacts/0`
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.rawPayload.toString('utf8')).not.toContain('ARTIFACT-PLAINTEXT');
    const opened = openEnvelope(
      { ...manifest[0]!.envelope, ciphertext: bytes.rawPayload.toString('base64') },
      key,
      `share:${sha256(token)}:artifact:0`
    );
    expect(opened.toString('utf8')).toBe('ARTIFACT-PLAINTEXT quarterly summary');

    // The read counted, the page did not, and nothing about the reader was written down.
    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/shares`,
      headers: { cookie: harness.cookie }
    });
    expect(
      listed.json<Array<{ viewCount: number; lastViewedAt: string | null }>>()[0]
    ).toMatchObject({ viewCount: 1 });
    expect(listed.json<Array<{ lastViewedAt: string | null }>>()[0]!.lastViewedAt).not.toBeNull();
    // And the badge count rides on the task.
    const taskRow = await harness.app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: harness.cookie }
    });
    expect(taskRow.json<{ shareCount: number }>().shareCount).toBe(1);
  });

  /**
   * Byte for byte, across every reason the public side will not answer. A branch that says
   * "revoked" where another says "not found" is an oracle: it tells a caller which 22-character
   * strings once meant something. The comparison is on status, body and every header, and it is
   * made on both the page and the data route.
   */
  it('answers a revoked, expired, unknown, malformed and switched-off link identically', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const revokedLink = parseLink(
      (await createShare(harness, taskId, { expiresInDays: 7 })).json<{ url: string }>().url
    );
    const expiredLink = parseLink(
      (await createShare(harness, taskId, { expiresInDays: 1 })).json<{ url: string }>().url
    );
    const disabledLink = parseLink(
      (await createShare(harness, taskId, { expiresInDays: 30 })).json<{ url: string }>().url
    );
    const shares = await harness.store.listSharesForTask(harness.userId, taskId);
    const revokedRow = shares.find((row) => row.lookupHash === sha256(revokedLink.token))!;
    const expiredRow = shares.find((row) => row.lookupHash === sha256(expiredLink.token))!;
    await harness.app.inject({
      method: 'DELETE',
      url: `/v1/shares/${revokedRow.id}`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'revoke-one' }
    });
    await harness.database.query(
      `UPDATE task_shares SET expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [expiredRow.id]
    );
    const unknown = 'AbCdEfGhIjKlMnOpQrStUv';

    const answers = async (path: (token: string) => string) => {
      const collect = async (token: string) => {
        const response = await harness.app.inject({ method: 'GET', url: path(token) });
        const headers = { ...response.headers };
        // The only header allowed to differ between two identical answers is the clock.
        delete headers.date;
        return { status: response.statusCode, body: response.body, headers };
      };
      const results = {
        revoked: await collect(revokedLink.token),
        expired: await collect(expiredLink.token),
        unknown: await collect(unknown),
        malformed: await collect('not-a-share-token'),
        uuid: await collect('0f2b1c9e-8a7d-4c3b-9e1f-2a3b4c5d6e7f')
      };
      return results;
    };

    for (const route of [
      (token: string) => `/v1/shares/${token}`,
      (token: string) => `/v1/shares/${token}/blob`,
      (token: string) => `/v1/shares/${token}/artifacts/0`
    ]) {
      const results = await answers(route);
      expect(results.unknown.status).toBe(404);
      expect(results.revoked).toEqual(results.unknown);
      expect(results.expired).toEqual(results.unknown);
      expect(results.malformed).toEqual(results.unknown);
      expect(results.uuid).toEqual(results.unknown);
      expect(results.unknown.headers['set-cookie']).toBeUndefined();
    }

    // A live link answers, so the comparison above was between refusals and not between nothings.
    const live = await harness.app.inject({
      method: 'GET',
      url: `/v1/shares/${disabledLink.token}/blob`
    });
    expect(live.statusCode).toBe(200);

    // Sharing switched off: the same 404 for a link that was live a moment ago.
    const off = await buildHarness({ SHARING_ENABLED: false });
    const offTask = await off.task();
    await off.event(offTask, 'user_message', 'Hello', { markdown: 'Hello' });
    await off.database.query('UPDATE sessions SET step_up_at=NOW()');
    const refused = await createShare(off, offTask);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('sharing_disabled');
    // A row that exists - planted through the store as one made before the switch was thrown.
    await off.store.createShare({
      userId: off.userId,
      taskId: offTask,
      workspaceId: off.workspaceId,
      lookupHash: sha256(unknown),
      envelope: { v: 1, iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y2lwaGVy' },
      manifest: [],
      snapshotBytes: 8,
      expiresAt: null,
      artifacts: []
    });
    for (const path of [`/v1/shares/${unknown}`, `/v1/shares/${unknown}/blob`]) {
      const offAnswer = await off.app.inject({ method: 'GET', url: path });
      const onAnswer = await harness.app.inject({
        method: 'GET',
        url: path.replace(unknown, 'ZyXwVuTsRqPoNmLkJiHgFe')
      });
      expect(offAnswer.statusCode).toBe(404);
      expect(offAnswer.body).toBe(onAnswer.body);
      const offHeaders = { ...offAnswer.headers };
      const onHeaders = { ...onAnswer.headers };
      delete offHeaders.date;
      delete onHeaders.date;
      expect(offHeaders).toEqual(onHeaders);
    }
  });

  /**
   * One bucket per address for the whole public side, sized for a reader rather than for a passkey
   * ceremony: opening the largest link this product makes is the page, two assets, the ciphertext
   * and `SHARE_LIMITS.artifacts` files from one address, and an office behind one address opens
   * more pages in a minute than the ceremony table's twenty a quarter-hour. The twenty-first read
   * of the ciphertext is asserted by name because twenty is that table's limit for one route
   * pattern, and a share route put back on it fails exactly there.
   */
  it('throttles the public side per address, in one bucket wide enough to open the largest link', async () => {
    expect(SHARE_REQUESTS_PER_MINUTE).toBeGreaterThanOrEqual(SHARE_LIMITS.artifacts + 4);
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token } = parseLink((await createShare(harness, taskId)).json<{ url: string }>().url);
    const read = (url: string, remoteAddress = '203.0.113.7') =>
      harness.app.inject({ method: 'GET', url, remoteAddress });
    const statuses: number[] = [(await read(`/v1/shares/${token}`)).statusCode];
    while (statuses.length < SHARE_REQUESTS_PER_MINUTE + 1)
      statuses.push((await read(`/v1/shares/${token}/blob`)).statusCode);
    expect(statuses[21]).toBe(200);
    expect(statuses.slice(0, SHARE_REQUESTS_PER_MINUTE).every((status) => status === 200)).toBe(
      true
    );
    expect(statuses[SHARE_REQUESTS_PER_MINUTE]).toBe(429);
    // The same bucket: the page's own assets are refused to the address that spent it, so a flood
    // cannot route round the count by fetching the script.
    expect((await read('/v1/shares/assets/share.css')).statusCode).toBe(429);
    // Another address is not the one that was throttled.
    expect((await read(`/v1/shares/${token}/blob`, '203.0.113.8')).statusCode).toBe(200);
  });

  /**
   * A session cookie on a public route is neither read nor written. The session is deliberately
   * young - well inside the half-life the store renews at - so that if `sessionUser` ran it would
   * slide the expiry and re-issue the cookie, and the assertion on `set-cookie` would go red.
   */
  it('neither reads nor writes a session, however valid the cookie it is sent', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token } = parseLink((await createShare(harness, taskId)).json<{ url: string }>().url);
    const sessionToken = 'a'.repeat(43);
    await harness.store.createSession(
      harness.userId,
      sha256(sessionToken),
      new Date(Date.now() + 60_000),
      undefined,
      'Test',
      true
    );
    const before = await harness.database.query<{ last_seen_at: string; expires_at: string }>(
      'SELECT last_seen_at, expires_at FROM sessions WHERE id_hash=$1',
      [sha256(sessionToken)]
    );
    for (const path of [
      `/v1/shares/${token}`,
      `/v1/shares/${token}/blob`,
      `/v1/shares/${token}/artifacts/0`,
      '/v1/shares/assets/share.js'
    ]) {
      const anonymous = await harness.app.inject({ method: 'GET', url: path });
      const withCookie = await harness.app.inject({
        method: 'GET',
        url: path,
        headers: { cookie: `athanor_session=${sessionToken}` }
      });
      expect(withCookie.headers['set-cookie'], path).toBeUndefined();
      expect(withCookie.statusCode, path).toBe(anonymous.statusCode);
      expect(withCookie.body, path).toBe(anonymous.body);
    }
    const after = await harness.database.query<{ last_seen_at: string; expires_at: string }>(
      'SELECT last_seen_at, expires_at FROM sessions WHERE id_hash=$1',
      [sha256(sessionToken)]
    );
    // Not even touched: the row is exactly as it was before the requests.
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('heads an HTML artifact as bytes to save, never as a document to open', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Make a page', { markdown: 'Make a page' });
    const artifactId = await harness.artifact(
      taskId,
      'page.html',
      'text/html',
      Buffer.from('<script>alert(document.cookie)</script>')
    );
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token } = parseLink(
      (await createShare(harness, taskId, { artifactIds: [artifactId] })).json<{ url: string }>()
        .url
    );
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/shares/${token}/artifacts/0`
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe("attachment; filename*=UTF-8''0.bin");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(response.rawPayload.toString('utf8')).not.toContain('<script>');
    // An index the manifest does not have is the same 404 as a link that does not exist.
    const missing = await harness.app.inject({
      method: 'GET',
      url: `/v1/shares/${token}/artifacts/1`
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('the viewer the page loads', () => {
  it('serves the built script and stylesheet under a digest the page names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-share-viewer-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, 'share.js'), 'console.log("viewer")');
    await writeFile(join(directory, 'share.css'), 'main{color:red}');
    const harness = await buildHarness({ SHARE_VIEWER_DIR: directory });
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token } = parseLink((await createShare(harness, taskId)).json<{ url: string }>().url);
    const page = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}` });
    const script = /src="(\/v1\/shares\/assets\/share\.js\?v=[0-9a-f]{16})"/.exec(page.body);
    const style = /href="(\/v1\/shares\/assets\/share\.css\?v=[0-9a-f]{16})"/.exec(page.body);
    expect(script, page.body).not.toBeNull();
    expect(style, page.body).not.toBeNull();
    const js = await harness.app.inject({ method: 'GET', url: script![1]! });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.body).toBe('console.log("viewer")');
    const css = await harness.app.inject({ method: 'GET', url: style![1]! });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(css.body).toBe('main{color:red}');
    // Only those two names, whatever else is in the directory.
    await writeFile(join(directory, 'secrets.txt'), 'nope');
    const other = await harness.app.inject({ method: 'GET', url: '/v1/shares/assets/secrets.txt' });
    expect(other.statusCode).toBe(404);
    const traversal = await harness.app.inject({
      method: 'GET',
      url: '/v1/shares/assets/..%2Fshare.js'
    });
    expect(traversal.statusCode).toBe(404);
  });

  it('still serves the page when the viewer is not built, and says so in the asset version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'athanor-share-noviewer-'));
    disposers.push(() => rm(directory, { recursive: true, force: true }));
    const harness = await buildHarness({ SHARE_VIEWER_DIR: directory });
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token } = parseLink((await createShare(harness, taskId)).json<{ url: string }>().url);
    const page = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('share.js?v=missing');
    const js = await harness.app.inject({ method: 'GET', url: '/v1/shares/assets/share.js' });
    expect(js.statusCode).toBe(404);
  });
});

describe('what a share carries', () => {
  it('is a snapshot: a message written after the link was made is not in it', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'First', { markdown: 'FIRST-MESSAGE' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token, key } = parseLink(
      (await createShare(harness, taskId)).json<{ url: string }>().url
    );
    await harness.event(taskId, 'assistant_message', 'Later', { markdown: 'LATER-MESSAGE' });
    const blob = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` });
    const snapshot = openSnapshot(blob.json<ShareBlob>(), token, key);
    const texts = snapshot.events.map((event) => event.text);
    expect(texts).toContain('FIRST-MESSAGE');
    expect(texts.join('\n')).not.toContain('LATER-MESSAGE');
  });

  it('runs the redaction net over messages and artifact names', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    // Assembled so the repository holds no literal of the shape a scanner alerts on.
    const secret = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz012345'].join('');
    await harness.event(taskId, 'user_message', 'Use my token', {
      markdown: `Use ${secret} to push the branch`
    });
    const artifactId = await harness.artifact(
      taskId,
      `notes-${secret}.txt`,
      'text/plain',
      Buffer.from('notes')
    );
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token, key } = parseLink(
      (await createShare(harness, taskId, { artifactIds: [artifactId] })).json<{ url: string }>()
        .url
    );
    const blob = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` });
    const snapshot = openSnapshot(blob.json<ShareBlob>(), token, key);
    expect(snapshot.events[0]!.text).toBe('Use [REDACTED] to push the branch');
    // The net takes the extension with it - the credential pattern admits a dot - and that is the
    // right side to err on for a name that carried a token.
    expect(snapshot.artifacts[0]!.name).toBe('notes-[REDACTED]');
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('carries the one-line summary of a tool step and nothing the tool read or was given', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await seedConversation(harness, taskId);
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token, key } = parseLink(
      (await createShare(harness, taskId)).json<{ url: string }>().url
    );
    const blob = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` });
    const snapshot = openSnapshot(blob.json<ShareBlob>(), token, key);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('ARGUMENT_MARKER');
    expect(json).not.toContain('never-shared');
    expect(json).not.toContain('/home/owner/private/ledger.csv');
    expect(json).not.toContain('FILE-DUMP-MARKER');
    expect(json).not.toContain('SECRET-REASONING');
    expect(json).not.toContain('PREVIEW-MARKER');
    expect(json).not.toContain('PREVIEW-TOKEN-MARKER');
    expect(json).not.toContain('COST_MARKER');
    expect(json).not.toContain('ERROR-DETAIL-MARKER');
    // Cost is on the list of what a link never carries, whichever line the figures rode in on.
    expect(json).not.toContain('$');
    const byKind = Object.fromEntries(snapshot.events.map((event) => [event.kind, event.text]));
    expect(byKind.tool_started).toBe('Running read_file');
    expect(byKind.tool_result).toBe('read_file completed');
    // A step that failed is still a step: the reader sees that it failed, not why in detail.
    expect(byKind.error).toBe('read_file failed');
    expect(byKind.status).toBe('Paused at a spending limit.');
    expect(byKind.warning).toBe('Approaching a spending limit.');
    expect(byKind.approval_requested).toBe('Allow a command to reach the internet?');
    expect(byKind.question_asked).toBe('Which quarter did you mean?');
    expect(byKind.plan).toBe(
      'Plan updated to version 1\n\n- [x] Read the spreadsheet\n- [ ] Write the summary'
    );
    expect(byKind.completed).toBe('The summary is written.');

    // Switched on, the reasoning and the result text ride; the arguments and the preview never do.
    const opted = parseLink(
      (
        await createShare(harness, taskId, { includeReasoning: true, includeToolResults: true })
      ).json<{ url: string }>().url
    );
    const optedBlob = await harness.app.inject({
      method: 'GET',
      url: `/v1/shares/${opted.token}/blob`
    });
    const optedJson = JSON.stringify(
      openSnapshot(optedBlob.json<ShareBlob>(), opted.token, opted.key)
    );
    expect(optedJson).toContain('SECRET-REASONING');
    expect(optedJson).toContain('FILE-DUMP-MARKER');
    expect(optedJson).not.toContain('ARGUMENT_MARKER');
    expect(optedJson).not.toContain('PREVIEW-MARKER');
    expect(optedJson).not.toContain('ERROR-DETAIL-MARKER');
    expect(optedJson).not.toContain('$');
  });

  it('shows the owner the exact snapshot before the link exists', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await seedConversation(harness, taskId);
    const preview = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/shares/preview`,
      headers: { cookie: harness.cookie },
      payload: {}
    });
    expect(preview.statusCode, preview.body).toBe(200);
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const shown = preview.json<SharePreviewResponse>();
    expect(shown.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    const repeated = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/shares/preview`,
      headers: { cookie: harness.cookie },
      payload: {}
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json<SharePreviewResponse>().previewDigest).toBe(shown.previewDigest);
    const created = await createShare(harness, taskId, {
      expectedPreviewDigest: shown.previewDigest
    });
    expect(created.statusCode, created.body).toBe(200);
    const { token, key } = parseLink(created.json<{ url: string }>().url);
    const blob = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` });
    const stored = openSnapshot(blob.json<ShareBlob>(), token, key);
    expect(shown.events).toEqual(stored.events);
    expect(shown.artifacts).toEqual(stored.artifacts);
    expect(shown.title).toBe(stored.title);
  });

  it('refuses changed content before creating a share or replacing an existing link', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Reviewed message', {
      markdown: 'Reviewed message'
    });
    const original = await createShare(harness, taskId);
    expect(original.statusCode, original.body).toBe(200);
    const old = original.json<{ share: { id: string }; url: string }>();
    const preview = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/shares/preview`,
      headers: { cookie: harness.cookie },
      payload: {}
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const expectedPreviewDigest = preview.json<SharePreviewResponse>().previewDigest;
    await harness.event(taskId, 'assistant_message', 'Unreviewed addition', {
      markdown: 'Unreviewed addition'
    });
    const refused = await createShare(harness, taskId, { expectedPreviewDigest });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('preview_changed');
    const replacement = await harness.app.inject({
      method: 'POST',
      url: `/v1/shares/${old.share.id}/refresh`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'stale-replacement' },
      payload: { expectedPreviewDigest }
    });
    expect(replacement.statusCode, replacement.body).toBe(409);
    const shares = await harness.store.listSharesForTask(harness.userId, taskId);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.revokedAt).toBeNull();
    const { token } = parseLink(old.url);
    const oldBlob = await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` });
    expect(oldBlob.statusCode, oldBlob.body).toBe(200);
  });

  it('binds the preview to artifact hashes even when names and sizes are identical', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    const reviewedFile = await harness.artifact(
      taskId,
      'result.txt',
      'text/plain',
      Buffer.from('A')
    );
    const changedFile = await harness.artifact(
      taskId,
      'result.txt',
      'text/plain',
      Buffer.from('B')
    );
    const preview = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/shares/preview`,
      headers: { cookie: harness.cookie },
      payload: { artifactIds: [reviewedFile] }
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json<SharePreviewResponse>();
    expect(shown.artifacts).toHaveLength(1);
    expect(shown.artifacts[0]!.sha256).toBe(sha256('A'));
    const refused = await createShare(harness, taskId, {
      artifactIds: [changedFile],
      expectedPreviewDigest: shown.previewDigest
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await harness.store.listSharesForTask(harness.userId, taskId)).toEqual([]);
    const created = await createShare(harness, taskId, {
      artifactIds: [reviewedFile],
      expectedPreviewDigest: shown.previewDigest
    });
    expect(created.statusCode, created.body).toBe(200);
  });
});

describe("the owner's side", () => {
  it('needs a recent passkey to make a link', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '10 minutes'");
    const refused = await createShare(harness, taskId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
    expect(await harness.store.listSharesForTask(harness.userId, taskId)).toEqual([]);
    // The preview is a read of the owner's own data and does not ask for one.
    const preview = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/shares/preview`,
      headers: { cookie: harness.cookie },
      payload: {}
    });
    expect(preview.statusCode, preview.body).toBe(200);
  });

  it("answers 404, not 403, for somebody else's conversation", async () => {
    const harness = await buildHarness();
    const stranger = await harness.stranger();
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const refused = await createShare(harness, stranger.taskId);
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('task_not_found');
    const preview = await harness.app.inject({
      method: 'POST',
      url: `/v1/tasks/${stranger.taskId}/shares/preview`,
      headers: { cookie: harness.cookie },
      payload: {}
    });
    expect(preview.statusCode).toBe(404);
    // And an artifact of the stranger's, ticked onto the owner's own task, is not found either.
    const ownTask = await harness.task();
    await harness.event(ownTask, 'user_message', 'Hello', { markdown: 'Hello' });
    const foreignArtifact = await harness.store.createArtifact({
      userId: harness.userId,
      workspaceId: harness.workspaceId,
      taskId: stranger.taskId,
      logicalKey: 'x',
      nameCiphertext: encryptJson(
        { name: 'x' },
        harness.key,
        `artifact-name:${harness.workspaceId}`
      ),
      mimeType: 'text/plain',
      sizeBytes: 1,
      sha256: sha256('x'),
      storageKey: '.athanor/artifacts/x'
    });
    const crossed = await createShare(harness, ownTask, {
      artifactIds: [String(foreignArtifact.id)]
    });
    expect(crossed.statusCode).toBe(404);
  });

  it('deletes every share with the conversation, and the link stops answering', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    const artifactId = await harness.artifact(taskId, 'a.txt', 'text/plain', Buffer.from('a'));
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const { token } = parseLink(
      (await createShare(harness, taskId, { artifactIds: [artifactId] })).json<{ url: string }>()
        .url
    );
    expect(
      (await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` })).statusCode
    ).toBe(200);
    // A conversation is deleted once it has stopped; a fresh row is queued.
    await harness.store.setTaskStatusForUser(harness.userId, taskId, 'completed');
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'delete-shared-task' }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    const shares = await harness.database.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM task_shares'
    );
    const artifacts = await harness.database.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM task_share_artifacts'
    );
    expect(Number(shares.rows[0]!.count)).toBe(0);
    expect(Number(artifacts.rows[0]!.count)).toBe(0);
    expect(
      (await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}/blob` })).statusCode
    ).toBe(404);
    expect(
      (await harness.app.inject({ method: 'GET', url: `/v1/shares/${token}` })).statusCode
    ).toBe(404);
  });

  it('revokes one link, revokes all of them, and re-snapshots under a new id and key', async () => {
    const harness = await buildHarness();
    const taskId = await harness.task();
    await harness.event(taskId, 'user_message', 'Hello', { markdown: 'Hello' });
    await harness.database.query('UPDATE sessions SET step_up_at=NOW()');
    const first = parseLink(
      (await createShare(harness, taskId, { expiresInDays: 1 })).json<{ url: string }>().url
    );
    const second = parseLink(
      (await createShare(harness, taskId, { expiresInDays: 7 })).json<{ url: string }>().url
    );
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/shares',
      headers: { cookie: harness.cookie }
    });
    const records = listed.json<Array<{ id: string; expiresAt: string | null }>>();
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.expiresAt !== null)).toBe(true);
    const firstRow = (await harness.store.listSharesForTask(harness.userId, taskId)).find(
      (row) => row.lookupHash === sha256(first.token)
    )!;

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: `/v1/shares/${firstRow.id}/refresh`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'refresh-first' },
      payload: { expiresInDays: null }
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const third = parseLink(refreshed.json<{ url: string }>().url);
    expect(third.token).not.toBe(first.token);
    expect(third.key.equals(first.key)).toBe(false);
    expect(refreshed.json<{ share: { version: number; expiresAt: null } }>().share).toMatchObject({
      version: 2,
      expiresAt: null
    });
    expect(
      (await harness.app.inject({ method: 'GET', url: `/v1/shares/${first.token}/blob` }))
        .statusCode
    ).toBe(404);
    expect(
      (await harness.app.inject({ method: 'GET', url: `/v1/shares/${third.token}/blob` }))
        .statusCode
    ).toBe(200);

    const revokedAll = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/tasks/${taskId}/shares`,
      headers: { cookie: harness.cookie, 'idempotency-key': 'revoke-all' }
    });
    expect(revokedAll.json()).toEqual({ revoked: 2 });
    for (const link of [second, third])
      expect(
        (await harness.app.inject({ method: 'GET', url: `/v1/shares/${link.token}/blob` }))
          .statusCode
      ).toBe(404);
    const taskRow = await harness.app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie: harness.cookie }
    });
    expect(taskRow.json<{ shareCount: number }>().shareCount).toBe(0);
    // A stranger cannot revoke what is not theirs, and is told nothing about whether it exists.
    const stranger = await harness.stranger();
    const foreign = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/shares/${firstRow.id}`,
      headers: { cookie: stranger.cookie, 'idempotency-key': 'stranger-revoke' }
    });
    expect(foreign.statusCode).toBe(404);
  });
});
