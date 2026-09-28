import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { DesktopManager } from './desktop.js';
import { ensureWorkspace } from './files.js';
import { DesktopControl } from './holder.js';
import { agentHome, hostSearchPath } from './execution.js';
import { buildServer } from './server.js';

describe('a preview whose app is not running', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  /*
   * These bytes go through the preview gateway to a browser without being touched, so the owner
   * opened the link they had been given and read
   * `{"error":{"code":"preview_unavailable",...}}` as text on the page. Everything else this
   * service answers is read by the worker, which is why it was JSON; the gateway's own two failure
   * pages are HTML for exactly this reason and this one sits a layer below them.
   */
  it('answers the browser with a page rather than with JSON', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-preview-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-preview-test-secret-at-least-32-characters';
    const config = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      BROWSER_CPU_NICE: 0,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      IMAGE_CONVERT_EXECUTABLE: 'magick',
      MAX_BACKGROUND_SECONDS: 120,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: '/var/lib/dpkg/status',
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    } as RunnerConfig;
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000a1';
    await ensureWorkspace(path.join(workspaceRoot, id));
    // A high port nothing binds, which is the case this covers.
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['preview:45999'],
        aud: capabilityAudience('GET', `/v1/workspaces/${id}/preview/45999/`),
        nonce: 'preview-test'
      },
      secret
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/preview/45999/`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Nothing is listening');
    expect(response.body).not.toContain('"error"');
  });
});

describe('workspace export', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('streams workspace files and artifacts without browser profile data', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-export-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-export-test-secret-at-least-32-characters';
    const config: RunnerConfig = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      BROWSER_CPU_NICE: 0,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      IMAGE_CONVERT_EXECUTABLE: 'magick',
      MAX_BACKGROUND_SECONDS: 120,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: '/var/lib/dpkg/status',
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    };
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000001';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    await writeFile(path.join(root, 'workspace', 'report.txt'), 'private report');
    await writeFile(path.join(root, '.garden', 'artifacts', 'chart.svg'), '<svg/>');
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'must-not-export');
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['files.read'],
        aud: capabilityAudience('GET', `/v1/workspaces/${id}/export`),
        nonce: 'export-test'
      },
      secret
    );

    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/export`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/gzip');
    expect(response.headers['content-disposition']).toContain(`garden-workspace-${id}.tar.gz`);
    const archive = gunzipSync(response.rawPayload).toString('utf8');
    expect(archive).toContain('workspace/report.txt');
    expect(archive).toContain('private report');
    expect(archive).toContain('.garden/artifacts/chart.svg');
    expect(archive).not.toContain('must-not-export');
    expect(archive).not.toContain('.garden/browser');

    const missingToken = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['files.read'],
        aud: capabilityAudience('GET', `/v1/workspaces/${id}/file`),
        nonce: 'missing-file-test'
      },
      secret
    );
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/file?path=workspace%2FGARDEN.md`,
      headers: { authorization: `Bearer ${missingToken}` }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'file_not_found' } });

    const replay = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/export`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('closes a terminal when the capability that opened it expires', async () => {
    // The browser and desktop streams have always done this. Without it here a sixty-second
    // token bought a shell on the box that ran until one side hung up, with nothing able to
    // revoke it in between.
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-terminal-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-terminal-test-secret-at-least-32-characters';
    const config: RunnerConfig = {
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
      IMAGE_CONVERT_EXECUTABLE: 'magick',
      MAX_BACKGROUND_SECONDS: 120,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/usr/bin/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/usr/sbin/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: '/var/lib/dpkg/status',
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    };
    const app = await buildServer(config);
    disposers.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const id = '00000000-0000-4000-8000-000000000002';
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['terminal'],
        aud: capabilityAudience('GET', `/v1/workspaces/${id}/terminal`),
        nonce: 'terminal-expiry-test'
      },
      secret,
      // Long enough that the handshake always wins the race against the clock. At one second a
      // loaded machine could finish signing after the token had already expired, and the server
      // then refused the upgrade instead of accepting it and closing on expiry - the same
      // behaviour arriving as an error rather than the close this asserts.
      3
    );
    const socket = new WebSocket(
      `${address.replace('http://', 'ws://')}/v1/workspaces/${id}/terminal`,
      ['garden-capability', token]
    );
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
      socket.once('error', reject);
    });
    expect(closed).toEqual({ code: 1008, reason: 'Capability expired' });
  }, 15_000);
});

describe('turn checkpoints over the runner API', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('creates, previews and restores one, and refuses a token without workspace.manage', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-checkpoint-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-checkpoint-test-secret-at-least-32-chars';
    const config: RunnerConfig = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      BROWSER_CPU_NICE: 0,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      IMAGE_CONVERT_EXECUTABLE: 'magick',
      MAX_BACKGROUND_SECONDS: 120,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: path.join(workspaceRoot, 'dpkg-status'),
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false
    };
    const app = await buildServer(config, {
      // The disk this case reads is stated, not measured. Taking a checkpoint passes the host
      // storage floor, so on a machine under two per cent free this failed with a sentence about
      // a full disk - which is what it looks like when the code is broken, and it was not.
      // `checkpoints.test.ts` carries the rest of the reasoning.
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000003';
    const checkpointId = '018f3dd3-8a2a-7d8b-8d3c-a2f4c8316be9';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    await writeFile(path.join(root, 'workspace', 'notes.md'), 'the good version\n');
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=live');

    const manage = (nonce: string, method: string, route: string): string =>
      signCapabilityToken(
        {
          sub: 'worker',
          workspaceId: id,
          role: 'agent',
          scopes: ['workspace.manage'],
          aud: capabilityAudience(method, route),
          nonce
        },
        secret
      );

    const created = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkpoints`,
      headers: {
        authorization: `Bearer ${manage('cp-create', 'POST', `/v1/workspaces/${id}/checkpoints`)}`
      },
      payload: { checkpointId, taskId: '00000000-0000-4000-8000-0000000000aa', turn: 0 }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: checkpointId, mechanism: 'content', pruned: [] });

    await writeFile(path.join(root, 'workspace', 'notes.md'), 'the bad version\n');
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'session=signed-in-since');

    const preview = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}/preview`,
      headers: {
        authorization: `Bearer ${manage('cp-preview', 'GET', `/v1/workspaces/${id}/checkpoints/${checkpointId}/preview`)}`
      }
    });
    expect(preview.json()).toMatchObject({
      modifiedCount: 1,
      addedCount: 0,
      deletedCount: 0,
      modified: [{ path: 'workspace/notes.md' }]
    });

    const forbidden = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}/restore`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'worker',
            workspaceId: id,
            role: 'agent',
            scopes: ['files.read'],
            aud: capabilityAudience(
              'POST',
              `/v1/workspaces/${id}/checkpoints/${checkpointId}/restore`
            ),
            nonce: 'cp-weak'
          },
          secret
        )}`
      }
    });
    expect(forbidden.statusCode).toBe(403);

    const restored = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/checkpoints/${checkpointId}/restore`,
      headers: {
        authorization: `Bearer ${manage('cp-restore', 'POST', `/v1/workspaces/${id}/checkpoints/${checkpointId}/restore`)}`
      }
    });
    expect(restored.json()).toMatchObject({ restoredFileCount: 1, removedFileCount: 0 });
    await expect(readFile(path.join(root, 'workspace', 'notes.md'), 'utf8')).resolves.toBe(
      'the good version\n'
    );
    // The sign-in that happened after the checkpoint survives the rewind, which is the point.
    await expect(readFile(path.join(root, '.garden', 'browser', 'Cookies'), 'utf8')).resolves.toBe(
      'session=signed-in-since'
    );
  });
});

describe('file organisation and toolchain routes', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig => ({
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: 4300,
    RUNNER_SHARED_SECRET: secret,
    WORKSPACE_ROOT: workspaceRoot,
    TAR_EXECUTABLE: '/usr/bin/tar',
    SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
    BROWSER_USE_DESKTOP_DISPLAY: false,
    BROWSER_CPU_NICE: 0,
    MAX_EXECUTION_SECONDS: 30,
    RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
    IMAGE_CONVERT_EXECUTABLE: 'magick',
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

  const harness = async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-files-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-files-route-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000010';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    // A nonce is spent on first use, so every request in a test needs its own.
    let issued = 0;
    const token = (scopes: string[], audience: { method: string; path: string }) =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes,
          aud: capabilityAudience(audience.method, audience.path),
          nonce: `files-${(issued += 1)}`
        },
        secret
      );
    return { app, id, root, token };
  };

  it('never replaces an existing file when a browser upload asks to create a new one', async () => {
    const { app, id, root, token } = await harness();
    const route = `/v1/workspaces/${id}/file`;
    const create = (content: string) =>
      app.inject({
        method: 'PUT',
        url: `${route}?path=workspace/upload.txt&createOnly=true`,
        headers: {
          authorization: `Bearer ${token(['files.write'], { method: 'PUT', path: route })}`,
          'content-type': 'application/octet-stream'
        },
        payload: Buffer.from(content)
      });
    expect((await create('original')).statusCode).toBe(200);
    expect((await create('replacement')).statusCode).toBe(409);
    expect(await readFile(path.join(root, 'workspace/upload.txt'), 'utf8')).toBe('original');
  });

  it('exposes file identity for a complete inspector window but never for a partial read', async () => {
    const { app, id, root, token } = await harness();
    const content = Buffer.from('{"value":"α"}\r\n');
    await writeFile(path.join(root, 'workspace/result.json'), content);
    for (const maxBytes of [262144, 5]) {
      const route = `/v1/workspaces/${id}/file`;
      const response = await app.inject({
        method: 'GET',
        url: `${route}?path=workspace/result.json&startLine=1&maxBytes=${maxBytes}`,
        headers: {
          authorization: `Bearer ${token(['files.read'], { method: 'GET', path: route })}`
        }
      });
      expect(response.statusCode, response.body).toBe(200);
      if (maxBytes === 262144) {
        expect(response.rawPayload).toEqual(content);
        expect(response.headers['x-content-sha256']).toBe(
          createHash('sha256').update(content).digest('hex')
        );
        expect(response.headers['x-truncated']).toBe('false');
      } else {
        expect(response.rawPayload.length).toBeLessThanOrEqual(maxBytes);
        expect(response.headers['x-content-sha256']).toBeUndefined();
        expect(response.headers['x-truncated']).toBe('true');
      }
    }
  });

  it('creates a folder and renames a file without ever overwriting one', async () => {
    const { app, id, root, token } = await harness();
    const authorization = (route: string) =>
      `Bearer ${token(['files.write'], { method: 'POST', path: `/v1/workspaces/${id}/files/${route}` })}`;
    await writeFile(path.join(root, 'workspace', 'draft.md'), '# draft');

    const folder = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/folder`,
      headers: { authorization: authorization('folder') },
      payload: { path: 'workspace/applications' }
    });
    expect(folder.statusCode).toBe(200);
    expect(folder.json()).toEqual({ path: path.join('workspace', 'applications') });

    const renamed = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/rename`,
      headers: { authorization: authorization('rename') },
      payload: { from: 'workspace/draft.md', to: 'workspace/applications/cover-letter.md' }
    });
    expect(renamed.statusCode).toBe(200);
    expect(
      await readFile(path.join(root, 'workspace', 'applications', 'cover-letter.md'), 'utf8')
    ).toBe('# draft');

    await writeFile(path.join(root, 'workspace', 'keep.md'), 'keep me');
    const clash = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/rename`,
      headers: { authorization: authorization('rename') },
      payload: { from: 'workspace/keep.md', to: 'workspace/applications/cover-letter.md' }
    });
    // A conflict, not a generic failure: the file browser has to be able to say which it was.
    expect(clash.statusCode).toBe(409);
    expect(await readFile(path.join(root, 'workspace', 'keep.md'), 'utf8')).toBe('keep me');
  });

  it('keeps both routes inside the workspace and behind files.write', async () => {
    const { app, id, token } = await harness();
    const escape = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/folder`,
      headers: {
        authorization: `Bearer ${token(['files.write'], { method: 'POST', path: `/v1/workspaces/${id}/files/folder` })}`
      },
      payload: { path: '../../escaped' }
    });
    expect(escape.statusCode).toBe(400);
    const profile = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/rename`,
      headers: {
        authorization: `Bearer ${token(['files.write'], { method: 'POST', path: `/v1/workspaces/${id}/files/rename` })}`
      },
      payload: { from: '.garden/browser/Cookies', to: 'workspace/cookies' }
    });
    expect(profile.statusCode).toBe(400);
    const readOnly = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/files/folder`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'POST', path: `/v1/workspaces/${id}/files/folder` })}`
      },
      payload: { path: 'workspace/nope' }
    });
    expect(readOnly.statusCode).toBe(403);
  });

  it('refuses a capability minted for one request when it is presented on another', async () => {
    // The claim the token carries had never been compared against the request serving it, so a
    // token seen on a file listing was still good against every other route its scopes reached.
    const { app, id, token } = await harness();
    const filesPath = `/v1/workspaces/${id}/files`;

    const onItsOwnRequest = await app.inject({
      method: 'GET',
      url: `${filesPath}?path=workspace`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: `${filesPath}?path=workspace` })}`
      }
    });
    expect(onItsOwnRequest.statusCode).toBe(200);

    const elsewhere = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/usage`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: filesPath })}`
      }
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json()).toMatchObject({
      error: { message: 'Capability token was minted for a different request' }
    });

    // The arguments of a call are not its identity: one listing capability still answers for the
    // folder it was asked about, whichever query string the request happens to carry.
    const differentQuery = await app.inject({
      method: 'GET',
      url: `${filesPath}?path=workspace`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: `${filesPath}?path=.garden/artifacts` })}`
      }
    });
    expect(differentQuery.statusCode).toBe(200);
  });

  it('counts the owner data in the storage figure and leaves the agent home out of it', async () => {
    /*
     * The decision, pinned as a number rather than left to be inferred from the entry list.
     *
     * `.home` is the agent's `$HOME` and holds toolchain caches - a Rust toolchain alone is 88,021
     * files - and it is deliberately not counted: the figure is a tree walk behind the API's
     * five-second metering timeout, and the quota it feeds has no way to let an owner clear that
     * directory, because `.home` is in `CONTAINER_ONLY` and the file routes cannot reach it. What
     * that costs is a per-workspace limit that does not bound `$HOME`; the host-disk floor is what
     * does. Written as an exact total so it fails in both directions - adding `.home` to the list,
     * and dropping any of the three that are on it.
     */
    const { app, id, root, token } = await harness();
    await writeFile(path.join(root, 'workspace', 'report.md'), 'w'.repeat(1_000));
    await writeFile(path.join(root, '.garden', 'artifacts', 'chart.png'), 'a'.repeat(200));
    await writeFile(path.join(root, '.garden', 'browser', 'Cookies'), 'b'.repeat(30));
    // Four hundred times the owner's own data, which is the ratio a real toolchain cache arrives in.
    await mkdir(path.join(agentHome(root), '.cargo'), { recursive: true });
    await writeFile(path.join(agentHome(root), '.cargo', 'registry'), 'h'.repeat(500_000));

    const usagePath = `/v1/workspaces/${id}/usage`;
    const usage = await app.inject({
      method: 'GET',
      url: usagePath,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'GET', path: usagePath })}`
      }
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json<{ storageBytes: number }>().storageBytes).toBe(1_230);
  });

  it('answers what the computer can actually do with documents', async () => {
    const { app, id, token } = await harness();
    const report = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/toolchain`,
      headers: {
        authorization: `Bearer ${token(['exec'], { method: 'GET', path: `/v1/workspaces/${id}/toolchain` })}`
      }
    });
    expect(report.statusCode).toBe(200);
    const body: {
      capabilities: Array<{ id: string; ready: boolean; install?: string }>;
      summary: string;
    } = report.json();
    expect(body.capabilities.some((capability) => capability.id === 'office-authoring')).toBe(true);
    // Whatever the host has, every unmet capability has to say how it would be met.
    for (const capability of body.capabilities)
      expect(capability.ready || typeof capability.install === 'string').toBe(true);
    expect(body.summary.length).toBeGreaterThan(0);

    const probe = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/toolchain/probe`,
      headers: {
        authorization: `Bearer ${token(['exec'], { method: 'POST', path: `/v1/workspaces/${id}/toolchain/probe` })}`
      },
      payload: { binaries: ['sh', 'garden-definitely-absent'] }
    });
    expect(probe.json()).toEqual({
      present: ['sh'],
      missing: ['garden-definitely-absent']
    });
  });

  it('binds original recording receipts to file-read authority and the requested workspace', async () => {
    const { app, id, root, token } = await harness();
    await writeFile(path.join(root, 'workspace', 'source.wav'), 'approved recording');
    const url = `/v1/workspaces/${id}/audio/source`;
    const request = (requested: string, scopes = ['files.read'], audience = url) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token(scopes, { method: 'POST', path: audience })}` },
        payload: { path: requested }
      });
    const accepted = await request('workspace/source.wav');
    expect(accepted.statusCode).toBe(200);
    const receipt = accepted.json<{ sourceSha256: string; sourceBytes: number }>();
    expect(receipt.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.sourceBytes).toBe(Buffer.byteLength('approved recording'));
    expect((await request('workspace/source.wav', ['exec'])).statusCode).toBe(403);
    expect(
      (await request('workspace/source.wav', ['files.read'], `/v1/workspaces/${id}/audio/prepare`))
        .statusCode
    ).toBe(403);
    expect((await request('../../escape')).statusCode).toBe(400);
    expect((await request('.garden/browser/Cookies')).statusCode).toBe(400);
  });

  it('will not prepare a recording for a token that may only read files elsewhere', async () => {
    const { app, id, token } = await harness();
    // The route only ever reads a file the owner already has, so `files.read` is the whole of what
    // it may ask for - and a token without it gets nothing, including the file's length.
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/audio/prepare`,
      headers: {
        authorization: `Bearer ${token(['exec'], { method: 'POST', path: `/v1/workspaces/${id}/audio/prepare` })}`
      },
      payload: { path: 'workspace/memo.m4a' }
    });
    expect(refused.statusCode).toBe(403);
  });

  it('will not read a recording outside the workspace, whatever the path says', async () => {
    const { app, id, token } = await harness();
    const escaped = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/audio/prepare`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'POST', path: `/v1/workspaces/${id}/audio/prepare` })}`
      },
      payload: { path: '../../etc/passwd' }
    });
    expect(escaped.statusCode).toBe(400);
    expect(escaped.json<{ error: { message: string } }>().error.message).toMatch(
      /escapes workspace/i
    );
  });

  it('says which second range it prepared, on the response that carries the bytes', async () => {
    const { app, id, root, token } = await harness();
    /*
     * Resolved against the HOST list, and not against the agent's, because that is what the route
     * now does. This case used to symlink the host's ffmpeg into the agent tool directory - index 0
     * of `agentSearchPath` - and that stopped working the day `prepareAudio` moved onto
     * `hostSearchPath` so an agent-written file could not decide which binary the runner spawns as
     * itself. The symlink was the test standing in the place the fix exists to close.
     *
     * The consequence, stated because it is a real loss: this case now skips on a machine whose
     * ffmpeg is outside the six system directories - a Homebrew laptop - and runs on a provisioned
     * Linux box, where the installer puts it in /usr/bin.
     */
    const onHostPath = (name: string): string | undefined =>
      hostSearchPath
        .split(path.delimiter)
        .map((directory) => path.join(directory, name))
        .find((candidate) => existsSync(candidate));
    const ffmpeg = onHostPath('ffmpeg');
    const ffprobe = onHostPath('ffprobe');
    if (!ffmpeg || !ffprobe) return;
    spawnSync(ffmpeg, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=8',
      path.join(root, 'workspace', 'memo.m4a')
    ]);

    const prepared = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/audio/prepare`,
      headers: {
        authorization: `Bearer ${token(['files.read'], { method: 'POST', path: `/v1/workspaces/${id}/audio/prepare` })}`
      },
      payload: { path: 'workspace/memo.m4a', endSeconds: 3 }
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.headers['content-type']).toContain('audio/ogg');
    expect(prepared.headers['x-audio-prepared-seconds']).toBe('3');
    // The file runs past the window, and the header is what lets the caller say where to resume
    // rather than leaving a bounded reading of a long recording as a dead end.
    expect(prepared.headers['x-audio-more']).toBe('true');
    expect(prepared.headers['x-audio-duration-seconds']).toBe('8');
    expect(prepared.rawPayload.length).toBeGreaterThan(0);
  }, 60_000);

  /*
   * THE SECOND SLOT, through the routes rather than through the functions under them.
   *
   * Two tasks share a workspace, and the runner's record of what has been shown used to be keyed by
   * resolved path - so it answered a question about task B with task A's reading, and B's whole-file
   * write changed a line only A had seen. What tells them apart is `sub` on the capability, which
   * the worker stamps with the task it is running: nothing new crosses the wire, and the code inside
   * a task cannot choose it because the token is signed over it.
   *
   * This case exists at the route because the route is where the reader is derived. Everything below
   * it can be correct while the server hands the write the wrong task, or no task at all, and that
   * is precisely the shape of the defect being closed.
   */
  it("holds the second task in a workspace to its own reads and not to the first task's", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-slot-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-slot-route-secret-at-least-32-characters';
    /*
     * The disk this case writes to is stated rather than measured. A PUT passes the host storage
     * floor, and measuring the real one made this the only case in the file whose answer depended
     * on how full the machine happened to be: on its own it was the 428 below, and inside the whole
     * package - 35 files writing temporary trees at once - it came back 507. `checkpoints.test.ts`
     * carries the rest of the reasoning.
     */
    const app = await buildServer(runnerConfig(workspaceRoot, secret), {
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000011';
    const root = path.join(workspaceRoot, id);
    await ensureWorkspace(root);
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
    const whole = `${lines.join('\n')}\n`;
    await writeFile(path.join(root, 'workspace', 'app.ts'), whole);

    let issued = 0;
    const asTask = (task: string, method: 'GET' | 'PUT'): string =>
      signCapabilityToken(
        {
          sub: task,
          workspaceId: id,
          role: 'agent',
          scopes: [method === 'GET' ? 'files.read' : 'files.write'],
          aud: capabilityAudience(method, `/v1/workspaces/${id}/file`),
          nonce: `slot-${(issued += 1)}`
        },
        secret
      );
    const read = (task: string, startLine: number, endLine: number) =>
      app.inject({
        method: 'GET',
        url: `/v1/workspaces/${id}/file?path=workspace/app.ts&maxBytes=400000&startLine=${startLine}&endLine=${endLine}`,
        headers: { authorization: `Bearer ${asTask(task, 'GET')}` }
      });
    const writeWhole = (task: string, from: string, to: string) =>
      app.inject({
        method: 'PUT',
        url: `/v1/workspaces/${id}/file?path=workspace/app.ts`,
        headers: {
          authorization: `Bearer ${asTask(task, 'PUT')}`,
          'content-type': 'application/octet-stream'
        },
        payload: Buffer.from(whole.replace(from, to))
      });

    expect((await read('task-b', 1, 50)).statusCode).toBe(200);
    expect((await read('task-a', 1, 401)).statusCode).toBe(200);

    // B has been shown fifty lines by its own read and four hundred by nobody.
    const fromB = await writeWhole('task-b', 'line 300', 'line 300 // from B');
    expect(fromB.statusCode).toBe(428);
    expect(fromB.json<{ error: { message: string } }>().error.message).toContain(
      'no read has shown you those lines'
    );
    await expect(readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).resolves.toBe(whole);

    // And A, which read the file, writes it: the second slot is bounded, not broken.
    expect((await writeWhole('task-a', 'line 300', 'line 300 // from A')).statusCode).toBe(200);
    await expect(readFile(path.join(root, 'workspace', 'app.ts'), 'utf8')).resolves.toContain(
      'line 300 // from A'
    );
  });
});

/**
 * One machine, one holder, over the two routes that hand it out.
 *
 * The browser and the desktop are the same screen whenever `BROWSER_USE_DESKTOP_DISPLAY` is on -
 * Chromium is launched on the workspace's own X server so a page looks like an ordinary desktop
 * application and a person taking over finds the browser where they are already looking. They had
 * a takeover each: `POST /desktop/holder` moved a `DesktopControl`, `POST /browser/holder` set a
 * field on a browser session, and neither route knew the other existed. So an owner could press
 * Take over on the Computer pane, watch the agent go on driving the browser on that same screen,
 * and have nothing anywhere say why.
 *
 * This drives both real routes against a runner with no X server on it, which is the only part
 * stood in for. The refusal has to arrive without a Chromium being launched to produce it - there
 * is none on the machine running this - and that is itself the property: the browser asks who
 * holds the screen before it starts a browser.
 */
describe('taking the machine over on one surface', () => {
  const disposers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('refuses the agent the browser once the owner has taken the desktop', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-one-holder-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-one-holder-secret-at-least-32-characters';
    const id = '00000000-0000-4000-8000-0000000000d7';
    await ensureWorkspace(path.join(workspaceRoot, id));

    // `ensure` spawns the session script and waits for an X server to come up. That is the one
    // seam replaced; `setHolder`, `controlFor`, the routes and the browser's own gate are shipped.
    const control = new DesktopControl({ release: async () => undefined });
    class HeadlessDesktop extends DesktopManager {
      constructor() {
        super('/nonexistent/bridge.py', '/nonexistent/session.sh');
      }

      override async ensure(): Promise<Awaited<ReturnType<DesktopManager['ensure']>>> {
        return { control } as unknown as Awaited<ReturnType<DesktopManager['ensure']>>;
      }
    }

    const config = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 0,
      RUNNER_SHARED_SECRET: secret,
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
      // The configuration this defect only exists in: one screen, two surfaces onto it.
      BROWSER_USE_DESKTOP_DISPLAY: true,
      BROWSER_CPU_NICE: 0,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      IMAGE_CONVERT_EXECUTABLE: 'magick',
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
    } as RunnerConfig;
    const app = await buildServer(config, {
      desktop: new HeadlessDesktop(),
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());

    const tokenFor = (role: 'user' | 'agent', scopes: string[], route: string): string =>
      signCapabilityToken(
        {
          sub: role,
          workspaceId: id,
          role,
          scopes,
          aud: capabilityAudience('POST', route),
          nonce: `one-holder-${role}-${scopes[0]}`
        },
        secret,
        120
      );

    const taken = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/desktop/holder`,
      headers: {
        authorization: `Bearer ${tokenFor('user', ['desktop.takeover'], `/v1/workspaces/${id}/desktop/holder`)}`
      },
      payload: { holder: 'user' }
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toMatchObject({ holder: 'user' });

    const acted = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/browser/action`,
      headers: {
        authorization: `Bearer ${tokenFor('agent', ['browser.control'], `/v1/workspaces/${id}/browser/action`)}`
      },
      payload: { type: 'reload' }
    });
    expect(acted.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(acted.json())).toMatch(/held by user/);
  });

  /*
   * A screenshot is the one browser action that lands a file, and the action route is scoped for
   * control alone. Held to the print route's terms: without the write scope the request ends at
   * the scope check, before the browser or the disk is touched, on its own and inside a batch.
   */
  it('refuses a screenshot on the action route without the write scope', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-screenshot-scope-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-screenshot-scope-secret-at-least-32-chars';
    const id = '00000000-0000-4000-8000-0000000000d8';
    await ensureWorkspace(path.join(workspaceRoot, id));
    class HeadlessDesktop extends DesktopManager {
      constructor() {
        super('/nonexistent/bridge.py', '/nonexistent/session.sh');
      }
    }
    const config = {
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
      IMAGE_CONVERT_EXECUTABLE: 'magick',
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
    } as RunnerConfig;
    const app = await buildServer(config, {
      desktop: new HeadlessDesktop(),
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());
    const route = `/v1/workspaces/${id}/browser/action`;
    const post = (scopes: string[], payload: Record<string, unknown>, nonce: string) =>
      app.inject({
        method: 'POST',
        url: route,
        headers: {
          authorization: `Bearer ${signCapabilityToken(
            {
              sub: 'agent',
              workspaceId: id,
              role: 'agent',
              scopes,
              aud: capabilityAudience('POST', route),
              nonce
            },
            secret,
            120
          )}`
        },
        payload
      });

    const alone = await post(
      ['browser.control'],
      { type: 'screenshot', path: 'proofs/page.png' },
      'screenshot-scope-alone'
    );
    expect(alone.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(alone.json())).toMatch(/files\.write is required/);

    const batched = await post(
      ['browser.control'],
      {
        type: 'batch',
        actions: [
          { type: 'hover', selector: '#menu' },
          { type: 'screenshot', path: 'proofs/menu.png' }
        ]
      },
      'screenshot-scope-batched'
    );
    expect(batched.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(batched.json())).toMatch(/files\.write is required/);

    // The control: an action that writes nothing is not asked for the write scope. It reaches the
    // browser, which this box does not have, and is refused for that and not for a capability.
    const reload = await post(['browser.control'], { type: 'reload' }, 'screenshot-scope-reload');
    expect(JSON.stringify(reload.json())).not.toMatch(/is required/);
  });
});

/**
 * The ladder, reported rather than assumed.
 *
 * `/healthz` is the one place an operator, and the control plane that tells the owner their shell
 * is confined, can read what this box actually does - and until this wave `agentSandbox` had no
 * production reader at all. What it must never do is answer from the setting: a box with
 * CONFINE_AGENT_FILESYSTEM on and no helper to apply a ruleset with is a box running every command
 * unconfined, and a health endpoint that reported otherwise would be worse than one that said
 * nothing.
 */
describe('what the runner says about its own boundaries', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const withSandbox = async (
    confine: boolean | undefined,
    helper: string | undefined
  ): Promise<{ app: Awaited<ReturnType<typeof buildServer>>; workspaceRoot: string }> => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-rung-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const config = {
      RUNNER_HOST: '127.0.0.1',
      RUNNER_PORT: 4300,
      RUNNER_SHARED_SECRET: 'runner-rung-test-secret-at-least-32-characters',
      WORKSPACE_ROOT: workspaceRoot,
      TAR_EXECUTABLE: '/usr/bin/tar',
      SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
      BROWSER_USE_DESKTOP_DISPLAY: false,
      BROWSER_CPU_NICE: 0,
      MAX_EXECUTION_SECONDS: 30,
      RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
      IMAGE_CONVERT_EXECUTABLE: 'magick',
      MAX_BACKGROUND_SECONDS: 120,
      COMMAND_PROCESS_LIMIT: 1024,
      COMMAND_OPEN_FILE_LIMIT: 4096,
      MAX_FILE_BYTES: 1024 * 1024,
      RESERVED_PREVIEW_PORTS: [],
      CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
      CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
      CHECKPOINT_PACKAGE_MANIFEST: path.join(workspaceRoot, 'dpkg-status'),
      CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
      CHECKPOINT_RETAIN_TURNS: 20,
      CHECKPOINT_RETAIN_DAILY_DAYS: 14,
      CHECKPOINT_MAX_FILES: 250_000,
      CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
      ISOLATE_AGENT_NETWORK: false,
      AGENT_SANDBOX_HELPER: helper,
      CONFINE_AGENT_FILESYSTEM: confine
    } as RunnerConfig;
    const app = await buildServer(config);
    disposers.push(() => app.close());
    return { app, workspaceRoot };
  };

  const stubHelper = async (): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-helper-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const helper = path.join(root, 'garden-sandbox');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o755);
    return helper;
  };

  it('reports the filesystem rung it is actually on', async () => {
    const { app } = await withSandbox(true, await stubHelper());
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({ agentSandbox: true, agentFilesystemConfined: true });
  });

  it('reports no filesystem boundary on a box whose installer found none', async () => {
    const { app } = await withSandbox(false, await stubHelper());
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({ agentSandbox: true, agentFilesystemConfined: false });
  });

  it('answers from the helper it has, not from the setting it was given', async () => {
    // A laptop: the setting says confine, there is no second account to drop to, and every command
    // runs as the runner with no ruleset anywhere. Answering `true` here would tell the owner a
    // boundary is in force that nothing on the box performs.
    const { app } = await withSandbox(true, undefined);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({ agentSandbox: false, agentFilesystemConfined: false });
  });

  /*
   * The other thing this route now answers: what a restart would destroy.
   *
   * The names are checked as exact keys rather than with `toMatchObject` on a shape, because the
   * only consumer is a `sed` pattern in scripts/garden and a typo in either spelling is invisible
   * to the compiler. `backgroundLongestRemainingMs` is null and not 0 on an idle box - the update
   * distinguishes "nothing running" from "running, no deadline", and 0 would read as the latter.
   *
   * This case pins the route's shape. That the SHELL then stands down on it is proved end to end
   * in long-work.test.ts, which is a different claim and cannot be made from here.
   */
  it('reports the background work a restart would destroy, in the names the update greps for', async () => {
    const { app, workspaceRoot } = await withSandbox(false, undefined);
    const id = '00000000-0000-4000-8000-0000000000b8';
    await ensureWorkspace(path.join(workspaceRoot, id));
    const idle = (await app.inject({ method: 'GET', url: '/healthz' })).json<
      Record<string, unknown>
    >();
    expect(idle.backgroundCommands).toBe(0);
    expect(idle.backgroundLongestRemainingMs).toBeNull();

    const started = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/processes/start`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'task-1',
            workspaceId: id,
            role: 'agent',
            scopes: ['exec'],
            aud: capabilityAudience('POST', `/v1/workspaces/${id}/processes/start`),
            nonce: 'healthz-background-1'
          },
          'runner-rung-test-secret-at-least-32-characters'
        )}`,
        'content-type': 'application/json'
      },
      payload: { executable: '/bin/sh', args: ['-c', 'sleep 90'], timeoutSeconds: 90 }
    });
    expect(started.statusCode).toBe(200);

    const busy = (await app.inject({ method: 'GET', url: '/healthz' })).json<
      Record<string, unknown>
    >();
    expect(busy.backgroundCommands).toBe(1);
    // Ninety seconds, minus however long this test took to get here. The window is wide because
    // what is under test is that a real deadline reaches the wire, not the scheduler's precision.
    expect(busy.backgroundLongestRemainingMs).toBeGreaterThan(60_000);
    expect(busy.backgroundLongestRemainingMs).toBeLessThanOrEqual(90_000);
  });

  it('prepares the agent home the toolchain will want, beside the undo point and not in it', async () => {
    // `bash` does not create a missing $HOME and `python3 -m venv $HOME/venv` fails outright when
    // its parent is absent, so a home that only appears once something has written in it is a home
    // half the toolchain trips over.
    const { app, workspaceRoot } = await withSandbox(false, undefined);
    const id = '00000000-0000-4000-8000-0000000000b7';
    const token = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['workspace.manage'],
        aud: capabilityAudience('PUT', `/v1/workspaces/${id}`),
        nonce: 'home-test'
      },
      'runner-rung-test-secret-at-least-32-characters'
    );
    const created = await app.inject({
      method: 'PUT',
      url: `/v1/workspaces/${id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(created.statusCode).toBe(200);
    const root = path.join(workspaceRoot, id);
    const home = agentHome(root);
    expect((await stat(home)).isDirectory()).toBe(true);
    // WHERE it is, spelled as one equality rather than as a prefix test. `.home` at the container
    // root: outside `workspace/`, which is what keeps a Rust toolchain's 88,021 files out of
    // CHECKPOINT_CONTENT and out of the workspace storage quota, and outside `.garden`, which is
    // the runner's alone. A prefix test would pass on `workspace/.home` and on `.home/anything`
    // alike; this one fails the moment the location moves in either direction, which is the whole
    // reason it is written this way - the assertion it replaced read the first path segment and
    // would have passed on any depth of nesting under `workspace/`.
    expect(path.relative(root, home)).toBe('.home');
    // And the mode, because the two accounts reach these files through the group they share: a
    // home the agent account cannot write is a home every `pip install` fails in. `0o770` from
    // files.ts's SHARED_MODE, masked by the process umask the same way `workspace/` is.
    const [homeStat, workspaceStat] = await Promise.all([
      stat(home),
      stat(path.join(root, 'workspace'))
    ]);
    expect(homeStat.mode & 0o777).toBe(workspaceStat.mode & 0o777);
  });
});

/**
 * The staleness refusal, over the routes that actually carry it.
 *
 * `DesktopControl.authorize` has refused a coordinate computed from a superseded observation since
 * it was written, and until now the only caller that ever named a generation was a test passing a
 * sixth argument by hand: `POST /desktop/action` passes five and the stream socket four, and
 * `DesktopAction` has no field for the model to echo. That is the shape this programme keeps
 * finding - a mechanism, its unit test, and no production caller - so this case refuses to touch
 * `act` at all and drives the HTTP routes the worker's `desktop_observe` and `desktop_action` tools
 * post to.
 *
 * The desktop itself is the one seam stood in for: there is no X server on the machine running
 * this, and none is needed to prove which observation the runner is holding the agent to.
 */
describe('a desktop action posted after the screen moved under it', () => {
  const disposers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('refuses it until the agent has observed again, over the real routes', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-desktop-stale-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-desktop-stale-secret-at-least-32-characters';
    const id = '00000000-0000-4000-8000-0000000000d8';
    await ensureWorkspace(path.join(workspaceRoot, id));

    const control = new DesktopControl({ release: async () => undefined });
    /*
     * Everything below `ensure` is shipped code: `snapshot` records the generation it served,
     * `act` names it, and `DesktopControl` refuses. `atspi: false` is a host with no accessibility
     * stack, which is also the cheapest way to keep the python bridge out of a test that is about
     * neither - the screenshot and the window list are attempted and fail, as they would here.
     */
    const session = {
      root: path.join(workspaceRoot, id),
      env: { DISPLAY: ':91' },
      control,
      subscribers: new Map(),
      applicationGroups: new Set<number>(),
      activeApplication: '',
      lastAction: '',
      geometry: { width: 1280, height: 800 },
      bootGeometry: { width: 1280, height: 800 },
      ceiling: { width: 3840, height: 2160 },
      outputName: 'screen',
      currentMode: null,
      codec: 'avc1' as const,
      congested: false,
      atspi: false,
      observedGeneration: null,
      bridgeServe: false,
      bridgeQueue: Promise.resolve(),
      pointer: { x: 640, y: 400 }
    };
    class HeadlessDesktop extends DesktopManager {
      constructor() {
        super('/nonexistent/bridge.py', '/nonexistent/session.sh');
      }

      override async ensure(): Promise<Awaited<ReturnType<DesktopManager['ensure']>>> {
        return session as unknown as Awaited<ReturnType<DesktopManager['ensure']>>;
      }
    }

    const config = {
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
      IMAGE_CONVERT_EXECUTABLE: 'magick',
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
    } as RunnerConfig;
    const app = await buildServer(config, {
      desktop: new HeadlessDesktop(),
      hostStorage: async () => ({
        hostStorageTotalBytes: 100 * 1024 ** 3,
        hostStorageAvailableBytes: 50 * 1024 ** 3
      })
    });
    disposers.push(() => app.close());

    // A nonce is consumed by the request that uses it, so each of the six calls below mints its
    // own; this case is about the second and third posts to the same route, not the first.
    let issued = 0;
    const tokenFor = (role: 'user' | 'agent', scopes: string[], route: string): string =>
      signCapabilityToken(
        {
          sub: role,
          workspaceId: id,
          role,
          scopes,
          aud: capabilityAudience('POST', route),
          nonce: `desktop-stale-${(issued += 1)}`
        },
        secret,
        120
      );
    const snapshotRoute = `/v1/workspaces/${id}/desktop/snapshot`;
    const actionRoute = `/v1/workspaces/${id}/desktop/action`;
    const holderRoute = `/v1/workspaces/${id}/desktop/holder`;
    const observe = () =>
      app.inject({
        method: 'POST',
        url: snapshotRoute,
        headers: {
          authorization: `Bearer ${tokenFor('agent', ['desktop.read'], snapshotRoute)}`
        },
        payload: {}
      });
    // The consequential scope is granted so that the only thing left to refuse this click is the
    // staleness check itself; a bare coordinate on a screen with no accessibility tree is a blind
    // click and would otherwise stop for an approval first.
    const click = () =>
      app.inject({
        method: 'POST',
        url: actionRoute,
        headers: {
          authorization: `Bearer ${tokenFor(
            'agent',
            ['desktop.control', 'desktop.consequential'],
            actionRoute
          )}`
        },
        payload: { type: 'click_at', x: 250, y: 120 }
      });
    const setHolder = (holder: 'agent' | 'user') =>
      app.inject({
        method: 'POST',
        url: holderRoute,
        headers: {
          authorization: `Bearer ${tokenFor('user', ['desktop.takeover'], holderRoute)}`
        },
        payload: { holder }
      });

    const first = await observe();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ available: true, generation: 1 });

    // The owner takes the machine and gives it back: two generations, and every coordinate read
    // off the screen before it now names whatever is there instead.
    expect((await setHolder('user')).statusCode).toBe(200);
    expect((await setHolder('agent')).json()).toMatchObject({ generation: 3 });

    const refused = await click();
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.json())).toMatch(/is stale; observe the desktop again/);

    /*
     * The other direction, and the reason the refusal is worth having: it is one the model can
     * answer. Observing again re-arms the click, which then travels the whole path - authorized,
     * classified, queued, performed - and fails only where this machine genuinely cannot go on:
     * `spawn /usr/bin/xdotool ENOENT`, which is what it says on the host that ran this. The
     * assertion is the absence of the staleness message rather than the presence of that one,
     * because a host that does have xdotool fails with the X server's words instead. A check that
     * refused everything would pass the case above and fail this one.
     */
    expect((await observe()).statusCode).toBe(200);
    const attempted = await click();
    expect(JSON.stringify(attempted.json())).not.toMatch(/is stale/);
  });
});
