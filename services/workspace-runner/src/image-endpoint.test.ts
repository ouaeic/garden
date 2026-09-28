import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

/**
 * The route that answers with a picture rather than with a file.
 *
 * Written against the real server because the bug it closes was a route that did not exist: a
 * photograph from a phone reached the workspace, sat in the Files pane where the owner could see
 * it, and could not be looked at - the file endpoint answered HEIC as bytes of no stated kind, and
 * the worker refused anything it had not been told was one of four types. What has to be asserted
 * here is that the conversion happens on this side of the wire, before a request is built, rather
 * than being discovered by a provider.
 *
 * The converter is a stand-in. What is under test is which files reach one and what is done with
 * what comes back, and a test that needed ImageMagick installed would be a test that ran nowhere.
 */
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

const WORKSPACE = '00000000-0000-4000-8000-0000000000c1';

const runnerConfig = (workspaceRoot: string, secret: string, converter: string): RunnerConfig => ({
  RUNNER_HOST: '127.0.0.1',
  RUNNER_PORT: 0,
  RUNNER_SHARED_SECRET: secret,
  WORKSPACE_ROOT: workspaceRoot,
  TAR_EXECUTABLE: '/usr/bin/tar',
  SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
  BROWSER_USE_DESKTOP_DISPLAY: false,
  BROWSER_CPU_NICE: 0,
  MAX_EXECUTION_SECONDS: 30,
  RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
  IMAGE_CONVERT_EXECUTABLE: converter,
  MAX_BACKGROUND_SECONDS: 120,
  COMMAND_PROCESS_LIMIT: 1024,
  COMMAND_OPEN_FILE_LIMIT: 4096,
  MAX_FILE_BYTES: 1024 * 1024,
  RESERVED_PREVIEW_PORTS: [],
  CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
  CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
  CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
  CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
  CHECKPOINT_RETAIN_TURNS: 20,
  CHECKPOINT_RETAIN_DAILY_DAYS: 14,
  CHECKPOINT_MAX_FILES: 250_000,
  CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
  ISOLATE_AGENT_NETWORK: false
});

/** A server with one workspace holding the named files, and a converter that echoes its input. */
const serve = async (files: Record<string, string>) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-image-'));
  disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
  const converter = path.join(workspaceRoot, 'magick');
  await writeFile(converter, '#!/bin/sh\nprintf converted-\ncat\n');
  await chmod(converter, 0o755);

  const root = path.join(workspaceRoot, WORKSPACE);
  await ensureWorkspace(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, 'workspace', name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const secret = 'runner-image-test-secret-at-least-32-characters';
  const app = await buildServer(runnerConfig(workspaceRoot, secret, converter));
  disposers.push(() => app.close());
  // A capability is spent when it is used, so each read is minted its own - which is also what the
  // worker does, and a shared one here would fail the second look at a picture rather than the code.
  const read = (name: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/workspaces/${WORKSPACE}/image?path=${encodeURIComponent(`workspace/${name}`)}`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'task',
            workspaceId: WORKSPACE,
            role: 'agent',
            scopes: ['files.read'],
            aud: capabilityAudience('GET', `/v1/workspaces/${WORKSPACE}/image`),
            nonce: randomUUID()
          },
          secret
        )}`
      }
    });
  return { read };
};

describe('reading a picture a model can be shown', () => {
  /*
   * The commonest thing a phone owner attaches. Before this route it was the one file garden
   * could see and not look at.
   */
  it('converts a phone photograph and says it did', async () => {
    const { read } = await serve({ 'IMG_0421.HEIC': 'heic-bytes' });
    const response = await read('IMG_0421.HEIC');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['x-image-source-type']).toBe('image/heic');
    expect(response.rawPayload.toString()).toBe('converted-heic-bytes');
  });

  it('converts a scan and a saved web image the same way', async () => {
    const { read } = await serve({ 'scan.tiff': 'tiff-bytes', 'saved.avif': 'avif-bytes' });
    for (const name of ['scan.tiff', 'saved.avif']) {
      const response = await read(name);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/jpeg');
    }
  });

  it('rasterises a drawing the agent made to something a model will take', async () => {
    const { read } = await serve({ 'plan.svg': '<svg/>' });
    const response = await read('plan.svg');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['x-image-source-type']).toBe('image/svg+xml');
  });

  /*
   * The other half of the promise, and the half that was a leak. A picture a model already accepts
   * used to be handed over exactly as it sat on disk, which sounded like care for the owner's
   * sharpness and meant that the one format every camera roll produces went out with the camera's
   * own notes on it. The converter is where the stripping happens, so a photograph has to reach it.
   */
  it('sends a photograph to the converter rather than out as it sits on disk', async () => {
    const { read } = await serve({ 'IMG_0422.JPG': 'jpeg-bytes' });
    const response = await read('IMG_0422.JPG');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['x-image-source-type']).toBe('image/jpeg');
    expect(response.rawPayload.toString()).toBe('converted-jpeg-bytes');
  });

  it('sends a screenshot, a saved WebP and a chart through it as well', async () => {
    const { read } = await serve({
      'shot.png': 'png-bytes',
      'saved.webp': 'webp-bytes',
      'chart.gif': 'gif-bytes'
    });
    for (const name of ['shot.png', 'saved.webp', 'chart.gif']) {
      const response = await read(name);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.rawPayload.toString()).toContain('converted-');
    }
  });

  it('refuses a file that was never a picture, and says what to read it with', async () => {
    const { read } = await serve({ 'notes.md': '# notes' });
    const response = await read('notes.md');
    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('file_read');
  });

  it('answers a picture that is not there as missing rather than as a bad request', async () => {
    const { read } = await serve({});
    const response = await read('holiday.heic');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'file_not_found' } });
  });

  /* The workspace boundary is the file endpoint's, and this route must not be the way around it. */
  it('will not read a picture outside the workspace', async () => {
    const { read } = await serve({});
    const response = await read('../../../etc/hosts.png');
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).not.toBe(200);
  });
});
