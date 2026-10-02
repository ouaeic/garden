import { captureBrowserErrors } from './browser-errors.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

// Navigation, edit retention and lazy loading are contracts between the shell and real panels.
export async function checkWorkspaceNavigation({ context, origin, task, report }) {
  const page = await context.newPage();
  const errors = [];
  const reads = [];
  await captureBrowserErrors(page, errors);
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
    const views = page.locator(
      'body:has(.project-panel[open]:not(.is-docked)) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open]:not(.is-docked))) .project-workspace-bar .project-view-nav'
    );
    const panel = page.locator('.project-panel[open]');
    const closePanel = async () => {
      await panel.locator(':scope > .dialog-heading > button').click();
      await panel.waitFor({ state: 'hidden' });
    };
    await views.getByRole('button', { name: 'Files', exact: true }).waitFor();
    assert.equal(await views.getByRole('button', { name: 'Work', exact: true }).count(), 0);
    await page.locator('.garden-task-composer textarea').waitFor();
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
    const originalOutput = await page
      .getByRole('region', { name: 'Project output', exact: true })
      .elementHandle();
    const originalComposer = await page.locator('.garden-task-composer').elementHandle();
    await page
      .getByRole('region', { name: 'Files card', exact: true })
      .getByRole('button', { name: 'results Folder', exact: true })
      .click();
    await panel.waitFor();
    assert.equal(new URL(page.url()).searchParams.get('task'), task.id);
    assert.equal(new URL(page.url()).searchParams.get('folder'), 'workspace/results');
    assert(
      await originalOutput.evaluate((element) => element.isConnected),
      'Opening a folder keeps the output mounted'
    );
    assert(
      await originalComposer.evaluate((element) => element.isConnected),
      'Opening a folder keeps the composer mounted'
    );
    const files = page.getByRole('region', { name: 'Project files', exact: true });
    await files.getByRole('combobox', { name: 'Working copy', exact: true }).waitFor();
    await files.getByRole('button', { name: 'workspace', exact: true }).click();
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
    await closePanel();
    const draft = page.locator('.garden-task-composer textarea');
    await draft.fill('Keep this follow-up draft while I inspect the files.');
    await views.getByRole('button', { name: 'Files', exact: true }).click();
    await closePanel();
    assert.equal(await draft.inputValue(), 'Keep this follow-up draft while I inspect the files.');
    // A floating editor must keep unsaved changes through every dismissal path.
    await page.route('**/file?**', (route) =>
      route.fulfill({
        contentType: 'text/plain',
        headers: {
          'x-content-sha256': 'fixture-source',
          'x-truncated': 'false',
          'x-end-line': '2'
        },
        body: 'name\tvalue\nexample\t1\n'
      })
    );
    await views.getByRole('button', { name: 'Files', exact: true }).click();
    await files.getByRole('button', { name: 'results', exact: true }).click();
    await files.getByRole('button', { name: 'Inspect summary.tsv', exact: true }).click();
    const editor = files.getByRole('textbox', {
      name: 'Contents of workspace/results/summary.tsv',
      exact: true
    });
    await editor.fill('name\tvalue\nchanged\t2\n');
    await page.keyboard.press('Escape');
    await files.getByText('Save or discard file edits before leaving.', { exact: true }).waitFor();
    await panel.locator(':scope > .dialog-heading > button').click();
    await views.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.goBack();
    assert.equal(await editor.inputValue(), 'name\tvalue\nchanged\t2\n');
    assert.equal(new URL(page.url()).searchParams.get('panel'), 'files');
    await files.getByRole('button', { name: 'Discard edits', exact: true }).click();
    await closePanel();
    await page.unroute('**/file?**');
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.equal(
        await page.getByRole('button', { name: 'Find anything', exact: true }).isVisible(),
        true
      );
      for (const label of ['Files', 'Activity', 'Tools'])
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
        await mode.waitFor({ state: 'visible' });
        const saved = await mode.inputValue();
        await mode.selectOption('autonomous');
        await settings.click();
        await mode.waitFor({ state: 'hidden' });
        await settings.click();
        await mode.waitFor({ state: 'visible' });
        assert.equal(await mode.inputValue(), 'autonomous', 'Folding settings preserves choices');
        await mode.selectOption(saved);
        await settings.click();
      }
      await page.screenshot({ path: resolve(report, `workspace-${width}.png`) });
      for (const section of ['Files', 'Activity', 'Tools']) {
        await views.getByRole('button', { name: section, exact: true }).click();
        await panel.waitFor();
        const box = await panel.boundingBox();
        assert(
          box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 900,
          `${section} panel fits ${width}px`
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
          true,
          'The page does not scroll'
        );
        await page.screenshot({
          path: resolve(report, `panel-${section.toLowerCase()}-${width}.png`)
        });
      }
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      assert.equal(
        await draft.inputValue(),
        'Keep this follow-up draft while I inspect the files.'
      );
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
  } catch (error) {
    await page.screenshot({ path: resolve(report, 'workspace-failure.png') });
    throw error;
  } finally {
    await page.close();
  }
}
