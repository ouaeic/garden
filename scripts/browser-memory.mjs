import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { captureBrowserErrors } from './browser-errors.mjs';

export async function checkMemoryLibrary({ context, origin, workspace, project, task, report }) {
  const page = await context.newPage();
  const errors = [];
  await captureBrowserErrors(page, errors);
  const requests = [];
  await page.route('**/memory-library?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(Object.fromEntries(params));
    const second = params.has('cursor');
    const filtered = params.has('q');
    return route.fulfill({
      json: {
        items: Array.from({ length: filtered || second ? 1 : 40 }, (_, index) => ({
          id: `memory-${second ? 'next' : index}`,
          workspaceId: workspace.id,
          projectId: project.id,
          taskId: task.id,
          kind: 'episode',
          status: 'active',
          excerpt: filtered
            ? 'Quartz analysis notes'
            : `Retained work ${second ? 'next page' : index}`,
          observedAt: '2026-09-28T10:00:00Z',
          validTo: null,
          lastVerified: null
        })),
        nextCursor: filtered || second ? null : 'next-page'
      }
    });
  });
  await page.route('**/memory-items/memory-*', (route) =>
    route.fulfill({
      json: {
        id: 'memory-0',
        title: 'Retained work',
        body: 'Complete source-linked memory body.',
        readable: true
      }
    })
  );
  await page.goto(origin);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const library = page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .or(page.getByRole('region', { name: 'Settings', exact: true }));
  await library
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Knowledge', exact: true })
    .click();
  const records = library.getByRole('region', { name: 'Memory records', exact: true });
  await records.getByText('Retained work 0', { exact: true }).waitFor();
  assert.equal(await records.locator('article').count(), 40);
  const sizing = await records.evaluate((el) => ({
    height: el.clientHeight,
    content: el.scrollHeight,
    overflow: getComputedStyle(el).overflowY
  }));
  assert(sizing.content > sizing.height);
  assert.equal(sizing.overflow, 'auto');
  await library.getByRole('button', { name: 'Next', exact: true }).click();
  await records.getByText('Retained work next page', { exact: true }).waitFor();
  assert(requests.some((r) => r.cursor === 'next-page'));
  await library.getByRole('button', { name: 'Previous', exact: true }).click();
  await records.getByText('Retained work 0', { exact: true }).waitFor();
  await records.getByRole('button', { name: 'Read', exact: true }).first().click();
  const full = page.getByRole('dialog', { name: 'Retained work', exact: true });
  await full.getByText('Complete source-linked memory body.', { exact: true }).waitFor();
  await full.getByRole('button', { name: 'Close Retained work', exact: true }).click();
  await library.getByRole('searchbox', { name: 'Search memory', exact: true }).fill('quartz');
  await library.getByRole('button', { name: 'Search', exact: true }).click();
  await records.getByText('Quartz analysis notes', { exact: true }).waitFor();
  assert.equal(await records.locator('article').count(), 1);
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('kind=episode')),
    library.getByLabel('Memory type', { exact: true }).selectOption('episode')
  ]);
  assert(requests.some((r) => r.q === 'quartz' && r.kind === 'episode' && !r.cursor));
  for (const [width, height] of [
    [1440, 950],
    [390, 844]
  ]) {
    await page.setViewportSize({ width, height });
    await library.scrollIntoViewIfNeeded();
    assert.equal(
      await page
        .getByRole(width < 700 ? 'region' : 'dialog', {
          name: 'Settings',
          exact: true
        })
        .count(),
      1,
      'Settings must become a navigation page on phones'
    );
    const dimensions = await library.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth
    }));
    assert(dimensions.scroll <= dimensions.width + 1, 'Memory must fit the panel width');
    await page.screenshot({ path: resolve(report, `memory-${width}.png`) });
  }
  assert.deepEqual(errors, [], 'Memory journeys must not leave uncaught browser errors');
  await page.close();
}
