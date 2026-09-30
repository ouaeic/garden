import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { captureBrowserErrors } from './browser-errors.mjs';
const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium, webkit } = requireRunner('playwright-core');
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const failures = [];
    await captureBrowserErrors(page, failures);
    await page.route('**/error-control', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<html><body>Error capture control</body></html>'
      })
    );
    await page.goto('http://127.0.0.1:51781/error-control');
    const raised = page.waitForEvent('pageerror');
    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error('beta error collector control');
      }, 0)
    );
    await raised;
    assert(failures.some((message) => message.includes('beta error collector control')));
    failures.length = 0;
    await page.route('**/collector', (route) => route.abort('internetdisconnected'));
    const failed = page.waitForEvent('requestfailed');
    await page.evaluate(() => {
      window.betaHandledFetch = false;
      fetch('/collector').catch(() => {
        window.betaHandledFetch = true;
      });
    });
    await failed;
    await page.waitForFunction(() => window.betaHandledFetch);
    assert.deepEqual(failures, []);
    const unhandled = page.waitForEvent('console', {
      predicate: (message) => message.text().startsWith('garden-uncaught:rejection:')
    });
    await page.evaluate(() => {
      void fetch('/collector');
    });
    await unhandled;
    assert(failures.some((message) => message.startsWith('garden-uncaught:rejection:')));
    console.log(
      `${engine.name()} error capture controls passed: uncaught exceptions fail; handled fetch cancellations remain diagnostics.`
    );
  } finally {
    await browser.close();
  }
}
