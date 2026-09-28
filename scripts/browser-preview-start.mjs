import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkPreviewStart({ context, origin, task, presentation, report, errors }) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const source = presentation.results.find((item) => item.kind === 'preview');
  assert(source);
  let state = 'stopped',
    starts = 0,
    reject = false;
  const startPath = `/v1/tasks/${task.id}/previews/fixture/start`;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/v1/tasks/${task.id}`)
      return route.fulfill({
        json: { ...task, status: state === 'starting' ? 'running' : 'completed' }
      });
    if (path === startPath) {
      assert.equal(route.request().method(), 'POST');
      starts++;
      if (reject)
        return route.fulfill({
          status: 409,
          json: { error: { code: 'task_active', message: 'This conversation is still working.' } }
        });
      state = 'starting';
      return route.fulfill({ json: { state } });
    }
    if (path === `/v1/tasks/${task.id}/presentation`)
      return route.fulfill({
        json: {
          ...presentation,
          eventCursor: 4,
          taskStatus:
            state === 'starting'
              ? 'running'
              : state === 'attention'
                ? 'awaiting_user'
                : 'completed',
          results: [
            {
              ...source,
              startPath,
              ...(state === 'starting' || state === 'attention' ? { startState: state } : {}),
              status: state === 'ready' ? 'ready' : state === 'unknown' ? 'unknown' : 'unavailable',
              detail:
                state === 'ready'
                  ? undefined
                  : 'The app has stopped. Start its preview again when you’re ready.'
            }
          ]
        }
      });
    return route.fallback();
  });
  const card = page.locator('.garden-output-primary').first();
  try {
    for (const width of [1440, 360]) {
      state = 'stopped';
      reject = false;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?task=${task.id}`);
      const start = card.getByRole('button', { name: 'Start preview', exact: true });
      await start.waitFor();
      assert(!(await card.innerText()).includes('published port'));
      const rect = await start.boundingBox();
      assert(rect && rect.x >= 0 && rect.x + rect.width <= width);
      await page.screenshot({ path: resolve(report, `preview-stopped-${width}.png`) });
      const before = starts;
      await start.click();
      await card.getByRole('button', { name: 'Starting preview…', exact: true }).waitFor();
      assert.equal(starts, before + 1);
      await page.reload();
      await card.getByRole('button', { name: 'Starting preview…', exact: true }).waitFor();
      assert.equal(starts, before + 1, 'Reload must observe the existing operation');
      state = 'ready';
      await card.locator('iframe').waitFor({ timeout: 10000 });
      await card.getByRole('button', { name: 'Open app', exact: true }).waitFor();
      assert.equal(starts, before + 1);
      await page.screenshot({ path: resolve(report, `preview-restored-${width}.png`) });
    }
    await card.locator('iframe').evaluate((frame) => {
      frame.dataset.preserved = 'yes';
    });
    for (const next of ['unknown', 'ready']) {
      state = next;
      const checked = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/v1/tasks/${task.id}/presentation`
      );
      await checked;
      await page.waitForTimeout(100);
      assert(await card.locator('iframe').isVisible());
      assert.equal(
        await card.locator('iframe').getAttribute('data-preserved'),
        'yes',
        'Availability uncertainty must preserve the app frame and its state'
      );
    }
    state = 'attention';
    await page.reload();
    await card.getByRole('link', { name: 'Open conversation' }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Start preview', exact: true }).count(), 0);
    state = 'stopped';
    reject = true;
    await page.reload();
    await card.getByRole('button', { name: 'Start preview', exact: true }).click();
    await page.getByText('This conversation is still working.', { exact: true }).waitFor();
    assert(await card.getByRole('button', { name: 'Start preview', exact: true }).isEnabled());
  } catch (error) {
    await page.screenshot({ path: resolve(report, 'preview-failure.png') });
    console.error({
      state,
      text: (await page.locator('body').innerText()).slice(0, 3000),
      frame: await card.locator('iframe').count()
    });
    throw error;
  } finally {
    await page.close();
  }
}
