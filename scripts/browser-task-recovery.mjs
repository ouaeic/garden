import { captureBrowserErrors } from './browser-errors.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkTaskRecovery({ context, origin, bootstrap, task, report, errors }) {
  const page = await context.newPage();
  await captureBrowserErrors(page, errors);
  let failHistory = true;
  let failPresentation = false;
  let currentTask = { ...task, title: 'New project', status: 'running' };
  const events = [];
  let historyRequests = 0;
  let streamRequests = 0;
  const actions = [];
  const activityError = 'Project activity could not be loaded. The request could not be completed';
  const outputError = 'Project output could not be refreshed. Output temporarily unavailable';
  const refresh = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = `/v1/tasks/${task.id}`;
    if (url.pathname === '/v1/bootstrap')
      return route.fulfill({ json: { ...bootstrap, tasks: [currentTask] } });
    if (url.pathname === `/v1/projects/${task.projectId}/conversations`)
      return route.fulfill({ json: { tasks: [currentTask], nextCursor: null } });
    if (url.pathname === path) return route.fulfill({ json: currentTask });
    if (url.pathname === `${path}/presentation` && failPresentation)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Output temporarily unavailable' } }
      });
    if (url.pathname === `${path}/events`) {
      if (url.searchParams.get('limit') === '250') {
        historyRequests++;
        assert.equal(url.searchParams.get('page'), '1');
        assert.equal(url.searchParams.get('before'), null);
        if (failHistory)
          return route.fulfill({
            status: 500,
            json: { error: { message: 'The request could not be completed' } }
          });
      }
      const after = Number(url.searchParams.get('after') ?? 0);
      return route.fulfill({
        json: {
          events: events.filter((event) => event.sequence > after),
          hasMore: false,
          oldestSequence: events[0]?.sequence ?? null,
          nextCursor: events.at(-1)?.sequence ?? after
        }
      });
    }
    if (url.pathname === `${path}/events/stream`) {
      streamRequests++;
      return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    }
    if (url.pathname === `${path}/resume`) {
      actions.push(route.request().method());
      currentTask = { ...currentTask, status: 'running' };
      return route.fulfill({ json: currentTask });
    }
    return route.fallback();
  });
  try {
    await page.goto(`${origin}/?task=${task.id}`);
    const alert = page.getByRole('alert').filter({ hasText: activityError });
    await alert.waitFor();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await page.getByText('Disconnected', { exact: true }).waitFor();
    assert(historyRequests > 0, 'Activity must have been requested before showing a load error');
    assert.equal(streamRequests, 0, 'A failed initial read cannot claim to be a live connection');
    failHistory = false;
    await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await alert.waitFor({ state: 'detached' });
    await page.getByText('Live', { exact: true }).waitFor();
    assert(streamRequests > 0, 'Try again must start the activity connection after a failed load');
    assert.deepEqual(actions, [], 'Retrying a display read must not restart paid work');

    failPresentation = true;
    await refresh();
    const outputAlert = page.getByRole('alert').filter({ hasText: outputError });
    await outputAlert.waitFor();
    failPresentation = false;
    await refresh();
    await outputAlert.waitFor({ state: 'detached' });
    assert.deepEqual(actions, [], 'Recovered polling must not require a task restart');

    const failure = {
      code: 'provider_unavailable',
      summary: 'The model provider temporarily refused the request (HTTP 503).'
    };
    currentTask = { ...currentTask, status: 'awaiting_resource', resourceWait: failure };
    await refresh();
    const reason = page.getByRole('status', { name: 'Why this work is waiting' });
    await reason.waitFor();
    assert((await reason.innerText()).includes(failure.summary));
    await page.getByRole('button', { name: 'Retry now', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Resume', exact: true }).count(), 0);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await reason.scrollIntoViewIfNeeded();
      assert(
        await reason.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `The waiting explanation fits at ${width}px`
      );
      const bounds = await reason.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.screenshot({ path: resolve(report, `task-recovery-${width}.png`) });
    }
    await page.getByRole('button', { name: 'Retry now', exact: true }).click();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    await reason.waitFor({ state: 'detached' });
    assert.deepEqual(actions, ['POST'], 'Only an explicit Retry now restarts provider work');

    const recorded = (sequence, kind, payload) => ({
      id: `recovery-${sequence}`,
      taskId: task.id,
      sequence,
      kind,
      payload,
      summary: 'Recorded update',
      createdAt: task.updatedAt
    });
    events.push(
      recorded(1, 'assistant_delta', { markdown: 'Saved progress from this direction.' })
    );
    await page.reload();
    await page.getByText('Writing…', { exact: true }).waitFor();
    events.push(recorded(2, 'cost', {}));
    await page.reload();
    await page.getByText('Saved progress from this direction.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Writing…', { exact: true }).count(), 0);
    for (const status of ['paused', 'awaiting_resource', 'awaiting_user', 'failed', 'cancelled']) {
      currentTask = { ...currentTask, status };
      await page.reload();
      await page.getByText('Saved progress from this direction.', { exact: true }).waitFor();
      assert.equal(await page.getByText('Writing…', { exact: true }).count(), 0, status);
      assert.equal(await page.getByText('Taking shape', { exact: true }).count(), 0, status);
      if (status === 'paused') {
        await page
          .getByText('Saved progress from this direction.', { exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(report, 'task-paused-320.png'), fullPage: true });
      }
    }
    currentTask = { ...currentTask, status: 'completed' };
    events.push(
      recorded(3, 'completed', {
        summary: 'The saved result needs review.',
        answer: 'The saved result needs review.',
        verification: {
          status: 'unverified',
          evidence: [],
          remainingRisks: ['Completion evidence could not be verified.']
        }
      })
    );
    await page.reload();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByText('Verification needs review', { exact: true }).waitFor();
    assert.equal(await page.locator('.completion-record.needs-review').count(), 1);
    assert.equal(await page.getByText('No executable checks needed', { exact: true }).count(), 0);
    assert.deepEqual(actions, ['POST'], 'Inspecting recorded progress never resumes paid work');
  } finally {
    await page.close();
  }
}
