import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checkInterfaceTexture } from './browser-output-appearance.mjs';
import { captureBrowserErrors } from './browser-errors.mjs';
import { writeFile } from 'node:fs/promises';

export async function checkMobileNavigation({ context, origin, task, bootstrap, report }) {
  const page = await context.newPage();
  const errors = [];
  const diagnostics = await captureBrowserErrors(page, errors);
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
      assert.equal(await bar.getByRole('button').count(), 3, 'Home, Needs you and Computer');
      await bar.getByRole('button', { name: 'Computer', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
      await page.locator('.computer-runs').waitFor();
      await fits();
      const computerTabs = page.getByRole('navigation', { name: 'Computer tools', exact: true });
      for (const name of ['Results', 'Files', 'Machine', 'Runs']) {
        await computerTabs.getByRole('button', { name, exact: true }).click();
        await fits();
        if (name === 'Results')
          await page.screenshot({ path: resolve(report, `mobile-computer-results-${width}.png`) });
        if (name === 'Files') {
          await page.locator('.computer-file-list').waitFor();
          for (const theme of ['light', 'dark']) {
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
            }, theme);
            await checkInterfaceTexture(page);
            await page.screenshot({
              path: resolve(report, `mobile-computer-files-${theme}-${width}.png`)
            });
            await fits();
          }
        }
      }
      for (const name of ['Needs you', 'Home']) {
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
      await bar.getByRole('button', { name: 'Needs you', exact: true }).click();
      const attention = page.getByRole('region', { name: 'Needs you', exact: true });
      await attention.waitFor();
      await fits();
      await page.goBack();
      await attention.waitFor({ state: 'detached' });
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
          '[data-perch], .desk-card, .desk-work-card, .panel, .phone-bar, .garden-masthead'
        );
        assert(
          (await candidates.count()) > 0,
          'The border visibility check needs real candidate edges'
        );
        const hiddenBorders = await page.addStyleTag({
          content: `[data-perch], .desk-card, .desk-work-card, .panel, .phone-bar, .garden-masthead { ${rule} !important; }`
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
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/?view=attention`);
    await page.locator('.navigation-page[open]').waitFor();
    await page.locator('.life-layer').waitFor({ state: 'attached' });
    // Leave only the phone bar's real top border available on this page.
    const onlyBar = await page.addStyleTag({
      content:
        '[data-perch], .desk-card, .desk-work-card, .panel, .garden-masthead { border-style: none !important; }'
    });
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('garden:scene', { detail: 'snailCrawl' }))
    );
    const barSnail = page.locator('[data-creature="snail"]');
    await barSnail.waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
      const actor = document.querySelector('[data-creature="snail"]')?.getBoundingClientRect();
      const bar = document.querySelector('.phone-bar')?.getBoundingClientRect();
      return actor && bar && actor.top < bar.top && Math.abs(actor.bottom - bar.top) < 3;
    });
    await page.screenshot({ path: resolve(report, 'mobile-library-border-creature.png') });
    await onlyBar.evaluate((element) => element.remove());
    // A normal page may contain usable borders; only actual modal dialogs exclude them.
    const pagePanel = await page.locator('.navigation-page .dialog-body').evaluateHandle((body) => {
      const panel = document.createElement('section');
      panel.className = 'panel';
      panel.id = 'perch-probe';
      panel.style.cssText =
        'position:fixed;left:24px;top:200px;width:250px;height:100px;border:1px solid currentColor';
      body.append(panel);
      return panel;
    });
    const hideOtherEdges = await page.addStyleTag({
      content:
        '[data-perch], .desk-card, .desk-work-card, .phone-bar, .garden-masthead, .empty { border-style:none !important; }'
    });
    await barSnail.waitFor({ state: 'detached' });
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('garden:scene', { detail: 'snailCrawl' }))
    );
    await barSnail.waitFor({ state: 'attached' });
    await page.waitForFunction(() => {
      const actor = document.querySelector('[data-creature="snail"]')?.getBoundingClientRect();
      // Measured, not assumed: the page around the probe decides where its border lands.
      const edge = document.getElementById('perch-probe')?.getBoundingClientRect().top;
      return actor && edge !== undefined && actor.top < edge && Math.abs(actor.bottom - edge) < 3;
    });
    const modal = await page.evaluateHandle(() => {
      const dialog = document.createElement('dialog');
      dialog.textContent = 'Modal test';
      document.body.append(dialog);
      dialog.showModal();
      return dialog;
    });
    await barSnail.waitFor({ state: 'detached' });
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('garden:scene', { detail: 'snailCrawl' }))
    );
    await page.waitForTimeout(400);
    assert.equal(await barSnail.count(), 0, 'A true modal still excludes covered borders');
    await modal.evaluate((element) => element.remove());
    await pagePanel.evaluate((element) => element.remove());
    await hideOtherEdges.evaluate((element) => element.remove());
    console.log('Mobile creatures use actual page borders and the full-width phone bar.');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(origin);
    await page.locator('.home-projects').waitFor();
    assert.equal(
      await page.locator('.life-actor').count(),
      0,
      'Reduced-motion preference is respected'
    );
    await page.clock.install({ time: new Date('2026-09-29T22:00:00') });
    await page.addInitScript(() => {
      Math.random = () => 0;
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`${origin}/?view=attention`);
    await page.locator('.navigation-page[open]').waitFor();
    await page.locator('.life-layer').waitFor({ state: 'attached' });
    await page.evaluate(() =>
      dispatchEvent(new CustomEvent('garden:scene', { detail: 'batVisit' }))
    );
    await page.locator('.life-clip [data-creature="bat"]').waitFor({ state: 'attached' });
    assert.equal(
      await page
        .locator('.life-clip:has([data-creature="bat"])')
        .evaluate((clip) => clip.getBoundingClientRect().top),
      await page.locator('.garden-masthead').evaluate((bar) => bar.getBoundingClientRect().bottom),
      'Bats can hang from the same painted masthead on phones'
    );
    await page.clock.setFixedTime(new Date('2026-09-29T12:00:00'));
    await page.reload();
    await page.locator('.navigation-page[open]').waitFor();
    await page.locator('.life-layer').waitFor({ state: 'attached' });
    for (let second = 0; second < 8; second++) {
      await page
        .locator('body')
        .dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 });
      await page.clock.runFor(1000);
    }
    assert(
      (await page.locator('.life-actor').count()) > 0,
      'Ordinary taps do not continually postpone natural arrivals'
    );
    console.log(
      'Natural visitors arrive on mobile pages during ordinary taps, without forced scenes.'
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
    await page.clock.setSystemTime(Date.now());
    await page.clock.resume();
    await page.close();
    await writeFile(resolve(report, 'mobile-errors.json'), JSON.stringify(diagnostics, null, 2));
  }
}
