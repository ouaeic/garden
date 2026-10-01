import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkCreatureExits({ context, origin, report }) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('garden-life', 'calm');
    Math.random = () => 0.5;
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [scene, kind] of [
      ['frogHop', 'frog'],
      ['monkeyTour', 'monkey']
    ]) {
      for (const frightened of [false, true]) {
        await page.goto(origin);
        await page.locator('.home-projects').waitFor();
        await page.locator('.life-layer').waitFor({ state: 'attached' });
        await page.evaluate(
          ({ scene, kind }) => {
            window.exitSamples = [];
            let seen = false;
            const sample = () => {
              const node = document.querySelector(`[data-creature="${kind}"]`);
              if (!node) {
                if (!seen) requestAnimationFrame(sample);
                return;
              }
              seen = true;
              const box = node.getBoundingClientRect();
              const clip = node.closest('.life-clip')?.getBoundingClientRect();
              window.exitSamples.push({
                y: box.top,
                visible: Math.max(
                  0,
                  Math.min(box.bottom, clip?.bottom ?? innerHeight) -
                    Math.max(box.top, clip?.top ?? 0)
                ),
                clipped: Boolean(clip)
              });
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            dispatchEvent(new CustomEvent('garden:scene', { detail: scene }));
          },
          { scene, kind }
        );
        const actor = page.locator(`[data-creature="${kind}"]`);
        await actor.waitFor({ state: 'attached' });
        await page.waitForFunction((kind) => {
          const node = document.querySelector(`[data-creature="${kind}"]`);
          return node?.closest('.life-free') && node.getBoundingClientRect().top > 0;
        }, kind);
        if (frightened) {
          const box = await actor.boundingBox();
          assert(box, 'The frightened creature must be visible');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        }
        await actor.waitFor({ state: 'detached', timeout: 25_000 });
        const samples = await page.evaluate(() => window.exitSamples);
        assert(samples.length > 0, 'The exit must have rendered frames');
        const lastFree = samples.findLastIndex((sample) => !sample.clipped);
        assert(lastFree >= 0, 'The creature must leave its entry border');
        const exit = samples.slice(lastFree + 1);
        assert(exit.length >= 3, `${kind} must animate behind its exit border`);
        assert(exit[0].visible > 4, `${kind} must remain visible when it starts leaving`);
        assert(exit.at(-1).visible < 2, `${kind} must cross the border before removal`);
        assert(
          new Set(exit.filter((sample) => sample.visible > 2).map((sample) => Math.round(sample.y)))
            .size >= 3,
          `${kind} must move visibly through its exit, ${width}px, frightened=${frightened}`
        );
        await page.screenshot({ path: resolve(report, `${kind}-exit-${width}-${frightened}.png`) });
      }
    }
  }
  await page.close();
  console.log(
    'Frog and monkey exits passed: normal and frightened visits cross painted borders on desktop and mobile.'
  );
}
