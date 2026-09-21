import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function projectUpdateFixture(project, tasks) {
  const fixture = { head: null, updates: [], revisions: [], actions: [], fail: false };
  fixture.handle = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/v1/projects/${project.id}/changes`) {
      const identities = url.searchParams.get('tasks').split(',');
      assert(
        identities.length > 0 && identities.every((id) => tasks.some((task) => task.id === id))
      );
      await route.fulfill({
        json: identities.map((taskId, index) => ({
          taskId,
          status: 'ready',
          measurement: {
            observedAt: new Date().toISOString(),
            baselineRevision: null,
            added: index === 0 ? 23 : 7,
            removed: index === 0 ? 4 : 0,
            changedFiles: 2,
            unmeasuredFiles: index === 0 ? 1 : 0,
            scannedFiles: 3,
            truncated: false
          }
        }))
      });
      return true;
    }
    if (url.pathname === `/v1/projects/${project.id}/cleanup/pending`) {
      assert.equal(route.request().method(), 'POST');
      await route.fulfill({ json: [] });
      return true;
    }
    if (url.pathname !== `/v1/projects/${project.id}/updates`) return false;
    if (fixture.fail) {
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Status temporarily unavailable' } }
      });
      return true;
    }
    const json = (body) => route.fulfill({ json: body });
    if (route.request().method() === 'GET') {
      const id = url.searchParams.get('updateId');
      const cursor = url.searchParams.get('revisionsBefore');
      const offset = cursor ? fixture.revisions.findIndex((item) => item.id === cursor) + 1 : 0;
      assert(!cursor || offset > 0, 'Version cursor must identify a published version');
      const revisions = fixture.revisions.slice(offset, offset + 40);
      await json(
        id
          ? fixture.updates.find((update) => update.id === id)
          : {
              head: fixture.head,
              updates: fixture.updates,
              revisions,
              nextRevisionCursor:
                offset + 40 < fixture.revisions.length ? revisions.at(-1).id : null,
              observedAt: new Date().toISOString(),
              nextCursor: null
            }
      );
      return true;
    }
    const { operation, taskId } = route.request().postDataJSON();
    fixture.actions.push(operation);
    let update = fixture.updates.find((update) => update.id === operation.updateId);
    if (operation.action === 'prepare') {
      const source = tasks.find((task) => task.id === taskId);
      assert(source, 'Preparation must name a project conversation');
      const id = operation.requestId;
      update = {
        id,
        projectId: project.id,
        taskId,
        sourceWorkspaceId: source.workspaceId,
        title: operation.update.title,
        state: 'ready',
        parentRevision: fixture.head?.id ?? null,
        candidateDigest: 'a'.repeat(64),
        path: `/home/athanor/.project-store/${project.id}/public/candidates/${id}/workspace`,
        changes: [
          {
            path: 'analysis.py',
            kind: 'added',
            proposed: { sha256: 'a'.repeat(64) },
            current: null,
            conflict: false,
            merged: false,
            lines: { added: 1, removed: 0 },
            diff: '+++ Proposed\nprint("cohort checks")'
          }
        ],
        changeCount: 1,
        lineChanges: { added: 1, removed: 0, unmeasuredFiles: 0 },
        nextChange: null,
        checks: operation.update.checks.map((check) => ({
          ...check,
          id: randomUUID(),
          status: 'pending',
          startedAt: null,
          finishedAt: null,
          ranForMs: 0,
          exitCode: null,
          detail: null,
          candidateDigest: 'a'.repeat(64),
          sessionId: null
        })),
        progress: { files: 1, bytes: 500, stage: 'Ready for checks' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        publishedRevision: null,
        detail: null,
        uncheckedReason: null
      };
      fixture.updates.unshift(update);
    } else if (operation.action === 'check') {
      assert.equal(operation.digest, update.candidateDigest);
      Object.assign(
        update.checks.find((check) => check.id === operation.checkId),
        {
          status: 'running',
          startedAt: new Date().toISOString(),
          ranForMs: 172_800_000,
          sessionId: randomUUID(),
          resources: {
            sampledAt: new Date().toISOString(),
            cpuPercent: 1250,
            residentBytes: 64 * 1024 ** 3
          }
        }
      );
      update.state = 'checking';
    } else if (operation.action === 'log') {
      await json({ stdout: 'Cohort 3: validation passed\n', stderr: '' });
      return true;
    } else if (operation.action === 'stop') {
      update.checks.find((check) => check.id === operation.checkId).status = 'cancelled';
      update.state = 'checks_failed';
    } else if (operation.action === 'rebase') {
      update = {
        ...structuredClone(update),
        id: operation.requestId,
        state: 'ready',
        parentRevision: fixture.head?.id ?? null,
        checks: update.checks.map((check) => ({
          ...check,
          id: randomUUID(),
          status: 'pending',
          startedAt: null,
          sessionId: null
        }))
      };
      fixture.updates.unshift(update);
    } else if (operation.action === 'publish') {
      assert(update.checks.every((check) => check.status === 'passed'));
      const revision = {
        id: randomUUID(),
        number: fixture.revisions.length + 1,
        updateId: update.id,
        title: update.title,
        taskId: update.taskId,
        digest: update.candidateDigest,
        createdAt: new Date().toISOString(),
        path: update.path,
        checks: structuredClone(update.checks),
        uncheckedReason: null
      };
      fixture.head = revision;
      fixture.revisions.unshift(revision);
      update.state = 'published';
      update.publishedRevision = revision.id;
    } else if (operation.action === 'cancel') update.state = 'cancelled';
    await json(update);
    return true;
  };
  return fixture;
}

export async function checkProjectUpdates({ page, fixture, project, report }) {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const conversations = page.getByRole('region', { name: 'Conversations', exact: true });
  await conversations.scrollIntoViewIfNeeded();
  await conversations
    .getByText('+23 −4 lines · 2 changed files · 1 unmeasured', { exact: true })
    .waitFor();
  const panel = page.getByRole('region', { name: 'Project updates and checks', exact: true });
  await panel.getByText('No published version yet', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Prepare update', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Prepare a project update', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Update title', exact: true })
    .fill('Cohort validation');
  await dialog
    .getByRole('textbox', { name: 'Files or directories · one per line', exact: true })
    .fill('analysis.py');
  await dialog
    .getByRole('textbox', { name: 'Check commands · one per line', exact: true })
    .fill('python -m pytest\npython analysis.py --validate');
  await dialog.getByRole('button', { name: 'Prepare files', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Cohort validation', exact: true });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Publish checked version', exact: true }).count(),
    0
  );
  await dialog.getByRole('button', { name: 'Run check', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Stop check', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Run check', exact: true }).count(), 1);
  await dialog.getByRole('button', { name: 'Run pending checks', exact: true }).click();
  await dialog.getByRole('button', { name: 'Stop check', exact: true }).first().waitFor();
  assert.equal(fixture.actions.filter((action) => action.action === 'check').length, 2);
  assert.match(await dialog.innerText(), /2d 0h/);
  assert.match(await dialog.innerText(), /64.0 GiB RAM/);
  await dialog.getByRole('button', { name: 'View output', exact: true }).first().click();
  await dialog.getByText('Cohort 3: validation passed', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Stop check', exact: true }).first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('.project-check .check-running').length === 1
  );
  assert.equal(fixture.actions.filter((action) => action.action === 'stop').length, 1);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    assert(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
      `Check details fit ${width}px`
    );
    await dialog.screenshot({ path: resolve(report, `project-checks-${width}.png`) });
  }
  await dialog.getByRole('button', { name: 'Close Cohort validation', exact: true }).click();
  fixture.updates[0].state = 'outdated';
  fixture.updates[0].checks.forEach((check) => {
    check.status = 'passed';
    check.exitCode = 0;
  });
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  await panel.getByRole('button', { name: /Newer version available.*Cohort validation/ }).click();
  dialog = page.getByRole('dialog', { name: 'Cohort validation', exact: true });
  await dialog.getByText('Any earlier passing checks apply', { exact: false }).waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Publish checked version', exact: true }).count(),
    0
  );
  await dialog.getByRole('button', { name: 'Rebuild and reset checks', exact: true }).click();
  await dialog.getByRole('button', { name: 'Run pending checks', exact: true }).waitFor();
  assert(fixture.updates[0].checks.every((check) => check.status === 'pending'));
  await dialog.getByRole('button', { name: 'Close Cohort validation', exact: true }).click();
  fixture.updates[0].checks.forEach((check) => {
    check.status = 'passed';
    check.exitCode = 0;
  });
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  await panel.getByRole('button', { name: /Ready to publish.*Cohort validation/ }).click();
  dialog = page.getByRole('dialog', { name: 'Cohort validation', exact: true });
  await dialog.getByRole('button', { name: 'Publish checked version', exact: true }).click();
  await dialog.getByText('Published', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close Cohort validation', exact: true }).click();
  await panel
    .locator('.project-version-head')
    .getByText('Version 1 · Cohort validation', { exact: true })
    .waitFor();
  fixture.updates[1].title = 'A long analysis update with descriptive detail '.repeat(5);
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    await panel.scrollIntoViewIfNeeded();
    assert(
      await panel.evaluate((element) => element.scrollWidth <= element.clientWidth),
      `Parallel work overview fits ${width}px`
    );
    await panel.screenshot({ path: resolve(report, `project-updates-${width}.png`) });
  }
  fixture.fail = true;
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  await panel
    .getByText('Last known status is shown. Work continues on the server.', { exact: true })
    .waitFor();
  await panel
    .locator('.project-version-head')
    .getByText('Version 1 · Cohort validation', { exact: true })
    .waitFor();
  fixture.fail = false;
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  await panel
    .getByText('Last known status is shown. Work continues on the server.', { exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(fixture.head.number, 1);
  assert.equal(fixture.head.updateId, fixture.updates[0].id);
  const firstPublication = structuredClone(fixture.head);
  fixture.revisions = Array.from({ length: 42 }, (_, index) => ({
    ...structuredClone(fixture.head),
    id: randomUUID(),
    number: 43 - index,
    title: `Published analysis ${43 - index}`
  }));
  fixture.revisions.push(firstPublication);
  fixture.head = fixture.revisions[0];
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  await panel
    .locator('.project-version-head')
    .getByText('Version 43 · Published analysis 43', { exact: true })
    .waitFor();
  await panel.getByText('Published files and version history', { exact: true }).click();
  const history = panel.locator('.project-version-history-list');
  assert.equal(
    await history.locator('li').count(),
    41,
    'A previously loaded old version stays visible when new versions arrive'
  );
  const earlier = panel.getByRole('button', { name: 'Load earlier versions', exact: true });
  await earlier.focus();
  await earlier.press('Enter');
  await earlier.waitFor({ state: 'detached' });
  assert.equal(await history.locator('li').count(), 43);
  await panel.getByRole('button', { name: 'Refresh project updates', exact: true }).click();
  await panel
    .locator('.project-version-head')
    .getByText('Version 43 · Published analysis 43', { exact: true })
    .waitFor();
  assert.equal(await history.locator('li').count(), 43, 'Polling must preserve loaded history');
  assert.deepEqual(
    await history.getByRole('button', { name: /^Version \d+ · / }).allTextContents(),
    fixture.revisions.map((item) => `Version ${item.number} · ${item.title}`)
  );
  await panel.getByText('Published files and version history', { exact: true }).click();
  console.log(
    'Project update browser checks passed: preparation, parallel checks, elapsed days, resource samples, logs, scoped cancellation, stale evidence, reset checks, checked publication, paginated history retained across refresh and responsive layouts.'
  );
}
