import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkInterfaceTexture(page) {
  const coverage = await page.evaluate(() => {
    const painted = [...document.querySelectorAll('*')].filter((element) => {
      if (element.matches('img, canvas, iframe, video, object, embed')) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width >= 12 &&
        box.height >= 12 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < innerHeight &&
        box.left < innerWidth &&
        style.visibility === 'visible' &&
        /^(?:rgb\(|color\([^/]+\)$)/.test(style.backgroundColor)
      );
    });
    return {
      count: painted.length,
      untiled: painted
        .filter((element) => {
          const style = getComputedStyle(element);
          const images = style.backgroundImage.split(/, (?=(?:repeating-)?linear-gradient)/);
          const sizes = style.backgroundSize.split(', ');
          return images.some(
            (image, index) =>
              image.includes('repeating-linear-gradient') && sizes[index] !== '3px 3px'
          );
        })
        .map((element) => element.className),
      missing: painted
        .filter(
          (element) =>
            !getComputedStyle(element).backgroundImage.includes('repeating-linear-gradient')
        )
        .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
    };
  });
  assert(coverage.count > 0, 'Check visible painted interface surfaces');
  assert.deepEqual(coverage.missing, [], 'Every opaque interface surface retains the LCD matrix');
  assert.deepEqual(coverage.untiled, [], 'Interface grids rasterize as bounded pixel tiles');
}

export async function checkOutputAppearance({ context, origin, task, report }) {
  const page = await context.newPage();
  await page.goto(`${origin}/?task=${task.id}`);
  await page.getByRole('navigation', { name: 'Output views' }).waitFor();
  await page.getByRole('button', { name: 'Summary', exact: true }).click();
  const visual = page.getByRole('region', { name: 'Work at a glance', exact: true });
  await visual.waitFor();
  assert.equal(await visual.locator('img, iframe, canvas').count(), 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await checkInterfaceTexture(page);
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
