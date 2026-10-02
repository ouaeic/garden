import { captureBrowserErrors } from './browser-errors.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/**
 * A result the model chose to show as a page: it runs its own script, reaches nothing outside
 * itself, sizes itself to its content, and takes the owner's comments - a circle on the view, a
 * quote from the answer - into the next message.
 */
export async function checkResultView({
  context,
  origin,
  task,
  workspace,
  presentation,
  report,
  errors
}) {
  const page = await context.newPage();
  await captureBrowserErrors(page, errors);
  const artifact = {
    id: '80000000-0000-4000-8000-000000000009',
    taskId: task.id,
    workspaceId: workspace.id,
    name: 'comparison.html',
    mimeType: 'text/html',
    sizeBytes: 900,
    version: 1,
    sha256: 'b'.repeat(64),
    createdAt: task.createdAt
  };
  const view = `<!doctype html><html><body style="margin:0;font-family:var(--garden-font);background:var(--garden-bg);color:var(--garden-fg)">
<h1 id="title">Three laptops compared</h1>
<div id="bars"></div>
<p data-label="Battery row">Battery: 14h, 11h, 9h</p>
<script>
  const bars = document.getElementById('bars');
  for (const [name, value] of [['Aster', 80], ['Brook', 64], ['Cedar', 51]]) {
    const row = document.createElement('div');
    row.textContent = name;
    row.style.cssText = 'height:40px;margin:8px;background:var(--garden-fg);color:var(--garden-bg);width:' + value + '%';
    bars.append(row);
  }
  document.body.dataset.ran = 'yes';
  fetch('https://example.com/leak').then(() => (document.body.dataset.network = 'reached'), () => (document.body.dataset.network = 'blocked'));
</script>
</body></html>`;
  let sent = null;
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: [artifact] });
    if (url.pathname === `/v1/artifacts/${artifact.id}/content`)
      return route.fulfill({ contentType: 'text/html', body: view });
    if (url.pathname === `/v1/tasks/${task.id}/presentation`)
      return route.fulfill({
        json: {
          ...presentation,
          eventCursor: 3,
          results: [
            {
              id: 'view-result',
              kind: 'artifact',
              title: artifact.name,
              status: 'ready',
              url: null,
              accessPath: null,
              downloadUrl: `/v1/artifacts/${artifact.id}/content`,
              artifactId: artifact.id,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              evidenceEventIds: ['view-answer']
            }
          ]
        }
      });
    if (url.pathname === `/v1/tasks/${task.id}/events`)
      return route.fulfill({
        json: {
          events: [
            {
              id: 'view-ask',
              taskId: task.id,
              sequence: 1,
              kind: 'user_message',
              summary: 'Compare the three laptops',
              payload: { markdown: 'Compare the three laptops for battery and weight.' },
              createdAt: task.createdAt
            },
            {
              id: 'view-answer',
              taskId: task.id,
              sequence: 3,
              kind: 'completed',
              summary: 'Aster lasts longest.',
              payload: {
                answer: 'Aster lasts longest on battery, and Cedar is the lightest of the three.',
                verification: { status: 'not_applicable' }
              },
              createdAt: task.createdAt
            }
          ],
          hasMore: false,
          oldestSequence: 1,
          nextCursor: 3
        }
      });
    if (url.pathname === `/v1/tasks/${task.id}/messages` && route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { ...task, status: 'queued' } });
    }
    return route.fallback();
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/?task=${task.id}`);
    const frame = page.locator('.result-view-frame');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
    const inside = page.frameLocator('.result-view-frame');
    await inside.locator('body[data-ran="yes"]').waitFor();
    await inside.locator('body[data-network="blocked"]').waitFor();
    // The page sizes itself to what it drew.
    await page.waitForFunction(
      () => document.querySelector('.result-view-stage')?.getBoundingClientRect().height > 200
    );
    await page.screenshot({ path: resolve(report, 'result-view-1440.png') });

    // Circle a place and say what is wanted there.
    await page.getByRole('button', { name: 'Mark', exact: true }).click();
    const marks = page.locator('.result-view-marks');
    const box = await marks.boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3 + 40, box.y + 150);
    await page.mouse.up();
    const popover = page.locator('.note-popover');
    await popover.locator('textarea').fill('Add the weights here too');
    await popover.getByRole('button', { name: 'Add', exact: true }).click();
    const chips = page.getByRole('list', { name: 'Your comments on the result' });
    await chips.getByText('Add the weights here too', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(report, 'result-view-marked-1440.png') });
    await page.getByRole('button', { name: 'Done marking', exact: true }).click();

    // Select words in the answer and comment on them.
    const answer = page.locator('.garden-answer .markdown p').first();
    await answer.evaluate((element) => {
      const range = document.createRange();
      const text = element.firstChild;
      range.setStart(text, 0);
      range.setEnd(text, 'Aster lasts longest'.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.locator('.note-popover textarea').fill('By how much?');
    await page.locator('.note-popover').getByRole('button', { name: 'Add', exact: true }).click();
    await chips.getByText('By how much?', { exact: true }).waitFor();
    assert.equal(await chips.locator('li').count(), 2);

    // The comments alone are a message.
    const send = page
      .locator('.garden-task-composer')
      .getByRole('button', { name: /^(Send|Queue next|Update run)$/ });
    await send.click();
    for (let wait = 0; wait < 100 && !sent; wait += 1) await page.waitForTimeout(50);
    assert(sent, 'Comments without typed text are sendable');
    assert.match(sent.prompt, /My comments on the result:/);
    assert.match(sent.prompt, /comparison\.html on the circled area/);
    assert.match(sent.prompt, /Add the weights here too/);
    assert.match(sent.prompt, /the answer on "Aster lasts longest": By how much\?/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator('.result-view-frame').waitFor();
    await page.screenshot({ path: resolve(report, 'result-view-390.png') });
  } finally {
    await page.close();
  }
  console.log(
    'Result view checks passed: sandboxed script, no network, self-sizing, circled and quoted comments sent as one message.'
  );
}
