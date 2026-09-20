#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));
const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium } = requireRunner('playwright-core');

test(
  'SVG download responses render as isolated images with bounded, cancellable loading',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-svg-view-'));
    let server, browser;
    const delayed = new Set();
    try {
      const root = path.resolve(import.meta.dirname, '../apps/web');
      const output = path.join(directory, 'dist');
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          react(),
          {
            name: 'svg-view-entry',
            resolveId: (id) => (id === 'virtual:svg-proof' ? '\0svg-proof.js' : null),
            load: (id) =>
              id === '\0svg-proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import React from 'react';import {createRoot} from 'react-dom/client';import {ResultPreview} from ${JSON.stringify(path.join(root, 'src/computer/ResultPreview.tsx'))};const root=createRoot(document.getElementById('root'));window.show=(id,size=100,mime='image/svg+xml')=>root.render(React.createElement(ResultPreview,{artifact:{id,name:id+'.svg',mimeType:mime,sizeBytes:size}}));window.show('valid');`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:svg-proof', output: { entryFileNames: 'proof.js' } }
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
        .join('');
      const requests = [];
      const svg = (origin) =>
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="120"><defs><rect id="bar" width="200" height="120" fill="#167050"/></defs><use xlink:href="#bar"/><text x="12" y="80" fill="white">GC — α 44.36%</text><script>parent.compromised=true;fetch('${origin}/external-script')</script><image href="${origin}/external-image" width="10" height="10"/><foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="${origin}/external-html" onerror="parent.compromised=true"/></div></foreignObject></svg>`;
      server = createServer(async (req, res) => {
        requests.push(req.url);
        if (req.url === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        } else if (req.url.startsWith('/v1/artifacts/')) {
          const id = req.url.split('/')[3];
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-disposition', 'attachment; filename="plot.svg"');
          res.setHeader('x-content-type-options', 'nosniff');
          res.setHeader('content-security-policy', "sandbox; default-src 'none'");
          if (id === 'delayed') {
            delayed.add(res);
            req.on('close', () => delayed.delete(res));
            return;
          }
          if (id === 'large-header') {
            res.setHeader('content-length', 33 * 1024 * 1024);
            res.flushHeaders();
            delayed.add(res);
            req.on('close', () => delayed.delete(res));
            return;
          }
          if (id === 'large-stream') {
            for (let i = 0; i < 33; i++) res.write(Buffer.alloc(1024 * 1024, 32));
            res.end();
            return;
          }
          if (id === 'missing') {
            res.writeHead(404);
            res.end('Missing image');
            return;
          }
          if (id === 'malformed') {
            res.end('<svg>broken');
            return;
          }
          if (id === 'invalid-utf8') {
            res.end(Buffer.from([0xff, 0xfe]));
            return;
          }
          if (id === 'entity') {
            res.end(
              `<!DOCTYPE svg [<!ENTITY external SYSTEM "http://${req.headers.host}/external-entity">]><svg xmlns="http://www.w3.org/2000/svg">&external;</svg>`
            );
            return;
          }
          res.end(svg(`http://${req.headers.host}`));
        } else {
          try {
            if (!/^\/(?:assets\/[^/]+|proof.js)$/.test(req.url)) throw Error('path');
            res.setHeader(
              'content-type',
              req.url.endsWith('.css') ? 'text/css' : 'text/javascript'
            );
            res.end(await readFile(path.join(output, req.url)));
          } catch {
            res.writeHead(404).end();
          }
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const rendered = async (id) => {
        const iframe = page.locator(`iframe[title="${id}.svg"]`);
        await iframe.waitFor();
        assert.equal(await iframe.getAttribute('sandbox'), '');
        const frame = await iframe.contentFrame();
        await frame.locator('img').evaluate(async (img) => {
          await img.decode();
        });
        const proof = await frame.locator('img').evaluate((img) => {
          const canvas = document.createElement('canvas');
          canvas.width = 200;
          canvas.height = 120;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          let parentDenied = false;
          try {
            void parent.document;
          } catch {
            parentDenied = true;
          }
          return {
            width: img.naturalWidth,
            height: img.naturalHeight,
            pixel: [...ctx.getImageData(100, 10, 1, 1).data],
            parentDenied
          };
        });
        assert.deepEqual(proof, {
          width: 200,
          height: 120,
          pixel: [22, 112, 80, 255],
          parentDenied: true
        });
      };
      await rendered('valid');
      assert.equal(await page.evaluate(() => window.compromised), undefined);
      assert.equal(
        requests.some((url) => url.startsWith('/external-')),
        false
      );
      await page.evaluate(() => window.show('fallback', 100, 'application/octet-stream'));
      await rendered('fallback');
      for (const id of ['malformed', 'invalid-utf8', 'missing', 'large-header', 'large-stream']) {
        await page.evaluate((id) => window.show(id), id);
        await page
          .getByRole('alert')
          .waitFor()
          .catch((cause) => {
            throw new Error(`Expected error for ${id}`, { cause });
          });
        assert.equal(await page.locator('iframe').count(), 0);
      }
      await page.evaluate(() => window.show('declared-large', 33 * 1024 * 1024));
      await page
        .getByText('This SVG is too large to preview here. Download the original to open it.', {
          exact: true
        })
        .waitFor();
      assert.equal(requests.includes('/v1/artifacts/declared-large/content'), false);
      await page.evaluate(() => window.show('entity'));
      await page.locator('iframe[title="entity.svg"]').waitFor();
      const delayedRequest = page.waitForRequest((request) =>
        request.url().endsWith('/delayed/content')
      );
      await page.evaluate(() => window.show('delayed'));
      await delayedRequest;
      await page.getByRole('status').waitFor();
      await page.evaluate(() => window.show('replacement'));
      await rendered('replacement');
      for (const response of delayed) response.end('<svg>stale error');
      await rendered('replacement');
      await page.setViewportSize({ width: 360, height: 640 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      assert.equal(
        requests.some((url) => url.startsWith('/external-')),
        false
      );
      assert.deepEqual(errors, []);
      const report = process.env.GARDEN_SVG_REPORT;
      if (report) {
        await mkdir(report, { recursive: true });
        await page.screenshot({ path: path.join(report, 'svg-phone.png'), fullPage: true });
        await writeFile(
          path.join(report, 'svg-browser.json'),
          JSON.stringify(
            {
              passed: true,
              requests,
              checks: [
                'rendered internal references',
                'opaque frame',
                'scripts and external references blocked',
                'MIME fallback',
                'bounded declared and streamed bytes',
                'malformed and failed responses',
                'cancelled stale response',
                'phone layout'
              ]
            },
            null,
            2
          ) + '\n'
        );
      }
    } finally {
      await browser?.close();
      for (const response of delayed) response.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
