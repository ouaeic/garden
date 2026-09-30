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
      requests.push({ path: url.pathname, method: request.method() });
  });
  await page.addInitScript(() => {
    window.betaVisibility = 'visible';
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
    const hiddenRequests = requests.slice(start);
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
    const projectHiddenRequests = requests.slice(projectStart);
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
    await page.close();
  }
}
