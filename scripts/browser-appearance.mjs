import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checkInterfaceTexture, checkOutputAppearance } from './browser-output-appearance.mjs';

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
            windows: [
              {
                connection: 'OpenRouter',
                label: 'Credit balance',
                used: 3,
                limit: 20,
                unit: 'usd',
                resetsAt: null
              },
              {
                connection: 'Ollama Cloud',
                label: 'Session',
                used: 0.25,
                limit: 1,
                unit: 'fraction',
                resetsAt: null
              },
              {
                connection: 'Ollama Cloud',
                label: 'Weekly',
                used: 0.6,
                limit: 1,
                unit: 'fraction',
                resetsAt: null
              },
              {
                connection: 'Another provider',
                label: 'Credit balance',
                used: null,
                limit: null,
                remaining: 8,
                unit: 'usd',
                resetsAt: null
              },
              {
                connection: 'Unavailable provider',
                label: 'Credit balance',
                used: null,
                limit: null,
                unit: 'usd',
                resetsAt: null
              }
            ],
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
  await page.locator('.desk-start-card').waitFor();
  const computerReadout = page.locator('.home-machine-readout');
  for (const label of [
    'OpenRouter · Balance',
    'Ollama Cloud · Session',
    'Ollama Cloud · Week',
    'Another provider · Balance',
    'Unavailable provider · Balance'
  ])
    await computerReadout.getByText(label, { exact: true }).waitFor();
  for (const text of ['$17.00 left', '25% used', '60% used', '$8.00 left', 'Unavailable'])
    await computerReadout.getByText(text, { exact: true }).waitFor();
  await page.locator('.intent-editor textarea').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Pixel Operator"')), true);
  const stats = page.getByRole('button', { name: 'Stats', exact: true });
  const statsPanel = page.getByRole('region', { name: 'Usage statistics', exact: true });
  await stats.hover();
  await statsPanel.waitFor();
  await statsPanel.getByRole('heading', { name: 'Limits & credits', exact: true }).waitFor();
  await statsPanel.getByText('CPU 17%', { exact: true }).hover();
  assert.equal(await stats.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: resolve(report, 'stats-desktop.png') });
  await page.locator('.desk-start-card').hover();
  await statsPanel.waitFor({ state: 'hidden' });
  await stats.focus();
  await page.keyboard.press('Enter');
  await statsPanel.waitFor();
  await page.keyboard.press('Escape');
  await statsPanel.waitFor({ state: 'hidden' });
  await stats.click();
  await page.locator('.home-projects .desk-card-heading').click({ position: { x: 4, y: 4 } });
  await statsPanel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Prompt settings', exact: true }).click();
  const promptSettings = page.getByRole('dialog', { name: 'Prompt settings', exact: true });
  await promptSettings.waitFor();
  assert.equal(
    await page.getByRole('combobox', { name: 'Model reasoning effort' }).isVisible(),
    true
  );
  await page.getByRole('spinbutton', { name: 'Task spend limit in USD' }).fill('2.50');
  await page.keyboard.press('Escape');
  await promptSettings.waitFor({ state: 'hidden' });
  assert(
    await page
      .getByRole('button', { name: 'Prompt settings', exact: true })
      .evaluate((element) => element === document.activeElement),
    'Escape returns focus to prompt settings'
  );
  await page.getByRole('button', { name: 'Prompt settings', exact: true }).click();
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Task spend limit in USD' }).inputValue(),
    '2.50'
  );
  await page.getByRole('button', { name: 'Close prompt settings', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const wordmark = await page.locator('.garden-masthead .garden-wordmark').evaluate((element) => {
      const style = getComputedStyle(element);
      return { ink: style.backgroundColor, text: style.color, image: style.maskImage };
    });
    assert.equal(wordmark.ink, wordmark.text, 'The wordmark follows the theme text colour');
    assert.match(
      wordmark.image,
      /data:image\/svg\+xml/,
      'The wordmark travels with the cached shell'
    );
    const navigation = page.locator('.desk-navigation button');
    assert((await navigation.count()) > 0, 'Exercise primary navigation interaction states');
    for (const button of await navigation.all()) {
      await button.hover();
      await checkInterfaceTexture(page);
      // Navigation sits on the case, not the screen: lit when hovered, with no matrix of its own.
      const hovered = await button.evaluate((element) => {
        const style = getComputedStyle(element);
        return { image: style.backgroundImage, color: style.backgroundColor };
      });
      assert.equal(hovered.image, 'none', 'Hovered navigation is a case control');
      assert.notEqual(hovered.color, 'rgba(0, 0, 0, 0)', 'Hovered navigation lights up');
    }
    const heading = page.locator('.home-projects .desk-card-heading h2');
    await heading.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    const selection = await heading.evaluate((element) => ({
      text: getSelection().toString(),
      background: getComputedStyle(element, '::selection').backgroundColor
    }));
    assert(selection.text.length > 0, 'Text is selected');
    assert.match(
      selection.background,
      /(?:\/\s*0\.18|,\s*0\.18)\)/,
      'Selection lets the matrix show through'
    );
    await page.screenshot({ path: resolve(report, `selection-${theme}.png`) });
    await page.evaluate(() => getSelection().removeAllRanges());
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
      if (width === 1440) {
        const readouts = await page
          .locator('.meter-provider > span, .meter-provider > small')
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              text: node.textContent,
              fits: node.scrollWidth <= node.clientWidth
            }))
          );
        assert(readouts.length > 0, 'The computer card must include provider readouts');
        assert(
          readouts.every((readout) => readout.fits),
          `Provider names and usage values must remain readable: ${JSON.stringify(readouts)}`
        );
      }
      assert.equal(geometry.separated, true, 'Send controls stay below the prompt');
      const composerBefore = await page.locator('.intent-editor').boundingBox();
      await page.getByRole('button', { name: 'Prompt settings', exact: true }).click();
      await promptSettings.waitFor();
      const panel = await promptSettings.boundingBox();
      assert(
        panel &&
          panel.x >= 0 &&
          panel.y >= 0 &&
          panel.x + panel.width <= width &&
          panel.y + panel.height <= (width > 760 ? 1000 : 844),
        'Prompt settings fit the viewport'
      );
      assert.deepEqual(
        await page.locator('.intent-editor').boundingBox(),
        composerBefore,
        'Settings must not resize or move the prompt'
      );
      await checkInterfaceTexture(page);
      await page.screenshot({ path: resolve(report, `prompt-settings-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const screen of ['field', 'amber']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.palette = value;
    }, screen);
    const palette = [];
    for (const mode of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, mode);
      palette.push(
        await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const muted = getComputedStyle(
            document.querySelector('.home-row small, .home-quiet')
          ).color;
          const luminance = (color) => {
            const values = color
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number)
              .map((value) => {
                const c = value / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
            return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
          };
          const contrast = (a, b) =>
            (Math.max(luminance(a), luminance(b)) + 0.05) /
            (Math.min(luminance(a), luminance(b)) + 0.05);
          return {
            foreground: root.color,
            background: root.backgroundColor,
            contrast: contrast(root.color, root.backgroundColor),
            secondaryContrast: contrast(muted, root.backgroundColor),
            overlayContent: getComputedStyle(document.body, '::after').content,
            texture: getComputedStyle(document.querySelector('.desk-card')).backgroundImage
          };
        })
      );
    }
    assert.equal(palette[0].foreground, palette[1].background, 'Modes reverse LCD ink and glass');
    assert.equal(palette[0].background, palette[1].foreground, 'Modes reverse LCD glass and ink');
    for (const colors of palette) {
      assert(colors.contrast >= 4.5, 'Body text must meet normal-text contrast');
      assert(colors.secondaryContrast >= 4.5, 'Secondary text must meet normal-text contrast');
      if (screen === 'amber') {
        for (const ink of [colors.foreground, colors.background]) {
          const [red, green, blue] = ink
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
          assert(red > green && green > blue, 'The warm screen uses amber and brown tones');
        }
      }
      assert.equal(
        colors.overlayContent,
        'none',
        'Screen texture must not overlay delivered content'
      );
      assert.match(
        colors.texture,
        /repeating-linear-gradient/,
        'Garden cards retain the LCD matrix'
      );
    }
    console.log('LCD contrast:', palette);
  }
  await page.evaluate(() => delete document.documentElement.dataset.palette);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    await page.reload();
    await page.getByRole('combobox', { name: 'Theme', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('combobox', { name: 'Theme', exact: true }).inputValue(),
      theme
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
      await checkInterfaceTexture(page);
      await page.screenshot({ path: resolve(report, `settings-${theme}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    }
  }
  await page.getByRole('radio', { name: 'Warm amber (low blue light)', exact: true }).check();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
    await page.reload();
    const amber = page.getByRole('radio', { name: 'Warm amber (low blue light)', exact: true });
    await amber.waitFor();
    assert(await amber.isChecked(), 'The warm palette survives reloads');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), 'amber');
    const chrome = await page.evaluate(() => {
      const paint = (value) => {
        const probe = document.createElement('i');
        probe.style.background = value;
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return colour;
      };
      return {
        case: getComputedStyle(document.body).backgroundColor,
        mobile: paint(document.querySelector('meta[name="theme-color"]').content),
        lit: paint('var(--s0)'),
        logo: getComputedStyle(document.querySelector('.garden-wordmark')).backgroundColor
      };
    });
    assert.equal(chrome.mobile, chrome.case, 'Mobile chrome continues the case');
    assert.equal(chrome.logo, chrome.lit, 'The wordmark is printed in the warm screen’s lit shade');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width > 760 ? 1000 : 844 });
      await checkInterfaceTexture(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: resolve(report, `settings-amber-${theme}-${width}.png`) });
    }
  }
  await page.goto(origin);
  await page.locator('.desk-home').waitFor();
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto(`${origin}/?task=${task.id}`);
  await page.locator('.garden-task-composer textarea').waitFor();
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
      await page.getByRole('button', { name: 'Prompt settings', exact: true }).click();
      await page.getByRole('dialog', { name: 'Prompt settings', exact: true }).waitFor();
      await checkInterfaceTexture(page);
      await page.screenshot({
        path: resolve(report, `conversation-settings-${theme}-${width}.png`)
      });
      await page.keyboard.press('Escape');
    }
  }
  await page.close();
  const fallback = await context.newPage();
  await fallback.addInitScript(() => {
    delete HTMLElement.prototype.showPopover;
  });
  await fallback.goto(origin);
  await fallback.getByRole('button', { name: 'Prompt settings', exact: true }).click();
  const fallbackDialog = fallback.getByRole('dialog', { name: 'Prompt settings', exact: true });
  await fallbackDialog.waitFor();
  await fallbackDialog.getByRole('spinbutton', { name: 'Task spend limit in USD' }).fill('3.00');
  await fallback.keyboard.press('Escape');
  await fallbackDialog.waitFor({ state: 'hidden' });
  await fallback.getByRole('button', { name: 'Prompt settings', exact: true }).click();
  assert.equal(
    await fallbackDialog.getByRole('spinbutton', { name: 'Task spend limit in USD' }).inputValue(),
    '3.00',
    'Older webviews retain prompt controls without native popovers'
  );
  await fallback.close();
  await checkOutputAppearance({ context, origin, task, report });
}
