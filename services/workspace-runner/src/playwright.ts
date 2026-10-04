/**
 * Playwright, opened at the moment a browser is actually wanted rather than when the process boots.
 *
 * ── The measurement this file exists to hold ───────────────────────────────────────────────────
 *
 * `playwright-core` is 108.3 MB of settled resident memory on top of a 41.7 MB bare-node floor
 * (median of three, macOS 23.6, node v24.18.1, `dist` build, four 400 ms quiescent intervals). The
 * runner's whole module graph settles at 213.3 MB, so Playwright is roughly half of everything the
 * process is holding - and it was holding all of it before a single request arrived, on every box,
 * including the ones that have no Chromium and could never launch one.
 *
 * Nothing needed it that early. Every value use of `chromium` in this package is inside an async
 * function body: the session launch, the isolated-browser launch and its two sandbox fallbacks in
 * `browser.ts`, and the registry-path question in `surfaces.ts`. What made it resident was two
 * static import statements, one in each of those files, and a third module - `server.ts` - taking
 * `BrowserManager` from `browser.ts` as a value, which is why making only one of the two lazy buys
 * nothing at all: the other still drags the package in through the server's own import.
 *
 * ── What this does NOT claim ───────────────────────────────────────────────────────────────────
 *
 * It removes the cost from *idle*, which is the figure the 120 MB target is written against. It
 * does not remove it from a box that has served a turn. `workspaceSurfaces` runs once per claimed
 * turn, and on a box with no `BROWSER_EXECUTABLE_PATH` - which is every box the installer builds,
 * `scripts/install-native.sh` never sets it - the browser probe asks Playwright's own registry
 * where its Chromium would be, and that question loads the package. So the first turn pays what an
 * eager import would have paid at boot, and the process stays there.
 *
 * That boundary was measured rather than reasoned about, and the numbers are in
 * `docs/design/actions/WEIGHT.md`. It is stated here because the alternative was tempting and is
 * wrong twice over: computing the registry path from `PLAYWRIGHT_BROWSERS_PATH` and a per-platform
 * default, without Playwright, is a re-implementation of somebody else's private layout that goes
 * stale silently - and it goes stale in the direction that reports `absent` for a browser that is
 * there, which withdraws four tool schemas from the catalogue and costs the model a capability it
 * has. A resident 108 MB is worth more than a capability that disappears on a version bump.
 *
 * Caching the probe's verdict is refused for a reason already written down in `surfaces.ts`: the
 * agent's own next move may be to install what is missing, and a remembered "absent" would keep
 * telling it the thing it just put on the box is not there.
 */

import type { chromium } from 'playwright-core';

/**
 * Playwright's Chromium driver, imported on demand.
 *
 * The import above is `import type`, which TypeScript erases entirely, so this module's own graph
 * is empty until the function is called and the name is here only to give the return type
 * somewhere to point. That is the whole mechanism, and `playwright-residency.test.ts` is what keeps
 * a later `import { chromium } from 'playwright-core'` from quietly undoing it.
 */
export const chromiumDriver = async (): Promise<typeof chromium> =>
  (await import('playwright-core')).chromium;
