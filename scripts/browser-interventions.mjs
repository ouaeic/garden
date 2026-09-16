import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkHumanInterventions({ context, origin, task, report }) {
  const page = await context.newPage();
  const frames = [],
    replies = [];
  let open = null,
    sockets = 0;
  let intervention = {
    id: '10000000-0000-4000-8000-000000000088',
    kind: 'signature',
    surface: 'browser',
    title: 'Review and sign the practice document',
    tabId: 'tab-2',
    route: 'approval'
  };
  const state = {
    holder: 'agent',
    width: 1440,
    height: 900,
    title: 'Practice document',
    url: 'https://example.invalid/practice',
    tabs: [
      { tabId: 'tab-1', title: 'Research', url: 'https://example.invalid/research', active: true },
      {
        tabId: 'tab-2',
        title: 'Practice document',
        url: 'https://example.invalid/practice',
        active: false
      }
    ]
  };
  const publish = () => open?.send(JSON.stringify({ type: 'state', state }));
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/v1/tasks/${task.id}/intervention`) return route.fulfill({ json: intervention });
    if (path === `/v1/workspaces/${task.workspaceId}/browser-token`)
      return route.fulfill({ json: { runnerUrl: origin, token: 'fixture' } });
    if (
      path === `/v1/approvals/${intervention?.id}/approve` ||
      path === `/v1/tasks/${task.id}/answer`
    ) {
      replies.push(route.request().postDataJSON());
      intervention = null;
      state.holder = 'agent';
      publish();
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  await page.routeWebSocket('**/browser/stream', (ws) => {
    sockets++;
    open = ws;
    publish();
    ws.onMessage((raw) => {
      const frame = JSON.parse(raw);
      frames.push(frame);
      if (frame.type === 'holder') state.holder = frame.holder;
      if (frame.type === 'action' && frame.action.type === 'select_tab')
        for (const tab of state.tabs) tab.active = tab.tabId === frame.action.tabId;
      if (frame.type === 'action' && frame.action.type === 'new_tab') {
        assert.equal(state.holder, 'user');
        state.tabs.forEach((tab) => {
          tab.active = false;
        });
        state.tabs.push({
          tabId: 'tab-recovered',
          title: 'Recovered verification page',
          url: frame.action.url,
          active: true
        });
      }
      publish();
      ws.send(JSON.stringify({ type: 'control_ack', requestId: frame.requestId }));
    });
  });
  try {
    await page.goto(`${origin}/?view=computer&task=${task.id}`);
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Your action is needed' });
    await panel.getByRole('heading', { name: 'Review and sign the practice document' }).waitFor();
    assert(await panel.getByRole('button', { name: 'Done and continue' }).isDisabled());
    await panel.getByRole('button', { name: 'Take control of this tab' }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('.garden-browser-tab.active')
        ?.textContent.includes('Practice document')
    );
    const canvas = page.locator('.computer-screen canvas');
    const box = await canvas.boundingBox();
    assert(box);
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 70, box.y + 50, { steps: 5 });
    await page.mouse.move(box.x + 100, box.y + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    const gesture = frames.find((frame) => frame.type === 'stroke');
    assert(gesture && gesture.action.points.length > 2, 'Freehand input must preserve the curve');
    assert.equal(gesture.action.tabId, 'tab-2', 'The stroke must name the inspected tab');
    await page.getByRole('button', { name: 'Private input', exact: true }).click();
    await page.getByText('The screen is hidden.', { exact: false }).waitFor();
    assert(await panel.getByRole('button', { name: 'Done and continue' }).isDisabled());
    assert.equal(await page.locator('.garden-browser-tabstrip').count(), 0);
    await page.getByRole('button', { name: 'End private input', exact: true }).click();
    open.close({ code: 1012, reason: 'Fixture reconnect' });
    await page.waitForFunction(() =>
      document
        .querySelector('.garden-screen-surface [role="status"]')
        ?.textContent.includes('You have control')
    );
    await page.waitForTimeout(1200);
    assert(sockets >= 2, 'The handoff must survive reconnection');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: resolve(report, `human-handoff-${width}.png`) });
    }
    await panel.getByRole('button', { name: 'Done and continue' }).click();
    await panel.waitFor({ state: 'detached' });
    assert.deepEqual(replies, [{}]);
    assert.equal(
      frames.filter((frame) => frame.type === 'stroke').length,
      1,
      'Completion must not replay the human action'
    );
    intervention = {
      id: '10000000-0000-4000-8000-000000000089',
      kind: 'challenge',
      surface: 'browser',
      route: 'answer',
      title: 'Complete browser verification',
      tabId: 'tab-missing',
      url: 'https://example.invalid/challenge'
    };
    state.holder = 'agent';
    state.tabs = [{ tabId: 'tab-1', title: 'New tab', url: 'about:blank', active: true }];
    await page.reload();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await panel.getByRole('button', { name: 'Reopen verification page', exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('.garden-browser-tab.active')
        ?.textContent.includes('Recovered verification page')
    );
    await panel.getByRole('button', { name: 'Done and continue' }).click();
    await panel.waitFor({ state: 'detached' });
    assert.equal(replies.length, 2);
    assert.equal(replies[1].questionId, '10000000-0000-4000-8000-000000000089');
    assert.equal(replies[1].tabId, 'tab-recovered');
    assert.equal(
      frames.filter((frame) => frame.type === 'action' && frame.action.type === 'new_tab').length,
      1
    );
    console.log(
      'Human handoff browser checks passed: exact tab, curved gesture, private blackout, reconnection, lost-page recovery, responsive layout, and single completion without replay.'
    );
  } finally {
    await page.close();
  }
}
