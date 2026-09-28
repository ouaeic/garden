import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkPermissionModes({
  context,
  origin,
  bootstrap,
  task,
  project,
  workspace,
  report
}) {
  const page = await context.newPage();
  const currentTask = { ...task },
    currentProject = { ...project },
    currentWorkspace = { ...workspace };
  const saved = [];
  const descriptionOf = (control) =>
    control.evaluate(
      (element) => document.getElementById(element.getAttribute('aria-describedby'))?.textContent
    );
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/bootstrap')
      return route.fulfill({
        json: {
          ...bootstrap,
          tasks: [currentTask],
          projects: [currentProject],
          workspaces: [currentWorkspace]
        }
      });
    if (path === `/v1/tasks/${task.id}/security-mode`) {
      Object.assign(currentTask, route.request().postDataJSON());
      return route.fulfill({ json: currentTask });
    }
    if (path === `/v1/tasks/${task.id}`) return route.fulfill({ json: currentTask });
    if (path === `/v1/projects/${project.id}/conversations`)
      return route.fulfill({ json: { tasks: [currentTask], nextCursor: null } });
    if (path === `/v1/projects/${project.id}`) {
      if (route.request().method() === 'PATCH')
        Object.assign(currentProject, route.request().postDataJSON());
      return route.fulfill({ json: currentProject });
    }
    if (path === `/v1/workspaces/${workspace.id}/security-mode`) {
      const input = route.request().postDataJSON();
      saved.push(input);
      Object.assign(currentWorkspace, input);
      return route.fulfill({ json: currentWorkspace });
    }
    if (path === `/v1/workspaces/${workspace.id}/snapshots`) return route.fulfill({ json: [] });
    if (path === `/v1/workspaces/${workspace.id}/brief`)
      return route.fulfill({ json: { markdown: '', path: 'workspace/GARDEN.md' } });
    return route.fallback();
  });
  try {
    await page.goto(`${origin}/?task=${task.id}`);
    await page.getByRole('button', { name: /^Continue this conversation/ }).click();
    await page.getByRole('button', { name: 'Prompt settings', exact: true }).click();
    const descriptions = new Map();
    const prompt = page.getByRole('combobox', { name: 'Approvals for this prompt', exact: true });
    for (const mode of ['review', 'balanced', 'autonomous']) {
      await prompt.selectOption(mode);
      const description = await descriptionOf(prompt);
      assert(description?.length > 0);
      descriptions.set(mode, description);
    }
    assert.equal(new Set(descriptions.values()).size, 3);
    await page.getByRole('button', { name: 'Project settings', exact: true }).click();
    const projectMode = page.getByLabel('Default autonomy for new conversations', { exact: true });
    await projectMode.selectOption('autonomous');
    await page.waitForFunction(
      ({ id, summary }) => document.getElementById(id)?.textContent === summary,
      {
        id: await projectMode.getAttribute('aria-describedby'),
        summary: descriptions.get('autonomous')
      }
    );
    assert.equal(await descriptionOf(projectMode), descriptions.get('autonomous'));
    const projectDialog = page.getByRole('dialog', { name: 'Project settings', exact: true });
    await projectDialog.getByText('What this mode allows', { exact: true }).click();
    await projectDialog.getByText(descriptions.get('autonomous'), { exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Computer & maintenance', exact: true })
      .click();
    const control = page.getByLabel('Review level for new work', { exact: true });
    for (const mode of ['review', 'balanced', 'autonomous']) {
      await control.selectOption(mode);
      assert.equal(await descriptionOf(control), descriptions.get(mode));
    }
    await page.getByRole('button', { name: 'Save review level', exact: true }).click();
    await page.getByText('Default review level saved', { exact: true }).waitFor();
    assert.deepEqual(saved, [{ securityMode: 'autonomous' }]);
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Computer & maintenance', exact: true })
      .click();
    assert.equal(await control.inputValue(), 'autonomous');
    const form = control.locator('xpath=ancestor::form');
    const help = form.getByText('What this mode allows', { exact: true });
    await help.focus();
    await page.keyboard.press('Enter');
    await form.getByText(descriptions.get('autonomous'), { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 1000 });
    await help.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.screenshot({ path: resolve(report, 'permission-mode-phone.png') });
    console.log(
      'Permission controls agree across prompt, project and settings; saving, reload and keyboard explanations passed.'
    );
  } catch (error) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: resolve(report, 'permission-mode-failure.png') });
    throw error;
  } finally {
    await page.close();
  }
}
