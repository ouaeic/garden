import { projectUpdateFixture, checkProjectUpdates } from './browser-project-updates.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function checkProjectConversations({
  context,
  origin,
  bootstrap,
  task,
  workspace,
  presentation,
  models,
  modelSurface,
  report,
  errors
}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const anchor = {
    ...workspace,
    id: randomUUID(),
    parentWorkspaceId: workspace.id,
    name: 'Genome project files'
  };
  const project = {
    id: randomUUID(),
    workspaceId: anchor.id,
    parentWorkspaceId: workspace.id,
    title: 'Genome study',
    brief: 'Use the verified assembly.',
    securityMode: 'autonomous',
    revision: 1,
    pinned: false,
    archivedAt: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    conversationCount: 1,
    activeCount: 0,
    attentionCount: 0,
    spentUsd: 0.01,
    latestTaskId: null
  };
  const root = {
    ...task,
    id: randomUUID(),
    workspaceId: anchor.id,
    projectId: project.id,
    title: 'Assembly analysis'
  };
  const tasks = [root],
    notes = [],
    drafts = new Map(),
    requests = [];
  project.latestTaskId = root.id;
  const updates = projectUpdateFixture(project, tasks);
  let pageSize = null;
  let delayPage = null;
  let delayTask = null;
  let releaseTask;
  const reads = [];
  const resultArtifact = {
    id: `artifact:${randomUUID()}`,
    kind: 'artifact',
    artifactId: randomUUID(),
    title: 'Genome analysis notes',
    mimeType: 'text/plain',
    sizeBytes: 30,
    status: 'ready',
    url: null,
    downloadUrl: null,
    accessPath: null,
    evidenceEventIds: []
  };
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method(),
      json = (body) => route.fulfill({ json: body });
    if (method === 'GET') reads.push(path);
    if (await updates.handle(route)) return;
    if (path === `/v1/artifacts/${resultArtifact.artifactId}/content`)
      return route.fulfill({ contentType: 'text/plain', body: 'Verified genome analysis result' });
    if (path === '/v1/bootstrap')
      return json({
        ...bootstrap,
        models,
        tasks: pageSize ? [root] : [...tasks],
        projects: [project],
        workspaces: [workspace, anchor],
        drafts: [...drafts.values()]
      });
    if (path === `/v1/projects/${project.id}`) {
      if (method === 'PATCH') {
        const input = route.request().postDataJSON();
        assert.equal(input.expectedRevision, project.revision);
        Object.assign(project, input, { revision: project.revision + 1 });
      }
      return json(project);
    }
    if (path === `/v1/projects/${project.id}/sessions`)
      return json({
        sessions: [
          {
            workspaceId: root.workspaceId,
            taskId: root.id,
            title: root.title,
            browser: {
              holder: 'agent',
              tabs: [
                {
                  tabId: 'tab-1',
                  title: 'Assembly reference',
                  url: 'https://example.invalid/reference',
                  active: true
                }
              ]
            },
            desktop: {
              holder: 'agent',
              windows: [{ id: 'window-1', name: 'Alignment viewer', role: 'window' }],
              activeApplication: 'Alignment viewer'
            }
          }
        ],
        unavailableWorkspaces: 0,
        observedAt: new Date().toISOString()
      });
    if (path === `/v1/projects/${project.id}/conversations`) {
      const rows = tasks
        .filter(
          (task) => Boolean(task.archivedAt) === (url.searchParams.get('archived') === 'true')
        )
        .slice()
        .reverse();
      const before = Number(url.searchParams.get('before') || 0);
      if (before && delayPage) await delayPage();
      const end = pageSize ? before + pageSize : rows.length;
      try {
        return await json({
          tasks: rows.slice(before, end),
          nextCursor: end < rows.length ? String(end) : null
        });
      } catch (error) {
        if (!before) throw error;
      }
      return;
    }
    if (path === `/v1/projects/${project.id}/notes`) {
      if (method === 'POST') {
        const input = route.request().postDataJSON(),
          id = randomUUID();
        if (input.replacesId) notes.find((note) => note.id === input.replacesId).supersededBy = id;
        notes.unshift({
          id,
          projectId: project.id,
          source: null,
          replacesId: null,
          supersededBy: null,
          createdAt: new Date().toISOString(),
          ...input
        });
        return json({ id });
      }
      return json({
        notes: notes.filter(
          (note) => url.searchParams.get('history') === 'true' || !note.supersededBy
        ),
        nextCursor: null
      });
    }
    if (path === `/v1/projects/${project.id}/model-preferences`)
      return json({ ...modelSurface(), projectTaskId: project.id });
    if (
      path === `/v1/projects/${project.id}/processes` ||
      tasks.some((task) => path === `/v1/tasks/${task.id}/processes`)
    )
      return json({
        processes: [],
        resourcesAvailable: true,
        observedAt: new Date().toISOString()
      });
    if (
      path === `/v1/workspaces/${anchor.id}` ||
      tasks.some((task) => path === `/v1/workspaces/${task.workspaceId}`)
    )
      return json({ ...anchor, id: path.split('/').at(-1) });
    if (path === '/v1/drafts') {
      if (method === 'GET') {
        const key = url.searchParams.get('taskId') ?? `new:${url.searchParams.get('workspaceId')}`;
        return json(
          drafts.get(key) ?? {
            workspaceId: anchor.id,
            taskId: null,
            body: '',
            attachments: [],
            revision: 0
          }
        );
      }
      const input = route.request().postDataJSON(),
        key = input.taskId ?? `new:${input.workspaceId}`,
        revision = (drafts.get(key)?.revision ?? 0) + 1;
      drafts.set(key, { ...input, revision, updatedAt: new Date().toISOString() });
      return json({ revision, updatedAt: new Date().toISOString() });
    }
    if (path === '/v1/tasks' && method === 'POST') {
      const input = route.request().postDataJSON();
      requests.push(input);
      const child = {
        ...root,
        id: randomUUID(),
        workspaceId: randomUUID(),
        title: 'QC conversation',
        status: 'queued',
        securityMode: input.securityMode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      tasks.push(child);
      project.conversationCount++;
      project.activeCount++;
      project.updatedAt = child.updatedAt;
      project.latestTaskId = child.id;
      return json(child);
    }
    const selected = tasks.find((task) => path === `/v1/tasks/${task.id}`);
    if (selected) {
      if (delayTask) await delayTask();
      return json(selected);
    }
    if (tasks.some((task) => path === `/v1/tasks/${task.id}/presentation`))
      return json({
        ...presentation,
        taskId: path.split('/')[3],
        results: [...presentation.results, resultArtifact]
      });
    return route.fallback();
  });
  try {
    await page.goto(`${origin}/?project=${project.id}`);
    await page.getByRole('heading', { name: project.title, exact: true }).waitFor();
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Tools', exact: true })
      .click();
    await page
      .getByRole('region', { name: 'Project browser and desktop' })
      .getByRole('button', { name: /Assembly reference/ })
      .waitFor();
    await page.getByText('Alignment viewer', { exact: true }).waitFor();
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Work', exact: true })
      .click();
    const result = page.locator('.garden-delivery').filter({ hasText: resultArtifact.title });
    await result.getByRole('button', { name: 'View', exact: true }).click();
    const resultDialog = page.getByRole('dialog', { name: resultArtifact.title, exact: true });
    await resultDialog.getByText('Verified genome analysis result', { exact: true }).waitFor();
    assert.equal(
      new URL(page.url()).searchParams.get('task'),
      null,
      'Viewing a result stays in the project overview'
    );
    assert.equal(
      await resultDialog
        .getByRole('link', { name: 'Download result', exact: true })
        .getAttribute('href'),
      `/v1/artifacts/${resultArtifact.artifactId}/content`
    );
    await page.keyboard.press('Escape');
    await resultDialog.waitFor({ state: 'detached' });
    assert(
      await result
        .getByRole('button', { name: 'View', exact: true })
        .evaluate((element) => element === document.activeElement)
    );
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
    let input = dialog.getByPlaceholder('Describe what you want to do…');
    await input.fill('Review quality without changing the assembly.');
    assert.equal(
      await dialog.getByRole('combobox', { name: 'Approvals for this prompt' }).inputValue(),
      'autonomous'
    );
    assert.equal(await dialog.getByRole('radio', { name: 'Shared project files' }).count(), 0);
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/drafts' &&
        response.request().method() === 'PUT' &&
        response.request().postDataJSON().controls?.conversation?.execution === 'independent'
    );
    await page.reload();
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
    input = dialog.getByPlaceholder('Describe what you want to do…');
    assert.equal(await input.inputValue(), 'Review quality without changing the assembly.');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'QC conversation', exact: true }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].projectId, project.id);
    assert.equal(requests[0].execution, 'independent');
    assert.equal(requests[0].securityMode, 'autonomous');
    await page.reload();
    await page.getByRole('heading', { name: 'QC conversation', exact: true }).waitFor();
    const tabs = page.getByRole('combobox', { name: 'Current conversation', exact: true });
    const initialOrder = ['Open a conversation…', 'Assembly analysis', 'QC conversation'];
    assert.deepEqual(await tabs.locator('option').allTextContents(), initialOrder);
    for (const name of ['Assembly analysis', 'QC conversation', 'QC conversation']) {
      await tabs.selectOption({ label: name });
      assert.equal(await tabs.locator('option:checked').textContent(), name);
      assert.deepEqual(await tabs.locator('option').allTextContents(), initialOrder);
    }
    root.updatedAt = new Date(Date.now() + 60_000).toISOString();
    const child = tasks[1];
    const additional = Array.from({ length: 7 }, (_, index) => ({
      ...root,
      id: randomUUID(),
      title: `Discussion ${index + 1}`,
      pinned: index === 6,
      createdAt: new Date(Date.parse(child.createdAt) + (index + 1) * 1000).toISOString()
    }));
    tasks.push(...additional);
    project.conversationCount = tasks.length;
    await page.reload();
    await tabs.locator('option').filter({ hasText: 'Discussion 7' }).waitFor({ state: 'attached' });
    const expandedOrder = [
      'Open a conversation…',
      'Discussion 7',
      'Assembly analysis',
      'QC conversation',
      ...additional.slice(0, 6).map((task) => task.title)
    ];
    assert.deepEqual(await tabs.locator('option').allTextContents(), expandedOrder);
    await page.setViewportSize({ width: 320, height: 900 });
    await tabs.selectOption({ label: 'Discussion 6' });
    await page.reload();
    await tabs.waitFor();
    assert.equal(await tabs.locator('option:checked').textContent(), 'Discussion 6');
    assert.deepEqual(await tabs.locator('option').allTextContents(), expandedOrder);
    await tabs.selectOption({ label: 'Assembly analysis' });
    assert.deepEqual(await tabs.locator('option').allTextContents(), expandedOrder);
    tasks.splice(2);
    project.conversationCount = tasks.length;
    await page.getByRole('heading', { name: root.title, exact: true }).waitFor();
    await page.goto(`${origin}/?task=${child.id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'QC conversation', exact: true }).waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const title = page.locator('.project-space-title h1');
      assert(
        (await title.boundingBox()).width > 40,
        'The project name must remain visible beside controls'
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: resolve(report, `conversations-${width}.png`) });
    }
    await page
      .getByRole('button', { name: `${project.title} · Project overview`, exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    const journal = page.getByRole('region', { name: 'Project notes' });
    await journal.getByRole('button', { name: 'Add note' }).click();
    const editor = page.getByRole('dialog', { name: 'Keep a project note' });
    await editor
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('The reference passed quality control.');
    await editor.getByRole('button', { name: 'Save note' }).click();
    await editor.waitFor({ state: 'detached' });
    await journal.getByText('The reference passed quality control.', { exact: true }).waitFor();
    await journal.getByRole('button', { name: 'Correct', exact: true }).click();
    const correction = page.getByRole('dialog', { name: 'Correct project note' });
    await correction
      .getByRole('textbox', { name: 'Note', exact: true })
      .fill('Use assembly version two; version one failed coverage.');
    await correction.getByRole('button', { name: 'Save note' }).click();
    await correction.waitFor({ state: 'detached' });
    await journal.getByRole('checkbox', { name: 'History' }).check();
    await journal.getByText('The reference passed quality control.', { exact: true }).waitFor();
    await journal
      .getByText('Use assembly version two; version one failed coverage.', { exact: true })
      .waitFor();
    await page.screenshot({ path: resolve(report, 'project-note-history.png') });
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Work', exact: true })
      .click();
    await page.getByRole('button', { name: 'Discuss', exact: true }).first().click();
    const linked = page.getByRole('dialog', { name: 'New conversation', exact: true });
    await linked.getByPlaceholder('Describe what you want to do…').fill('Explain this result.');
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/drafts' &&
        response.request().method() === 'PUT' &&
        Boolean(response.request().postDataJSON().controls?.conversation?.source?.result)
    );
    assert(
      drafts.get(`new:${anchor.id}`).controls.conversation.source.result.id,
      'The selected result identity must survive draft recovery'
    );
    await linked.getByRole('button', { name: 'Close New conversation', exact: true }).click();
    await page
      .getByRole('button', { name: `${project.title} · Project overview`, exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await checkProjectUpdates({ page, fixture: updates, project, report });
    const dense = Array.from({ length: 248 }, (_, index) => ({
      ...root,
      id: randomUUID(),
      title: `Analysis ${String(index + 1).padStart(3, '0')}`,
      createdAt: new Date(Date.parse(child.createdAt) + (index + 1) * 1000).toISOString(),
      updatedAt: new Date(Date.parse(child.createdAt) + (index + 1) * 1000).toISOString()
    }));
    tasks.push(...dense);
    const archivedTask = {
      ...root,
      id: randomUUID(),
      title: 'Archived analysis',
      archivedAt: new Date().toISOString()
    };
    tasks.push(archivedTask);
    pageSize = 50;
    project.conversationCount = tasks.length;
    reads.length = 0;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install();
    const began = performance.now();
    await page.goto(`${origin}/?project=${project.id}`);
    await tabs.locator('option').nth(50).waitFor({ state: 'attached' });
    const initialReadyMs = performance.now() - began;
    assert.equal(await tabs.locator('option').count(), 51);
    await tabs.focus();
    await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === `/v1/projects/${project.id}`
      ),
      page.clock.runFor(15_100)
    ]);
    assert(
      await tabs.evaluate((element) => element === document.activeElement),
      'Refreshing progress must not steal conversation focus'
    );
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page
      .getByRole('region', { name: 'Conversations', exact: true })
      .getByRole('button', { name: 'More conversations', exact: true })
      .click();
    await tabs.locator('option').nth(100).waitFor({ state: 'attached' });
    assert.equal(await tabs.locator('option').count(), 101);
    assert(
      await page
        .getByRole('region', { name: 'Conversations', exact: true })
        .getByRole('button', { name: 'More conversations', exact: true })
        .evaluate((el) => document.activeElement === el)
    );
    const metrics = {
      totalConversations: tasks.length,
      loadedConversations: 100,
      initialReadyMs,
      domNodes: await page.locator('*').count(),
      requestCounts: Object.fromEntries(
        [...new Set(reads)].map((path) => [path, reads.filter((value) => value === path).length])
      )
    };
    const presentationReads = reads.filter((path) => path.endsWith('/presentation'));
    assert(presentationReads.length > 0);
    assert.equal(
      new Set(presentationReads).size,
      4,
      'Result presentation reads must stay bounded by visible recent results'
    );
    let enteredTask;
    const taskPending = new Promise((done) => {
      releaseTask = done;
    });
    const taskEntered = new Promise((done) => {
      enteredTask = done;
    });
    delayTask = async () => {
      enteredTask();
      await taskPending;
    };
    const olderOption = tabs.locator('option').nth(30);
    const olderName = await olderOption.textContent();
    await tabs.focus();
    await tabs.selectOption({ label: olderName });
    await taskEntered;
    assert.equal(await tabs.locator('option:checked').textContent(), olderName);
    assert.equal(await tabs.locator('option').count(), 101);
    releaseTask();
    delayTask = null;
    await page.getByRole('heading', { name: olderName, exact: true }).waitFor();
    assert(await tabs.evaluate((el) => document.activeElement === el));
    await page
      .getByRole('button', { name: `${project.title} · Project overview`, exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Project views' })
      .getByRole('button', { name: 'Activity', exact: true })
      .click();
    await page.getByRole('region', { name: 'Conversations', exact: true }).waitFor();
    assert.equal(await tabs.locator('option').count(), 101);
    const smallInput = page.getByRole('textbox', { name: 'Find a conversation', exact: true });
    await page.setViewportSize({ width: 360, height: 340 });
    await smallInput.scrollIntoViewIfNeeded();
    await smallInput.fill('Analysis');
    assert(await smallInput.evaluate((el) => document.activeElement === el));
    const inputBox = await smallInput.boundingBox();
    assert(inputBox.y >= 0 && inputBox.y + inputBox.height <= 340);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
    await page.screenshot({ path: resolve(report, 'project-keyboard-compact-viewport.png') });
    await smallInput.fill('');
    await page.setViewportSize({ width: 1440, height: 900 });
    const trigger = page.getByRole('button', { name: 'Project settings', exact: true });
    await trigger.focus();
    await trigger.press('Enter');
    await page.getByRole('dialog', { name: 'Project settings', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert(await trigger.evaluate((el) => document.activeElement === el));
    let releasePage, enteredPage;
    const pendingPage = new Promise((done) => {
      releasePage = done;
    });
    const entered = new Promise((done) => {
      enteredPage = done;
    });
    delayPage = async () => {
      enteredPage();
      await pendingPage;
    };
    const cancelledPage = page.waitForEvent('requestfailed', {
      predicate: (request) => {
        const url = new URL(request.url());
        return (
          url.pathname === `/v1/projects/${project.id}/conversations` &&
          url.searchParams.get('before') === '100'
        );
      }
    });
    await page
      .getByRole('region', { name: 'Conversations', exact: true })
      .getByRole('button', { name: 'More conversations', exact: true })
      .click();
    await entered;
    await page.getByRole('checkbox', { name: 'Archived', exact: true }).check();
    await tabs
      .locator('option')
      .filter({ hasText: archivedTask.title })
      .waitFor({ state: 'attached' });
    releasePage();
    await cancelledPage;
    await page.clock.runFor(100);
    assert.deepEqual(await tabs.locator('option').allTextContents(), [
      'Open a conversation…',
      archivedTask.title
    ]);
    assert.equal(
      await page
        .getByRole('region', { name: 'Conversations', exact: true })
        .getByRole('button', { name: 'More conversations', exact: true })
        .count(),
      0
    );
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 540 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: resolve(report, `project-keyboard-${width}.png`) });
    }
    await writeFile(resolve(report, 'project-scale.json'), JSON.stringify(metrics, null, 2) + '\n');
    await writeFile(resolve(report, 'project-tabs-accessibility.txt'), await tabs.ariaSnapshot());
    console.log(
      'Project conversation browser checks passed: persistent working-area drafts, inherited autonomy, independent creation, stable conversation order across navigation and activity, pinned conversations and restored selection, reloads, responsive names and controls, notes with correction history, and exact result references.'
    );
  } finally {
    releaseTask?.();
    await page.close();
  }
}
