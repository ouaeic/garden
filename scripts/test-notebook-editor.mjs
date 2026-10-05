#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  'notebook cells edit, save with conflict detection, retain metadata and protect navigation on desktop and phone',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-notebook-edit-'));
    let server, browser;
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
            name: 'notebook-edit-entry',
            resolveId: (id) => (id === 'virtual:notebook-proof' ? '\0notebook-proof.js' : null),
            load: (id) =>
              id === '\0notebook-proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles/index.css'))};import React from 'react';import {createRoot} from 'react-dom/client';import NotebookPreview from ${JSON.stringify(path.join(root, 'src/computer/NotebookPreview.tsx'))};import {fileNavigationBlocked} from ${JSON.stringify(path.join(root, 'src/file-navigation.ts'))};const root=createRoot(document.getElementById('root'));window.show=(editable=true)=>root.render(React.createElement(NotebookPreview,{key:String(editable),url:'/v1/workspaces/project/download?path=workspace/analysis.ipynb',name:'analysis.ipynb',...(editable?{editable:{workspaceId:'project',path:'workspace/analysis.ipynb'}}:{})}));window.tryLeave=()=>!fileNavigationBlocked();window.show();`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:notebook-proof', output: { entryFileNames: 'proof.js' } }
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
        .join('');
      const original = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, custom: 'keep' },
        cells: [
          {
            id: 'description',
            cell_type: 'markdown',
            metadata: {},
            source: '# Sequence analysis',
            attachments: { 'plot.png': { 'image/png': 'keep' } }
          },
          {
            id: 'calculation',
            cell_type: 'code',
            metadata: {},
            source: 'count = 3\nprint(count)',
            execution_count: 1,
            outputs: [{ output_type: 'stream', name: 'stdout', text: '3\n' }]
          }
        ]
      };
      let current = JSON.stringify(original),
        writes = 0;
      const digest = () => createHash('sha256').update(current).digest('hex');
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        } else if (
          url.pathname === '/v1/workspaces/project/file' ||
          url.pathname === '/v1/workspaces/project/download'
        ) {
          assert.equal(url.searchParams.get('path'), 'workspace/analysis.ipynb');
          if (req.method === 'PUT') {
            if (url.searchParams.get('expectSha256') !== digest()) {
              res.writeHead(409, { 'content-type': 'application/json' }).end(
                JSON.stringify({
                  error: {
                    code: 'file_changed',
                    message:
                      'This file changed after you read it. Reload it and reapply your edits.'
                  }
                })
              );
            } else {
              const parts = [];
              for await (const part of req) parts.push(part);
              current = Buffer.concat(parts).toString('utf8');
              writes++;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ sha256: digest() }));
            }
          } else {
            res.setHeader('x-content-sha256', digest());
            res.setHeader('x-truncated', 'false');
            res.end(current);
          }
        } else {
          try {
            if (!/^\/(?:assets\/[^/]+|proof.js)$/.test(url.pathname)) throw Error('path');
            res.setHeader(
              'content-type',
              url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'
            );
            res.end(await readFile(path.join(output, url.pathname)));
          } catch {
            res.writeHead(404).end();
          }
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1050, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: 'Edit notebook', exact: true }).click();
      await page.getByRole('button', { name: 'Edit cell 2', exact: true }).click();
      await page.getByRole('textbox', { name: 'Cell 2 source' }).fill('count = 42\nprint(count)');
      assert.equal(await page.evaluate(() => window.tryLeave()), false);
      await page
        .getByText('Save or discard notebook edits before leaving.', { exact: true })
        .waitFor();
      await page
        .getByText('Recorded outputs are stale: code or execution order has changed.', {
          exact: true
        })
        .waitFor();
      await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
      await page.getByText('Notebook saved. Code has not been run.', { exact: true }).waitFor();
      assert.equal(writes, 1);
      assert.equal(JSON.parse(current).cells[1].source, 'count = 42\nprint(count)');
      assert.deepEqual(JSON.parse(current).metadata, original.metadata);
      assert.deepEqual(JSON.parse(current).cells[0].attachments, original.cells[0].attachments);
      assert.equal(await page.evaluate(() => window.tryLeave()), true);
      await page.getByRole('button', { name: 'Move up cell 2', exact: true }).click();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal(await page.evaluate(() => window.tryLeave()), true);
      await page.getByRole('button', { name: 'Edit cell 2', exact: true }).click();
      await page.getByRole('textbox', { name: 'Cell 2 source' }).fill('count = 100');
      current = JSON.stringify({ ...JSON.parse(current), external_edit: 'retained' });
      await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
      await page
        .getByText('This file changed after you read it. Reload it and reapply your edits.', {
          exact: true
        })
        .waitFor();
      assert.equal(writes, 1);
      assert.equal(
        await page.getByRole('textbox', { name: 'Cell 2 source' }).inputValue(),
        'count = 100'
      );
      assert.equal(JSON.parse(current).external_edit, 'retained');
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download current copy', exact: true }).click();
      assert.equal(
        JSON.parse(await readFile(await (await download).path(), 'utf8')).cells[1].source,
        'count = 100'
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      if (process.env.GARDEN_NOTEBOOK_SCREENSHOT)
        await page.screenshot({ path: process.env.GARDEN_NOTEBOOK_SCREENSHOT, fullPage: true });
      await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
      await page.getByRole('button', { name: 'Reload file', exact: true }).click();
      await page.getByRole('button', { name: 'Edit cell 2', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Done editing', exact: true }).click();
      await page.getByRole('button', { name: 'Edit notebook', exact: true }).waitFor();
      await page.evaluate(() => window.show(false));
      await page
        .getByRole('button', { name: 'Edit notebook', exact: true })
        .waitFor({ state: 'hidden' });
      await page.getByText('Saved outputs may be stale.', { exact: false }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Edit notebook', exact: true }).count(),
        0
      );
      assert.equal(await page.evaluate(() => window.tryLeave()), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
