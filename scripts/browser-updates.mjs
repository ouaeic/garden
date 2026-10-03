import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureBrowserErrors } from './browser-errors.mjs';

export async function checkUpdates({ context, origin, report }) {
  const current = JSON.parse(
    await readFile(new URL('../apps/web/dist/build.json', import.meta.url), 'utf8')
  );
  for (const width of [1440, 390, 320]) {
    const page = await context.newPage();
    const errors = [];
    await captureBrowserErrors(page, errors);
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install();
    let build = current.id;
    let serverStatus = 'available';
    await page.route('**/build.json', (route) => route.fulfill({ json: { id: build } }));
    await page.route('**/v1/instance/updates', (route) =>
      route.fulfill({
        json: {
          checkedAt: new Date().toISOString(),
          server: { status: serverStatus, revision: 'a'.repeat(40) },
          client: null
        }
      })
    );
    await page.goto(origin);
    const notice = page.locator('.update-notice');
    await notice.getByText('Your garden server can be updated.', { exact: true }).waitFor();
    const editor = page.locator('.desk-start-card textarea');
    await editor.fill('Keep this unsent idea through the update notice.');
    await page.clock.runFor(100);
    await notice.getByRole('button', { name: 'Dismiss update notice', exact: true }).click();
    assert.equal(await notice.count(), 0);
    assert.equal(await editor.inputValue(), 'Keep this unsent idea through the update notice.');

    build = 'b'.repeat(64);
    await page.clock.fastForward(5 * 60_000);
    await notice.getByText('A fresh version of garden is ready.', { exact: true }).waitFor();
    assert.equal(
      await editor.inputValue(),
      'Keep this unsent idea through the update notice.',
      'A new build must not reload an unsent draft'
    );
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width < 700) {
      const bar = await page.locator('.phone-bar').boundingBox();
      assert(
        bar && bar.y + bar.height <= 845,
        'The update notice must leave mobile navigation in the viewport'
      );
    }
    await page.screenshot({ path: resolve(report, `update-notice-${width}.png`) });
    build = current.id;
    await page.reload();
    await notice.getByRole('button', { name: 'View update', exact: true }).click();
    await page.getByText('An update is available for your server.', { exact: true }).waitFor();
    await page.getByText('sudo garden update', { exact: true }).waitFor();
    // Maintenance is the Computer page's Machine tab, open as soon as the notice is followed.
    assert.equal(
      await page
        .getByRole('navigation', { name: 'Computer tools', exact: true })
        .getByRole('button', { name: 'Machine', exact: true })
        .getAttribute('aria-pressed'),
      'true',
      'View update must open the machine tab'
    );
    await page.screenshot({ path: resolve(report, `server-update-${width}.png`) });
    serverStatus = 'unknown';
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page
      .getByText('Could not check for server updates. Your installed version is still available.', {
        exact: true
      })
      .waitFor();
    assert.deepEqual(errors, [], 'Update journeys must not leave uncaught browser errors');
    await page.clock.setSystemTime(Date.now());
    await page.clock.resume();
    await page.close();
  }
  console.log(
    'Update notices passed on desktop and mobile: drafts remain, navigation fits, maintenance opens, and failed checks remain unknown.'
  );
}
