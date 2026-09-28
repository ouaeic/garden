/*
 * The surface probe, exercised against a real filesystem rather than a mocked one.
 *
 * These files are what the answer is actually about - `DesktopManager.ensure` spawns the session
 * executable and `BrowserManager.ensure` hands Playwright the browser path - so a suite that stubbed
 * `access` would be testing its own stub. Every case below writes or does not write a real file in a
 * temporary directory and asks the probe what it sees.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserPresence, desktopPresence, workspaceSurfaces } from './surfaces.js';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-surfaces-'));
  roots.push(root);
  return root;
};

/** A file something could actually be spawned from, which is the whole of what the probe asks. */
const executable = async (root: string, name: string): Promise<string> => {
  const at = path.join(root, name);
  await writeFile(at, '#!/bin/sh\nexit 0\n');
  await chmod(at, 0o755);
  return at;
};

describe('the desktop probe', () => {
  it('says absent when the runner was never configured for a desktop', async () => {
    const root = await workspace();
    // A developer's laptop. `DesktopManager.configured` is false and every call into it throws
    // "GUI desktop runtime is not enabled on this workspace runner", so the three desktop tools
    // were never callable here.
    expect(await desktopPresence({ root })).toBe('absent');
    expect(
      await desktopPresence({ root, sessionExecutable: await executable(root, 'session') })
    ).toBe('absent');
  });

  it('says absent when the paths are configured and nothing is at them', async () => {
    const root = await workspace();
    /*
     * The shape a config echo would get wrong, and the reason this is a probe.
     *
     * `DESKTOP_BRIDGE_EXECUTABLE` and `DESKTOP_SESSION_EXECUTABLE` being set says a path was
     * written into the runner's environment, not that a desktop was ever installed at it - a
     * half-finished host, a container built from the wrong layer, an installer that failed after
     * writing the unit file. Nothing checks these until a session is spawned and the spawn fails,
     * which is one turn and one confused owner later.
     */
    expect(
      await desktopPresence({
        root,
        bridgeExecutable: path.join(root, 'no-such-bridge'),
        sessionExecutable: path.join(root, 'no-such-session')
      })
    ).toBe('absent');
  });

  it('says absent when only one half of the pair is really there', async () => {
    const root = await workspace();
    // The session comes up and the accessibility bridge does not, which is a screen the agent can
    // see a picture of and cannot read a control off. Both or neither.
    expect(
      await desktopPresence({
        root,
        bridgeExecutable: path.join(root, 'no-such-bridge'),
        sessionExecutable: await executable(root, 'session')
      })
    ).toBe('absent');
  });

  it('says available when both are present and executable', async () => {
    const root = await workspace();
    expect(
      await desktopPresence({
        root,
        bridgeExecutable: await executable(root, 'bridge'),
        sessionExecutable: await executable(root, 'session')
      })
    ).toBe('available');
  });

  it('says absent for a path that exists and cannot be run', async () => {
    const root = await workspace();
    const bridge = await executable(root, 'bridge');
    const session = path.join(root, 'session');
    await writeFile(session, 'not executable\n');
    await chmod(session, 0o644);
    // `existsSync` would call this a desktop. The spawn would not, so neither does the probe.
    expect(
      await desktopPresence({ root, bridgeExecutable: bridge, sessionExecutable: session })
    ).toBe('absent');
  });
});

describe('the browser probe', () => {
  it('follows the configured executable when there is one', async () => {
    const root = await workspace();
    // With BROWSER_EXECUTABLE_PATH set, Playwright is handed that path and its own registry is
    // never consulted - so that is the only file worth asking about.
    expect(await browserPresence({ root, executablePath: await executable(root, 'chrome') })).toBe(
      'available'
    );
    expect(await browserPresence({ root, executablePath: path.join(root, 'no-chrome') })).toBe(
      'absent'
    );
  });

  it('asks Playwright where its own browser is, and whether anything is there', async () => {
    const root = await workspace();
    /*
     * The case the whole gate is for, and the reason `existsSync` is not skippable.
     *
     * `chromium.executablePath()` computes a path from the registry and PLAYWRIGHT_BROWSERS_PATH
     * without checking that anything is at it. A box that installed the library and never ran
     * `playwright install` - which is every box that took the runner as a dependency and none of
     * its browsers - therefore reports a plausible path to a file that does not exist. Pointed at
     * an empty directory, the answer has to be `absent` and not `available`.
     */
    const empty = await workspace();
    const before = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
    try {
      expect(await browserPresence({ root })).toBe('absent');
    } finally {
      if (before === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = before;
    }
  });
});

describe('both surfaces together', () => {
  it('answers each independently, so one missing surface does not withdraw the other', async () => {
    const root = await workspace();
    const answered = await workspaceSurfaces({
      root,
      browserExecutablePath: await executable(root, 'chrome'),
      desktopBridgeExecutable: path.join(root, 'no-such-bridge'),
      desktopSessionExecutable: path.join(root, 'no-such-session')
    });
    // The common real shape: a headless server with a Chromium and no X session. Four browser
    // tools stay on the wire and three desktop ones come off, which is 4,401 bytes and no
    // capability.
    expect(answered).toEqual({ browser: 'available', desktop: 'absent' });
  });

  it('answers absent for both on a box that has neither', async () => {
    const root = await workspace();
    const empty = await workspace();
    const before = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
    try {
      expect(await workspaceSurfaces({ root })).toEqual({ browser: 'absent', desktop: 'absent' });
    } finally {
      if (before === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = before;
    }
  });
});
