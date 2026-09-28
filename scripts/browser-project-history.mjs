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
          report: null,
          references: [],
          sources: [],
          unavailableReferences: 0,
          currentResultIds: presentation.results.map((result) => result.id)
        }
      }
    })
  );
  await page.goto(`${origin}/?task=${task.id}`);
  const results = page.locator('.garden-previous-results');
  const response = page.locator('.garden-previous-answer');
  await response.locator('summary').waitFor();
  await page.locator('.garden-preview-frame').waitFor();
  const originalPreview = await page.locator('.garden-preview-frame').elementHandle();
  assert(originalPreview, 'The current app preview must exist before opening history');
  assert.equal(await response.locator('summary').textContent(), 'Previous response');
  for (const { width, height } of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 568 }
  ]) {
    await page.setViewportSize({ width, height });
    for (const [name, section] of [
      ['results', results],
      ['response', response]
    ]) {
      const heading = section.locator(':scope > summary');
      await heading.click();
      await section
        .locator(name === 'results' ? '.garden-delivery' : '.markdown p')
        .last()
        .waitFor({ state: 'attached' });
      assert(
        await section.evaluate((element) => element.scrollHeight > element.clientHeight + 100),
        'Long history must scroll within its own card'
      );
      const scroller = page.locator('.garden-task-scroll');
      const outerScroll = await scroller.evaluate((element) => element.scrollTop);
      const bounds = await section.boundingBox();
      const header = await heading.boundingBox();
      await page.mouse.move(bounds.x + 12, header.y + header.height + 18);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(
        (name) =>
          document.querySelector(`.garden-previous-${name === 'results' ? 'results' : 'answer'}`)
            .scrollTop > 0,
        name
      );
      await heading.press('PageDown');
      await section.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      assert(
        await heading.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const card = element.parentElement.getBoundingClientRect();
          return (
            bounds.top >= card.top - 1 &&
            bounds.bottom <= card.bottom &&
            bounds.bottom <= innerHeight &&
            document
              .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
              ?.closest('summary') === element
          );
        }),
        'The collapse control must stay visible and clickable at the end of the history'
      );
      assert.equal(
        await scroller.evaluate((element) => element.scrollTop),
        outerScroll,
        'History scrolling must not move the project output'
      );
      if (name === 'results') {
        assert.equal(await section.locator('.garden-delivery').count(), olderFiles.length);
        assert(
          await section
            .locator('.scroll-region')
            .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
          'The file list must not add a second scrollbar'
        );
      } else {
        await section
          .getByText('Garden’s last written response before your latest message.', { exact: true })
          .waitFor({ state: 'attached' });
      }
      await page.screenshot({ path: resolve(report, `history-${name}-${width}.png`) });
      await heading.click();
      assert.equal(await section.getAttribute('open'), null);
      assert(
        await originalPreview.evaluate((element) => element.isConnected),
        'Closing history must preserve the running preview'
      );
      await page.locator('.garden-preview-frame').waitFor({ state: 'visible' });
    }
    await results.locator('summary').click();
    await response.locator('summary').click();
    assert.equal(
      await results.getAttribute('open'),
      null,
      'Opening another history section preserves room for the current output'
    );
    await response.locator('summary').click();
  }
  await page.close();
}
