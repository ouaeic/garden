import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptJson, sha256, wrapDataKey } from '@garden/core';
import { createDatabase, DataStore, migrateDatabase } from '@garden/data';
import { TaskPresentation } from '@garden/contracts';
import { AVAILABILITY_TTL_MS } from '../task-evidence.js';
import type { RouteContext } from '../http/server-context.js';
import { registerTaskPresentationRoutes } from './task-presentation.js';

describe('authenticated task presentation from stored execution evidence', () => {
  const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
  const store = new DataStore(database);
  const masterKey = Buffer.alloc(32, 3),
    key = Buffer.alloc(32, 7);
  const app = Fastify();
  let ownerId = '',
    taskId = '',
    workspaceId = '',
    previewId = '';
  const reads: string[] = [];
  const runner = {
    request: vi.fn(async (input: { path: string }) => {
      reads.push(input.path);
      return { available: true };
    }),
    raw: vi.fn(async (input: { path: string }) => {
      reads.push(input.path);
      return new Response('x', { headers: { 'x-file-bytes': '21000' } });
    })
  };
  beforeAll(async () => {
    await migrateDatabase(database);
    const owner = await store.createUser({ username: 'presentation-owner', displayName: 'Owner' });
    ownerId = owner.id;
    const outsider = await store.createUser({
      username: 'presentation-outsider',
      displayName: 'Other'
    });
    workspaceId = randomUUID();
    await store.createWorkspace({
      id: workspaceId,
      userId: owner.id,
      name: 'Workspace',
      storageLimitBytes: 10_000_000_000,
      imageRevision: 'test',
      region: 'local',
      securityMode: 'balanced',
      wrappedKey: wrapDataKey(key, masterKey, workspaceId)
    });
    await store.updateWorkspaceStatus(workspaceId, 'running');
    const task = await store.createTask({
      userId: owner.id,
      workspaceId,
      titleCiphertext: encryptJson({ title: 'Maze game' }, key, `task-title:${workspaceId}`),
      promptCiphertext: encryptJson({ prompt: 'Build a game' }, key, `task-prompt:${workspaceId}`),
      nameIndex: { nameTokens: 'maze game', openingTokens: 'build game' },
      modelId: 'test/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1,
      securityMode: 'balanced'
    });
    taskId = task.id;
    const preview = await store.createWorkspacePreview({
      userId: owner.id,
      workspaceId,
      label: 'Maze game',
      port: 8080,
      slug: '0123456789abcdef0123456789abcdef',
      accessTokenHash: sha256('never-return-this-token')
    });
    previewId = preview.id;
    const emit = async (kind: 'preview' | 'completed' | 'assistant_delta', payload: unknown) =>
      store.appendTaskEvent({
        taskId,
        kind,
        summary: 'Observed',
        payloadCiphertext: encryptJson(payload, key, `task-event:${taskId}`)
      });
    await emit('preview', { previewId, url: 'https://untrusted.test/forged?access=secret' });
    await emit('completed', {
      deliverables: ['maze/index.html', '../../escape', 'https://untrusted.test/forged']
    });
    await emit('assistant_delta', { markdown: 'STREAM-TOKEN-NOT-PRESENTED' });
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (request) => {
      request.user = request.headers['x-test-owner'] === 'yes' ? owner : outsider;
    });
    registerTaskPresentationRoutes({
      app,
      store,
      database,
      masterKey,
      runner,
      privateTaskPlanResponse: async () => null,
      workspacePreviewResponse: (p: typeof preview) => ({
        id: p.id,
        workspaceId: p.workspaceId,
        label: p.label,
        port: p.port,
        visibility: p.visibility,
        status: p.status,
        url: `https://garden.test/__garden/preview/${p.slug}/`,
        expiresAt: p.expiresAt,
        lastAccessedAt: p.lastAccessedAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      })
    } as unknown as RouteContext);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('returns registry-bound results and bounded file observations with no generation or credential minting', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/presentation`,
      headers: { 'x-test-owner': 'yes' }
    });
    expect(response.statusCode).toBe(200);
    const body = TaskPresentation.parse(response.json());
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      previewId,
      url: 'https://garden.test/__garden/preview/0123456789abcdef0123456789abcdef/',
      accessPath: `/v1/previews/${previewId}/access`
    });
    expect(body.results[1]).toMatchObject({
      kind: 'file',
      path: 'workspace/maze/index.html',
      status: 'ready',
      sizeBytes: 21_000
    });
    expect(reads).toContain(
      `/v1/workspaces/${workspaceId}/file?path=workspace%2Fmaze%2Findex.html&maxBytes=1`
    );
    expect(response.body).not.toMatch(/untrusted\.test|secret|STREAM-TOKEN/);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('shows the latest stored source version without publication tool receipts and keeps older downloads in history', async () => {
    const task = await store.createTask({
      userId: ownerId,
      workspaceId,
      titleCiphertext: encryptJson({ title: 'Versioned app' }, key, `task-title:${workspaceId}`),
      promptCiphertext: encryptJson(
        { prompt: 'Update the app' },
        key,
        `task-prompt:${workspaceId}`
      ),
      nameIndex: { nameTokens: 'versioned app', openingTokens: 'update' },
      modelId: 'test/model',
      privacyRoute: 'provider_zdr',
      maxComputeCredits: 1
    });
    const sourceKey = sha256(randomUUID());
    const published = [];
    for (const logicalKey of [sourceKey, sourceKey, sha256(randomUUID())]) {
      const artifact = await store.createArtifact({
        userId: ownerId,
        workspaceId,
        taskId: task.id,
        logicalKey,
        nameCiphertext: encryptJson({ name: 'app.html' }, key, `artifact-name:${workspaceId}`),
        mimeType: 'application/octet-stream',
        sizeBytes: 123,
        sha256: sha256(randomUUID()),
        storageKey: randomUUID()
      });
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'artifact',
        summary: 'Published app',
        payloadCiphertext: encryptJson({ artifactId: artifact.id }, key, `task-event:${task.id}`)
      });
      published.push(String(artifact.id));
    }
    expect(published).toHaveLength(3);
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.id}/presentation`,
      headers: { 'x-test-owner': 'yes' }
    });
    expect(response.statusCode).toBe(200);
    const body = TaskPresentation.parse(response.json());
    expect(body.results.filter((result) => result.kind === 'artifact')).toHaveLength(3);
    expect(body.surface?.currentResultIds).toEqual(
      expect.arrayContaining(published.slice(1).map((id) => `artifact:${id}`))
    );
    expect(body.surface?.currentResultIds).toHaveLength(2);
    expect(body.surface?.currentResultIds).not.toContain(`artifact:${published[0]}`);
    expect(response.body).not.toContain(sourceKey);
  });

  it('merges a ready execution with its original sealed artifacts and live source previews', async () => {
    const sourceId = randomUUID(),
      executionId = randomUUID(),
      sourceKey = Buffer.alloc(32, 11);
    await store.createWorkspace({
      id: sourceId,
      userId: ownerId,
      name: 'Source',
      storageLimitBytes: 1_000_000,
      imageRevision: 'test',
      region: 'local',
      wrappedKey: wrapDataKey(sourceKey, masterKey, sourceId)
    });
    await store.updateWorkspaceStatus(sourceId, 'running');
    const task = await store.createTask({
      userId: ownerId,
      workspaceId: sourceId,
      modelId: 'test/model',
      privacyRoute: 'provider_zdr',
      securityMode: 'balanced',
      maxComputeCredits: 1,
      titleCiphertext: encryptJson({ title: 'Research app' }, sourceKey, `task-title:${sourceId}`),
      promptCiphertext: encryptJson(
        { prompt: 'Extend the research app' },
        sourceKey,
        `task-prompt:${sourceId}`
      ),
      nameIndex: { nameTokens: 'research', openingTokens: 'extend' }
    });
    const prepared = await store.beginProjectExecution({
      userId: ownerId,
      taskId: task.id,
      workspaceId: executionId,
      wrappedKey: wrapDataKey(key, masterKey, executionId),
      seedKind: 'legacy',
      sourceManifestCiphertext: encryptJson({ paths: [] }, key)
    });
    expect(prepared?.status).toBe('preparing');
    expect(
      await store.finishProjectExecution({
        userId: ownerId,
        taskId: task.id,
        workspaceId: executionId,
        receiptCiphertext: encryptJson({ copied: [] }, key),
        rewrite: () => ({
          titleCiphertext: encryptJson({ title: 'Research app' }, key, `task-title:${executionId}`),
          promptCiphertext: encryptJson(
            { prompt: 'Extend the research app' },
            key,
            `task-prompt:${executionId}`
          )
        })
      })
    ).toBe(true);
    expect(await store.getProjectExecution(ownerId, task.id)).toMatchObject({
      status: 'ready',
      sourceWorkspaceId: sourceId,
      workspaceId: executionId
    });
    const published = [];
    for (const [id, dataKey, name, port] of [
      [sourceId, sourceKey, 'Original research.pdf', 8101],
      [executionId, key, 'Extended research.pdf', 8102]
    ] as const) {
      const artifact = await store.createArtifact({
        userId: ownerId,
        workspaceId: id,
        taskId: task.id,
        logicalKey: name,
        nameCiphertext: encryptJson({ name }, dataKey, `artifact-name:${id}`),
        mimeType: 'application/pdf',
        sizeBytes: 123,
        sha256: sha256(name),
        storageKey: randomUUID()
      });
      const preview = await store.createWorkspacePreview({
        userId: ownerId,
        workspaceId: id,
        label: name,
        port,
        slug: randomUUID().replaceAll('-', ''),
        accessTokenHash: sha256(randomUUID())
      });
      await store.appendTaskEvent({
        taskId: task.id,
        kind: 'preview',
        summary: 'Published app',
        payloadCiphertext: encryptJson({ previewId: preview.id }, key, `task-event:${task.id}`)
      });
      published.push({
        workspaceId: id,
        artifactId: String(artifact.id),
        previewId: preview.id,
        name,
        port
      });
    }
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.id}/presentation`,
      headers: { 'x-test-owner': 'yes' }
    });
    expect(response.statusCode).toBe(200);
    const body = TaskPresentation.parse(response.json<unknown>());
    expect(body.results.filter((result) => result.kind === 'artifact')).toHaveLength(2);
    expect(body.results.filter((result) => result.kind === 'preview')).toHaveLength(2);
    expect(published).toHaveLength(2);
    for (const result of published) {
      expect(body.results.find((item) => item.artifactId === result.artifactId)).toMatchObject({
        title: result.name,
        workspaceId: result.workspaceId,
        status: 'ready',
        sha256: sha256(result.name),
        url: `/v1/artifacts/${result.artifactId}/content`
      });
      expect(body.results.find((item) => item.previewId === result.previewId)).toMatchObject({
        status: 'ready',
        accessPath: `/v1/previews/${result.previewId}/access`
      });
      expect(runner.request).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: result.workspaceId,
          path: `/v1/workspaces/${result.workspaceId}/preview-check/${result.port}`
        })
      );
    }
    expect(reads).not.toContain(`/v1/workspaces/${executionId}/preview-check/8101`);
  });

  it('rejects an owner-mismatched task before reading its events or files', async () => {
    const before = reads.length;
    const response = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/presentation` });
    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toContain('Maze game');
    expect(reads).toHaveLength(before);
  });

  it('streams a bundle scoped to this task and preserves owner authorization', async () => {
    const raw = runner.raw as ReturnType<typeof vi.fn>;
    raw.mockImplementationOnce(async (input: { body: string }) => {
      expect(JSON.parse(input.body)).toEqual({ paths: ['workspace/maze/index.html'] });
      return new Response('zip-bytes', { headers: { 'content-type': 'application/zip' } });
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/bundle`,
      headers: { 'x-test-owner': 'yes' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('zip-bytes');
    const before = raw.mock.calls.length;
    const denied = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/bundle` });
    expect(denied.statusCode).not.toBe(200);
    expect(raw.mock.calls).toHaveLength(before);
  });

  it('degrades runner failure to unknown instead of a ready but dead app', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + AVAILABILITY_TTL_MS + 1);
    runner.request.mockRejectedValueOnce(new Error('offline'));
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/presentation`,
      headers: { 'x-test-owner': 'yes' }
    });
    expect(response.statusCode).toBe(200);
    expect(TaskPresentation.parse(response.json<unknown>()).results[0]).toMatchObject({
      status: 'unknown',
      url: null,
      accessPath: null
    });
    vi.restoreAllMocks();
  });
});
