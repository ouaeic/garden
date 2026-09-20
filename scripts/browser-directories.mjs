import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export function directoryFixture(workspaceId) {
  const fixture = {
    failRead: false,
    tableStale: false,
    tableReads: [],
    reads: [],
    branch: '10000000-0000-4000-8000-000000000088'
  };
  fixture.handle = async (route, pathname) => {
    const url = new URL(route.request().url());
    if (pathname.endsWith('/directories')) {
      await route.fulfill({
        json: {
          directories: [
            { workspaceId, name: 'Project computer', path: 'workspace', current: true },
            {
              workspaceId: fixture.branch,
              name: 'Assembly branch',
              path: 'workspace',
              current: false
            }
          ]
        }
      });
      return true;
    }
    if (pathname.endsWith('/table')) {
      const cursor = url.searchParams.get('cursor');
      fixture.tableReads.push({ pathname, cursor });
      if (fixture.tableStale && cursor) {
        await route.fulfill({
          status: 409,
          json: { error: { message: 'This table changed. Refresh to start from the first page.' } }
        });
        return true;
      }
      const start = cursor ? 101 : 1;
      await route.fulfill({
        json: {
          path: url.searchParams.get('path'),
          format: 'tsv',
          identity: 'table-identity',
          sizeBytes: 20 * 1024 ** 3,
          rowStart: start,
          columns: Array.from({ length: 12 }, (_, index) => ({
            name: `Column ${index + 1}`,
            types: ['string'],
            truncated: false
          })),
          rows: Array.from({ length: 100 }, (_, index) =>
            Array.from({ length: 12 }, (_, col) => ({
              text: col
                ? `value ${start + index}.${col}`
                : index
                  ? String(start + index)
                  : '<script>literal text</script>',
              truncated: index === 0 && col === 1
            }))
          ),
          nextCursor: cursor ? null : 'next-table-page',
          columnsOmitted: 0,
          cellsTruncated: 1,
          schemaScope: 'page'
        }
      });
      return true;
    }
    if (!pathname.endsWith('/directory')) return false;
    const folder = url.searchParams.get('path'),
      cursor = url.searchParams.get('cursor');
    fixture.reads.push({ pathname, folder, cursor });
    if (fixture.failRead) {
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Directory temporarily unavailable' } }
      });
      return true;
    }
    const entry = (name, type = 'file', sizeBytes = 8 * 1024 ** 3) => ({
      name,
      type,
      sizeBytes,
      path: `${folder}/${name}`,
      modifiedAt: '2026-09-13T00:00:00Z'
    });
    await route.fulfill({
      json: {
        path: folder,
        entries: cursor
          ? [entry('later-page-results.bam')]
          : folder === 'workspace'
            ? [
                entry('results', 'directory'),
                entry('empty', 'directory'),
                entry('cohort-with-a-long-name-'.repeat(6) + '.fastq.gz'),
                entry('.analysis-config', 'file', 220)
              ]
            : folder === 'workspace/empty'
              ? []
              : [entry('alignment.bam'), entry('summary.tsv', 'file', 512)],
        nextCursor: folder === 'workspace' && !cursor ? 'page-two' : null
      }
    });
    return true;
  };
  return fixture;
}

export async function checkProjectDirectories({
  context,
  origin,
  taskId,
  workspaceId,
  fixture,
  report,
  errors
}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/?task=${taskId}`);
    const panel = page.getByRole('region', { name: 'Project files', exact: true });
    await panel.getByRole('button', { name: 'Browse files', exact: true }).click();
    await panel.getByRole('button', { name: 'results', exact: true }).waitFor();
    assert((await panel.innerText()).includes('8.0 GiB'));
    assert((await panel.innerText()).includes('.analysis-config'));
    await panel.getByRole('button', { name: 'Load more files', exact: true }).click();
    await panel.getByText('later-page-results.bam', { exact: true }).waitFor();
    const endOfFiles = panel.getByRole('button', { name: 'All files loaded', exact: true });
    assert.equal(await endOfFiles.getAttribute('aria-disabled'), 'true');
    assert(await endOfFiles.evaluate((element) => element === document.activeElement));
    assert(fixture.reads.some((read) => read.cursor === 'page-two'));
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await panel.scrollIntoViewIfNeeded();
      assert(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `Directory controls fit at ${width}px`
      );
      const bounds = await panel.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await panel.screenshot({ path: resolve(report, `project-directories-${width}.png`) });
    }
    await panel.getByRole('button', { name: 'results', exact: true }).focus();
    await page.keyboard.press('Enter');
    await panel.getByText('alignment.bam', { exact: true }).waitFor();
    const breadcrumbs = panel.getByRole('navigation', { name: 'Project directory path' });
    assert(await breadcrumbs.evaluate((element) => element === document.activeElement));
    const file = panel.getByRole('link', { name: 'Download alignment.bam', exact: true });
    assert.equal(
      await file.getAttribute('href'),
      `/v1/workspaces/${workspaceId}/download?path=workspace%2Fresults%2Falignment.bam`
    );
    assert.equal(
      await panel
        .getByRole('link', { name: 'Download this folder ZIP', exact: true })
        .getAttribute('href'),
      `/v1/workspaces/${workspaceId}/directory.zip?path=workspace%2Fresults`
    );
    await panel.getByRole('button', { name: 'View table summary.tsv', exact: true }).click();
    const table = panel.getByRole('region', {
      name: 'Table preview for workspace/results/summary.tsv',
      exact: true
    });
    await table.getByText('Rows 1–100', { exact: true }).waitFor();
    assert.equal(await table.getByRole('row').count(), 101);
    assert.equal(
      await table.getByRole('button', { name: 'Previous page', exact: true }).isDisabled(),
      true
    );
    assert((await table.innerText()).includes('<script>literal text</script>'));
    assert.equal(await table.locator('script').count(), 0);
    const scroll = table.getByRole('region', { name: 'Table data, scroll for more columns' });
    await scroll.focus();
    assert(await scroll.evaluate((element) => element === document.activeElement));
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await table.scrollIntoViewIfNeeded();
      assert(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
        `Table fits the project panel at ${width}px`
      );
      const tableBounds = await table.boundingBox();
      assert(
        tableBounds && tableBounds.x >= 0 && tableBounds.x + tableBounds.width <= width + 1,
        `Table stays inside ${width}px viewport`
      );
      if (width <= 768)
        assert(
          await scroll.evaluate((element) => element.scrollWidth > element.clientWidth),
          'Wide table scrolls inside its own region'
        );
      await table.screenshot({ path: resolve(report, `project-table-${width}.png`) });
    }
    await table.getByRole('button', { name: 'Next page', exact: true }).focus();
    await page.keyboard.press('Enter');
    await table.getByText('Rows 101–200', { exact: true }).waitFor();
    assert.equal(
      await table.getByRole('row').count(),
      101,
      'Only the visible page remains in the DOM'
    );
    assert.equal(
      await table.getByRole('button', { name: 'Next page', exact: true }).isDisabled(),
      true
    );
    await table.getByRole('button', { name: 'Previous page', exact: true }).click();
    await table.getByText('Rows 1–100', { exact: true }).waitFor();
    fixture.tableStale = true;
    await table.getByRole('button', { name: 'Next page', exact: true }).click();
    await table
      .getByText('This table changed. Refresh to start from the first page.', { exact: true })
      .waitFor();
    assert.equal(
      await table.getByRole('row').count(),
      0,
      'Stale rows are not presented as current'
    );
    await table.getByRole('button', { name: 'Refresh table', exact: true }).click();
    await table.getByText('Rows 1–100', { exact: true }).waitFor();
    assert.equal(
      await table.getByRole('button', { name: 'Previous page', exact: true }).isDisabled(),
      true
    );
    fixture.tableStale = false;
    await panel.getByRole('button', { name: 'Close file', exact: true }).click();
    assert(fixture.tableReads.some((read) => read.cursor === 'next-table-page'));
    fixture.failRead = true;
    await panel.getByRole('button', { name: 'Refresh directory', exact: true }).click();
    await panel.getByText('Directory temporarily unavailable', { exact: true }).waitFor();
    assert(
      await panel
        .getByRole('button', { name: 'Refresh directory', exact: true })
        .evaluate((element) => element === document.activeElement)
    );
    assert(await file.isVisible());
    fixture.failRead = false;
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await panel
      .getByText('Directory temporarily unavailable', { exact: true })
      .waitFor({ state: 'detached' });
    await panel.getByRole('combobox', { name: 'Execution directory' }).selectOption(fixture.branch);
    await panel.getByRole('button', { name: 'empty', exact: true }).click();
    await panel.getByText('This directory is empty.', { exact: true }).waitFor();
    assert.equal(
      await panel
        .getByRole('link', { name: 'Download directory ZIP', exact: true })
        .getAttribute('href'),
      `/v1/workspaces/${fixture.branch}/directory.zip?path=workspace`
    );
    assert(
      fixture.reads.some(
        (read) => read.pathname.includes(fixture.branch) && read.folder === 'workspace/empty'
      )
    );
    await panel
      .getByRole('navigation', { name: 'Project directory path' })
      .getByRole('button', { name: 'workspace', exact: true })
      .click();
    await panel.getByRole('button', { name: 'results', exact: true }).waitFor();
    assert(await breadcrumbs.evaluate((element) => element === document.activeElement));
    console.log(
      'Project directory browser checks passed: branch roots, breadcrumbs, paging, hidden files, large file links, folder ZIP links, empty folders, stale/error states and responsive controls.'
    );
  } finally {
    fixture.failRead = false;
    await page.close();
  }
}
