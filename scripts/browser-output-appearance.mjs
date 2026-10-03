import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/**
 * The screen's glass: one layer over the screen carrying the dot matrix at the display's own pixel
 * size, under everything garden draws and behind everything the owner was given.
 */
export async function checkScreenGlass(page) {
  const glass = await page.evaluate(() => {
    const screen =
      document.querySelector('.desk-shell .navigation-page[open]') ??
      document.querySelector('.desk-shell .garden-main:not([hidden])');
    if (!screen) return null;
    const style = getComputedStyle(screen, '::after');
    const ratio = devicePixelRatio;
    const size = parseFloat(style.backgroundSize);
    // Anything that makes a stacking context traps what it holds behind the glass.
    const traps = (element) => {
      for (let node = element.parentElement; node && node !== screen; node = node.parentElement) {
        const own = getComputedStyle(node);
        if (
          (own.position !== 'static' && own.zIndex !== 'auto') ||
          Number(own.opacity) < 1 ||
          own.transform !== 'none' ||
          own.filter !== 'none' ||
          own.isolation === 'isolate' ||
          /transform|opacity|filter/.test(own.willChange) ||
          /paint|layout|strict|content/.test(own.contain)
        )
          return `${node.tagName.toLowerCase()}.${node.className}`;
      }
      return null;
    };
    const delivered = [
      ...screen.querySelectorAll(
        '.result-view-frame, .garden-preview-frame, .computer-preview, .computer-result-image, .computer-result-media, .garden-captured-result img, .pdf-page canvas, .markdown img'
      )
    ].filter((element) => element.getClientRects().length);
    return {
      content: style.content,
      zIndex: style.zIndex,
      pointer: style.pointerEvents,
      image: style.backgroundImage.slice(0, 30),
      devicePixels: size * ratio,
      delivered: delivered.length,
      behind: delivered
        .filter((element) => getComputedStyle(element).zIndex !== '41' || traps(element))
        .map((element) => `${element.className} in ${traps(element)}`)
    };
  });
  assert(glass, 'A screen is on show');
  assert.equal(glass.content, '""', 'The screen carries its glass');
  assert.equal(glass.zIndex, '40');
  assert.equal(glass.pointer, 'none', 'The glass never takes a press');
  assert.match(glass.image, /^url\("data:image\/png/, 'The glass carries the dot matrix');
  assert(
    Math.abs(glass.devicePixels - Math.round(glass.devicePixels)) < 0.01,
    `A dot is a whole number of device pixels (${glass.devicePixels})`
  );
  assert.deepEqual(glass.behind, [], 'What the owner was given is shown in front of the glass');
  return glass;
}

export async function checkOutputAppearance({ context, origin, task, report }) {
  const page = await context.newPage();
  await page.goto(`${origin}/?task=${task.id}`);
  const visual = page.getByRole('region', { name: 'Results and downloads', exact: true });
  await visual.waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await checkScreenGlass(page);
      await page.screenshot({ path: resolve(report, `summary-${theme}-${width}.png`) });
      assert(await visual.evaluate((element) => element.scrollWidth <= element.clientWidth));
    }
    for (const surface of ['page', 'dialog', 'popover']) {
      await page.evaluate((surface) => {
        const host = document.createElement(surface === 'dialog' ? 'dialog' : 'div');
        host.id = 'output-color-check';
        host.className = 'garden-media-job';
        host.style.cssText =
          'position:fixed;inset:20px auto auto 20px;padding:10px;margin:0;z-index:10000;width:300px;';
        if (surface === 'popover') host.setAttribute('popover', 'manual');
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><path fill="#3976d8" d="M0 0h60v60H0z"/></svg>';
        host.innerHTML =
          `<img class="computer-result-image" alt="Color fidelity fixture" src="data:image/svg+xml,${encodeURIComponent(svg)}" style="width:120px;height:60px;display:block">` +
          '<canvas width="120" height="60" style="display:block"></canvas>' +
          `<video poster="data:image/svg+xml,${encodeURIComponent(svg)}" style="display:block;width:120px;height:60px"></video>` +
          '<iframe class="garden-preview-frame" title="Color fidelity frame" style="display:block;width:120px;height:60px;border:0" srcdoc="<style>html,body{margin:0;background:#3976d8}</style>"></iframe>';
        document.body.append(host);
        host.querySelector('canvas').getContext('2d').fillStyle = '#3976d8';
        host.querySelector('canvas').getContext('2d').fillRect(0, 0, 60, 60);
        if (surface === 'dialog') host.showModal();
        if (surface === 'popover') host.showPopover();
      }, surface);
      const host = page.locator('#output-color-check');
      await host.locator('img').evaluate((image) => image.decode());
      await host.locator('iframe').evaluate(
        (frame) =>
          new Promise((done) => {
            if (
              frame.contentDocument?.readyState === 'complete' &&
              frame.contentDocument.querySelector('style')
            )
              done();
            else frame.addEventListener('load', done, { once: true });
          })
      );
      for (const tag of ['img', 'canvas', 'iframe', 'video']) {
        const screenshot = await host.locator(tag).screenshot();
        const colors = await page.evaluate(async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
          const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4)
            colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]},${pixels[i + 3]}`);
          return [...colors].sort();
        }, screenshot.toString('base64'));
        assert.deepEqual(
          colors,
          tag === 'iframe'
            ? ['57,118,216,255']
            : [tag === 'video' ? '0,0,0,255' : '255,255,255,255', '57,118,216,255'],
          `${theme} ${surface} ${tag}: originals retain exact colors and a neutral transparent background`
        );
      }
      await host.evaluate((element) => element.remove());
    }
  }
  await page.close();
}
