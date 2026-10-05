/**
 * Every icon: one leaf, in the wordmark's colour, on the night garden.
 *
 * The word is the mark wherever there is room for a word; where there is only a square - a tab, a
 * dock, a home screen - a single leaf stands for it, drawn in the colour the word is written in at
 * night. Small icons get a little of the leaf's own colour stroked around it so it keeps its shape
 * at tab size. Also writes the wordmark as a file for the screens drawn outside the web client,
 * and then runs the native icon generator over the native sources.
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
const lit = token('--light-a');
const ink = token('--ink');
assert(night && card && ink && lit, 'The mark takes its colours from the night theme');

// The leaf, on a 100-unit square: base low on the left, tip high on the right, a vein down its
// middle and a short stem. The vein is cut out of the leaf so it shows whatever is behind it.
const LEAF = 'M27 81C21 55 39 27 79 16C83 48 63 77 27 81Z';
const VEIN = 'M33 75C44 62 55 48 66 31';
const STEM = 'M28 80C25 84 22 86.5 18 88.5';
const outline = await readFile(root + 'apps/web/src/app/wordmark-outline.ts', 'utf8');
const field = (name) => outline.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1];
const [viewBox, word, tendril, cut] = ['viewBox', 'word', 'tendril', 'cut'].map(field);
assert(viewBox && word && tendril && cut, 'The wordmark outline must carry the whole word');

const runner = createRequire(new URL('../services/workspace-runner/package.json', import.meta.url));
const { chromium } = runner('playwright-core');
const browser = await chromium.launch({ headless: true });

/**
 * One rendering of the mark. `inset` is the share of the canvas left around the tile, `radius` the
 * tile's corner as a share of the tile, `scale` the letter's height as a share of the tile.
 */
async function render(
  size,
  { color = ink, tile = true, inset = 0, radius = 0, scale = 0.72, weight = 0 } = {}
) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  try {
    const box = size * (1 - 2 * inset);
    await page.setContent(`<!doctype html><style>
      html, body { margin: 0; background: transparent; }
      .tile { position: absolute; left: ${size * inset}px; top: ${size * inset}px; width: ${box}px; height: ${box}px;
        border-radius: ${box * radius}px; display: grid; place-items: center; overflow: hidden;
        background: ${tile ? `radial-gradient(120% 95% at 28% 12%, color-mix(in srgb, ${lit} 62%, ${card}), ${card} 52%, ${night} 88%)` : 'transparent'}; }
      svg { height: ${box * scale}px; width: auto; overflow: visible; }
    </style><div class="tile"><svg viewBox="8 8 84 84"><defs><mask id="vein" maskUnits="userSpaceOnUse">
      <rect x="0" y="0" width="100" height="100" fill="#fff"/><path d="${VEIN}" fill="none" stroke="#000"
      stroke-width="${2.2 + weight / 2}" stroke-linecap="round"/></mask></defs>
      <path d="${LEAF}" fill="${color}" stroke="${color}" stroke-width="${weight}" stroke-linejoin="round" mask="url(#vein)"/>
      <path d="${STEM}" fill="none" stroke="${color}" stroke-width="${4.2 + weight}" stroke-linecap="round"/>
      </svg></div>`);
    return await page.screenshot({ omitBackground: true, type: 'png' });
  } finally {
    await page.close();
  }
}

const write = (path, bytes) => writeFile(root + path, bytes);
try {
  // Installed web icons fill their square; the system rounds them. The maskable one keeps the
  // leaf inside the safe circle, and the favicon is a rounded tile small enough for a tab.
  await write('apps/web/public/brand/garden-icon-192.png', await render(192, { weight: 1 }));
  await write('apps/web/public/brand/garden-icon-512.png', await render(512));
  await write('apps/web/public/brand/garden-maskable-512.png', await render(512, { scale: 0.56 }));
  await write('apps/web/public/brand/garden-apple-touch.png', await render(180, { weight: 1 }));
  await write(
    'apps/web/public/brand/garden-favicon.png',
    await render(64, { radius: 0.24, scale: 0.8, weight: 3 })
  );
  // A desktop icon sits on the platform's grid: a rounded tile inset from the canvas edge.
  await write(
    'apps/desktop/src-tauri/icons/garden-logo.png',
    await render(1024, { inset: 0.098, radius: 0.225 })
  );
  await write(
    'apps/desktop/src-tauri/icons/garden-monochrome.png',
    await render(1024, { color: '#ffffff', tile: false, scale: 0.66 })
  );
} finally {
  await browser.close();
}
// The word itself, for screens drawn outside the web client: one colour, used there as a mask so
// it takes whatever colour the screen's text is.
await write(
  'apps/web/public/brand/garden-wordmark.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><clipPath id="c"><path clip-rule="evenodd" d="${cut}"/></clipPath><path clip-path="url(#c)" d="${word}"/><path d="${tendril}"/></svg>\n`
);
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
