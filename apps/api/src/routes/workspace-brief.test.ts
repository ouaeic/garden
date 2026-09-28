import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { RouteContext } from '../http/server-context.js';
import { registerWorkspaceRoutes } from './workspaces.js';

describe('garden workspace brief editor', () => {
  const app = Fastify(),
    files = new Map<string, string>(),
    workspace = { id: 'workspace', userId: 'owner', storageBytes: 0, storageLimitBytes: 1e9 };
  const raw = vi.fn(async (input: { path: string }) => {
    const file = new URL(input.path, 'http://runner').searchParams.get('path')!;
    return new Response(files.get(file) ?? '', { status: files.has(file) ? 200 : 404 });
  });
  const request = vi.fn(async (input: { method?: string; path: string; body?: ArrayBuffer }) => {
    if (input.method === 'PUT')
      files.set(
        new URL(input.path, 'http://runner').searchParams.get('path')!,
        Buffer.from(input.body!).toString()
      );
    return { storageBytes: 10 };
  });
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'owner' } as typeof req.user;
  });
  registerWorkspaceRoutes({
    app,
    store: { getWorkspace: async () => workspace, setWorkspaceStorage: async () => {} },
    runner: { raw, request },
    idempotent: async (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn()
  } as unknown as RouteContext);
  afterAll(async () => app.close());
  it('reads the preferred brief, falls back through every supported alias and saves the preferred file', async () => {
    files.set('workspace/GARDEN.md', 'Garden guidance');
    files.set('workspace/GARDEN.md', 'Specific compatibility');
    files.set('workspace/OPEN_CLOUD.md', 'Cloud compatibility');
    files.set('workspace/AGENTS.md', 'Shared guidance');
    const url = '/v1/workspaces/workspace/brief';
    for (const [file, expected] of [
      ['workspace/GARDEN.md', 'Garden guidance'],
      ['workspace/GARDEN.md', 'Specific compatibility'],
      ['workspace/OPEN_CLOUD.md', 'Cloud compatibility'],
      ['workspace/AGENTS.md', 'Shared guidance']
    ]) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ markdown: expected, path: 'workspace/GARDEN.md' });
      files.delete(file!);
    }
    expect(raw.mock.calls.length).toBeGreaterThan(4);
    const saved = await app.inject({
      method: 'PUT',
      url,
      payload: { markdown: 'Owner edited guidance' }
    });
    expect(saved.statusCode).toBe(200);
    expect(files.get('workspace/GARDEN.md')).toBe('Owner edited guidance');
    expect(files.has('workspace/GARDEN.md')).toBe(false);
  });
});
