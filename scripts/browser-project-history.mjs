import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkProjectHistory({ context, origin, task, presentation, report }) {
  const page = await context.newPage();
  const events = [
    {
      id: 'first-request',
      sequence: 1,
      kind: 'user_message',
      payload: { markdown: 'Make the first version.' }
    },
    {
      id: 'previous-reply',
      sequence: 2,
      kind: 'completed',
      payload: {
        answer: Array.from(
          { length: 80 },
          (_, index) =>
            `Previous response paragraph ${index + 1}. These are the findings from the earlier request.`
        ).join('\n\n')
      }
    },
    {
      id: 'next-request',
      sequence: 3,
      kind: 'user_message',
      payload: { markdown: 'Improve the next version.' }
    },
    {
      id: 'latest-reply',
      sequence: 4,
      kind: 'completed',
      payload: { answer: 'The current version is ready.' }
    }
  ].map((event) => ({ ...event, taskId: task.id, createdAt: task.createdAt, summary: event.kind }));
  const direction = {
    eventId: 'next-request',
    sequence: 3,
    text: 'Improve the next version.',
    queued: false,
    truncated: false
  };
  const olderFiles = Array.from({ length: 45 }, (_, index) => ({
    id: `old-file-${index}`,
    kind: 'file',
    title: `earlier-result-${index + 1}.txt`,
    path: `workspace/earlier-result-${index + 1}.txt`,
    status: 'ready',
    url: null,
    accessPath: null,
    downloadUrl: `/v1/artifacts/old-file-${index}/content`,
    evidenceEventIds: ['previous-reply']
  }));
  await page.route(`**/v1/tasks/${task.id}/events**`, (route) => {
    if (!new URL(route.request().url()).pathname.endsWith('/events')) return route.fallback();
    return route.fulfill({ json: { events, hasMore: false, oldestSequence: 1, nextCursor: 4 } });
  });
  await page.route(`**/v1/tasks/${task.id}/presentation`, (route) =>
    route.fulfill({
      json: {
        ...presentation,
        eventCursor: 4,
        results: [...presentation.results, ...olderFiles],
        surface: {
          direction,
          directions: [direction],
          sources: [],
          currentResultIds: presentation.results.map((result) => result.id)
        }
      }
    })
  );
  await page.goto(`${origin}/?task=${task.id}`);
  const results = page.locator('.garden-previous-results');
  await page
    .locator('.garden-answer')
    .getByText('The current version is ready.', { exact: true })
    .waitFor();
  // The conversation reads as a thread: the earlier exchange is one line, what was asked last is
  // above the answer, and nothing is behind a dialog.
  const earlier = page.locator('.thread > li > details').first();
  await earlier.locator('summary').getByText('Make the first version.', { exact: true }).waitFor();
  await page
    .locator('.owner-line')
    .getByText('Improve the next version.', { exact: true })
    .waitFor();
  await page.locator('.garden-preview-frame').waitFor();
  const originalPreview = await page.locator('.garden-preview-frame').elementHandle();
  assert(originalPreview, 'The current app preview must exist before opening history');
  const scroller = page.locator('.garden-task-scroll');
  for (const { width, height } of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 568 }
  ]) {
    await page.setViewportSize({ width, height });
    await earlier.locator('summary').click();
    await earlier
      .getByText('Previous response paragraph 80.', { exact: false })
      .waitFor({ state: 'attached' });
    // One card scrolls - the conversation - and the history inside it adds no second scrollbar.
    assert(await earlier.evaluate((element) => element.scrollHeight <= element.clientHeight + 1));
    assert(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight));
    await page.screenshot({ path: resolve(report, `history-response-${width}.png`) });
    await earlier.locator('summary').click();
    assert.equal(await earlier.getAttribute('open'), null);
    await results.locator('summary').click();
    assert.equal(await results.locator('.garden-delivery').count(), olderFiles.length);
    await page.screenshot({ path: resolve(report, `history-results-${width}.png`) });
    await results.locator('summary').click();
    assert.equal(await results.getAttribute('open'), null);
    assert(
      await originalPreview.evaluate((element) => element.isConnected),
      'Opening history must preserve the running preview'
    );
  }
  await page.close();
}
