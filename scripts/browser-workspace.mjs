import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// Navigation, edit retention and lazy loading are contracts between the shell and real panels.
export async function checkWorkspaceNavigation({ context, origin, task, report }) {
  const page = await context.newPage();
  const errors = [];
  const reads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/v1/')) reads.push(new URL(request.url()).pathname);
  });
  await page.route('**/browser-token', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: 'No browser session in this navigation fixture.' } }
    })
  );
  try {
    await page.goto(`${origin}/?task=${task.id}`);
    const views = page.getByRole('navigation', { name: 'Project views', exact: true });
    await views.getByRole('button', { name: 'Work', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue this conversation…', exact: true }).waitFor();
    assert.equal(
      reads.some((path) => path.endsWith('/directories')),
      true,
      'Desktop file shortcuts show the active working copy'
    );
    assert.equal(
      await page.getByRole('navigation', { name: 'Project conversations' }).count(),
      1,
      'Desktop conversations have a stable tab strip'
    );
    const conversations = page.getByRole('combobox', {
      name: 'Current conversation',
      exact: true,
      includeHidden: true
    });
    const order = await conversations.locator('option').allTextContents();
    assert(order.length > 1);
    await views.getByRole('button', { name: 'Files', exact: true }).click();
    const files = page.getByRole('region', { name: 'Project files', exact: true });
    await files.getByRole('combobox', { name: 'Working copy', exact: true }).waitFor();
    await files.getByRole('button', { name: 'results', exact: true }).click();
    await files.getByRole('button', { name: 'View table summary.tsv', exact: true }).click();
    await files.getByRole('table').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('file'), 'workspace/results/summary.tsv');
    await page.reload();
    await files.getByRole('table').waitFor();
    await views.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByRole('button', { name: 'Full activity', exact: true }).waitFor();
    assert.equal(await files.isVisible(), false);
    await page.goBack();
    await files.getByRole('table').waitFor();
    await views.getByRole('button', { name: 'Tools', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Computer tools', exact: true })
      .getByRole('button', { name: 'Jobs', exact: true })
      .click();
    await page.getByRole('region', { name: 'Project processes', exact: true }).waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get('view'),
      null,
      'Project tools retain the project shell'
    );
    assert.equal(new URL(page.url()).searchParams.get('tool'), 'processes');
    await page.reload();
    await page.getByRole('region', { name: 'Project processes', exact: true }).waitFor();
    assert.deepEqual(await conversations.locator('option').allTextContents(), order);
    await views.getByRole('button', { name: 'Work', exact: true }).click();
    await page.getByRole('button', { name: /^Continue this conversation/ }).click();
    const draft = page.locator('.garden-task-composer textarea');
    await draft.fill('Keep this follow-up draft while I inspect the files.');
    await views.getByRole('button', { name: 'Files', exact: true }).click();
    await views.getByRole('button', { name: 'Work', exact: true }).click();
    assert.equal(await draft.inputValue(), 'Keep this follow-up draft while I inspect the files.');
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.equal(
        await page.getByRole('button', { name: 'Find anything', exact: true }).isVisible(),
        true
      );
      for (const label of ['Work', 'Files', 'Activity', 'Tools'])
        assert.equal(
          await views.getByRole('button', { name: label, exact: true }).isVisible(),
          true
        );
      if (width <= 760) {
        const settings = page.getByRole('button', { name: 'Prompt settings', exact: true });
        const mode = page.getByRole('combobox', { name: 'Approvals for this prompt', exact: true });
        assert.equal(await mode.isVisible(), false, 'Secondary controls start folded on mobile');
        assert(
          await page
            .locator('.garden-task-composer')
            .evaluate((element) => element.clientHeight <= innerHeight * 0.4)
        );
        await settings.click();
        assert.equal(await mode.isVisible(), true, 'Advanced controls remain directly accessible');
        const saved = await mode.inputValue();
        await mode.selectOption('autonomous');
        await settings.click();
        await settings.click();
        assert.equal(await mode.inputValue(), 'autonomous', 'Folding settings preserves choices');
        await mode.selectOption(saved);
        await settings.click();
      }
      await page.screenshot({ path: resolve(report, `workspace-${width}.png`) });
    }
    await page.goto(`${origin}/?view=settings&section=Models`);
    await page.getByRole('heading', { name: 'Model defaults', exact: true }).waitFor();
    const defaults = page.getByRole('region', { name: 'Main agent', exact: true });
    await defaults.waitFor();
    assert.equal(await defaults.isVisible(), true);
    assert.equal(
      await page.getByRole('region', { name: 'Coding agents', exact: true }).isVisible(),
      false
    );
    await page.getByText('Advanced model choices', { exact: true }).click();
    await page.getByRole('region', { name: 'Coding agents', exact: true }).waitFor();
    await page.getByText('Decision model preference', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Allow decision models', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Model defaults', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('section'), 'Models');
    assert.deepEqual(errors, []);
    console.log(
      'Workspace navigation passed: lazy files, deep-linked table and tool selection, history, stable conversations, draft retention, responsive search and model disclosure.'
    );
  } finally {
    await page.close();
  }
}
