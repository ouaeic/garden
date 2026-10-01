import { captureBrowserErrors } from './browser-errors.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkPreviewStart({ context, origin, task, presentation, report, errors }) {
  const page = await context.newPage();
  await captureBrowserErrors(page, errors);
  const source = presentation.results.find((item) => item.kind === 'preview');
  assert(source);
  let state = 'stopped',
    starts = 0,
    reject = false;
  let directionSequence = 0;
  let publishedSequence = 3;
  let previewRevision;
  let frameLoads = 0;
  let tipDefault = '15';
  await page.route('**/__garden/preview/**', (route) => {
    frameLoads++;
    return route.fulfill({
      contentType: 'text/html',
      body: `<label>Tip percentage<input value="${tipDefault}"></label>`
    });
  });
  const startPath = `/v1/tasks/${task.id}/previews/fixture/start`;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (directionSequence && path === `/v1/tasks/${task.id}/events`) {
      return route.fulfill({
        json: {
          events: [
            {
              id: 'follow-up-preview',
              taskId: task.id,
              sequence: publishedSequence,
              kind: 'preview',
              summary: 'Published app',
              payload: { previewId: 'fixture' },
              createdAt: task.createdAt
            },
            {
              id: `direction-${directionSequence}`,
              taskId: task.id,
              sequence: directionSequence,
              kind: 'user_message',
              summary: 'Explain the app',
              payload: { markdown: 'Explain the app.' },
              createdAt: task.createdAt
            },
            {
              id: 'follow-up-answer',
              taskId: task.id,
              sequence: directionSequence + 2,
              kind: 'completed',
              summary: 'Explanation ready',
              payload: { answer: 'This is the latest explanation.', answerChannel: 'final' },
              createdAt: task.createdAt
            }
          ].sort((a, b) => a.sequence - b.sequence),
          hasMore: false,
          oldestSequence: Math.min(publishedSequence, directionSequence),
          nextCursor: directionSequence + 2
        }
      });
    }
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
          eventCursor: directionSequence ? directionSequence + 2 : 4,
          ...(directionSequence
            ? {
                progress: { ...presentation.progress, phases: [] },
                surface: {
                  direction: {
                    eventId: `direction-${directionSequence}`,
                    sequence: directionSequence,
                    text: 'Explain the app.',
                    truncated: false,
                    queued: false
                  },
                  directions: [],
                  report: null,
                  references: [],
                  sources: [],
                  currentResultIds: [source.id],
                  unavailableReferences: 0
                }
              }
            : {}),
          taskStatus:
            state === 'starting'
              ? 'running'
              : state === 'attention'
                ? 'awaiting_user'
                : 'completed',
          results: [
            {
              ...source,
              previewId: 'fixture',
              ...(directionSequence
                ? {
                    evidenceEventIds: [
                      'follow-up-preview',
                      ...(previewRevision ? ['follow-up-answer'] : [])
                    ]
                  }
                : {}),
              ...(previewRevision ? { previewRevision } : {}),
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
    for (const width of [1440, 360]) {
      directionSequence = 5;
      publishedSequence = 3;
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      const views = page.getByRole('navigation', { name: 'Output views' });
      await page
        .locator('.garden-answer')
        .getByText('This is the latest explanation.', { exact: true })
        .waitFor();
      assert.equal(
        await views
          .getByRole('button', { name: 'Summary', exact: true })
          .getAttribute('aria-pressed'),
        'true'
      );
      assert.equal(
        await page.getByRole('region', { name: 'Work at a glance' }).count(),
        0,
        'A text-only follow-up has no charts of previous work above its answer'
      );
      await page.screenshot({ path: resolve(report, `follow-up-answer-${width}.png`) });
      await views.getByRole('button', { name: 'Preview', exact: true }).click();
      await card.locator('iframe').waitFor({ state: 'visible' });
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/v1/tasks/${task.id}/presentation`
      );
      await refreshed;
      assert.equal(
        await views
          .getByRole('button', { name: 'Preview', exact: true })
          .getAttribute('aria-pressed'),
        'true',
        'A refresh preserves the owner’s selected view within a direction'
      );
      directionSequence = 10;
      await page.reload();
      await page
        .locator('.garden-answer')
        .getByText('This is the latest explanation.', { exact: true })
        .waitFor();
      publishedSequence = 11;
      await page.reload();
      await card.locator('iframe').waitFor({ state: 'visible' });
      assert.equal(
        await views
          .getByRole('button', { name: 'Preview', exact: true })
          .getAttribute('aria-pressed'),
        'true',
        'A newly produced app remains the default result'
      );
      const tip = page.frameLocator('iframe').getByRole('textbox', { name: 'Tip percentage' });
      await tip.fill('27');
      const beforeUpdate = frameLoads;
      directionSequence = 15;
      await views.getByRole('button', { name: 'Summary', exact: true }).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('.desk-output-sections button[aria-pressed="true"]')
            ?.textContent === 'Summary'
      );
      assert.equal(
        frameLoads,
        beforeUpdate,
        'A new direction preserves the existing app until an edit completes'
      );
      tipDefault = '10';
      previewRevision = `source-edit-${width}`;
      await card.locator('iframe').waitFor({ state: 'visible' });
      await page.waitForFunction(
        () =>
          document.querySelector('.desk-output-sections button[aria-pressed="true"]')
            ?.textContent === 'Preview'
      );
      await tip.waitFor();
      assert.equal(
        await tip.inputValue(),
        '10',
        'The same preview opens its updated app without republishing or a manual refresh'
      );
      assert.equal(frameLoads, beforeUpdate + 1, 'Finished edits reload the app once');
      await tip.fill('23');
      await views.getByRole('button', { name: 'Summary', exact: true }).click();
      await views.getByRole('button', { name: 'Preview', exact: true }).click();
      await card.getByRole('button', { name: 'Expand', exact: true }).click();
      await card.getByRole('button', { name: 'Exit full screen', exact: true }).waitFor();
      const [expandedCard, expandedFrame, expandedActions] = await Promise.all([
        card.boundingBox(),
        card.locator('iframe').boundingBox(),
        card.locator('.garden-output-actions').boundingBox()
      ]);
      assert(expandedCard && expandedFrame && expandedActions);
      assert(
        expandedFrame.height > expandedCard.height * 0.6,
        'The expanded app receives most of the screen rather than the action bar'
      );
      assert(expandedFrame.y + expandedFrame.height <= expandedActions.y + 2);
      assert(
        expandedActions.y + expandedActions.height <= expandedCard.y + expandedCard.height + 2
      );
      await page.screenshot({ path: resolve(report, `expanded-preview-${width}.png`) });
      await card.getByRole('button', { name: 'Exit full screen', exact: true }).click();
      await page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/v1/tasks/${task.id}/presentation`
      );
      assert.equal(
        await tip.inputValue(),
        '23',
        'Polling, tab changes and expansion keep the updated app state'
      );
      assert.equal(frameLoads, beforeUpdate + 1);
      await page.screenshot({ path: resolve(report, `follow-up-app-update-${width}.png`) });
      previewRevision = undefined;
      tipDefault = '15';
    }
    directionSequence = 0;
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
