/*
 * Whether `playwright-core` is in the process, asked of the process rather than of the source.
 *
 * ── Why this is a spawned child and not a regular expression over imports ──────────────────────
 *
 * The obvious guard here is a pattern over `browser.ts` and `surfaces.ts` asserting that neither
 * says `import { chromium } from 'playwright-core'`. It is wrong in both directions and I built it
 * before I built this. It reports a violation for an import whose bindings are all unused, which
 * TypeScript elides and which therefore costs nothing - I hit exactly that false red while proving
 * these cases, and spent a while believing a fix had failed when the compiler had already removed
 * the thing I was accusing. And it reports nothing at all for the route that actually put 108 MB
 * in the process here, which is a third module importing a value out of a second one.
 *
 * So the question is put to Node. `require.cache` is keyed on resolved realpath and every CJS
 * package Node loads lands in it, `playwright-core` included, whether it was reached by a static
 * import, a dynamic one, or through four modules of `export ... from`. A child process is used
 * rather than the test's own so the answer cannot depend on which file vitest ran first -
 * `fileParallelism: false` means `surfaces.test.ts` legitimately loads Playwright in this same
 * worker, and an in-process reading of the cache would be green or red according to test order.
 *
 * ── What the bound is worth, measured ──────────────────────────────────────────────────────────
 *
 * Runner module graph, settled resident, median of three, macOS 23.6 / node v24.18.1 / `dist`:
 * 213.28 MB with Playwright statically imported, 115.33 MB without it, over a 41.67 MB bare-node
 * floor. @see docs/design/actions/WEIGHT.md for the method and the full table.
 */
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = path.resolve(PACKAGE, '..', '..');

const scratch: string[] = [];
afterEach(async () => {
  while (scratch.length) await rm(scratch.pop()!, { recursive: true, force: true });
});

const directory = async (prefix: string): Promise<string> => {
  const at = await mkdtemp(path.join(tmpdir(), prefix));
  scratch.push(at);
  return at;
};

interface Reading {
  /** Whether `playwright-core` was in the child's module cache when the work had finished. */
  readonly resident: boolean;
  /** Whatever the probed work returned, so a case can check the work still happened. */
  readonly answered: unknown;
}

/**
 * One reading, taken in a child process that starts with nothing loaded.
 *
 * `body` is the module-level source of the work under test; whatever it assigns to `answered`
 * comes back. The child resolves bare specifiers from the runner package, so `playwright-core`
 * resolves to the same realpath the shipped modules reach and the cache key matches.
 */
const reading = async (body: string, environment: NodeJS.ProcessEnv = {}): Promise<Reading> => {
  const at = path.join(await directory('garden-residency-'), 'probe.mts');
  await writeFile(
    at,
    `import { createRequire } from 'node:module';
const resolveFrom = createRequire(${JSON.stringify(path.join(PACKAGE, 'src', 'probe.ts'))});
const playwright = resolveFrom.resolve('playwright-core');
if (resolveFrom.cache[playwright]) throw new Error('the probe started with Playwright loaded');
let answered = null;
${body}
console.log(JSON.stringify({ resident: Boolean(resolveFrom.cache[playwright]), answered }));
`
  );
  const { stdout } = await run(process.execPath, ['--import', 'tsx', at], {
    cwd: REPOSITORY,
    env: { ...process.env, NODE_OPTIONS: '--conditions=development', ...environment }
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as Reading;
};

const src = (file: string): string => JSON.stringify(path.join(PACKAGE, 'src', file));

describe('the weight of a runner that has not been asked for a browser', () => {
  it('holds no Playwright after the whole server has been built', async () => {
    /*
     * The case the whole change is for, and the one a single-file fix does not produce.
     *
     * `server.ts` takes `BrowserManager` out of `browser.ts` as a value, so `browser.ts` is in
     * every runner's graph whether or not a browser is ever launched, and anything `browser.ts`
     * imports as a value is resident with it. Making `surfaces.ts` lazy on its own leaves this
     * reading `true` and the process 214.35 MB heavy against a 213.28 MB baseline: I built and
     * measured that arm before writing this, and it is in WEIGHT.md.
     */
    expect(await reading(`await import(${src('server.ts')});`)).toEqual({
      resident: false,
      answered: null
    });
  });

  it('holds no Playwright when the browser probe was told where the browser is', async () => {
    // The configured-executable branch returns before the driver is asked for. On a box that sets
    // BROWSER_EXECUTABLE_PATH this is the whole per-turn probe, so such a box never loads
    // Playwright until it launches one.
    const root = await directory('garden-residency-root-');
    const chrome = path.join(root, 'chrome');
    await writeFile(chrome, '#!/bin/sh\nexit 0\n');
    await chmod(chrome, 0o755);
    expect(
      await reading(
        `const { browserPresence } = await import(${src('surfaces.ts')});
answered = await browserPresence({ root: ${JSON.stringify(root)}, executablePath: ${JSON.stringify(chrome)} });`
      )
    ).toEqual({ resident: false, answered: 'available' });
  });
});

describe('the weight of a runner that has been asked for a browser', () => {
  it('opens the real Playwright to answer where its own Chromium would be', async () => {
    /*
     * The other direction, and the one that makes the bound above worth anything.
     *
     * A lazy import that resolved to nothing, or to a driver whose `executablePath()` never ran,
     * would satisfy every case above and would have quietly withdrawn four tool schemas from the
     * catalogue on every box that relies on Playwright's own registry. So this asks for the branch
     * that needs the package, and requires both that it became resident and that it produced the
     * verdict the registry produces - pointed at an empty browsers directory, `absent`.
     */
    const root = await directory('garden-residency-root-');
    const empty = await directory('garden-residency-browsers-');
    expect(
      await reading(
        `const { browserPresence } = await import(${src('surfaces.ts')});
answered = await browserPresence({ root: ${JSON.stringify(root)} });`,
        { PLAYWRIGHT_BROWSERS_PATH: empty }
      )
    ).toEqual({ resident: true, answered: 'absent' });
  });
});
