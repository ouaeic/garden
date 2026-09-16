import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { DiagnosticRecord, DiagnosticReplay, encryptJson, wrapDataKey } from '@athanor/core';
import type { RouteContext } from '../http/server-context.js';
import { registerTaskDiagnosticRoutes } from './task-diagnostics.js';

const ownerId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const taskId = '00000000-0000-4000-8000-000000000003';
const canary = 'UNIQUE_PRIVATE_CANARY_EVEN_WITHOUT_A_TOKEN_PATTERN';
const key = Buffer.alloc(32, 7),
  masterKey = Buffer.alloc(32, 9);
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup({
  count = 205,
  foreign = false,
  corrupt = false,
  failedPage = false,
  gap = false
} = {}) {
  const app = Fastify();
  apps.push(app);
  const task = {
    id: taskId,
    workspaceId,
    status: 'awaiting_resource',
    securityMode: 'autonomous',
    modelId: canary,
    spentUsd: 0,
    attempt: 0,
    agentStateCiphertext: encryptJson(
      { step: 2, messages: [{ role: 'user', content: canary }] },
      key,
      `task-state:${taskId}`
    )
  };
  if (corrupt)
    task.agentStateCiphertext = encryptJson({}, Buffer.alloc(32, 2), `task-state:${taskId}`);
  const workspace = { id: workspaceId, wrappedKey: wrapDataKey(key, masterKey, workspaceId) };
  const rows = Array.from({ length: count }, (_, i) => ({
    id: String(i),
    taskId,
    sequence: i + 1,
    kind: 'notice',
    createdAt: '2026-09-17T00:00:00.000Z',
    summary: canary,
    payloadCiphertext: encryptJson(
      { __athanorEventVersion: 1, summary: canary, payload: { private: canary } },
      key,
      `task-event:${taskId}`
    )
  }));
  if (corrupt && rows[0])
    rows[0].payloadCiphertext = encryptJson({}, Buffer.alloc(32, 2), `task-event:${taskId}`);
  if (gap) rows.splice(1, 1);
  const readPage = vi.fn(
    async (_id: string, { after, limit }: { after: number; limit: number }) => {
      if (failedPage && after > 0) throw new Error(canary);
      return { events: rows.filter((row) => row.sequence > after).slice(0, limit) };
    }
  );
  const latest = vi.fn(async () => ({ nextCursor: count }));
  const getTask = vi.fn(async (userId: string, id: string) =>
    userId === ownerId && id === taskId && !foreign ? task : null
  );
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request) => {
    request.user = { id: ownerId } as typeof request.user;
  });
  registerTaskDiagnosticRoutes({
    app,
    masterKey,
    store: {
      getTask,
      getWorkspace: async () => workspace,
      listRecentTaskEvents: latest,
      listTaskEventPage: readPage
    }
  } as unknown as RouteContext);
  return { app, rows, readPage, latest, getTask };
}
async function download(app: FastifyInstance) {
  return app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/diagnostics` });
}
function replay(body: string) {
  const records = body
    .trim()
    .split('\n')
    .map((line) => DiagnosticRecord.parse(JSON.parse(line)));
  expect(records.length).toBeGreaterThan(0);
  const replay = new DiagnosticReplay();
  records.forEach((row) => replay.accept(row));
  return { result: replay.result(), records };
}
describe('authenticated diagnostic download', () => {
  it('streams bounded pages with private content omitted and a fixed event boundary', async () => {
    const { app, rows, latest, readPage, getTask } = setup();
    latest.mockImplementationOnce(async () => {
      rows.push({ ...rows[0]!, sequence: 206 });
      return { nextCursor: 205 };
    });
    const response = await download(app);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="garden-diagnostic.ndjson"'
    );
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toContain(canary);
    expect(getTask).toHaveBeenCalledWith(ownerId, taskId);
    expect(readPage.mock.calls.map((call) => call[1])).toEqual([
      { after: 0, limit: 100 },
      { after: 100, limit: 100 },
      { after: 200, limit: 100 }
    ]);
    expect(replay(response.body).result).toMatchObject({
      events: 205,
      complete: true,
      waiting: 'resource',
      providerCalls: 0,
      commandsRun: 0
    });
  });
  it('unwraps encrypted event envelopes before projecting tool outcomes', async () => {
    const { app, rows } = setup({ count: 1 });
    rows[0]!.kind = 'tool_result';
    rows[0]!.payloadCiphertext = encryptJson(
      {
        __athanorEventVersion: 1,
        summary: canary,
        payload: { toolCallId: 'call', result: { exitCode: 7, stderr: canary } }
      },
      key,
      `task-event:${taskId}`
    );
    const response = await download(app);
    expect(replay(response.body).result).toMatchObject({ failedEvents: 1, lastFailureSequence: 1 });
    expect(response.body).not.toContain(canary);
  });
  it('refuses another owner or an unknown conversation before reading events', async () => {
    const { app, readPage, latest } = setup({ foreign: true });
    expect((await download(app)).statusCode).toBe(404);
    expect(latest).not.toHaveBeenCalled();
    expect(readPage).not.toHaveBeenCalled();
  });
  it('marks unreadable checkpoints and events without discarding the rest of the export', async () => {
    const { app } = setup({ count: 2, corrupt: true });
    const response = await download(app);
    expect(response.statusCode).toBe(200);
    const { result, records } = replay(response.body);
    expect(records[0]).toMatchObject({ checkpoint: { readable: false } });
    expect(result).toMatchObject({
      complete: true,
      readable: false,
      unreadableEvents: 1,
      events: 2
    });
  });
  it.each([{ failedPage: true }, { gap: true }])(
    'marks partial history explicitly: %o',
    async (options) => {
      const { app } = setup(options);
      const response = await download(app);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(canary);
      const { result } = replay(response.body);
      expect(result.complete).toBe(false);
      expect(result.missingEvents).toBeGreaterThan(0);
    }
  );
  it('exports an empty history as complete', async () => {
    const { app, readPage } = setup({ count: 0 });
    expect(replay((await download(app)).body).result).toMatchObject({ events: 0, complete: true });
    expect(readPage).not.toHaveBeenCalled();
  });
});
