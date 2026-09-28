import assert from 'node:assert/strict';
import { resolve } from 'node:path';

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
  page.on('pageerror', (error) => failures.push(error.message));
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
        const intro = await page.locator('.desk-home-intro > header').boundingBox();
        assert(prompt && editor && intro);
        assert(prompt.height <= editor.height + 4, 'The prompt card must fit its contents');
        assert(
          Math.abs(prompt.y + prompt.height / 2 - intro.y - intro.height / 2) < 2,
          'The greeting and prompt must align'
        );
      }
      if (width <= 760 || height <= 540) {
        const cards = page.getByRole('navigation', { name: 'Home cards' });
        await cards.getByRole('button', { name: 'New project', exact: true }).click();
      }
      await page.getByLabel('Describe what you want to do').fill('A useful new project');
      await checkComposer(page.locator('.desk-start-card .intent-editor'));
      const promptBox = await page.locator('.desk-start-card').boundingBox();
      const promptForm = await page.locator('.desk-start-card .intent-editor').boundingBox();
      assert(promptBox && promptForm);
      assert(
        promptBox.height <= promptForm.height + 4,
        'The prompt must not stretch into an empty card'
      );
      await page.screenshot({ path: resolve(report, `desk-prompt-${width}-${height}.png`) });
      if (width <= 760 || height <= 540)
        await page
          .getByRole('navigation', { name: 'Home cards' })
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
      const composer = page.getByRole('button', {
        name: 'Continue this conversation…',
        exact: true
      });
      await composer.waitFor();
      await page.locator('.garden-outputs.is-fitted').waitFor();
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
        const processes = page.locator('.desk-processes .scroll-region').first();
        assert(await processes.evaluate((element) => element.scrollHeight > element.clientHeight));
      }
      await page
        .frameLocator('.garden-preview-frame')
        .getByRole('button', { name: '0', exact: true })
        .click();
      await inWindow(page.locator('.garden-preview-frame'));
      const output = page.getByRole('navigation', { name: 'Output views' });
      await output.getByRole('button', { name: 'Summary', exact: true }).click();
      await page
        .getByText('The maze is ready to open. Use the arrow keys to play.', { exact: true })
        .waitFor();
      await output.getByRole('button', { name: 'Downloads', exact: true }).click();
      await page.getByRole('link', { name: 'Download', exact: true }).waitFor();
      await output.getByRole('button', { name: 'Preview', exact: true }).click();
      await page
        .frameLocator('.garden-preview-frame')
        .getByRole('button', { name: '1', exact: true })
        .waitFor();
      await page.screenshot({ path: resolve(report, `desk-project-${width}-${height}.png`) });
      await composer.click();
      const draft = page.locator('.garden-task-composer textarea');
      await draft.fill('Keep this direction while I inspect my work.');
      await checkComposer(page.locator('.garden-task-composer .intent-editor'));
      await page.screenshot({ path: resolve(report, `desk-composer-${width}-${height}.png`) });
      await inWindow(draft);
      const inputBox = await draft.boundingBox();
      const controlsBox = await page.locator('.garden-task-composer .intent-toolbar').boundingBox();
      const collapseBox = await page
        .getByRole('button', { name: 'Collapse composer', exact: true })
        .boundingBox();
      assert(inputBox && controlsBox && collapseBox);
      assert(
        inputBox.y + inputBox.height <= controlsBox.y + 1,
        'Prompt controls must be outside the text area'
      );
      assert(inputBox.y + inputBox.height <= collapseBox.y, 'Collapse must not cover typing');
      const workUrl = page.url();
      const libraryTrigger = page
        .getByRole('navigation', { name: 'Workspace navigation' })
        .getByRole('button', { name: 'Library', exact: true });
      await libraryTrigger.click();
      const library = page.getByRole('dialog', { name: 'Library', exact: true });
      await library.waitFor();
      await inWindow(library);
      await library.getByRole('button', { name: 'Memory', exact: true }).click();
      await library.getByRole('button', { name: 'Skills', exact: true }).click();
      await library.getByRole('button', { name: 'Close Library', exact: true }).click();
      await library.waitFor({ state: 'detached' });
      assert.equal(page.url(), workUrl, 'Closing a panel must restore the exact project location');
      await page.keyboard.press('Escape');
      await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
      assert.equal(await draft.inputValue(), 'Keep this direction while I inspect my work.');
      await page
        .frameLocator('.garden-preview-frame')
        .getByRole('button', { name: '1', exact: true })
        .waitFor();
      await libraryTrigger.click();
      await library.waitFor();
      await page.goBack();
      await library.waitFor({ state: 'detached' });
      await page.goForward();
      await library.waitFor();
      await page.keyboard.press('Escape');
      await library.waitFor({ state: 'detached' });

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
        await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
        const dialogBox = await page
          .getByRole('dialog', { name: 'Conversation', exact: true })
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
        'body:has(.project-panel[open]) .project-panel[open] .project-view-nav, body:not(:has(.project-panel[open])) .project-workspace-bar .project-view-nav'
      );
      for (const view of ['Files', 'Activity', 'Tools']) {
        await views.getByRole('button', { name: view, exact: true }).click();
        await fit();
      }
      await page.keyboard.press('Escape');
      await page.locator('.project-panel[open]').waitFor({ state: 'hidden' });
      assert.equal(await draft.inputValue(), 'Keep this direction while I inspect my work.');
      await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
      await page.getByRole('dialog', { name: 'Conversation', exact: true }).waitFor();
      await page.keyboard.press('Escape');
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
      await draft.fill('');
      await page.waitForTimeout(600);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin);
    await page
      .getByRole('navigation', { name: 'Workspace navigation', exact: true })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
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
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`${origin}/?task=${task.id}`);
    await page.getByRole('button', { name: 'Continue this conversation…', exact: true }).click();
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
    assert.deepEqual(failures, []);
    console.log(
      'Desk passed: fixed viewport, independent file/process/project scroll, output sections, prompt reachability, retained drafts, conversation, navigation and management views.'
    );
  } catch (error) {
    console.error(await page.locator('body').innerText());
    await page.screenshot({ path: resolve(report, 'desk-failure.png') });
    throw error;
  } finally {
    bootstrap.projects = originalProjects;
    directoryUi.longList = false;
    processUi.rows = rows;
    await page.close();
  }
}
