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
  page.on('pageerror', (error) => errors.push(error.message));
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
