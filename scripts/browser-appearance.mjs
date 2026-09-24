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
        computer: { cpuPercent: 17, memoryUsedBytes: 256, memoryTotalBytes: 1024 },
        usage: {
          ...bootstrap.usage,
          plan: {
            provider: 'openrouter',
            windows: [{ label: 'Credit balance', used: 3, limit: 20, unit: 'usd', resetsAt: null }],
            queriedAt: new Date().toISOString()
          }
        },
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
  await page.getByRole('heading', { name: 'What’s next?' }).waitFor();
  await page.locator('.intent-editor textarea').waitFor();
  const stats = page.getByRole('button', { name: 'Stats', exact: true });
  const statsPanel = page.getByRole('region', { name: 'Usage statistics', exact: true });
  await stats.hover();
  await statsPanel.waitFor();
  await statsPanel.getByRole('heading', { name: 'Limits & credits', exact: true }).waitFor();
  await statsPanel.getByText('CPU 17%', { exact: true }).hover();
  assert.equal(await stats.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: resolve(report, 'stats-desktop.png') });
  await page.getByRole('heading', { name: 'What’s next?' }).hover();
  await statsPanel.waitFor({ state: 'hidden' });
  await stats.focus();
  await page.keyboard.press('Enter');
  await statsPanel.waitFor();
  await page.keyboard.press('Escape');
  await statsPanel.waitFor({ state: 'hidden' });
  await stats.click();
  await page.getByRole('heading', { name: 'What’s next?' }).click();
  await statsPanel.waitFor({ state: 'hidden' });
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
    return animations.filter((animation) => animation.playState === 'running').length === 0;
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (!(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Show projects', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const motion = page.getByRole('checkbox', { name: 'Background motion', exact: true });
  assert.equal(await motion.isChecked(), true);
  await motion.uncheck();
  await page.reload();
  await motion.waitFor();
  assert.equal(await motion.isChecked(), false);
  await page.goto(origin);
  await page.getByRole('heading', { name: 'What’s next?' }).waitFor();
  assert.equal(
    await page.locator('.garden-living-field').evaluate((element) => {
      const animations = element.getAnimations({ subtree: true });
      return (
        animations.length > 0 && animations.every((animation) => animation.playState === 'paused')
      );
    }),
    true
  );
  if (!(await page.getByRole('button', { name: 'Settings', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Show projects', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await motion.check();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
      await page.screenshot({ path: resolve(report, `settings-${theme}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    }
  }
  await page.goto(origin);
  await page.getByRole('heading', { name: 'What’s next?' }).waitFor();
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
