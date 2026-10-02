import { captureBrowserErrors } from './browser-errors.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkArtifactLinks({
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
    id: '80000000-0000-4000-8000-000000000008',
    taskId: task.id,
    workspaceId: workspace.id,
    name: 'result.json',
    mimeType: 'application/json',
    sizeBytes: 14,
    version: 1,
    sha256: 'a'.repeat(64),
    createdAt: task.createdAt
  };
  const answer =
    '[Open result.json](artifact:result.json) and [missing file](artifact:missing.json).';
  let reads = 0;
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: [artifact] });
    if (url.pathname === `/v1/artifacts/${artifact.id}/content`) {
      reads++;
      return route.fulfill({ json: { passed: true } });
    }
    if (url.pathname === `/v1/tasks/${task.id}/presentation`)
      return route.fulfill({ json: { ...presentation, results: [], eventCursor: 3 } });
    if (url.pathname === `/v1/tasks/${task.id}/events`)
      return route.fulfill({
        json: {
          events: [
            {
              id: 'research-review',
              taskId: task.id,
              sequence: 2,
              kind: 'subagent',
              summary: 'Research review completed',
              createdAt: task.createdAt,
              payload: {
                laneId: 'research-lane',
                lane: 'research',
                name: 'Clinical source review',
                status: 'completed',
                citations: { checked: 2, matched: 2, cited: 6 },
                claimReview: { checked: 2, supported: 0, contradicted: 1 },
                detail:
                  'The current figure contradicts the report. The causal claim remains unestablished.'
              }
            },
            {
              id: 'artifact-answer',
              taskId: task.id,
              sequence: 3,
              kind: 'completed',
              summary: 'The analysis is ready.',
              payload: { answer, verification: { status: 'verified' } },
              createdAt: task.createdAt
            }
          ],
          hasMore: false,
          oldestSequence: 3,
          nextCursor: 3
        }
      });
    return route.fallback();
  });
  try {
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/?task=${task.id}`);
      const link = page
        .locator('.garden-answer')
        .getByRole('link', { name: 'Open result.json', exact: true });
      await link.waitFor();
      await page
        .locator(
          'body:has(.project-panel[open]:not(.is-docked)) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open]:not(.is-docked))) .project-workspace-bar .project-view-nav'
        )
        .getByRole('button', { name: 'Activity', exact: true })
        .click();
      const lane = page.locator('.garden-mission').filter({ hasText: 'Clinical source review' });
      await lane.getByText('Report outcome', { exact: true }).click();
      assert((await lane.innerText()).includes('0 supported'));
      assert((await lane.innerText()).includes('1 contradicted'));
      assert(!(await lane.innerText()).includes('Verified'));
      const laneBounds = await lane.boundingBox();
      assert(laneBounds && laneBounds.x >= 0 && laneBounds.x + laneBounds.width <= width + 1);
      await page.screenshot({ path: resolve(report, `claim-review-${width}.png`) });
      await page.locator('.project-panel[open] > .dialog-heading > button').click();
      await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
      assert.equal(await link.getAttribute('href'), `/v1/artifacts/${artifact.id}/content`);
      assert.equal(await page.getByRole('link', { name: 'missing file', exact: true }).count(), 0);
      const before = reads;
      const pages = context.pages().length;
      await link.click();
      const preview = page.getByRole('dialog', { name: 'result.json', exact: true });
      await preview.getByText('"passed":true', { exact: false }).waitFor();
      assert(reads > before, 'Opening an artifact reads its authenticated immutable bytes');
      assert.equal(context.pages().length, pages, 'Ordinary artifact clicks stay in the project');
      const bounds = await preview.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.screenshot({ path: resolve(report, `artifact-link-${width}.png`) });
    }
  } finally {
    await page.close();
  }
}
