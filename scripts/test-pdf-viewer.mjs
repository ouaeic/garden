#!/usr/bin/env node

import assert from 'node:assert/strict';
import { before as beforeAll, after as afterAll, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pdfAssets } from '../apps/web/pdf-assets.ts';
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));

const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium } = requireRunner('playwright-core');
let server, origin, directory;
const requests = [];
const delayedResponses = new Set();
let abortedDocuments = 0;
const report = process.env.GARDEN_PDF_REPORT;
function pdf(count = 2) {
  const streams = Array.from(
    { length: count },
    (_, index) =>
      `${index % 2 ? '1 0 0' : '0 0 1'} rg 20 20 90 90 re f BT /F1 20 Tf 20 170 Td (${count === 2 ? (index ? 'Second garden page' : 'First garden page') : `Garden page ${index + 1}`}) Tj ET`
  );
  const fontId = count + 3,
    streamStart = fontId + 1,
    scriptId = streamStart + count;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /OpenAction ${scriptId} 0 R >>`,
    `<< /Type /Pages /Kids [${streams.map((_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${count} >>`,
    ...streams.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${count > 2 && index % 2 ? 200 : 300} ${count > 2 && index % 2 ? 300 : 200}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${index + streamStart} 0 R >>`
    ),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map((stream) => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    '<< /S /JavaScript /JS (app.launchURL("/v1/bootstrap")) >>'
  ];
  let body = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(body);
}
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'garden-pdf-proof-'));
  const root = path.resolve(import.meta.dirname, '../apps/web');
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      react(),
      pdfAssets(),
      {
        name: 'pdf-proof-entry',
        resolveId: (id) => (id === 'virtual:pdf-proof' ? '\0pdf-proof.js' : null),
        load: (id) =>
          id === '\0pdf-proof.js'
            ? `import ${JSON.stringify(path.resolve(import.meta.dirname, '../apps/web/src/styles.css'))};import React from 'react';import {createRoot} from 'react-dom/client';import PdfPreview from ${JSON.stringify(path.resolve(import.meta.dirname, '../apps/web/src/computer/PdfPreview.tsx'))};const root=createRoot(document.getElementById('root'));root.render(React.createElement(PdfPreview,{url:'/fixture.pdf',name:'Garden proof'}));window.closePdf=()=>root.unmount();window.showPdf=(url,name='Garden proof')=>root.render(React.createElement(PdfPreview,{url,name}));`
            : null
      }
    ],
    build: {
      outDir: directory,
      emptyOutDir: true,
      rollupOptions: { input: 'virtual:pdf-proof', output: { entryFileNames: 'proof.js' } }
    }
  });
  const assets = await readdir(path.join(directory, 'assets'));
  const css = assets
    .filter((file) => file.endsWith('.css'))
    .map((file) => `<link rel="stylesheet" href="/assets/${file}">`)
    .join('');
  server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    requests.push({ path: url, cookie: req.headers.cookie ?? '' });
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' blob:; img-src 'self' data: blob:"
    );
    if (url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html>${css}<div id="root"></div><script type="module" src="/proof.js"></script>`
      );
      return;
    }
    if (url === '/fixture.pdf' || url === '/long.pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-security-policy', "sandbox; default-src 'none'");
      res.end(pdf(url === '/long.pdf' ? 240 : 2));
      return;
    }
    if (url === '/password.pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.end(await readFile(new URL('./fixtures/pdf/password.pdf', import.meta.url)));
      return;
    }
    if (url === '/delayed.pdf') {
      delayedResponses.add(res);
      res.on('close', () => {
        if (!res.writableEnded) abortedDocuments += 1;
        delayedResponses.delete(res);
      });
      return;
    }
    if (url.includes('..') || !url.startsWith('/')) {
      res.writeHead(404).end();
      return;
    }
    try {
      res.setHeader(
        'content-type',
        url.endsWith('.js') || url.endsWith('.mjs')
          ? 'text/javascript'
          : url.endsWith('.css')
            ? 'text/css'
            : url.endsWith('.wasm')
              ? 'application/wasm'
              : 'application/octet-stream'
      );
      res.end(await readFile(path.join(directory, url)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const response of delayedResponses) response.destroy();
  await new Promise((resolve) => server?.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
test(
  'renders actual authenticated PDF bytes under the artifact sandbox, navigates every page, and never executes PDF actions',
  { timeout: 30_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'owner-session', value: 'fixture', url: origin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      await page.goto(origin);
      await page.getByText('First garden page', { exact: true }).waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('[role="status"]'));
      const canvas = page.locator('[data-page="1"] canvas');
      const originalWidth = await canvas.evaluate(
        (element) => element.getBoundingClientRect().width
      );
      const first = await canvas.evaluate((element) =>
        Array.from(
          element
            .getContext('2d')
            .getImageData(Math.floor(element.width * 0.2), Math.floor(element.height * 0.75), 1, 1)
            .data
        )
      );
      assert.ok(first[2] > first[0]);
      await page.getByRole('button', { name: 'Next page', exact: true }).click();
      await page.getByText('Second garden page', { exact: true }).waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('[role="status"]'));
      assert.equal(
        await page.getByRole('spinbutton', { name: 'Page', exact: true }).inputValue(),
        '2'
      );
      await page.getByLabel('Zoom', { exact: true }).selectOption('2');
      await page.waitForFunction(() => !document.querySelector('[role="status"]'));
      await page.waitForFunction(
        (width) => document.querySelector('canvas')?.getBoundingClientRect().width > width * 1.9,
        originalWidth
      );
      assert.ok((await canvas.evaluate((element) => element.width * element.height)) <= 4_010_000);
      assert.match(
        await page.locator('[data-page="2"] .pdf-text-layer').innerText(),
        /Second garden page/
      );
      assert.equal(
        await page.getByRole('link', { name: 'Download PDF' }).getAttribute('download'),
        'Garden proof'
      );
      assert.equal(requests.filter((request) => request.path === '/fixture.pdf').length, 1);
      assert.ok(
        requests
          .find((request) => request.path === '/fixture.pdf')
          ?.cookie.includes('owner-session=fixture')
      );
      assert.equal(
        requests.some((request) => request.path === '/v1/bootstrap'),
        false
      );
      const worker = page.workers()[0];
      assert.ok(worker, 'PDF parsing must use the bundled worker');
      assert.match(
        new URL(worker.url()).pathname,
        /\.js$/,
        'Worker assets use the native server JavaScript MIME mapping'
      );
      const closed = new Promise((resolve) => worker.once('close', resolve));
      await page.evaluate(() => {
        window.closePdf();
      });
      await closed;
      assert.equal(await page.locator('canvas').count(), 0);
    } finally {
      await browser.close();
    }
  },
  30_000
);

test(
  'keeps the reading location across zoom and resize while bounding mixed-page rendering',
  { timeout: 30_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.evaluate(() => window.showPdf('/long.pdf'));
      await page.getByText('Garden page 1', { exact: true }).waitFor({ state: 'attached' });
      await page.getByRole('spinbutton', { name: 'Page', exact: true }).fill('120');
      await page.getByText('Garden page 120', { exact: true }).waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('[role="status"]'));
      const top = () =>
        page
          .locator('[data-page="120"]')
          .evaluate(
            (element) =>
              element.getBoundingClientRect().top -
              document.querySelector('.pdf-page-scroll').getBoundingClientRect().top
          );
      const before = await top();
      await page.getByLabel('Zoom', { exact: true }).selectOption('2');
      await page.waitForFunction(() => {
        const scroller = document.querySelector('.pdf-page-scroll');
        const canvas = document.querySelector('[data-page="120"] canvas');
        return (
          canvas &&
          Math.abs(canvas.getBoundingClientRect().width - scroller.clientWidth * 2) < 2 &&
          !document.querySelector('[role="status"]')
        );
      });
      assert.ok(
        Math.abs((await top()) - before) < 3,
        'zoom must keep the selected page at the same reading position'
      );
      assert.ok(
        (await page.locator('[data-page]').count()) < 25,
        'offscreen page wrappers must be virtualized'
      );
      assert.ok((await page.locator('canvas').count()) < 25);
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByLabel('Zoom', { exact: true }).selectOption('1');
      await page.waitForFunction(() => {
        const scroller = document.querySelector('.pdf-page-scroll');
        const canvas = document.querySelector('[data-page="120"] canvas');
        return (
          canvas &&
          Math.abs(canvas.getBoundingClientRect().width - scroller.clientWidth) < 2 &&
          !document.querySelector('[role="status"]')
        );
      });
      const resizedTop = await top();
      assert.ok(
        Math.abs(resizedTop) < 3,
        `resize must preserve the page anchor; observed ${resizedTop}, before ${before}`
      );
      assert.match(await page.locator('[data-page="120"]').ariaSnapshot(), /Garden page 120/);
      const controlSizes = await page.evaluate(() => ({
        page: document.querySelector('.pdf-toolbar input').getBoundingClientRect().width,
        zoom: document.querySelector('.pdf-toolbar select').getBoundingClientRect().width,
        document: document.documentElement.scrollWidth,
        viewport: window.innerWidth
      }));
      assert.ok(
        controlSizes.page >= 85 && controlSizes.zoom >= 110,
        'page and zoom values must remain readable'
      );
      assert.ok(
        controlSizes.document <= controlSizes.viewport,
        'document controls must wrap at phone widths'
      );
      if (report) {
        await mkdir(report, { recursive: true });
        await page.screenshot({ path: path.join(report, 'pdf-phone.png'), fullPage: true });
      }
      await page.evaluate(() => window.showPdf('/fixture.pdf', 'Replacement'));
      await page.getByText('First garden page', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(
        await page.locator('.pdf-page-scroll').evaluate((element) => element.scrollTop),
        0
      );
      assert.equal(await page.getByText('Garden page 120', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'unlocks one fetched document and cancels pending documents when replaced',
  { timeout: 30_000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      const before = requests.filter((request) => request.path === '/password.pdf').length;
      await page.evaluate(() => window.showPdf('/password.pdf', 'Private document'));
      await page.getByLabel('PDF password', { exact: true }).fill('wrong');
      await page.getByRole('button', { name: 'Open document' }).click();
      await page.getByLabel('Incorrect password. Try again', { exact: true }).fill('garden-test');
      await page.getByRole('button', { name: 'Open document' }).click();
      await page.getByText('Unlocked garden page', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(
        requests.filter((request) => request.path === '/password.pdf').length - before,
        1
      );
      assert.equal(await page.locator('input[type="password"]').count(), 0);

      await page.evaluate(() => window.showPdf('/fixture.pdf'));
      await page.getByText('First garden page', { exact: true }).waitFor({ state: 'attached' });
      await page.evaluate(() => window.showPdf('/password.pdf'));
      await page.getByLabel('PDF password', { exact: true }).waitFor();
      await page.evaluate(() => window.showPdf('/fixture.pdf'));
      await page.getByText('First garden page', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(await page.locator('input[type="password"]').count(), 0);

      const abortsBefore = abortedDocuments;
      const pending = page.waitForRequest(
        (request) => new URL(request.url()).pathname === '/delayed.pdf'
      );
      await page.evaluate(() => window.showPdf('/delayed.pdf'));
      const request = await pending;
      const failed = page.waitForEvent('requestfailed', (value) => value === request);
      await page.evaluate(() => window.showPdf('/fixture.pdf'));
      await failed;
      await page.getByText('First garden page', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(abortedDocuments, abortsBefore + 1);
      assert.equal(await page.getByText('Unlocked garden page', { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
