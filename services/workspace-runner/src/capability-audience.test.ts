import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import { buildServer } from './server.js';

/**
 * The audience claim, measured at the door rather than in the signing helper.
 *
 * `aud` was carried, documented and - because the verifier skipped the comparison whenever the
 * claim was absent, and because nine of the worker's ten signing sites never set one - never
 * compared. A capability was therefore a bearer token for everything its scopes admitted: the
 * `exec` scope the processes panel asks for is the same `exec` scope that starts a command, so a
 * token observed on the read was good against the write for its whole lifetime.
 *
 * These cases are the whole claim: the token works where it was minted for, nowhere else, and a
 * token that names nothing works nowhere. They are runner-level on purpose - the unit test in
 * `packages/core` proves the comparison, and this proves the comparison is reached by a real
 * request through the real preHandler hook, on routes that exist.
 */
const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig =>
  ({
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
    CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
    CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
    CHECKPOINT_RETAIN_TURNS: 20,
    CHECKPOINT_RETAIN_DAILY_DAYS: 14,
    CHECKPOINT_MAX_FILES: 250_000,
    CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
    ISOLATE_AGENT_NETWORK: false
  }) as RunnerConfig;

describe('a capability is only good for the request it names', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  const harness = async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-audience-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-audience-test-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-0000000000b1';
    await ensureWorkspace(path.join(workspaceRoot, id));
    // A nonce is spent on first use, so every request in a test needs its own.
    let issued = 0;
    const readingProcesses = (): string =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes: ['exec'],
          aud: capabilityAudience('GET', `/v1/workspaces/${id}/processes`),
          nonce: `audience-${(issued += 1)}`
        },
        secret
      );
    return { app, id, readingProcesses };
  };

  it('answers the request it was minted for', async () => {
    const { app, id, readingProcesses } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/processes`,
      headers: { authorization: `Bearer ${readingProcesses()}` }
    });
    expect(response.statusCode).toBe(200);
  });

  /*
   * The one that matters. Same secret, same workspace, same owner, same `exec` scope, still inside
   * its lifetime, nonce never spent - and it must not start a command, because it was minted to
   * read the process list.
   */
  it('is refused at a different request that its scopes would otherwise admit', async () => {
    const { app, id, readingProcesses } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/exec`,
      headers: {
        authorization: `Bearer ${readingProcesses()}`,
        'content-type': 'application/json'
      },
      payload: { executable: 'echo', args: ['owned'] }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      'minted for a different request'
    );
  });

  /*
   * A token with no audience at all is the same hole wearing a different hat: before this wave the
   * verifier compared only when the claim was present, so omitting it bought a token that was good
   * everywhere. There is no legitimate signer left that mints one.
   */
  it('refuses a token that names no request at all', async () => {
    const { app, id } = await harness();
    const secret = 'runner-audience-test-secret-at-least-32-characters';
    const unbound = signCapabilityToken(
      {
        sub: 'user',
        workspaceId: id,
        role: 'user',
        scopes: ['exec'],
        nonce: 'audience-unbound'
      },
      secret
    );
    const response = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/processes`,
      headers: { authorization: `Bearer ${unbound}` }
    });
    expect(response.statusCode).toBe(403);
  });
});
