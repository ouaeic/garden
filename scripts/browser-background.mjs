import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function checkBackgroundWork({ context, origin, report, taskId }) {
  const page = await context.newPage();
  const requests = [];
  const activeBootstrap = new Set();
  let maxBootstrapRequests = 0;
  const settled = (request) => activeBootstrap.delete(request);
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/v1/bootstrap') {
      activeBootstrap.add(request);
      maxBootstrapRequests = Math.max(maxBootstrapRequests, activeBootstrap.size);
    }
    if (url.pathname.startsWith('/v1/'))
      requests.push({
        path: url.pathname,
        method: request.method(),
        startedWhile: request.headers()['x-beta-visibility'] ?? 'unknown'
      });
  });
  /*
   * The network sees a request some time after the page asks for it, so a read begun while the
   * page was visible can reach it just after the page is hidden. Each fetch is labelled with the
   * visibility it began under; only one begun while hidden, or not labelled at all, is traffic
   * the hidden page made.
   */
  const madeWhileHidden = (list) =>
    list
      .filter((request) => request.startedWhile !== 'visible')
      .map(({ path, method }) => ({ path, method }));
  await page.addInitScript(() => {
    window.betaVisibility = 'visible';
    const fetchFromPage = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      // Only the page's own reads are labelled, so nothing cross-origin needs a preflight.
      if (url.origin !== location.origin) return fetchFromPage(input, init);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}));
      headers.set('x-beta-visibility', window.betaVisibility);
      return fetchFromPage(input, { ...init, headers });
    };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => window.betaVisibility
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => window.betaVisibility !== 'visible'
    });
  });
  await page.clock.install();
  const visibility = async (value) => {
    await page.evaluate((state) => {
      window.betaVisibility = state;
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
    await page.locator('.desk-home').waitFor();
    await page.waitForFunction(() => document.querySelector('.garden-health'));
    assert(requests.some((request) => request.path === '/v1/bootstrap'));
    await visibility('hidden');
    const start = requests.length;
    await page.clock.runFor(180_000);
    const hiddenRequests = madeWhileHidden(requests.slice(start));
    await writeFile(
      resolve(report, 'background-traffic.json'),
      JSON.stringify({ hiddenDurationMs: 180_000, hiddenRequests, requests }, null, 2) + '\n'
    );
    assert.deepEqual(hiddenRequests, [], 'An idle hidden page must make no control API requests');
    const wake = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/v1/bootstrap'
    );
    await visibility('visible');
    await page.clock.runFor(500);
    await wake;
    assert(
      requests.slice(start).some((request) => request.path.endsWith('/heartbeat')),
      'Returning to the app must refresh presence immediately'
    );
    await page.route('**/v1/bootstrap', async (route) => {
      await new Promise((done) => setTimeout(done, 250));
      await route.fallback();
    });
    const slowRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/v1/bootstrap'
    );
    await page.clock.runFor(60_000);
    await slowRead;
    assert.equal(
      maxBootstrapRequests,
      1,
      'Slow bootstrap reads must never overlap during polling or reconnect'
    );
    const mediaRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/media-batches')
    );
    await page.goto(`${origin}/?task=${encodeURIComponent(taskId)}`);
    await mediaRead;
    await page.locator('.desk-project').waitFor();
    await page.clock.runFor(1000);
    await visibility('hidden');
    const projectStart = requests.length;
    await page.clock.runFor(180_000);
    const projectHiddenRequests = madeWhileHidden(requests.slice(projectStart));
    await writeFile(
      resolve(report, 'background-traffic.json'),
      JSON.stringify(
        {
          hiddenDurationMs: 180_000,
          hiddenRequests,
          projectHiddenRequests,
          maxBootstrapRequests,
          requests
        },
        null,
        2
      ) + '\n'
    );
    assert.deepEqual(
      projectHiddenRequests,
      [],
      'A hidden project must suspend media and control API polling'
    );
    await visibility('visible');
    await page.clock.runFor(500);
    await page.screenshot({ path: resolve(report, 'background-return-phone.png') });
  } finally {
    await page.clock.setSystemTime(Date.now());
    await page.clock.resume();
    await page.close();
  }
}
