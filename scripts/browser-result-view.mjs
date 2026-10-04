import { captureBrowserErrors } from './browser-errors.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * A result the model chose to show as a page: it runs its own script, reaches nothing outside
 * itself, sizes itself to its content, and takes the owner's comments - a pin on one of its
 * elements, a highlight in the answer - into the next message, each said in the content's words.
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
  // Its own draft store, so drafts other checks left on this task cannot conflict with this one.
  let draftRevision = 0;
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v1/drafts') {
      if (route.request().method() === 'GET')
        return route.fulfill({
          json: {
            workspaceId: workspace.id,
            taskId: task.id,
            body: '',
            attachments: [],
            revision: draftRevision
          }
        });
      draftRevision += 1;
      return route.fulfill({
        json: { revision: draftRevision, updatedAt: new Date().toISOString() }
      });
    }
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

    // Pin a comment to one of the view's own elements.
    await page
      .locator('.result-view-bar')
      .getByRole('button', { name: 'Comment', exact: true })
      .click();
    await inside.getByText('Brook', { exact: true }).click();
    const popover = page.locator('.note-popover');
    await popover.locator('textarea').fill('Add the weights here too');
    await popover.getByRole('button', { name: 'Add', exact: true }).click();
    const chips = page.getByRole('list', { name: 'Your comments on the result' });
    await chips.getByText('Add the weights here too', { exact: true }).waitFor();
    const pin = inside.locator('[data-garden-pins] b');
    await pin.waitFor();
    assert.equal(await pin.textContent(), '1');
    await page.screenshot({ path: resolve(report, 'result-view-marked-1440.png') });

    // The pin stays on what it is about when the page scrolls and the view reflows.
    const offset = async () => {
      const [mark, brook] = await Promise.all([
        pin.boundingBox(),
        inside.getByText('Brook', { exact: true }).boundingBox()
      ]);
      assert(mark && brook, 'The pin and its element are both on screen');
      return { x: Math.round(mark.x - brook.x), y: Math.round(mark.y - brook.y), top: mark.y };
    };
    // A short window, so the conversation has to scroll to show the whole view.
    await page.setViewportSize({ width: 1440, height: 560 });
    await page.waitForTimeout(150);
    const before = await offset();
    const bar = await page.locator('.result-view-bar').boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.wheel(0, 80);
    await page.waitForTimeout(100);
    const scrolled = await offset();
    assert.deepEqual(
      { x: scrolled.x, y: scrolled.y },
      { x: before.x, y: before.y },
      'A pin keeps its place on its element through a scroll'
    );
    assert.notEqual(scrolled.top, before.top, 'The scroll moved the content under test');
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.waitForTimeout(200);
    const reflowed = await offset();
    assert(
      Math.abs(reflowed.y - before.y) <= 2,
      `A pin stays on its element when the view reflows (${reflowed.y} vs ${before.y})`
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .locator('.result-view-bar')
      .getByRole('button', { name: 'Done', exact: true })
      .click();

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
    await page.locator('.note-offer').click();
    await page.locator('.note-popover textarea').fill('By how much?');
    await page.locator('.note-popover').getByRole('button', { name: 'Add', exact: true }).click();
    await chips.getByText('By how much?', { exact: true }).waitFor();
    assert.equal(await chips.locator('li').count(), 2);
    assert.equal(await page.locator('.garden-answer .comment-pin').textContent(), '2');

    // The comments alone are a message.
    const send = page
      .locator('.garden-task-composer')
      .getByRole('button', { name: /^(Send|Queue next|Update run)$/ });
    await send.click();
    for (let wait = 0; wait < 300 && !sent; wait += 1) await page.waitForTimeout(50);
    assert(sent, 'Comments without typed text are sendable');
    assert.match(sent.prompt, /My comments, numbered as I pinned them:/);
    assert.match(
      sent.prompt,
      /1\. comparison\.html at “Brook” under “Three laptops compared” \(#bars > div:nth-of-type\(2\)\): Add the weights here too/
    );
    assert.match(sent.prompt, /2\. the answer on “Aster lasts longest”: By how much\?/);
    // The send is confirmed and the comments leave the composer before the page goes, so no later
    // check opens this task to find a send still waiting on its receipt.
    await chips.waitFor({ state: 'detached' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator('.result-view-frame').waitFor();
    await page.screenshot({ path: resolve(report, 'result-view-390.png') });
  } finally {
    await page.close();
  }
  console.log(
    'Result view checks passed: sandboxed script, no network, self-sizing, a pin that holds its place, a highlight, both sent as one message in words.'
  );
}

/**
 * A live app the preview gateway reached: the same bridge, added to the app's own page. While the
 * owner comments, pressing the app pins a comment instead of working it; the pin is drawn in the
 * app and scrolls with the app's own scrolling; and the app works again the moment they are done.
 */
export async function checkAppComments({ context, errors }) {
  const bridge = await readFile(
    new URL('../apps/web/src/marks-bridge.js', import.meta.url),
    'utf8'
  );
  const app = `<!doctype html><html><head><script>window.__gardenFrame='app'</script><script type="module">${bridge}</script></head>
<body style="margin:0"><main id="list" style="height:200px;overflow:auto"><h2>Counter</h2>
<button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button><div style="height:900px"></div></main></body></html>`;
  const page = await context.newPage();
  await captureBrowserErrors(page, errors);
  try {
    await page.setContent(
      '<iframe sandbox="allow-scripts" style="width:400px;height:240px;border:0"></iframe>'
    );
    await page.evaluate((html) => {
      window.heard = [];
      addEventListener('message', (event) => window.heard.push(event.data));
      document.querySelector('iframe').srcdoc = html;
    }, app);
    await page.waitForFunction(() => window.heard.some((data) => data.type === 'ready'));
    // Garden may start listening after the page announced itself; asking again gets an answer.
    await page.evaluate(() => {
      window.heard = [];
      document.querySelector('iframe').contentWindow.postMessage({ garden: 1, type: 'hello' }, '*');
    });
    await page.waitForFunction(() => window.heard.some((data) => data.type === 'ready'), null, {
      timeout: 5000
    });
    const tell = (message) =>
      page.evaluate(
        (data) => document.querySelector('iframe').contentWindow.postMessage(data, '*'),
        { garden: 1, type: 'comments', ...message }
      );
    const inside = page.frameLocator('iframe');
    await tell({ commenting: true, pins: [] });
    await inside.locator('html.garden-commenting').waitFor({ state: 'attached' });
    await inside.locator('#count').click();
    assert.equal(
      await inside.locator('#count').textContent(),
      '0',
      'Commenting does not work the app'
    );
    const point = await page
      .waitForFunction(() => window.heard.find((data) => data.type === 'point'), null, {
        timeout: 5000
      })
      .then((handle) => handle.jsonValue())
      .catch(() => null);
    assert(point, 'Pressing the app while commenting reports a point');
    assert.equal(point.anchor.kind, 'point');
    assert.equal(point.anchor.label, '0');
    assert.equal(point.anchor.context, 'Counter');
    assert.equal(point.anchor.path, '#count');
    await tell({ commenting: true, pins: [{ n: 1, anchor: point.anchor, text: 'Larger' }] });
    const pin = inside.locator('[data-garden-pins] b');
    await pin.waitFor();
    const gap = async () => {
      const [mark, button] = await Promise.all([
        pin.boundingBox(),
        inside.locator('#count').boundingBox()
      ]);
      return { x: Math.round(mark.x - button.x), y: Math.round(mark.y - button.y) };
    };
    const before = await gap();
    await inside.locator('#list').evaluate((list) => (list.scrollTop = 30));
    await page.waitForTimeout(100);
    assert.deepEqual(await gap(), before, 'The pin scrolls with the app’s own scrolling');
    await inside.locator('#list').evaluate((list) => (list.scrollTop = 600));
    await page.waitForTimeout(100);
    assert.equal(await pin.count(), 0, 'A pin scrolled out of its box is not drawn over the app');
    await inside.locator('#list').evaluate((list) => (list.scrollTop = 0));
    await tell({ commenting: false, pins: [{ n: 1, anchor: point.anchor, text: 'Larger' }] });
    await inside.locator('html:not(.garden-commenting)').waitFor({ state: 'attached' });
    await inside.locator('#count').click();
    assert.equal(
      await inside.locator('#count').textContent(),
      '1',
      'The app works once commenting ends'
    );
  } finally {
    await page.close();
  }
  console.log(
    'App comment checks passed: commenting holds the app still, anchors to its elements in words, and pins ride its own scrolling.'
  );
}
