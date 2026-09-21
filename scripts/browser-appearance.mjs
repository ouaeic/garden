import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkAppearance({ context, origin, bootstrap, project, task, report }) {
  const page = await context.newPage();
  const titles = [
    'Protein sequence analysis',
    'A place for weekend plans',
    'Interactive garden journal',
    'Research notes'
  ];
  await page.route('**/v1/bootstrap', (route) =>
    route.fulfill({
      json: {
        ...bootstrap,
        projects: titles.map((title, index) => ({
          ...project,
          id: index ? `appearance-${index}` : project.id,
          title,
          activeCount: index === 0 ? 1 : 0,
          conversationCount: index + 1,
          attentionCount: 0
        }))
      }
    })
  );
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Where shall we begin?' }).waitFor();
  await page.locator('.intent-editor textarea').waitFor();
  const options = page.locator('.garden-prompt-options');
  assert.equal(
    await page.getByRole('combobox', { name: 'Approvals for this prompt' }).isVisible(),
    true
  );
  assert.equal(
    await page.getByRole('combobox', { name: 'Model reasoning effort' }).isVisible(),
    false
  );
  await options.locator('summary').click();
  await page.getByRole('spinbutton', { name: 'Task spend limit in USD' }).fill('2.50');
  await options.locator('summary').click();
  await options.locator('summary').click();
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Task spend limit in USD' }).inputValue(),
    '2.50'
  );
  await options.locator('summary').click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
      await page.screenshot({
        animations: 'disabled',
        path: resolve(report, `home-${theme}-${width}.png`)
      });
      const geometry = await page.evaluate(() => {
        const text = document.querySelector('.intent-editor textarea').getBoundingClientRect();
        const actions = document.querySelector('.intent-toolbar').getBoundingClientRect();
        return {
          width: innerWidth,
          actual: document.documentElement.scrollWidth,
          separated: text.bottom <= actions.top,
          mainOverflow:
            document.querySelector('.garden-main').scrollWidth >
            document.querySelector('.garden-main').clientWidth
        };
      });
      assert.equal(geometry.actual, geometry.width, 'Appearance must fit the viewport');
      assert.equal(geometry.mainOverflow, false, 'Work must not overflow sideways');
      assert.equal(geometry.separated, true, 'Send controls stay below the prompt');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => {
    const animations = document
      .querySelector('.garden-living-field')
      .getAnimations({ subtree: true });
    return (
      animations.length > 0 && animations.every((animation) => animation.playState === 'running')
    );
  });
  // Let viewport changes and pending draft feedback settle before sampling ambient cost.
  await page.waitForTimeout(1200);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const before = await cdp.send('Performance.getMetrics');
  await page.waitForTimeout(1200);
  const after = await cdp.send('Performance.getMetrics');
  const metric = (result, name) => result.metrics.find((item) => item.name === name).value;
  assert.equal(
    metric(after, 'LayoutCount') - metric(before, 'LayoutCount'),
    0,
    'Ambient movement must not cause continuous layout'
  );
  console.log('Ambient motion sample:', {
    scriptSeconds: metric(after, 'ScriptDuration') - metric(before, 'ScriptDuration'),
    layoutCount: 0
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => {
    const animations = document
      .querySelector('.garden-living-field')
      .getAnimations({ subtree: true });
    return (
      animations.length > 0 && animations.every((animation) => animation.playState === 'paused')
    );
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (await page.getByRole('button', { name: 'Show projects', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Show projects', exact: true }).click();
  await page.getByRole('button', { name: 'Pause background motion', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume background motion', exact: true }).waitFor();
  assert.equal(
    await page.locator('.garden-living-field').evaluate((element) => {
      const animations = element.getAnimations({ subtree: true });
      return (
        animations.length > 0 && animations.every((animation) => animation.playState === 'paused')
      );
    }),
    true
  );
  await page.getByRole('button', { name: 'Resume background motion', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 500 });
  await page.locator('.garden-main').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(
    () => document.querySelector('.garden-living-field').dataset.moving === 'false'
  );
  await page.goto(`${origin}/?task=${task.id}`);
  await page.locator('.garden-task-composer').waitFor();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
      await page.screenshot({
        animations: 'disabled',
        path: resolve(report, `conversation-${theme}-${width}.png`)
      });
    }
  }
  await page.close();
}
