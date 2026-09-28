import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { buildServer, terminalSize, TERMINAL_DEFAULT_SIZE } from './server.js';

const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig => ({
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
  CHECKPOINT_PACKAGE_MANIFEST: path.join(workspaceRoot, 'dpkg-status'),
  CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
  CHECKPOINT_RETAIN_TURNS: 20,
  CHECKPOINT_RETAIN_DAILY_DAYS: 14,
  CHECKPOINT_MAX_FILES: 250_000,
  CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
  ISOLATE_AGENT_NETWORK: false
});

describe('the size a terminal is spawned at', () => {
  it('keeps the size it has when a frame carries something that is not a number', () => {
    const current = { cols: 96, rows: 30 };
    expect(terminalSize(undefined, undefined, current)).toEqual(current);
    expect(terminalSize('80', Number.NaN, current)).toEqual(current);
  });

  it('holds the floor that stops a hidden pane reflowing a running pager', () => {
    // A tab that is `display: none` measures 0x0 and FitAddon floors at 2x1; that really did reach
    // the pty as a SIGWINCH and reflow the owner's build to two columns.
    expect(terminalSize(2, 1, TERMINAL_DEFAULT_SIZE)).toEqual({ cols: 20, rows: 5 });
  });

  it('bounds what a frame off a socket can ask a pty to allocate', () => {
    expect(terminalSize(1e6, 1e6, TERMINAL_DEFAULT_SIZE)).toEqual({ cols: 500, rows: 200 });
    expect(terminalSize(100.7, 40.2, TERMINAL_DEFAULT_SIZE)).toEqual({ cols: 100, rows: 40 });
  });
});

/**
 * The half of the terminal contract no test covered.
 *
 * `server.test.ts:179` asserts a session dies with its capability, which is the rule; nothing
 * asserted that a renewed one lives, which is the rule being usable. Between them they are the
 * whole of it: revocable, and not cut off mid-command.
 */
describe('a terminal session and the capability behind it', () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it('outlives the token that opened it once it is renewed, at the size the client asked for', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-terminal-life-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-terminal-life-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const id = '00000000-0000-4000-8000-000000000042';
    const mint = (ttlSeconds: number, nonce: string): string =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes: ['terminal'],
          aud: capabilityAudience('GET', `/v1/workspaces/${id}/terminal`),
          nonce
        },
        secret,
        ttlSeconds
      );

    const socket = new WebSocket(
      `${address.replace('http://', 'ws://')}/v1/workspaces/${id}/terminal`,
      ['garden-capability', mint(4, 'terminal-life-open')]
    );
    let output = '';
    let renewedExp = 0;
    let closed: { code: number; reason: string } | undefined;
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as {
        type: string;
        data?: string;
        exp?: number;
      };
      if (message.type === 'data') output += message.data ?? '';
      if (message.type === 'renewed') renewedExp = message.exp ?? 0;
    });
    socket.on('close', (code, reason) => {
      closed = { code, reason: reason.toString('utf8') };
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    disposers.push(async () => socket.close());

    /*
     * Sent in the same breath as the open, which is the case that used to be lost: the runner
     * builds the workspace before it spawns the shell, so this frame arrives while there is no pty
     * to hand it to. `stty size` proves it was not dropped - it prints the rows and columns the
     * shell actually believes it has.
     */
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    socket.send(JSON.stringify({ type: 'input', data: 'stty size\n' }));
    const waitFor = async (probe: () => boolean, within = 8_000): Promise<void> => {
      const until = Date.now() + within;
      while (!probe() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      if (!probe()) throw new Error(`Timed out. Terminal said: ${JSON.stringify(output)}`);
    };
    await waitFor(() => /40\s+100/.test(output));

    // Well before the four seconds the opening capability bought.
    socket.send(JSON.stringify({ type: 'renew', token: mint(900, 'terminal-life-renew') }));
    await waitFor(() => renewedExp > 0);

    // Past the original deadline, with a margin: the session that would have died is still here,
    // and still the same shell rather than a fresh one.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(closed).toBeUndefined();
    output = '';
    socket.send(JSON.stringify({ type: 'input', data: 'echo still-here\n' }));
    await waitFor(() => output.includes('still-here'));
  }, 40_000);

  /**
   * Single-use, which is what SECURITY.md has always said a capability is and what this frame was
   * not. A renewal arrives inside an open socket, so it never passes the HTTP hook that spends a
   * nonce - one captured frame therefore re-armed this shell, and every other terminal the same
   * owner had open, for as long as it lived.
   */
  it('spends a renewal frame once, so a captured one cannot re-arm the shell again', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-terminal-replay-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-terminal-replay-secret-at-least-32-chars-ok';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const id = '00000000-0000-4000-8000-000000000044';
    const mint = (ttlSeconds: number, nonce: string): string =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes: ['terminal'],
          aud: capabilityAudience('GET', `/v1/workspaces/${id}/terminal`),
          nonce
        },
        secret,
        ttlSeconds
      );
    const socket = new WebSocket(
      `${address.replace('http://', 'ws://')}/v1/workspaces/${id}/terminal`,
      ['garden-capability', mint(60, 'replay-open')]
    );
    let renewals = 0;
    socket.on('message', (raw: Buffer) => {
      if ((JSON.parse(raw.toString('utf8')) as { type: string }).type === 'renewed') renewals += 1;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    disposers.push(async () => socket.close());

    const captured = mint(900, 'replay-renew');
    socket.send(JSON.stringify({ type: 'renew', token: captured }));
    await expect.poll(() => renewals, { interval: 20, timeout: 8_000 }).toBe(1);
    // The same frame again. A bad renewal is ignored rather than answered, so the count is what
    // says it was refused - and the session keeps the deadline the first one bought.
    socket.send(JSON.stringify({ type: 'renew', token: captured }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(renewals).toBe(1);
    // A different frame still works, so what was refused was the replay and not renewal itself.
    socket.send(JSON.stringify({ type: 'renew', token: mint(900, 'replay-renew-2') }));
    await expect.poll(() => renewals, { interval: 20, timeout: 8_000 }).toBe(2);
  }, 30_000);

  it('does not renew on a token minted for a different owner', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-terminal-other-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-terminal-other-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret));
    disposers.push(() => app.close());
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const id = '00000000-0000-4000-8000-000000000043';
    const socket = new WebSocket(
      `${address.replace('http://', 'ws://')}/v1/workspaces/${id}/terminal`,
      [
        'garden-capability',
        signCapabilityToken(
          {
            sub: 'user',
            workspaceId: id,
            role: 'user',
            scopes: ['terminal'],
            aud: capabilityAudience('GET', `/v1/workspaces/${id}/terminal`),
            nonce: 'other-open'
          },
          secret,
          3
        )
      ]
    );
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      socket.once('open', () =>
        // Another owner's capability, correctly signed. It must buy this shell nothing, so the
        // deadline it already had stands and the session closes on it.
        socket.send(
          JSON.stringify({
            type: 'renew',
            token: signCapabilityToken(
              {
                sub: 'someone-else',
                workspaceId: id,
                role: 'user',
                scopes: ['terminal'],
                aud: capabilityAudience('GET', `/v1/workspaces/${id}/terminal`),
                nonce: 'other-renew'
              },
              secret,
              900
            )
          })
        )
      );
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
      socket.once('error', reject);
    });
    expect(closed).toEqual({ code: 1008, reason: 'Capability expired' });
  }, 30_000);
});
