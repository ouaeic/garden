import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
      for (const frightened of [false, true, 'flight']) {
        await page.goto(origin);
        await page.locator('.home-projects').waitFor();
        await page.locator('.life-layer').waitFor({ state: 'attached' });
        if (frightened === 'flight') {
          await page.addStyleTag({
            content: `
            [data-perch], .desk-card, .desk-work-card, .panel { border: none !important; }
            .exit-test-perch { position: fixed; width: 150px; height: 80px; z-index: 20;
              background: var(--bg); border-top: 1px solid var(--text) !important; }
          `
          });
          await page.evaluate((kind) => {
            // A monkey can also start hanging from the top of the screen; this one starts on a card.
            Math.random = () => (kind === 'monkey' ? 0.6 : 0.1);
            for (const [left, top] of [
              [20, 140],
              [210, 440]
            ]) {
              const edge = document.createElement('div');
              edge.className = 'exit-test-perch';
              edge.dataset.perch = '';
              edge.style.left = `${left}px`;
              edge.style.top = `${top}px`;
              document.body.append(edge);
            }
          }, kind);
        }
        await page.evaluate(
          ({ scene, kind }) => {
            window.exitSamples = [];
            let seen = false;
            const watched = new WeakSet();
            const record = (node) => {
              const box = node.getBoundingClientRect();
              const clip = node.closest('.life-clip')?.getBoundingClientRect();
              window.exitSamples.push({
                x: box.left,
                y: box.top,
                visible:
                  Math.max(
                    0,
                    Math.min(box.bottom, clip?.bottom ?? innerHeight) -
                      Math.max(box.top, clip?.top ?? 0)
                  ) * Math.max(0, Math.min(box.right, innerWidth) - Math.max(box.left, 0)),
                clipped: Boolean(clip)
              });
            };
            const sample = () => {
              const node = document.querySelector(`[data-creature="${kind}"]`);
              if (!node) {
                if (!seen) requestAnimationFrame(sample);
                return;
              }
              seen = true;
              record(node);
              for (const animation of node.getAnimations()) {
                if (watched.has(animation)) continue;
                watched.add(animation);
                // A busy renderer may finish and remove the actor between animation frames.
                void animation.finished
                  .then(() => node.isConnected && record(node))
                  .catch(() => {});
              }
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            dispatchEvent(new CustomEvent('garden:scene', { detail: scene }));
          },
          { scene, kind }
        );
        const actor = page.locator(`[data-creature="${kind}"]`);
        await actor.waitFor({ state: 'attached' });
        await page.waitForFunction(
          ({ kind, descending, standing }) => {
            const node = document.querySelector(`[data-creature="${kind}"]`);
            if (standing && kind === 'monkey') {
              const clip = node?.closest('.life-clip')?.getBoundingClientRect();
              return (
                clip &&
                node.getBoundingClientRect().top < clip.bottom - 8 &&
                !node.getAnimations().some((animation) => animation.playState === 'running')
              );
            }
            return (
              node?.closest('.life-free') &&
              node.getBoundingClientRect().top > (descending ? 200 : 0)
            );
          },
          { kind, descending: frightened === 'flight', standing: frightened === true }
        );
        const exitAt = await page.evaluate(() => window.exitSamples.length);
        if (frightened) {
          const box = await actor.boundingBox();
          assert(box, 'The frightened creature must be visible');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        }
        await actor.waitFor({ state: 'detached', timeout: 25_000 });
        const samples = await page.evaluate(() => window.exitSamples);
        await writeFile(
          resolve(report, `${kind}-exit-${width}-${frightened}.json`),
          JSON.stringify(samples)
        );
        assert(samples.length > 0, 'The exit must have rendered frames');
        if (frightened === 'flight') {
          const exit = samples.slice(exitAt);
          assert(exit.length >= 3, `${kind} must animate its airborne escape`);
          assert(
            exit.every((sample) => !sample.clipped),
            `${kind} must not hide behind a border it has left`
          );
          assert(
            new Set(
              exit.filter((sample) => sample.visible > 2).map((sample) => Math.round(sample.x))
            ).size >= 3,
            `${kind} must stay visible while escaping mid-flight`
          );
          assert(exit.at(-1).visible < 2, `${kind} must leave the screen before removal`);
          continue;
        }
        const lastFree = samples.findLastIndex((sample) => !sample.clipped);
        if (!(frightened === true && kind === 'monkey'))
          assert(lastFree >= 0, 'The creature must leave its entry border');
        const exit = samples.slice(frightened ? exitAt : lastFree + 1);
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
