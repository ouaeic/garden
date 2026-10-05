/**
 * The mark and every icon made from it: the word's own italic "g", in leaf on the night garden.
 *
 * Rendered by a real browser from the bundled Fraunces with the axes the interface sets on the
 * word, so the icon and the header are one letterform. Writes the web icons, the native sources,
 * and then runs the native icon generator over them.
 *
 *   node scripts/build-brand.mjs
 */
import assert from 'node:assert/strict';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tokens = await readFile(root + 'apps/web/src/styles/foundation.css', 'utf8');
const token = (name) => tokens.match(new RegExp(`${name}:\\s*(#[\\da-f]{6});`, 'i'))?.[1];
const night = token('--bg');
const card = token('--card');
const leaf = token('--leaf');
assert(night && card && leaf, 'The mark takes its colours from the night theme');
const font = (await readFile(root + 'apps/web/public/fonts/Fraunces-Italic.woff2')).toString(
  'base64'
);

const runner = createRequire(new URL('../services/workspace-runner/package.json', import.meta.url));
const { chromium } = runner('playwright-core');
const browser = await chromium.launch({ headless: true });

/**
 * One rendering of the mark. `inset` is the share of the canvas left around the tile, `radius` the
 * tile's corner as a share of the tile, `scale` the letter's height as a share of the tile.
 */
async function render(size, { ink = leaf, tile = true, inset = 0, radius = 0, scale = 0.78 } = {}) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  try {
    const box = size * (1 - 2 * inset);
    await page.setContent(`<!doctype html><style>
      @font-face { font-family: Mark; src: url(data:font/woff2;base64,${font}) format('woff2'); font-style: italic; font-weight: 100 900; }
      html, body { margin: 0; background: transparent; }
      .tile { position: absolute; left: ${size * inset}px; top: ${size * inset}px; width: ${box}px; height: ${box}px;
        border-radius: ${box * radius}px; display: grid; place-items: center; overflow: hidden;
        background: ${tile ? `radial-gradient(120% 90% at 30% 15%, ${card}, ${night} 70%)` : 'transparent'}; }
      .g { font: italic 520 ${box * scale}px/1 Mark; color: ${ink}; letter-spacing: 0;
        font-variation-settings: 'SOFT' 100, 'opsz' 144; transform: translateY(-${box * 0.2}px); }
    </style><div class="tile"><span class="g">g</span></div>`);
    await page.evaluate(() => document.fonts.ready);
    assert.ok(
      await page.evaluate(() => document.fonts.check(`italic 520 40px Mark`)),
      'The bundled Fraunces must load'
    );
    return await page.screenshot({ omitBackground: true, type: 'png' });
  } finally {
    await page.close();
  }
}

const write = (path, bytes) => writeFile(root + path, bytes);
try {
  // Installed web icons fill their square; the system rounds them. The maskable one keeps the
  // letter inside the safe circle, and the favicon is a rounded tile small enough for a tab.
  await write('apps/web/public/brand/garden-icon-192.png', await render(192));
  await write('apps/web/public/brand/garden-icon-512.png', await render(512));
  await write('apps/web/public/brand/garden-maskable-512.png', await render(512, { scale: 0.6 }));
  await write('apps/web/public/brand/garden-apple-touch.png', await render(180));
  await write('apps/web/public/brand/garden-favicon.png', await render(64, { radius: 0.24 }));
  // A desktop icon sits on the platform's grid: a rounded tile inset from the canvas edge.
  await write(
    'apps/desktop/src-tauri/icons/garden-logo.png',
    await render(1024, { inset: 0.098, radius: 0.225 })
  );
  await write(
    'apps/desktop/src-tauri/icons/garden-monochrome.png',
    await render(1024, { ink: '#ffffff', tile: false, scale: 0.7 })
  );
} finally {
  await browser.close();
}
await write(
  'apps/desktop/src-tauri/icons/garden-android-background.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><rect width="108" height="108" fill="${night}"/></svg>\n`
);
const config = root + 'apps/desktop/src-tauri/icons/garden-icon.json';
await write(
  'apps/desktop/src-tauri/icons/garden-icon.json',
  JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), bg_color: night }, null, 2) + '\n'
);

const generated = spawnSync(
  'pnpm',
  [
    '--filter',
    '@garden/desktop',
    'exec',
    'tauri',
    'icon',
    'src-tauri/icons/garden-icon.json',
    '--output',
    'src-tauri/icons'
  ],
  { cwd: root, stdio: 'inherit' }
);
assert.equal(generated.status, 0, 'Native icon export must succeed');
// Tauri writes mobile icons directly into initialized native projects. Keep the source copies
// alongside the desktop exports, without copying unrelated native resources.
for (const [source, target] of [
  ['icons/android', 'gen/android/app/src/main/res'],
  ['icons/ios', 'gen/apple/Assets.xcassets/AppIcon.appiconset']
]) {
  const directory = root + 'apps/desktop/src-tauri/';
  const files = (await readdir(directory + source, { recursive: true })).filter((file) =>
    /\.(png|xml)$/.test(file)
  );
  assert(files.length > 0, `${source} must contain platform icons`);
  for (const file of files) {
    if (source === 'icons/ios' && file.endsWith('.png')) {
      const output = directory + target + '/' + file;
      const opaque = spawnSync('magick', [output, '-alpha', 'off', 'PNG24:' + output], {
        stdio: 'inherit'
      });
      assert.equal(opaque.status, 0, `${file} must export without an alpha channel`);
    }
    await copyFile(directory + target + '/' + file, directory + source + '/' + file);
  }
}
