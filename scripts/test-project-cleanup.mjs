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
  'permanent cleanup preserves review identity, recovers a lost acknowledgement and remains usable on a phone',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-cleanup-ui-'));
    let server, browser;
    const project = '00000000-0000-4000-8000-000000000001',
      old = '00000000-0000-4000-8000-000000000002',
      head = '00000000-0000-4000-8000-000000000003';
    const revisions = [
      { id: head, number: 2, title: 'Current result', createdAt: '2026-01-02T00:00:00Z' },
      {
        id: old,
        number: 1,
        title: 'Archived result',
        createdAt: '2026-01-01T00:00:00Z',
        archive: { state: 'archived', requestId: 'archive' }
      }
    ];
    let receipt = null,
      previewCount = 0,
      applies = 0,
      statusReads = 0;
    const selections = [];
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
            name: 'cleanup-proof',
            resolveId: (id) => (id === 'virtual:proof' ? '\0proof.js' : null),
            load: (id) =>
              id === '\0proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import ${JSON.stringify(path.join(root, 'src/project-updates.css'))};import React,{useState} from 'react';import{createRoot}from'react-dom/client';import History from ${JSON.stringify(path.join(root, 'src/ProjectVersionHistory.tsx'))};function Proof(){const[rows,setRows]=useState(${JSON.stringify(revisions)});return React.createElement(History,{projectId:${JSON.stringify(project)},headId:${JSON.stringify(head)},revisions:rows,nextCursor:null,loading:false,onEarlier:()=>{},onInspect:()=>{},onChanged:value=>setRows(old=>old.map(item=>item.id===value.id?value:item))});}createRoot(document.getElementById('root')).render(React.createElement(Proof));`
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
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        if (url.pathname === `/v1/projects/${project}/cleanup/pending`)
          return json(receipt?.state === 'removing' ? [receipt] : []);
        if (url.pathname.startsWith(`/v1/projects/${project}/cleanup/`)) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          const action = url.pathname.split('/').at(-1);
          if (action === 'preview') {
            previewCount++;
            selections.push(input);
            return json({
              digest: String(previewCount).repeat(64),
              observedAt: new Date().toISOString(),
              items: [
                {
                  kind: 'version',
                  id: old,
                  title: 'Version 1 · Archived result',
                  logicalBytes: 4096,
                  reasons: []
                }
              ],
              logicalBytes: 4096,
              estimatedFreedBytes: 2048,
              sharedObjectsRemoved: 1,
              sharedObjectsRetained: 1
            });
          }
          if (action === 'apply') {
            applies++;
            assert.deepEqual(input.selection, { versions: [old], updates: [], checks: [] });
            if (applies === 1)
              return json(
                {
                  error: {
                    code: 'history_changed',
                    message: 'History changed. Review a fresh cleanup preview.'
                  }
                },
                409
              );
            receipt = {
              ...input,
              state: 'removing',
              running: true,
              detail: null,
              startedAt: new Date().toISOString(),
              completedAt: null,
              logicalBytes: 4096,
              estimatedFreedBytes: 2048,
              removedPaths: 0
            };
            return json(
              { error: { code: 'lost_acknowledgement', message: 'The response was interrupted.' } },
              502
            );
          }
          if (action === 'status') {
            if (!receipt)
              return json({ error: { code: 'not_found', message: 'No cleanup receipt.' } }, 404);
            assert.equal(input.requestId, receipt.requestId);
            statusReads++;
            if (statusReads > 1) {
              receipt = {
                ...receipt,
                state: 'removed',
                running: false,
                completedAt: new Date().toISOString(),
                removedPaths: 4,
                revisions: [
                  {
                    ...revisions[1],
                    contentRemoval: {
                      requestId: receipt.requestId,
                      state: 'removed',
                      startedAt: receipt.startedAt,
                      completedAt: new Date().toISOString()
                    }
                  }
                ]
              };
            }
            return json(receipt);
          }
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
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: 'Free storage…', exact: true }).click();
      assert.equal(
        await page
          .getByRole('checkbox', { name: 'Select version 2 to remove permanently' })
          .isDisabled(),
        true
      );
      await page.getByRole('checkbox', { name: 'Select version 1 to remove permanently' }).check();
      await page.getByRole('button', { name: 'Review 1 selected' }).click();
      const dialog = page.getByRole('dialog', { name: 'Free project storage' });
      await dialog.getByText('Ready to remove', { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      await dialog.getByRole('button', { name: 'Permanently remove files' }).click();
      await dialog
        .getByText('History changed. Review a fresh cleanup preview.', { exact: true })
        .waitFor();
      await dialog.getByRole('button', { name: 'Refresh preview' }).click();
      await dialog.getByText('Ready to remove', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Permanently remove files' }).click();
      await dialog.getByText('Cleanup complete', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await page
        .getByText('Files permanently removed · history retained', { exact: true })
        .waitFor();
      assert.equal(await page.getByRole('button', { name: 'Restore version 1' }).count(), 0);
      assert.equal(applies, 2);
      assert.equal(previewCount, 2);
      assert.equal(statusReads, 2);
      assert.ok(selections.length);
      for (const selection of selections)
        assert.deepEqual(selection, { versions: [old], updates: [], checks: [] });
      assert.deepEqual(errors, []);
      if (process.env.GARDEN_CLEANUP_SCREENSHOT)
        await page.screenshot({ path: process.env.GARDEN_CLEANUP_SCREENSHOT, fullPage: true });
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
