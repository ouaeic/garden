import { randomBytes, randomUUID } from 'node:crypto';
import { get, type IncomingMessage } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerFileReadRoutes } from './file-downloads.js';
import { acquireProjectReference, ProjectReferences } from './project-reference-lock.js';

it.each(['finish', 'abort'] as const)(
  'holds immutable file references through a backpressured ZIP until %s',
  async (ending) => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-stream-reference-'));
    const project = randomUUID();
    const publicRoot = path.join(root, '.project-store', project, 'public');
    const version = path.join(publicRoot, 'versions', randomUUID());
    const directory = path.join(version, 'workspace');
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const payload = randomBytes(8 * 1024 * 1024);
    await writeFile(path.join(directory, 'first.bin'), payload);
    await writeFile(path.join(directory, 'second.bin'), payload);
    const references = new ProjectReferences(root);
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.capability = { scopes: ['files.read'] } as never;
    });
    let opened = 0,
      released = 0;
    registerFileReadRoutes(app, '/version', async () => {
      const lease = await references.acquire(project);
      opened++;
      return {
        root: version,
        release: async () => {
          await lease.release();
          released++;
        }
      };
    });
    let response: IncomingMessage | undefined;
    let request: ReturnType<typeof get> | undefined;
    try {
      const url = await app.listen({ host: '127.0.0.1', port: 0 });
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        request = get(`${url}/version/directory.zip?path=workspace`, (incoming) => {
          incoming.pause();
          resolve(incoming);
        });
        request.once('error', reject);
      });
      expect(response.statusCode).toBe(200);
      expect(opened).toBe(1);
      expect(released).toBe(0);
      await expect(acquireProjectReference(root, project, 'write')).rejects.toMatchObject({
        status: 409
      });
      if (ending === 'abort') response.destroy();
      else {
        let bytes = 0;
        for await (const chunk of response) bytes += (chunk as Buffer).length;
        expect(bytes).toBeGreaterThan(payload.length);
      }
      await expect.poll(() => released).toBe(1);
      const exclusive = await acquireProjectReference(root, project, 'write');
      await exclusive.release();
      // Error responses also finish the reference acquired before file resolution.
      const missing = await app.inject({ url: '/version/download?path=workspace/missing' });
      expect(missing.statusCode).not.toBe(200);
      await expect.poll(() => released).toBe(2);
      const afterError = await acquireProjectReference(root, project, 'write');
      await afterError.release();
    } finally {
      response?.destroy();
      request?.destroy();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
