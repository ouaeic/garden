import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkMobileNavigation({ context, origin, task, bootstrap, report }) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/bootstrap')
      return route.fulfill({
        json: {
          ...bootstrap,
          computer: {
            ...bootstrap.computer,
            cpuPercent: 17,
            memoryUsedBytes: 256,
            memoryTotalBytes: 1024
          }
        }
      });
    const emptyLists = [
      '/v1/connectors',
      '/v1/connectors/catalog',
      '/v1/connectors/audit',
      '/v1/notifications/destinations',
      '/v1/sessions',
      '/v1/auth/passkeys',
      '/v1/devices/enrollments',
      '/v1/api-tokens'
    ];
    if (emptyLists.includes(path) || path.endsWith('/snapshots'))
      return route.fulfill({ json: [] });
    if (path === '/v1/connectors/accounts/oauth/config')
      return route.fulfill({ json: { redirectUrl: origin + '/oauth/callback' } });
    if (path === '/v1/spend-limits')
      return route.fulfill({
        json: {
          dailyCapUsd: null,
          monthlyCapUsd: null,
          defaultTaskCapUsd: null,
          warnAtPercent: 80,
          maxInputUsdPerMillionTokens: null,
          maxOutputUsdPerMillionTokens: null
        }
      });
    if (path === '/v1/spend')
      return route.fulfill({ json: { windows: [], byDay: [], byModel: [], byTask: [] } });
    if (path === '/v1/usage')
      return route.fulfill({
        json: {
          period: { start: '2026-09-01', end: '2026-10-01' },
          totals: {},
          storageBytes: 0,
          storageLimitBytes: 1e9,
          storageThreshold: 'normal',
          history: []
        }
      });
    if (path === '/v1/notifications/config')
      return route.fulfill({ json: { enabled: false, publicKey: null } });
    if (path === '/v1/notifications/settings')
      return route.fulfill({
        json: {
          timeZone: 'UTC',
          kinds: {},
          quietHoursStart: null,
          quietHoursEnd: null,
          quietHoursAllowApprovals: true
        }
      });
    if (path === '/v1/auth/me') return route.fulfill({ json: { user: bootstrap.user } });
    if (path.endsWith('/brief'))
      return route.fulfill({ json: { markdown: '', path: 'GARDEN.md' } });
    return route.fallback();
  });
  try {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(origin);
      const bar = page.getByRole('navigation', { name: 'Sections', exact: true });
      const fits = async () => {
        const bounds = await bar.boundingBox();
        assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 845);
        assert.equal(
          await page.locator('dialog:modal').count(),
          0,
          'Navigation never blocks the phone bar'
        );
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      };
      await bar.waitFor();
      const stats = page.getByRole('button', { name: 'Stats', exact: true });
      await stats.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 });
      const panel = page.getByRole('region', { name: 'Usage statistics', exact: true });
      await panel.waitFor();
      await panel.getByText('CPU 17%', { exact: true }).waitFor();
      await panel.getByText(/Fixture GPU · GPU 37%/).waitFor();
      await panel.getByText(/Unavailable GPU · GPU unavailable/).waitFor();
      await stats.dispatchEvent('pointerup', { pointerType: 'touch' });
      await stats.dispatchEvent('click', { detail: 1 });
      assert(await panel.isVisible(), 'The synthesized click after a hold must not close Stats');
      await page.screenshot({ path: resolve(report, `mobile-stats-${width}.png`) });
      await bar.getByRole('button', { name: 'Projects', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
      await fits();
      await page.locator('#navigation-page.desk-sheet-projects').waitFor();
      await page.getByRole('button', { name: 'Automations', exact: true }).click();
      await page.getByRole('region', { name: 'Automations', exact: true }).waitFor();
      await fits();
      for (const name of ['Library', 'Needs you', 'Computer', 'Home']) {
        await bar.getByRole('button', { name, exact: true }).click();
        await fits();
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('region', { name: 'Settings', exact: true });
      await settings.waitFor();
      const settingsTabs = settings
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button');
      await settingsTabs.first().waitFor();
      assert.equal(await settingsTabs.count(), 7);
      for (const tab of await settingsTabs.all()) {
        await tab.click();
        assert.equal(await tab.getAttribute('aria-current'), 'page');
        await fits();
      }
      await page.screenshot({ path: resolve(report, `mobile-settings-${width}.png`) });
      await bar.getByRole('button', { name: 'Library', exact: true }).click();
      const library = page.getByRole('region', { name: 'Library', exact: true });
      await library.waitFor();
      for (const name of ['Results', 'Memory', 'Skills']) {
        await library.getByRole('button', { name, exact: true }).click();
        await fits();
      }
      await page.screenshot({ path: resolve(report, `mobile-library-${width}.png`) });
      await page.goto(`${origin}/?task=${task.id}&project=${task.projectId}`);
      await bar.waitFor();
      for (const name of ['Files', 'Activity', 'Tools']) {
        await page
          .locator('.project-view-nav:visible')
          .getByRole('button', { name, exact: true })
          .click();
        await page.locator('.project-panel.navigation-page[open]').waitFor();
        await fits();
      }
      await page.screenshot({ path: resolve(report, `mobile-project-tools-${width}.png`) });
      await bar.getByRole('button', { name: 'Library', exact: true }).click();
      await library.waitFor();
      await fits();
      await page.goBack();
      await library.waitFor({ state: 'detached' });
      await page.locator('.project-panel.navigation-page[open]').waitFor();
      await fits();
    }
    await page.goto(origin);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await page.locator('.life-layer').waitFor({ state: 'attached' });
    const scenes = {
      birdVisit: 'bird',
      monkeyTour: 'monkey',
      frogHop: 'frog',
      ladybirdWalk: 'ladybird',
      snailCrawl: 'snail'
    };
    for (const [scene, creature] of Object.entries(scenes)) {
      console.log('Mobile creature:', scene);
      await page.reload();
      await page.locator('.home-projects').waitFor();
      await page.locator('.life-layer').waitFor({ state: 'attached' });
      await page.evaluate(
        (name) => dispatchEvent(new CustomEvent('garden:scene', { detail: name })),
        scene
      );
      const actor = page.locator(`[data-creature="${creature}"]`).first();
      await actor.waitFor({ state: 'attached', timeout: 3000 });
      await page.waitForFunction((kind) => {
        const actor = document.querySelector(`[data-creature="${kind}"]`);
        if (!actor) return false;
        const box = actor.getBoundingClientRect();
        const clip = actor.closest('.life-clip')?.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          (!clip || Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top) > 6)
        );
      }, creature);
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(report, 'mobile-creatures.png') });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const rule of ['border-style: none', 'border-color: transparent', 'opacity: 0']) {
        await page.reload();
        await page.locator('.home-projects').waitFor();
        await page.locator('.life-layer').waitFor({ state: 'attached' });
        await page.evaluate(() =>
          dispatchEvent(new CustomEvent('garden:scene', { detail: 'snailCrawl' }))
        );
        const snail = page.locator('[data-creature="snail"]');
        await snail.waitFor({ state: 'attached' });
        const candidates = page.locator(
          '[data-perch], .desk-card, .desk-work-card, .garden-masthead'
        );
        assert(
          (await candidates.count()) > 0,
          'The border visibility check needs real candidate edges'
        );
        const hiddenBorders = await page.addStyleTag({
          content: `[data-perch], .desk-card, .desk-work-card, .garden-masthead { ${rule} !important; }`
        });
        await snail.waitFor({ state: 'detached' });
        await page.evaluate((names) => {
          for (const name of names)
            dispatchEvent(new CustomEvent('garden:scene', { detail: name }));
        }, Object.keys(scenes));
        await page.waitForTimeout(400);
        assert.equal(
          await page
            .locator(
              '[data-creature="bird"], [data-creature="monkey"], [data-creature="frog"], [data-creature="ladybird"], [data-creature="snail"]'
            )
            .count(),
          0,
          `No invisible perches at ${width}px with ${rule}`
        );
        await hiddenBorders.evaluate((element) => element.remove());
        await page.evaluate(() =>
          dispatchEvent(new CustomEvent('garden:scene', { detail: 'snailCrawl' }))
        );
        await snail.waitFor({ state: 'attached' });
      }
    }
    console.log(
      'Painted-edge checks passed on desktop and mobile: absent, transparent and hidden borders are rejected; returning borders can be used again.'
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.locator('.home-projects').waitFor();
    assert.equal(
      await page.locator('.life-actor').count(),
      0,
      'Reduced-motion preference is respected'
    );
    assert.deepEqual(errors, [], 'Mobile navigation must not trigger render errors');
  } catch (error) {
    console.error(
      await page.locator('.life-actor').evaluateAll((actors) =>
        actors.map((actor) => ({
          kind: actor.getAttribute('data-creature'),
          bounds: actor.getBoundingClientRect().toJSON(),
          animations: actor.getAnimations().map((animation) => animation.playState)
        }))
      )
    );
    await page.screenshot({ path: resolve(report, 'mobile-failure.png') });
    throw error;
  } finally {
    await page.close();
  }
}
