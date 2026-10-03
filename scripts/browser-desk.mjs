import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { captureBrowserErrors } from './browser-errors.mjs';

// A fixed workspace must keep its controls reachable while each overflowing card scrolls.
export async function checkDesk({
  context,
  origin,
  task,
  bootstrap,
  project,
  report,
  directoryUi,
  processUi
}) {
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const failures = [];
  const pageErrors = await captureBrowserErrors(page, failures);
  const failedRequests = [];
  page.on('requestfailed', (request) =>
    failedRequests.push({ url: request.url(), failure: request.failure() })
  );
  directoryUi.longList = true;
  processUi.seed();
  const rows = processUi.rows;
  processUi.rows = [
    ...rows,
    ...Array.from({ length: 8 }, (_, index) => ({
      ...rows[0],
      sessionId: `desk-job-${index}`,
      job: { ...rows[0].job, name: `Sequence analysis ${index + 1}` }
    }))
  ];
  const originalProjects = bootstrap.projects;
  const originalUsage = bootstrap.usage;
  bootstrap.projects = Array.from({ length: 25 }, (_, index) => ({
    ...project,
    id: index ? `desk-${index}` : project.id,
    title: index ? `Research project ${index}` : 'Protein sequence analysis'
  }));
  const fit = async () => {
    await page.waitForFunction(
      () =>
        Math.abs(
          document.querySelector('.desk-shell').getBoundingClientRect().height - innerHeight
        ) < 2
    );
    const dimensions = await page.evaluate(() => {
      const main = document.querySelector('.garden-main');
      return {
        width: innerWidth,
        height: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        mainHeight: main.clientHeight,
        mainScroll: main.scrollHeight
      };
    });
    assert.equal(dimensions.documentWidth, dimensions.width, 'Page must fit horizontally');
    assert.equal(dimensions.documentHeight, dimensions.height, 'Page must fit vertically');
    assert(
      dimensions.mainScroll <= dimensions.mainHeight + 1,
      `Main content must not scroll: ${JSON.stringify(dimensions)}`
    );
  };
  const inWindow = async (locator) => {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert(
      box &&
        box.width > 0 &&
        box.height > 0 &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      `Control must be in the viewport: ${JSON.stringify(box)}`
    );
  };
  const checkComposer = async (editor, settled = true) => {
    const saved = settled
      ? editor.getByRole('status', { name: 'Draft synced', exact: true })
      : editor.locator('.draft-status');
    await saved.waitFor();
    const saveBox = await saved.boundingBox();
    const send = editor.locator('button[type="submit"]');
    const sendBox = await send.boundingBox();
    assert(saveBox && sendBox);
    assert(
      Math.abs(saveBox.y + saveBox.height / 2 - sendBox.y - sendBox.height / 2) < 2,
      'Draft status must share the send row, without a separate footer'
    );
    await inWindow(send);
    const bounds = await editor.locator('.intent-toolbar button').evaluateAll((buttons) =>
      buttons
        .filter((button) => button.getClientRects().length)
        .map((button) => {
          const box = button.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        })
    );
    assert(bounds.length > 0);
    const editorBox = await editor.boundingBox();
    assert(editorBox);
    for (const box of bounds) {
      assert(
        box.left >= editorBox.x && box.right <= editorBox.x + editorBox.width,
        'Composer controls must fit inside the card'
      );
    }
    for (let i = 0; i < bounds.length; i++)
      for (let j = i + 1; j < bounds.length; j++) {
        const a = bounds[i],
          b = bounds[j];
        assert(
          a.right <= b.left + 1 ||
            b.right <= a.left + 1 ||
            a.bottom <= b.top + 1 ||
            b.bottom <= a.top + 1,
          'Composer controls must not overlap'
        );
      }
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin);
    await page.locator('.desk-start-card').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const compactPrompt = await page.locator('.desk-start-card').boundingBox();
    const compactProjects = await page.locator('.home-projects').boundingBox();
    assert(compactPrompt && compactProjects);
    bootstrap.usage = {
      ...originalUsage,
      plan: {
        provider: 'openrouter',
        windows: Array.from({ length: 8 }, (_, index) => ({
          connection: `Connected provider ${index + 1}`,
          label: 'Credit balance',
          used: index,
          limit: 20,
          unit: 'usd',
          resetsAt: null
        })),
        queriedAt: new Date().toISOString()
      }
    };
    await page.reload();
    const readouts = page.getByRole('region', { name: 'Computer readouts', exact: true });
    await readouts.getByText('Connected provider 8 · Balance', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(
      await page.locator('.desk-start-card').boundingBox(),
      compactPrompt,
      'Adding provider readouts must not enlarge or move the home prompt'
    );
    assert.deepEqual(
      await page.locator('.home-projects').boundingBox(),
      compactProjects,
      'Provider readouts must not take height away from the projects'
    );
    const machine = await page.locator('.home-machine').boundingBox();
    assert(machine && Math.abs(machine.height - compactPrompt.height) < 1);
    await readouts.getByText('Connected provider 1 · Balance', { exact: true }).waitFor();
    await readouts.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const region = document.querySelector('[aria-label="Computer readouts"]');
      return (
        region.scrollTop > 0 && region.scrollHeight - region.clientHeight - region.scrollTop < 2
      );
    });
    const lastReadout = await readouts
      .getByText('Connected provider 8 · Balance', { exact: true })
      .boundingBox();
    const readoutBox = await readouts.boundingBox();
    assert(lastReadout && readoutBox);
    assert(
      lastReadout.y >= readoutBox.y &&
        lastReadout.y + lastReadout.height <= readoutBox.y + readoutBox.height + 1,
      'Every provider remains reachable by keyboard scrolling inside the computer card'
    );
    await page.screenshot({ path: resolve(report, 'desk-provider-readouts.png') });
    await page.locator('.home-machine-title').click();
    await page.locator('.view-computer').waitFor();
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [768, 1024],
      [390, 844],
      [320, 568],
      [844, 390]
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(origin);
      await page.locator('.desk-home').waitFor();
      await fit();
      const headerButtons = await page.locator('.garden-masthead button').evaluateAll((elements) =>
        elements
          .filter((element) => element.getClientRects().length)
          .map((element) => {
            const r = element.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          })
      );
      assert(headerButtons.length > 0);
      for (const bounds of headerButtons)
        assert(
          bounds.left >= 0 && bounds.right <= width,
          'Every header control must fit on screen'
        );
      for (let i = 0; i < headerButtons.length; i++)
        for (let j = i + 1; j < headerButtons.length; j++) {
          const a = headerButtons[i],
            b = headerButtons[j];
          assert(
            a.right <= b.left + 1 ||
              b.right <= a.left + 1 ||
              a.bottom <= b.top + 1 ||
              b.bottom <= a.top + 1,
            'Header buttons must not overlap'
          );
        }
      if (width > 760 && height > 540) {
        const prompt = await page.locator('.desk-start-card').boundingBox();
        const editor = await page.locator('.desk-start-card .intent-editor').boundingBox();
        const lists = await page.locator('.home-projects').boundingBox();
        assert(prompt && editor && lists);
        assert(prompt.height <= editor.height + 20, 'The prompt card must fit its contents');
        assert(prompt.y + prompt.height <= lists.y, 'The lists sit under the prompt');
        assert(
          lists.y + lists.height <= height + 1,
          'The lists take the height that is left and no more'
        );
      }
      await page.getByLabel('Describe what you want to do').fill('A useful new project');
      await checkComposer(page.locator('.desk-start-card .intent-editor'));
      const promptBox = await page.locator('.desk-start-card').boundingBox();
      const promptForm = await page.locator('.desk-start-card .intent-editor').boundingBox();
      assert(promptBox && promptForm);
      assert(
        promptBox.height <= promptForm.height + 20,
        'The prompt must not stretch into an empty card'
      );
      await page.screenshot({ path: resolve(report, `desk-prompt-${width}-${height}.png`) });
      // Home never scrolls as a page: each list scrolls inside its own card.
      if (width <= 700)
        await page
          .getByRole('navigation', { name: 'Home lists' })
          .getByRole('button', { name: 'Projects', exact: true })
          .click();
      const recent = page.locator('.desk-recent .scroll-region');
      assert(await recent.evaluate((element) => element.scrollHeight > element.clientHeight));
      await recent.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      assert(await recent.evaluate((element) => element.scrollTop > 0));
      await fit();
      await page.screenshot({ path: resolve(report, `desk-home-${width}-${height}.png`) });
      await page.goto(`${origin}/?task=${task.id}`);
      // The reply box is always there: no click stands between a result and the next message.
      const composer = page.locator('.garden-task-composer textarea');
      await composer.waitFor();
      await page.locator('.garden-outputs').waitFor();
      assert.equal(
        await page.getByRole('navigation', { name: 'Output views' }).count(),
        0,
        'The result, its preview and its files share one view'
      );
      await fit();
      await inWindow(composer);
      if (width >= 960 && height >= 540) {
        const files = page.getByRole('region', { name: 'Project file shortcuts' });
        await files.getByText('sample-69.fastq.gz', { exact: true }).waitFor();
        assert(await files.evaluate((element) => element.scrollHeight > element.clientHeight));
        const before = await composer.boundingBox();
        await files.focus();
        await page.keyboard.press('End');
        await page.waitForFunction(
          () => document.querySelector('[aria-label="Project file shortcuts"]').scrollTop > 0
        );
        assert.deepEqual(
          await composer.boundingBox(),
          before,
          'Scrolling files must not move the prompt'
        );
        // A conversation's own runs sit in its flow, a few rows and then one line for the rest.
        const runs = page.locator('.conversation-runs');
        await runs.waitFor();
        assert((await runs.locator('.run-row').count()) <= 4);
      }
      await page
        .frameLocator('.garden-preview-frame')
        .getByRole('button', { name: '0', exact: true })
        .click();
      await inWindow(page.locator('.garden-preview-frame'));
      await page
        .getByText('The maze is ready to open. Use the arrow keys to play.', { exact: true })
        .waitFor();
      await page.getByRole('link', { name: 'Download', exact: true }).waitFor();
      await page
        .frameLocator('.garden-preview-frame')
        .getByRole('button', { name: '1', exact: true })
        .waitFor();
      await page.screenshot({ path: resolve(report, `desk-project-${width}-${height}.png`) });
      await composer.click();
      const draft = composer;
      await draft.fill('Keep this direction while I inspect my work.');
      await checkComposer(page.locator('.garden-task-composer .intent-editor'));
      await page.screenshot({ path: resolve(report, `desk-composer-${width}-${height}.png`) });
      await inWindow(draft);
      const inputBox = await draft.boundingBox();
      const controlsBox = await page.locator('.garden-task-composer .intent-toolbar').boundingBox();
      assert(inputBox && controlsBox);
      assert(
        inputBox.y + inputBox.height <= controlsBox.y + 1,
        'Prompt controls must be outside the text area'
      );
      const workUrl = page.url();
      // Settings opens over the project and closing it puts the project back exactly.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settingsPage = page.getByRole(width <= 700 ? 'region' : 'dialog', {
        name: 'Settings',
        exact: true
      });
      await settingsPage.waitFor();
      await inWindow(settingsPage);
      await settingsPage
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Knowledge', exact: true })
        .click();
      await settingsPage
        .getByRole('button', {
          name: width <= 700 ? 'Back from Settings' : 'Close Settings',
          exact: true
        })
        .click();
      await settingsPage.waitFor({ state: 'detached' });
      assert.equal(page.url(), workUrl, 'Closing a panel must restore the exact project location');
      await page.keyboard.press('Escape');
      await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
      assert.equal(await draft.inputValue(), 'Keep this direction while I inspect my work.');
      await page
        .frameLocator('.garden-preview-frame')
        .getByRole('button', { name: '1', exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await settingsPage.waitFor();
      await page.goBack();
      await settingsPage.waitFor({ state: 'detached' });
      await page.goForward();
      await settingsPage.waitFor();
      await page.keyboard.press('Escape');
      await settingsPage.waitFor({ state: 'detached' });

      if (width === 390) {
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', {
            configurable: true,
            value: 350
          });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(
          () => document.querySelector('.desk-shell').getBoundingClientRect().height === 350
        );
        const send = page
          .locator('.garden-task-composer')
          .getByRole('button', { name: 'Send', exact: true });
        await send.scrollIntoViewIfNeeded();
        const sendBox = await send.boundingBox();
        assert(
          sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 350,
          'Send must stay above the keyboard'
        );
        await page.screenshot({ path: resolve(report, 'desk-keyboard.png') });
        await page.getByRole('button', { name: 'Work options', exact: true }).click();
        const dialogBox = await page
          .getByRole('dialog', { name: 'Work options', exact: true })
          .boundingBox();
        assert(
          dialogBox && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 350,
          'Dialogs must stay above the keyboard'
        );
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await fit();
      }
      const settings = page.getByRole('button', { name: 'Prompt settings', exact: true });
      await settings.click();
      await page
        .getByRole('combobox', { name: 'Approvals for this prompt', exact: true })
        .waitFor();
      await settings.click();
      await fit();
      const views = page.locator(
        'body:has(.project-panel[open]:not(.is-docked)) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open]:not(.is-docked))) .project-workspace-bar .project-view-nav'
      );
      for (const view of ['Files', 'Activity', 'Tools']) {
        await views.getByRole('button', { name: view, exact: true }).click();
        await fit();
      }
      await page.keyboard.press('Escape');
      await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
      assert.equal(await draft.inputValue(), 'Keep this direction while I inspect my work.');
      const voice = page.getByRole('button', { name: 'Live voice', exact: true });
      await inWindow(voice);
      await voice.click();
      const voiceDialog = page.getByRole('dialog', { name: 'Live voice', exact: true });
      const contextChoice = voiceDialog.getByRole('checkbox', {
        name: /Include this conversation and save discussion notes/
      });
      await contextChoice.waitFor();
      assert.equal(await contextChoice.isChecked(), false);
      assert((await voiceDialog.innerText()).includes(task.title));
      await inWindow(voiceDialog);
      if (width === 390 || width === 1440)
        await voiceDialog.screenshot({ path: resolve(report, `desk-voice-${width}.png`) });
      await page.keyboard.press('Escape');
      await voiceDialog.waitFor({ state: 'detached' });
      const clearedDraft = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/drafts' &&
          response.request().method() !== 'GET' &&
          response.request().postDataJSON()?.body === ''
      );
      await draft.fill('');
      await clearedDraft;
      await page
        .locator('.garden-task-composer .intent-editor')
        .getByRole('status', { name: 'Draft synced', exact: true })
        .waitFor();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin);
    await page.getByRole('button', { name: 'All projects', exact: true }).click();
    await page.getByRole('dialog', { name: 'Projects', exact: true }).waitFor();
    assert.equal(await page.locator('.garden-sidebar').count(), 0);
    await page.locator('.desk-project-index').waitFor();
    await fit();
    await page.screenshot({ path: resolve(report, 'desk-projects-panel.png') });
    for (const view of ['settings', 'library', 'automations', 'attention', 'computer']) {
      await page.goto(`${origin}/?view=${view}`);
      await page
        .locator(
          '.desk-sheet .management-page, .desk-sheet-attention .section-intro, .garden-main > section:not([hidden])'
        )
        .first()
        .waitFor();
      await fit();
      if (view === 'computer') {
        await page.locator('.computer-runs').waitFor();
        await page.getByRole('heading', { name: 'Scheduled', exact: true }).waitFor();
        await page.screenshot({ path: resolve(report, 'desk-computer-runs-1440.png') });
        await page
          .getByRole('heading', { name: 'Scheduled', exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(report, 'desk-computer-runs-lower.png') });
      }
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`${origin}/?task=${task.id}`);
    const sendingEditor = page.locator('.garden-task-composer .intent-editor');
    await sendingEditor
      .locator('textarea')
      .fill('Keep this draft if the send needs to be retried.');
    await checkComposer(sendingEditor);
    let releaseSend;
    const heldSend = new Promise((resolve) => {
      releaseSend = resolve;
    });
    const routePath = `**/v1/tasks/${task.id}/messages`;
    const hold = async (route) => {
      await heldSend;
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Send temporarily unavailable' } }
      });
    };
    await page.route(routePath, hold);
    try {
      await sendingEditor.getByRole('button', { name: 'Send', exact: true }).click();
      const sending = sendingEditor.getByRole('button', { name: 'Sending…', exact: true });
      await sending.waitFor();
      assert(await sending.isDisabled());
      await checkComposer(sendingEditor, false);
      await page.screenshot({ path: resolve(report, 'desk-sending-phone.png') });
      releaseSend();
      const retry = sendingEditor.getByRole('button', { name: 'Retry send', exact: true });
      await retry.waitFor();
      await retry.scrollIntoViewIfNeeded();
      await checkComposer(sendingEditor, false);
      assert.equal(
        await sendingEditor.locator('textarea').inputValue(),
        'Keep this draft if the send needs to be retried.'
      );
      await page.screenshot({ path: resolve(report, 'desk-retry-phone.png') });
    } finally {
      releaseSend();
      await page.unroute(routePath, hold);
    }
    // Leave this conversation as later checks expect to find it: no held send and no draft.
    await sendingEditor
      .getByRole('button', { name: 'Keep as an unsent draft', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Keep as an unsent draft', exact: true })
      .getByRole('button', { name: 'Keep as an unsent draft', exact: true })
      .click();
    await sendingEditor.locator('textarea').fill('');
    await sendingEditor.getByRole('status', { name: 'Draft synced', exact: true }).waitFor();
    await page.goto(origin);
    const homePrompt = page.getByLabel('Describe what you want to do');
    const cleared = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/drafts' &&
        response.request().method() !== 'GET' &&
        response.request().postDataJSON()?.body === ''
    );
    await homePrompt.fill('');
    await cleared;
    await writeFile(
      resolve(report, 'desk-errors.json'),
      JSON.stringify({ pageErrors, failedRequests }, null, 2) + '\n'
    );
    assert.deepEqual(failures, []);
    console.log(
      'Desk passed: fixed viewport, independent file/process/project scroll, output sections, prompt reachability, retained drafts, conversation, navigation and management views.'
    );
  } catch (error) {
    console.error(error);
    console.error(
      await page
        .locator('body')
        .innerText({ timeout: 3000 })
        .catch(() => '')
    );
    await page.screenshot({ path: resolve(report, 'desk-failure.png') });
    throw error;
  } finally {
    bootstrap.projects = originalProjects;
    bootstrap.usage = originalUsage;
    directoryUi.longList = false;
    processUi.rows = rows;
    await page.close();
  }
}
