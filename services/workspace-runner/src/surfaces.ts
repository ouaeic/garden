import type { SurfacePresence, WorkspaceSurfaces } from '@garden/contracts';
import { resolveExecutable } from './command-policy.js';
import { agentSearchPath } from './execution.js';
import { chromiumDriver } from './playwright.js';

/**
 * Whether this box actually has a browser and a desktop, asked of the process that owns them.
 *
 * The worker sends every tool schema on every request of every turn, and the two largest bags in
 * that catalogue - `browser_snapshot`/`read_elements`/`browser_action`/`print_pdf` and
 * `desktop_observe`/`desktop_launch`/`desktop_action` - describe capabilities that a runner
 * without a Chromium or without an X session simply cannot honour. Until this file existed
 * nothing in `apps/worker` could know that: `BROWSER_USE_DESKTOP_DISPLAY` and the two
 * `DESKTOP_*_EXECUTABLE` settings are runner-side configuration the worker never sees, and the
 * only capability probe that crossed the wire was the *document* toolchain, twelve capabilities
 * of which not one is a screen or a browser. Three waves aimed at the catalogue and moved 1,181
 * bytes between them for exactly this reason.
 *
 * It is a probe rather than a config echo. `BROWSER_USE_DESKTOP_DISPLAY` being on says the owner
 * wants the browser drawn on the workspace's screen; it does not say a Chromium was ever
 * downloaded, and `DESKTOP_SESSION_EXECUTABLE` being set says a path was configured, not that
 * anything is at it. Both of those are how a box ends up described as able to do something it
 * cannot.
 *
 * Deliberately not cached, for the same reason `toolchainReport` is not: the agent's own next move
 * may be to install what is missing, and a remembered "absent" would keep telling it the thing it
 * just put on the box is not there. It is three `access(2)` calls; the worker asks once per turn.
 */

/**
 * The Chromium `BrowserManager.ensure` would actually launch.
 *
 * Two routes and they must be probed the way the launch resolves them, not the way a reader would
 * guess. With `BROWSER_EXECUTABLE_PATH` set, Playwright is handed that path and nothing else is
 * consulted. With it unset, Playwright resolves its own registry - honouring
 * `PLAYWRIGHT_BROWSERS_PATH` - and `executablePath()` computes that path *without checking that
 * anything is at it*, which is precisely the case worth catching: a box that has the library and
 * has never downloaded the browser reports a plausible path to a file that does not exist.
 *
 * A throw is the probe failing to get an answer rather than a box that has no browser, so it is
 * `unknown` and the catalogue stays whole. @see surfaceDescribable in `@garden/contracts`. Two
 * things throw there and both mean that: the registry refusing to name a browser, and - since the
 * driver is opened on demand, @see chromiumDriver - `playwright-core` not being installable at all.
 *
 * The configured-path branch returns before the driver is ever asked for, and that ordering is now
 * load-bearing rather than incidental: it is the one route through this probe that answers without
 * making the process resident in 108.3 MB of Playwright.
 */
export const browserPresence = async (input: {
  root: string;
  executablePath?: string | undefined;
}): Promise<SurfacePresence> => {
  const searchPath = agentSearchPath(input.root);
  if (input.executablePath)
    return (await resolveExecutable(input.executablePath, searchPath, input.root))
      ? 'available'
      : 'absent';
  let bundled: string;
  try {
    bundled = (await chromiumDriver()).executablePath();
  } catch {
    return 'unknown';
  }
  return (await resolveExecutable(bundled, searchPath, input.root)) ? 'available' : 'absent';
};

/**
 * The GUI desktop, probed as `DesktopManager.ensure` would fail on it.
 *
 * `DesktopManager.configured` is the first half - both executables named - and it is the half that
 * throws "GUI desktop runtime is not enabled on this workspace runner". The second half is that
 * something executable is at each path, which nothing checks until a session is spawned and the
 * spawn fails. A developer's laptop has neither; a half-installed host has the first without the
 * second, and that shape is the one a config echo would describe as having a screen.
 */
export const desktopPresence = async (input: {
  root: string;
  bridgeExecutable?: string | undefined;
  sessionExecutable?: string | undefined;
}): Promise<SurfacePresence> => {
  if (!input.bridgeExecutable || !input.sessionExecutable) return 'absent';
  const searchPath = agentSearchPath(input.root);
  const [bridge, session] = await Promise.all([
    resolveExecutable(input.bridgeExecutable, searchPath, input.root),
    resolveExecutable(input.sessionExecutable, searchPath, input.root)
  ]);
  return bridge && session ? 'available' : 'absent';
};

/** Both surfaces, probed together because the caller asks one question and pays one round trip. */
export const workspaceSurfaces = async (input: {
  root: string;
  browserExecutablePath?: string | undefined;
  desktopBridgeExecutable?: string | undefined;
  desktopSessionExecutable?: string | undefined;
}): Promise<WorkspaceSurfaces> => {
  const [browser, desktop] = await Promise.all([
    browserPresence({ root: input.root, executablePath: input.browserExecutablePath }),
    desktopPresence({
      root: input.root,
      bridgeExecutable: input.desktopBridgeExecutable,
      sessionExecutable: input.desktopSessionExecutable
    })
  ]);
  return { browser, desktop };
};
