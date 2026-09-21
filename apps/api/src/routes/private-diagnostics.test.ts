import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTIC_CAPTURE_BYTES } from '@athanor/contracts';
import {
  diagnosticCipherHash,
  diagnosticRecordAad,
  DIAGNOSTIC_EMPTY_HASH,
  encryptJson,
  PrivateDiagnosticReader,
  wrapDataKey
} from '@athanor/core';
import type { RouteContext } from '../http/server-context.js';
import { registerPrivateDiagnosticRoutes } from './private-diagnostics.js';
const apps: FastifyInstance[] = [];
afterEach(() => Promise.all(apps.splice(0).map((app) => app.close())));
const owner = randomUUID(),
  taskId = randomUUID(),
  workspaceId = randomUUID(),
  id = randomUUID();
const key = Buffer.alloc(32, 8),
  masterKey = Buffer.alloc(32, 9),
  canary = 'PRIVATE_BODY_CANARY';
function setup({ corrupt = false, foreign = false, missing = false } = {}) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: owner } as typeof request.user;
  });
  let hash = DIAGNOSTIC_EMPTY_HASH;
  const rows = Array.from({ length: 6 }, (_, index) => {
    const previousHash = hash,
      sequence = index + 1;
    const envelope = encryptJson(
      { version: 1, kind: 'harness_event', at: new Date().toISOString(), data: { canary } },
      key,
      diagnosticRecordAad(id, sequence, hash)
    );
    hash = diagnosticCipherHash(envelope);
    return { sequence, previousHash, hash, envelope };
  });
  const status = {
    id,
    state: 'stopped',
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
    records: rows.length,
    bytes: 1000,
    limitBytes: DIAGNOSTIC_CAPTURE_BYTES,
    reason: null
  };
  if (corrupt) rows[3]!.hash = 'f'.repeat(64);
  const get = vi.fn(async (user: string, task: string) =>
    !foreign && user === owner && task === taskId
      ? { userId: owner, taskId, workspaceId, status, lastHash: hash }
      : null
  );
  const page = vi.fn(
    async (_owner: string, _task: string, _id: string, after: number, through: number) =>
      missing && after > 0
        ? []
        : rows.filter((row) => row.sequence > after && row.sequence <= through).slice(0, 3)
  );
  const control = vi.fn(async () => status);
  const idempotent: RouteContext['idempotent'] = async (_req, _reply, _user, operation) =>
    operation();
  registerPrivateDiagnosticRoutes({
    app,
    masterKey,
    idempotent,
    store: {
      getTask: async () => (foreign ? null : { id: taskId }),
      getWorkspace: async () => ({
        id: workspaceId,
        wrappedKey: wrapDataKey(key, masterKey, workspaceId)
      }),
      diagnostics: { get, page, control }
    }
  } as unknown as RouteContext);
  return { app, get, page, control };
}
const url = `/v1/tasks/${taskId}/diagnostic-capture`;
const read = (body: string) => {
  const reader = new PrivateDiagnosticReader();
  const lines = body.trim().split('\n');
  expect(lines.length).toBeGreaterThan(0);
  lines.forEach((line) => reader.accept(JSON.parse(line)));
  return reader.result();
};
describe('private diagnostic API', () => {
  it('exports bounded owner-only decrypted pages separately from ordinary diagnostics', async () => {
    const { app, get, page } = setup();
    const response = await app.inject(`${url}/${id}/export`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(canary);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain('garden-private-diagnostic.ndjson');
    expect(read(response.body)).toEqual({ records: 6, complete: true });
    expect(get).toHaveBeenCalledWith(owner, taskId);
    expect(page.mock.calls).toEqual([
      [owner, taskId, id, 0, 6],
      [owner, taskId, id, 3, 6]
    ]);
  });
  it.each([{ corrupt: true }, { missing: true }])(
    'marks interrupted or corrupt exports incomplete: %o',
    async (options) => {
      const { app } = setup(options);
      const response = await app.inject(`${url}/${id}/export`);
      expect(response.statusCode).toBe(200);
      expect(read(response.body).complete).toBe(false);
    }
  );
  it('denies unknown owners and changed capture identities before reading content', async () => {
    const { app, page } = setup({ foreign: true });
    expect((await app.inject(url)).statusCode).toBe(404);
    expect((await app.inject(`${url}/${id}/export`)).statusCode).toBe(404);
    expect(page).not.toHaveBeenCalled();
    const second = setup();
    expect((await second.app.inject(`${url}/${randomUUID()}/export`)).statusCode).toBe(404);
    expect(second.page).not.toHaveBeenCalled();
  });
  it('validates owner controls and does not expose bodies in status responses', async () => {
    const { app, control } = setup();
    expect((await app.inject(url)).body).not.toContain(canary);
    expect(
      (await app.inject({ method: 'POST', url, payload: { id, action: 'start' } })).statusCode
    ).toBe(200);
    expect(control).toHaveBeenCalledWith(owner, taskId, id, 'start');
    await app.inject({ method: 'POST', url, payload: { id, action: 'upload' } });
    expect(control).toHaveBeenCalledTimes(1);
  });
});
