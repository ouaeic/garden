import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkRunningQuestion({ context, origin, bootstrap, task, report }) {
  const page = await context.newPage();
  const running = { ...task, status: 'running', pendingApprovalCount: 0, hasOpenQuestion: true };
  const question = {
    id: '10000000-0000-4000-8000-000000000098',
    taskId: task.id,
    kind: 'question_asked',
    sequence: 101,
    createdAt: new Date().toISOString(),
    summary: 'Choose the control sample',
    payload: {
      question: 'Which sample is the control?',
      why: 'The comparison needs the control label.',
      continueWith: 'Check sequence quality in both samples.',
      options: ['Sample A', 'Sample B']
    }
  };
  let answer;
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/bootstrap')
      return route.fulfill({ json: { ...bootstrap, tasks: [running] } });
    if (path === `/v1/projects/${task.projectId}/conversations`)
      return route.fulfill({ json: { tasks: [running], nextCursor: null } });
    if (path === `/v1/tasks/${task.id}`) return route.fulfill({ json: running });
    if (path === `/v1/tasks/${task.id}/events`) {
      const events = [question];
      if (answer)
        events.push({
          ...question,
          id: '10000000-0000-4000-8000-000000000099',
          sequence: 102,
          kind: 'queued_message',
          payload: { questionId: question.id, markdown: answer.prompt }
        });
      return route.fulfill({
        json: { events, hasMore: false, oldestSequence: 101, nextCursor: events.at(-1).sequence }
      });
    }
    if (path === `/v1/tasks/${task.id}/answer`) {
      answer = route.request().postDataJSON();
      running.hasOpenQuestion = false;
      return route.fulfill({ json: running });
    }
    return route.fallback();
  });
  try {
    await page.goto(`${origin}/?task=${task.id}`);
    const card = page.locator('.question-card');
    await card.getByRole('heading', { name: question.payload.question }).waitFor();
    await card
      .getByText('Working meanwhile: Check sequence quality in both samples.', { exact: true })
      .waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await card.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: resolve(report, `running-question-${width}.png`) });
    }
    // The composer is the answer box: one place to type, whatever the agent is waiting on.
    const composer = page.locator('.garden-task-composer');
    await composer.getByLabel('Your answer', { exact: true }).fill('Sample B is the control.');
    await composer.getByRole('button', { name: 'Answer', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(answer, { questionId: question.id, prompt: 'Sample B is the control.' });
  } finally {
    await page.close();
  }
}
