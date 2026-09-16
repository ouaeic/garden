#!/usr/bin/env node

import assert from 'node:assert/strict';
import { before as beforeAll, after as afterAll, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
function pdf() {
  const streams = [
    '0 0 1 rg 20 20 90 90 re f BT /F1 20 Tf 20 170 Td (First garden page) Tj ET',
    '1 0 0 rg 20 20 90 90 re f BT /F1 20 Tf 20 170 Td (Second garden page) Tj ET'
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...streams.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents ${index + 6} 0 R >>`
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
            ? `import React from 'react';import {createRoot} from 'react-dom/client';import PdfPreview from ${JSON.stringify(path.resolve(import.meta.dirname, '../apps/web/src/computer/PdfPreview.tsx'))};const root=createRoot(document.getElementById('root'));root.render(React.createElement(PdfPreview,{url:'/fixture.pdf',name:'Garden proof'}));window.closePdf=()=>root.unmount();`
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
    if (url === '/fixture.pdf') {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-security-policy', "sandbox; default-src 'none'");
      res.end(pdf());
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
