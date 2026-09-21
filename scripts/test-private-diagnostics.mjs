#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const web = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(web.resolve('vite'));
const { default: react } = await import(web.resolve('@vitejs/plugin-react'));
const { chromium } = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
)('playwright-core');

test(
  'private recording is opt-in, recovers lost acknowledgement and supports phone and keyboard use',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-diagnostic-ui-'));
    let server,
      browser,
      capture = null,
      reads = 0,
      loseAck = true;
    const actions = [],
      errors = [],
      taskId = '00000000-0000-4000-8000-000000000001';
    try {
      const root = path.resolve(import.meta.dirname, '../apps/web'),
        output = path.join(directory, 'dist');
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          react(),
          {
            name: 'diagnostic-proof',
            resolveId: (id) => (id === 'virtual:proof' ? '\0proof.js' : null),
            load: (id) =>
              id === '\0proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import ${JSON.stringify(path.join(root, 'src/presentation.css'))};import React from 'react';import{createRoot}from'react-dom/client';import Capture from ${JSON.stringify(path.join(root, 'src/PrivateDiagnostics.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(Capture,{taskId:${JSON.stringify(taskId)}}));`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:proof', output: { entryFileNames: 'proof.js' } }
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
        .join('');
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (value, code = 200) =>
          res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (url.pathname === '/')
          return res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:720px;margin:auto;padding:20px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        if (url.pathname === `/v1/tasks/${taskId}/diagnostic-capture`) {
          if (req.method === 'GET') {
            reads++;
            return json({ capture });
          }
          assert.ok(req.headers['idempotency-key']);
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          actions.push(input);
          if (input.action === 'delete') capture = null;
          else
            capture = {
              id: input.id,
              state: input.action === 'start' ? 'recording' : 'stopped',
              startedAt: new Date().toISOString(),
              stoppedAt: null,
              records: input.action === 'start' ? 0 : 4,
              bytes: 1024,
              limitBytes: 134217728,
              reason: null
            };
          if (loseAck) {
            loseAck = false;
            return json({ error: { code: 'lost_ack', message: 'Response interrupted' } }, 502);
          }
          return json({ capture });
        }
        try {
          const file = path.join(output, url.pathname);
          res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
          res.end(await readFile(file));
        } catch {
          res.writeHead(404).end();
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      assert.equal(reads, 0);
      assert.deepEqual(actions, []);
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      await page.getByText('Recording is off.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Record next work', exact: true }).click();
      await page.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
      assert.equal(actions.length, 1);
      assert.equal(actions[0].action, 'start');
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
      await page.getByRole('button', { name: 'Record future work', exact: true }).waitFor();
      const link = page.getByRole('link', { name: 'Download private recording' });
      assert.equal(
        await link.getAttribute('href'),
        `/v1/tasks/${taskId}/diagnostic-capture/${capture.id}/export`
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      await page.getByRole('button', { name: 'Delete recording…', exact: true }).click();
      await page.getByRole('button', { name: 'Keep recording', exact: true }).click();
      assert.equal(actions.length, 2);
      await page.getByRole('button', { name: 'Delete recording…', exact: true }).click();
      const remove = page.getByRole('button', { name: 'Delete recording', exact: true });
      await remove.focus();
      await page.keyboard.press('Enter');
      await page.getByText('Recording is off.', { exact: true }).waitFor();
      assert.deepEqual(
        actions.map((row) => row.action),
        ['start', 'stop', 'delete']
      );
      assert.equal(new Set(actions.map((row) => row.id)).size, 1);
      assert.deepEqual(errors, []);
      if (process.env.GARDEN_DIAGNOSTIC_SCREENSHOT)
        await page.screenshot({ path: process.env.GARDEN_DIAGNOSTIC_SCREENSHOT, fullPage: true });
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
