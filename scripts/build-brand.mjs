import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const root = fileURLToPath(new URL('../', import.meta.url));
const palette = await readFile(root + 'apps/web/src/lcd.css', 'utf8');
const light = palette.match(/--s0:\s*(#[\da-f]{6});/i)?.[1];
const dark = palette.match(/--s3:\s*(#[\da-f]{6});/i)?.[1];
assert(light && dark, 'Garden must define both ends of its ink palette');
const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium } = requireRunner('playwright-core');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const save = async (path, data) => {
  const target = root + path;
  if (path.endsWith('.svg')) {
    data = await format(data, { ...(await resolveConfig(target)), parser: 'html' });
  }
  await writeFile(target, data);
};

try {
  for (const name of ['icon', 'wordmark']) {
    const source = await readFile(root + `design/brand/selected-${name}.png`);
    const artwork = await page.evaluate(
      async (uri) => {
        const image = new Image();
        image.src = uri;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        // The selected artwork has one light ink on a dark backdrop. Trace its silhouette so
        // the interface can supply its own ink without carrying the backdrop or a colour filter.
        const ink = (x, y) => {
          const at = (y * image.width + x) * 4;
          return data[at] * 0.2126 + data[at + 1] * 0.7152 + data[at + 2] * 0.0722 > 128;
        };
        const rectangles = [];
        let previous = new Map();
        let left = image.width,
          top = image.height,
          right = 0,
          bottom = 0;
        for (let y = 0; y < image.height; y++) {
          const row = new Map();
          for (let x = 0; x < image.width; x++) {
            if (!ink(x, y)) continue;
            const start = x;
            while (x < image.width && ink(x, y)) x++;
            const width = x - start;
            const key = `${start},${width}`;
            const rectangle = previous.get(key) || { x: start, y, width, height: 0 };
            if (!previous.has(key)) rectangles.push(rectangle);
            rectangle.height++;
            row.set(key, rectangle);
            left = Math.min(left, start);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y + 1);
          }
          previous = row;
        }
        return { rectangles, width: image.width, height: image.height, left, top, right, bottom };
      },
      `data:image/png;base64,${source.toString('base64')}`
    );
    assert(artwork.rectangles.length > 0, `${name} must contain visible artwork`);
    const path = artwork.rectangles
      .map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h-${width}z`)
      .join('');
    const viewBox =
      name === 'icon'
        ? `0 0 ${artwork.width} ${artwork.height}`
        : `${artwork.left} ${artwork.top} ${artwork.right - artwork.left} ${artwork.bottom - artwork.top}`;
    const svg = (fill, backdrop = '') =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" shape-rendering="crispEdges">${backdrop}<path fill="${fill}" d="${path}"/></svg>\n`;
    await save(`apps/web/public/brand/garden-${name}.svg`, svg('currentColor'));
    if (name === 'wordmark') continue;
    await save(
      'apps/web/public/garden-mark.svg',
      svg(light, `<path fill="${dark}" d="M0 0h${artwork.width}v${artwork.height}H0z"/>`)
    );
    const render = async (size, fill, background) => {
      const png = await page.evaluate(
        async ({ svg, size, background }) => {
          const image = new Image();
          image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const context = canvas.getContext('2d');
          if (background) {
            context.fillStyle = background;
            context.fillRect(0, 0, size, size);
          }
          context.drawImage(image, 0, 0, size, size);
          return canvas.toDataURL('image/png').split(',')[1];
        },
        { svg: svg(fill), size, background }
      );
      return Buffer.from(png, 'base64');
    };
    await save('apps/desktop/src-tauri/icons/garden-logo.png', await render(1024, light));
    await save('apps/desktop/src-tauri/icons/garden-monochrome.png', await render(1024, '#ffffff'));
    for (const [file, size, background] of [
      ['garden-icon-192.png', 192, dark],
      ['garden-icon-512.png', 512, dark],
      ['garden-maskable-512.png', 512, dark],
      ['garden-apple-touch.png', 180, dark],
      ['garden-mark-512.png', 512, undefined]
    ])
      await save(`apps/web/public/brand/${file}`, await render(size, light, background));
  }
} finally {
  await browser.close();
}

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
for (const [source, generated] of [
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
      const target = directory + generated + '/' + file;
      const opaque = spawnSync('magick', [target, '-alpha', 'off', 'PNG24:' + target], {
        stdio: 'inherit'
      });
      assert.equal(opaque.status, 0, `${file} must export without an alpha channel`);
    }
    await copyFile(directory + generated + '/' + file, directory + source + '/' + file);
  }
}
