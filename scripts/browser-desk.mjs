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
      if (width <= 760 || height <= 540) {
        const cards = page.getByRole('navigation', { name: 'Home cards' });
        await cards.getByRole('button', { name: 'New project', exact: true }).click();
        await page.getByLabel('Describe what you want to do').fill('A useful new project');
        await inWindow(page.getByRole('button', { name: 'Start', exact: true }));
        await cards.getByRole('button', { name: 'Projects', exact: true }).click();
      }
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
      await inWindow(draft);
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
      const views = page.getByRole('navigation', { name: 'Project views', exact: true });
      for (const view of ['Files', 'Activity', 'Tools', 'Work']) {
        await views.getByRole('button', { name: view, exact: true }).click();
        await fit();
      }
      assert.equal(await draft.inputValue(), 'Keep this direction while I inspect my work.');
      await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
      await page.getByRole('dialog', { name: 'Conversation', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await draft.fill('');
      await page.waitForTimeout(600);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Show projects', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Main navigation', exact: true })
      .getByRole('button', { name: 'Projects', exact: true })
      .click();
    assert.equal(await page.locator('.garden-main').getAttribute('inert'), null);
    await page.locator('.desk-project-index').waitFor();
    await fit();
    for (const view of ['settings', 'library', 'automations', 'attention', 'computer']) {
      await page.goto(`${origin}/?view=${view}`);
      await page
        .locator('.garden-main > .management-page, .garden-main > section:not([hidden])')
        .first()
        .waitFor();
      await fit();
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
