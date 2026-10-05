#!/usr/bin/env node
/**
 * The interface as an owner meets it: the built client in a real browser against the fixture scene.
 *
 * Each journey gets a fresh scene and a fresh browser context, so a planted deal in one never
 * empties the deck of the next. Every journey also holds three things that apply everywhere: no
 * page error, no request the scene does not serve, and nothing wider than the screen.
 *
 *   GARDEN_UI_ENGINE  chromium (default), webkit, or both
 *   GARDEN_UI_FOCUS   comma-separated journey names; every journey when empty
 *   GARDEN_UI_REPORT  where screenshots and the summary go; a temporary folder otherwise
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBrowserErrors } from './browser-errors.mjs';
import { createGardenFixtures } from './garden-fixtures.mjs';

const runner = createRequire(new URL('../services/workspace-runner/package.json', import.meta.url));
const { chromium, webkit } = runner('playwright-core');
const dist = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
await access(resolve(dist, 'index.html')).catch(() => {
  throw new Error('apps/web/dist is missing. Run pnpm --filter @garden/web build first.');
});
const report = process.env.GARDEN_UI_REPORT || (await mkdtemp(resolve(tmpdir(), 'garden-ui-')));
await mkdir(report, { recursive: true });
const engineName = process.env.GARDEN_UI_ENGINE || 'chromium';
const engines =
  engineName === 'both' ? [chromium, webkit] : [engineName === 'webkit' ? webkit : chromium];
const focus = (process.env.GARDEN_UI_FOCUS ?? '').split(',').filter(Boolean);

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};

/** One server for the run; `reset` gives the next journey an untouched scene. */
function serve() {
  let fixtures = createGardenFixtures();
  const misses = [];
  const writes = [];
  const reads = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/v1/')) {
        if (request.method === 'GET') reads.push(new URL(request.url, 'http://local').pathname);
        if (request.method !== 'GET')
          writes.push({
            method: request.method,
            path: new URL(request.url, 'http://local').pathname,
            key: request.headers['idempotency-key'] ?? null,
            replayOnly: request.headers['idempotency-replay-only'] === 'true'
          });
        if (await fixtures.handle(request, response)) return;
        misses.push(`${request.method} ${request.url}`);
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'not_in_fixture', message: request.url }));
        return;
      }
      // The service worker would cache this build across journeys; the interface works without it.
      if (request.url === '/sw.js') return void response.writeHead(404).end();
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      const file = resolve(dist, '.' + (extname(pathname) ? pathname : '/index.html'));
      if (!file.startsWith(dist + sep)) return void response.writeHead(403).end();
      const bytes = await readFile(file);
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream'
      });
      response.end(bytes);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  });
  return {
    listen: () =>
      new Promise((done) =>
        server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`))
      ),
    reset() {
      fixtures = createGardenFixtures();
      misses.length = 0;
      writes.length = 0;
      reads.length = 0;
      return fixtures;
    },
    misses,
    writes,
    reads,
    close: () => new Promise((done) => server.close(done))
  };
}

/** Anything drawn past the screen's edge that no scrolling or clipping parent contains. */
const overflowing = (page) =>
  page.evaluate(() => {
    const clips = (element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow !== 'visible') {
          const box = parent.getBoundingClientRect();
          return box.left >= -1 && box.right <= innerWidth + 1;
        }
      }
      return false;
    };
    const found = [];
    for (const element of document.querySelectorAll('body *')) {
      const style = getComputedStyle(element);
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      if (
        element.closest('[aria-hidden="true"]') ||
        (style.position === 'fixed' && element.matches('canvas'))
      )
        continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= innerWidth + 1 && box.left >= -1) continue;
      if (clips(element)) continue;
      found.push(
        `${element.tagName.toLowerCase()}.${[...element.classList].join('.')} ${Math.round(box.left)}..${Math.round(box.right)} "${(element.textContent ?? '').trim().slice(0, 40)}"`
      );
    }
    return found.slice(0, 8);
  });

/**
 * Whatever a scrolling pane ends with must be able to scroll clear of the ask bar, which floats
 * over the bottom of every view. Each pane is scrolled to its end and its last content measured.
 */
const buriedUnderAsk = (page) =>
  page.evaluate(() => {
    const ask = document.querySelector('form.ask .ask-field')?.getBoundingClientRect();
    if (!ask) return [];
    const buried = [];
    for (const pane of document.querySelectorAll('.stage *')) {
      const style = getComputedStyle(pane);
      if (!/(auto|scroll)/.test(style.overflowY) || pane.scrollHeight <= pane.clientHeight + 1)
        continue;
      pane.scrollTop = pane.scrollHeight;
      const box = pane.getBoundingClientRect();
      if (box.bottom <= ask.top || box.right <= ask.left || box.left >= ask.right) continue;
      let last = null;
      const governed = (child) => {
        for (let at = child.parentElement; at && at !== pane; at = at.parentElement)
          if (getComputedStyle(at).overflowY !== 'visible') return false;
        return true;
      };
      for (const child of pane.querySelectorAll('*')) {
        if (!governed(child) || !child.checkVisibility({ visibilityProperty: true })) continue;
        const rect = child.getBoundingClientRect();
        if (
          rect.height > 0 &&
          rect.width > 0 &&
          child.children.length === 0 &&
          (!last || rect.bottom > last.bottom)
        )
          last = {
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            text: (child.textContent ?? '').trim().slice(0, 30)
          };
      }
      if (last && last.bottom > ask.top - 4 && last.right > ask.left && last.left < ask.right)
        buried.push(
          `${pane.className}: "${last.text}" ends at ${Math.round(last.bottom)}, the ask bar starts at ${Math.round(ask.top)}`
        );
      pane.scrollTop = 0;
    }
    return buried;
  });

/**
 * Text that falls below WCAG AA against what is really drawn behind it. Every glyph on the page is
 * made transparent for one screenshot, so whatever sits under a line of text - a pane, a sliding
 * tab thumb, the light canvas - is measured as painted, at points along each line box.
 */
async function contrastFailures(page) {
  const runs = await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish();
      } catch {
        // An endless animation cannot finish; reduced motion has already stilled it.
      }
    }
    const parse = (value) => {
      const numbers = (value.match(/[\d.]+/g) ?? []).map(Number);
      const [r = 0, g = 0, b = 0, a = 1] = numbers;
      return [r, g, b, numbers.length > 3 ? a : 1];
    };
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.textContent?.trim()) continue;
      if (element.closest('[aria-hidden="true"], .sr-only, svg, [inert], textarea, input, select'))
        continue;
      if (element.closest('button:disabled, [aria-disabled="true"]')) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.webkitBackgroundClip === 'text') continue;
      let opacity = 1;
      for (let at = element; at; at = at.parentElement)
        opacity *= Number(getComputedStyle(at).opacity);
      if (opacity < 0.05) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()]
        .filter(
          (r) =>
            r.width > 2 &&
            r.height > 4 &&
            r.bottom > 0 &&
            r.top < innerHeight &&
            r.right > 0 &&
            r.left < innerWidth
        )
        .slice(0, 3)
        .map((r) => ({
          left: Math.max(0, r.left),
          top: Math.max(0, r.top),
          right: Math.min(innerWidth, r.right),
          bottom: Math.min(innerHeight, r.bottom)
        }));
      if (!rects.length) continue;
      // Text something else sits on top of - a sheet's scrim, the ask bar - is not being read.
      const points = [];
      for (const rect of rects)
        for (const fy of [0.3, 0.5, 0.7])
          for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const x = rect.left + (rect.right - rect.left) * fx;
            const y = rect.top + (rect.bottom - rect.top) * fy;
            const top = document.elementFromPoint(x, y);
            if (top && (top === element || element.contains(top) || top.contains(element)))
              points.push([x, y]);
          }
      if (points.length < 3) continue;
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const [r, g, b, a] = parse(style.color);
      found.push({
        points,
        ink: [r, g, b, a * opacity],
        needed: size >= 24 || (bold && size >= 18.66) ? 3 : 4.5,
        label: `"${node.textContent.trim().slice(0, 40)}" (${element.tagName.toLowerCase()}.${[...element.classList].join('.')})`
      });
    }
    return found;
  });
  if (!runs.length) return ['No text was found to measure'];
  const hidden = await page.addStyleTag({
    content:
      '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important;caret-color:transparent!important}'
  });
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );
  const png = (await page.screenshot({ type: 'png' })).toString('base64');
  await hidden.evaluate((style) => style.remove());
  return page.evaluate(
    async ({ png, runs }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const scale = image.width / innerWidth;
      const luminance = (rgb) =>
        rgb
          .slice(0, 3)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => {
        const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
        return (x + 0.05) / (y + 0.05);
      };
      const failures = [];
      for (const run of runs) {
        const measured = run.points.map(([x, y]) => {
          const [r, g, b] = context.getImageData(
            Math.floor(x * scale),
            Math.floor(y * scale),
            1,
            1
          ).data;
          const a = run.ink[3];
          const shown = [0, 1, 2].map((i) => run.ink[i] * a + [r, g, b][i] * (1 - a));
          return ratio(shown, [r, g, b]);
        });
        measured.sort((m, n) => m - n);
        // The second-worst point, so one stray pixel of a neighbouring border cannot fail a line.
        const worst = measured[Math.min(1, measured.length - 1)];
        if (worst < run.needed) failures.push(`${worst.toFixed(2)} < ${run.needed}: ${run.label}`);
      }
      return failures;
    },
    { png, runs }
  );
}

/** Turns the deck until the card about `text` is on top, as the owner would with "next". */
async function toTop(page, text) {
  const deck = page.getByRole('region', { name: 'Your move' });
  await deck.locator('.move').first().waitFor();
  for (let turn = 0; turn < 6; turn++) {
    if (await deck.locator('.move:not([inert])', { hasText: text }).count()) return;
    await deck.getByRole('button', { name: /waiting · next/ }).click();
  }
  throw new Error(`No card about ${text} reached the top of the deck`);
}

/** WebKit's Tab, like Safari's, moves only between fields; Option-Tab walks every control. */
const tab = (page) =>
  page.keyboard.press(
    page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab'
  );

const shot = (page, name) => page.screenshot({ path: resolve(report, `${name}.png`) });

const journeys = {
  /** The desk opens on the verdict, offers the catch-up after a long absence, and shows each bed. */
  async desk({ page, origin }) {
    await page.goto(origin);
    const catchUp = page.locator('[role="dialog"][aria-labelledby="catchup-title"]');
    await catchUp.waitFor();
    await shot(page, 'catch-up');
    await catchUp.getByRole('button', { name: 'Close' }).click();
    await catchUp.waitFor({ state: 'detached' });
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
    await page.getByRole('heading', { name: 'Ready for you' }).waitFor();
    await page.getByRole('heading', { name: 'Your move' }).waitFor();
    await page.getByRole('heading', { name: 'Your server' }).waitFor();
    assert.ok(
      (await page.locator('[data-goal-id]').count()) >= 3,
      'Every growing goal has a card on the desk'
    );
    assert.equal(
      await page.locator('[data-goal-id]', { hasText: 'Portfolio site refresh' }).count(),
      0,
      'An accepted goal leaves the desk'
    );
    await shot(page, 'desk');
  },

  /** Every view fits every width without anything spilling past the screen. */
  async layout({ page, origin, scheme }) {
    const views = [
      ['today', ''],
      ['goal', `?goal=${createGardenFixtures().id(1)}`],
      ['glance', `?goal=${createGardenFixtures().id(3)}&zoom=glance`],
      ['inspect', `?goal=${createGardenFixtures().id(1)}&zoom=inspect`],
      ['keys', '?view=keys'],
      ['record', '?view=record'],
      ['computer', '?view=computer'],
      ['settings', '?view=settings'],
      ['deal', `?view=today&goal=${createGardenFixtures().id(4)}&sheet=deal`]
    ];
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 760 : 900 });
      for (const [name, query] of views) {
        await page.goto(`${origin}/${query}`);
        await page.locator('.app').waitFor();
        await page
          .locator('[aria-busy="true"]')
          .first()
          .waitFor({ state: 'detached' })
          .catch(() => undefined);
        await page.waitForTimeout(250);
        const spill = await overflowing(page);
        assert.deepEqual(spill, [], `${name} at ${width}px in ${scheme} spills past the screen`);
        assert.deepEqual(
          await buriedUnderAsk(page),
          [],
          `${name} at ${width}px ends under the ask bar`
        );
        if (width === 320 || width === 1440) await shot(page, `${name}-${width}-${scheme}`);
      }
    }
  },

  /** Text keeps AA contrast against what is really behind it, in both themes. */
  async contrast({ page, origin, scheme }) {
    const id = createGardenFixtures().id;
    // The light falls differently on every load. Each page is measured under its own fixed fall of
    // light, so a failure can be reproduced and the set as a whole covers many arrangements.
    await page.addInitScript(() => {
      if (window !== window.top) return;
      let seed = Number(sessionStorage.getItem('garden-light-seed') ?? '1');
      sessionStorage.setItem('garden-light-seed', String(seed + 1));
      Math.random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
    });
    for (const query of [
      '?view=today',
      `?goal=${id(1)}`,
      `?goal=${id(3)}&zoom=glance`,
      `?goal=${id(2)}&zoom=inspect`,
      '?view=keys',
      '?view=record',
      '?view=settings',
      `?view=today&goal=${id(4)}&sheet=deal`,
      '?view=today&sheet=catchup'
    ]) {
      await page.goto(`${origin}/${query}`);
      await page.locator('.app').waitFor();
      await page.waitForTimeout(400);
      const failures = await contrastFailures(page);
      assert.deepEqual(failures, [], `Contrast in ${scheme} at ${query}`);
    }
  },

  /** The desk can be worked from the keyboard alone, with a visible mark on whatever has focus. */
  async keyboard({ page, origin }) {
    await page.goto(`${origin}/?view=today`);
    await page.getByRole('heading', { name: 'Your move' }).waitFor();
    const reached = [];
    for (let step = 0; step < 90; step++) {
      await tab(page);
      // Focus is visible when something about the control, or the frame drawn around it, looks
      // different from the same control unfocused.
      const focused = await page.evaluate(async () => {
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        const look = () => {
          const parts = [];
          for (let at = element, depth = 0; at && depth < 4; at = at.parentElement, depth++)
            for (const pseudo of [null, '::before', '::after']) {
              const style = getComputedStyle(at, pseudo);
              parts.push(
                [
                  style.outlineStyle,
                  style.outlineWidth,
                  style.outlineColor,
                  style.boxShadow,
                  style.borderColor,
                  style.backgroundColor,
                  style.opacity,
                  style.color
                ].join('|')
              );
            }
          return parts.join('\n');
        };
        const settle = () => new Promise((done) => setTimeout(done, 40));
        await settle();
        const withFocus = look();
        element.blur();
        await settle();
        const without = look();
        element.focus({ preventScroll: true, focusVisible: true });
        await settle();
        return {
          name: (
            element.getAttribute('aria-label') ||
            element.textContent ||
            element.getAttribute('placeholder') ||
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 60),
          marked: withFocus !== without
        };
      });
      if (focused) reached.push(focused);
    }
    const names = reached.map((item) => item.name);
    for (const expected of ['Today', 'Keys', 'Record', 'Review the deal', '3 waiting · next'])
      assert.ok(
        names.some((name) => name.startsWith(expected)),
        `Tab reaches ${expected}; reached ${names.join(' | ')}`
      );
    assert.ok(
      names.some((name) => /What should garden grow/.test(name)) ||
        (await page.evaluate(() => document.querySelector('#ask-input') !== null)),
      'The ask bar is part of the tab order'
    );
    const unmarked = reached.filter((item) => !item.marked).map((item) => item.name);
    assert.deepEqual([...new Set(unmarked)], [], 'Every focused control shows where focus is');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const search = page.getByRole('dialog', { name: 'Search' });
    await search.waitFor();
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'detached' });
  },

  /** An approval waits on the deck, goes through with one press, and a decline carries its reason. */
  async approval({ page, origin, server }) {
    await page.goto(`${origin}/?view=today`);
    const deck = page.getByRole('region', { name: 'Your move' });
    const card = deck.locator('.move:not([inert])', { hasText: 'Mitte Diagnostics' });
    await toTop(page, 'Mitte Diagnostics');
    await card.getByRole('button', { name: 'Decline' }).click();
    await card
      .getByRole('textbox', { name: 'Reason for declining' })
      .fill('German at C1 is out of scope.');
    await card
      .getByRole('button', { name: /Decline/ })
      .last()
      .click();
    await card.waitFor({ state: 'detached' });
    assert.ok(
      server.writes.some((write) => /\/v1\/approvals\/[^/]+\/deny$/.test(write.path)),
      'Declining sends the decision'
    );
    server.reset().state.preferences.lastLookAt = new Date().toISOString();
    await page.reload();
    const again = page
      .getByRole('region', { name: 'Your move' })
      .locator('.move:not([inert])', { hasText: 'Mitte Diagnostics' });
    await toTop(page, 'Mitte Diagnostics');
    await again.getByRole('button', { name: 'Approve', exact: true }).click();
    await again.waitFor({ state: 'detached' });
    assert.ok(server.writes.some((write) => /\/v1\/approvals\/[^/]+\/approve$/.test(write.path)));
  },

  /** A proposed deal opens from the deck, and planting it sends the owner's choices once. */
  async deal({ page, origin, server }) {
    await page.goto(`${origin}/?view=today`);
    await page.getByRole('button', { name: 'Review the deal' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.waitFor();
    await shot(page, 'deal');
    for (let step = 0; step < 30; step++) {
      await tab(page);
      // Leaving for the browser's own controls is allowed; landing on the page behind is not.
      assert.ok(
        await page.evaluate(
          () =>
            document.activeElement === document.body ||
            Boolean(document.activeElement?.closest('[role="dialog"]'))
        ),
        'Focus stays inside an open sheet'
      );
    }
    await sheet
      .getByRole('button', { name: /^Plant/ })
      .last()
      .click();
    await sheet.waitFor({ state: 'detached' });
    const planted = server.writes.filter((write) => /\/deal$/.test(write.path));
    assert.equal(planted.length, 1, 'One press plants once');
    await page.getByRole('button', { name: 'Review the deal' }).waitFor({ state: 'detached' });
  },

  /** A goal asked for from the desk is sent once, and a retry after a lost reply reuses its key. */
  async ask({ page, origin, server }) {
    await page.goto(`${origin}/?view=today`);
    const input = page.getByRole('textbox', { name: 'What should garden grow?' });
    await input.fill('Summarise the Wellcome discovery call for me');
    let dropped = false;
    await page.route('**/v1/tasks', async (route) => {
      if (route.request().method() === 'POST' && !dropped) {
        dropped = true;
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Plant', exact: true }).click();
    await page.locator('.hint.is-error').waitFor();
    await page.getByRole('button', { name: 'Plant', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#ask-input')?.value === '');
    const sent = server.writes.filter((write) => write.path === '/v1/tasks');
    assert.equal(sent.length, 1, 'The dropped send never reached the server; the retry did');
    assert.ok(sent[0].key, 'A send carries an idempotency key');
    assert.equal(sent[0].replayOnly, true, 'A retry asks only for the original send');
    await page.locator('[data-goal-id]', { hasText: 'Summarise the Wellcome' }).waitFor();
  },

  /** A goal reads at three distances, and the tabs move with arrow keys as well as clicks. */
  async goal({ page, origin }) {
    const id = createGardenFixtures().id;
    await page.goto(`${origin}/?goal=${id(1)}`);
    const tabs = page.getByRole('tablist', { name: 'How close to look' });
    await tabs.waitFor();
    for (const name of ['Glance', 'Look', 'Inspect']) {
      await tabs.getByRole('tab', { name }).click();
      await page.waitForFunction(
        (label) =>
          [...document.querySelectorAll('[role="tab"]')].some(
            (tab) => tab.textContent === label && tab.getAttribute('aria-selected') === 'true'
          ),
        name
      );
      await shot(page, `goal-${name.toLowerCase()}`);
    }
    await page.goto(`${origin}/?goal=${id(3)}`);
    await page.getByRole('heading', { name: '2025 tax return' }).waitFor();
  },

  /** When the server stops answering the desk says so, and stops saying so once it is back. */
  async reconnect({ page, origin }) {
    await page.goto(`${origin}/?view=today`);
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
    await page.route('**/v1/bootstrap', (route) => route.abort('connectionrefused'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const lost = page.getByRole('status').filter({ hasText: 'Reconnecting' });
    await lost.waitFor();
    await page.unroute('**/v1/bootstrap');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await lost.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
  },

  /**
   * A visible desk reads on a steady beat, a hidden one reads nothing at all, and a burst of
   * refreshes shares one read. Time is the browser's fake clock, so minutes pass in a moment.
   */
  async quiet({ page, origin, server }) {
    await page.clock.install();
    await page.goto(`${origin}/?view=today`);
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
    const count = (path) => server.reads.filter((read) => read.endsWith(path)).length;
    const settle = () => page.waitForTimeout(300);
    let before = count('/bootstrap');
    for (let beat = 0; beat < 4; beat++) {
      await page.clock.runFor(15_000);
      await settle();
    }
    const visible = count('/bootstrap') - before;
    assert.equal(
      visible,
      4,
      `A visible desk reads every 15 s; it read ${visible} times in a minute`
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden'
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    before = count('/bootstrap');
    const quietFrom = server.reads.length;
    const beats = server.writes.filter((write) => write.path.endsWith('/heartbeat')).length;
    await page.clock.runFor(180_000);
    await settle();
    assert.deepEqual(server.reads.slice(quietFrom), [], 'A hidden desk reads nothing');
    assert.equal(
      server.writes.filter((write) => write.path.endsWith('/heartbeat')).length,
      beats,
      'A hidden desk keeps nothing awake'
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible'
      });
      for (let burst = 0; burst < 6; burst++) document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    const burst = count('/bootstrap') - before;
    assert.ok(
      burst >= 1 && burst <= 2,
      `Six refreshes at once share their reads; they made ${burst}`
    );
  },

  /** Day and night switch at once and are remembered on this device. */
  async theme({ page, origin }) {
    await page.goto(`${origin}/?view=today`);
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null);
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByRole('button', { name: 'Switch day or night' }).click();
    const chosen = await theme();
    assert.ok(chosen === 'light' || chosen === 'dark');
    await page.waitForFunction(
      (previous) => getComputedStyle(document.body).backgroundColor !== previous,
      before
    );
    await page.reload();
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
    assert.equal(await theme(), chosen, 'The chosen theme survives a reload');
  },

  /** A phone keeps every place reachable: the views in the header, the rest behind one menu. */
  async phone({ page, origin }) {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`${origin}/?view=today`);
    await page.getByRole('heading', { name: 'Growing' }).waitFor();
    for (const [item, check] of [
      ['Settings', () => page.getByRole('navigation', { name: 'Settings' }).waitFor()],
      ['Your computer', () => page.locator('.app[data-view="computer"]').waitFor()],
      ['Search', () => page.getByRole('dialog', { name: 'Search' }).waitFor()]
    ]) {
      await page.getByRole('button', { name: 'More' }).click();
      await page.locator('#phone-menu').getByRole('button', { name: item }).click();
      await check();
      if (item === 'Search') await page.keyboard.press('Escape');
    }
    await shot(page, 'phone-menu');
  },

  /** Settings rooms open: models from the connected providers, memory, notifications, updates. */
  async settings({ page, origin, fixtures }) {
    fixtures.state.serverUpdate = 'available';
    await page.goto(`${origin}/?view=settings&section=models`);
    await page.getByText('openrouter', { exact: false }).first().waitFor();
    for (const section of ['Knowledge', 'Notifications', 'Computer', 'Spending', 'Appearance']) {
      await page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: new RegExp(`^${section}`) })
        .click();
      await page.locator('.settings-room .skeleton').waitFor({ state: 'detached' });
      await shot(page, `settings-${section.toLowerCase()}`);
    }
    await page.goto(`${origin}/?view=today`);
    const notice = page.locator('.update-notice');
    await notice.getByText('Your garden server can be updated.').waitFor();
    await notice.getByRole('button', { name: 'View update' }).click();
    await page.getByRole('navigation', { name: 'Settings' }).waitFor();
  }
};

const selected = Object.entries(journeys).filter(([name]) => !focus.length || focus.includes(name));
assert.ok(selected.length > 0, `No journey matches GARDEN_UI_FOCUS=${focus.join(',')}`);
const server = serve();
const origin = await server.listen();
const results = [];
try {
  for (const engine of engines) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const [name, run] of selected) {
        for (const scheme of name === 'layout' || name === 'contrast'
          ? ['dark', 'light']
          : ['dark']) {
          const fixtures = server.reset();
          // Only the desk journey returns after a long absence; the rest arrive having just looked.
          if (name !== 'desk') fixtures.state.preferences.lastLookAt = new Date().toISOString();
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            colorScheme: scheme,
            reducedMotion: 'reduce'
          });
          const page = await context.newPage();
          page.setDefaultTimeout(8000);
          const failures = [];
          await captureBrowserErrors(page, failures);
          const started = Date.now();
          const label = `${engine.name()} ${name}${scheme === 'light' ? ' (day)' : ''}`;
          try {
            await run({ page, origin, scheme, server, fixtures });
            assert.deepEqual(failures, [], 'No page errors');
            assert.deepEqual([...new Set(server.misses)], [], 'Every request is part of the scene');
            results.push({ journey: label, passed: true, ms: Date.now() - started });
            console.log(`✔ ${label}`);
          } catch (error) {
            await page
              .screenshot({
                path: resolve(report, `failed-${engine.name()}-${name}-${scheme}.png`)
              })
              .catch(() => undefined);
            results.push({ journey: label, passed: false, error: String(error?.message ?? error) });
            console.error(`✖ ${label}\n${error?.stack ?? error}`);
            process.exitCode = 1;
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
  await writeFile(resolve(report, 'summary.json'), JSON.stringify({ results }, null, 2) + '\n');
  console.log(`Evidence: ${report}`);
}
