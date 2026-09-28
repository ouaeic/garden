import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import { authenticateRunnerRequest } from './auth.js';
import { registerDocumentRoutes } from './document-routes.js';
import { execute } from './execution.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const otherWorkspace = '00000000-0000-4000-8000-000000000002';
const secret = 'document-read-test-secret-at-least-thirty-two';
const url = `/v1/workspaces/${workspaceId}/documents`;
const script = path.resolve('../../scripts/garden-document');

describe('scoped native document reading', () => {
  it('shares file path conventions, preserves source links and refuses private or escaped files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'garden-document-route-'));
    const root = path.join(directory, workspaceId);
    await mkdir(path.join(root, 'workspace', 'reports'), { recursive: true });
    await mkdir(path.join(root, '.home'), { recursive: true });
    await mkdir(path.join(root, '.garden', 'artifacts'), { recursive: true });
    await writeFile(path.join(root, 'workspace', 'reports', 'note.txt'), 'Sparse readable text');
    await writeFile(path.join(root, '.home', 'private.txt'), 'PRIVATE CANARY');
    await writeFile(path.join(root, '.garden', 'artifacts', 'report.txt'), 'Published evidence');
    await symlink(
      path.join(root, '.home', 'private.txt'),
      path.join(root, 'workspace', 'escaped.txt')
    );
    const app = Fastify();
    app.addHook('preHandler', authenticateRunnerRequest(secret));
    registerDocumentRoutes(
      app,
      directory,
      { maximumSeconds: 300 },
      async (root, input, options) => {
        const request = input as { args: string[] };
        return execute(
          root,
          { ...request, executable: '/usr/bin/python3', args: [script, ...request.args] },
          options
        );
      }
    );
    const auth = (scopes = ['files.read'], id = workspaceId) => ({
      authorization: `Bearer ${signCapabilityToken({ sub: 'task-1', workspaceId: id, role: 'agent', scopes, nonce: randomUUID(), aud: capabilityAudience('POST', url) }, secret, 60)}`
    });
    const read = (requested: string, headers = auth()) =>
      app.inject({
        method: 'POST',
        url,
        headers,
        payload: { action: 'read', path: requested, startPage: 1, endPage: 20, maxCharacters: 1000 }
      });
    try {
      for (const requested of [
        'reports/note.txt',
        'workspace/reports/note.txt',
        path.join(root, 'workspace', 'reports', 'note.txt')
      ]) {
        const result = await read(requested);
        expect(result.statusCode, result.body).toBe(200);
        const body = result.json<Awaited<ReturnType<typeof execute>>>();
        expect(body.exitCode, body.stderr).toBe(0);
        expect(JSON.parse(body.stdout)).toMatchObject({
          path: 'workspace/reports/note.txt',
          text: 'Sparse readable text'
        });
      }
      const search = await app.inject({
        method: 'POST',
        url,
        headers: auth(),
        payload: {
          action: 'search',
          path: 'reports',
          query: 'Sparse',
          alternatives: [],
          maxFiles: 10,
          fileOffset: 0,
          maxResults: 10,
          maxPages: 20
        }
      });
      expect(search.statusCode, search.body).toBe(200);
      expect(
        (
          JSON.parse(search.json<Awaited<ReturnType<typeof execute>>>().stdout) as {
            results: unknown[];
          }
        ).results
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'workspace/reports/note.txt' })])
      );
      const published = await read('.garden/artifacts/report.txt');
      expect(
        (
          JSON.parse(published.json<Awaited<ReturnType<typeof execute>>>().stdout) as {
            text: string;
          }
        ).text
      ).toBe('Published evidence');
      for (const requested of [
        '.home/private.txt',
        '../private.txt',
        path.join(root, '.home', 'private.txt')
      ]) {
        expect((await read(requested)).statusCode).toBeGreaterThanOrEqual(400);
      }
      const escaped = await read('escaped.txt');
      expect(escaped.json<Awaited<ReturnType<typeof execute>>>().exitCode).not.toBe(0);
      expect(escaped.body).not.toContain('PRIVATE CANARY');
      expect((await read('reports/note.txt', auth(['exec']))).statusCode).toBeGreaterThanOrEqual(
        400
      );
      expect(
        (await read('reports/note.txt', auth(['files.read'], otherWorkspace))).statusCode
      ).toBeGreaterThanOrEqual(400);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
