#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const report = process.env.GARDEN_ANALYSIS_REPORT;

test(
  'native run record renders in files and saved results, preserves editing and scopes downloads',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-analysis-view-'));
    let server, browser;
    try {
      const run = path.join(directory, 'run');
      await mkdir(path.join(run, 'records'), { recursive: true });
      await writeFile(
        path.join(run, 'analysis.py'),
        "from pathlib import Path\nfrom garden_view_science import VALUE\nPath('result.txt').write_text(str(VALUE)+'\\n')\n"
      );
      const wheel = 'garden_view_science-1.0-py3-none-any.whl';
      execFileSync(
        'python3',
        [
          '-c',
          String.raw`import zipfile
with zipfile.ZipFile('${wheel}', 'w') as archive:
    archive.writestr('garden_view_science.py', 'VALUE = 42\n')
    archive.writestr('garden_view_science-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\nName: garden-view-science\nVersion: 1.0\n')
    archive.writestr('garden_view_science-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
    archive.writestr('garden_view_science-1.0.dist-info/RECORD', '')
`
        ],
        { cwd: run }
      );
      await writeFile(
        path.join(run, 'spec.json'),
        JSON.stringify({
          name: 'Reference analysis',
          command: ['python', 'analysis.py'],
          sources: ['analysis.py'],
          inputs: [],
          outputs: ['result.txt'],
          environment: {
            lockFiles: [wheel],
            python: {
              interpreter: 'python3',
              directory: '.venv',
              wheels: [
                {
                  path: wheel,
                  sha256: createHash('sha256')
                    .update(await readFile(path.join(run, wheel)))
                    .digest('hex')
                }
              ]
            },
            probes: [{ name: 'Python', command: ['python', '--version'] }]
          }
        })
      );
      execFileSync(
        'python3',
        [
          path.resolve(import.meta.dirname, 'reproducible-run.py'),
          'run',
          '--spec',
          'spec.json',
          '--manifest',
          'records/run.json'
        ],
        { cwd: run }
      );
      let current = await readFile(path.join(run, 'records/run.json'), 'utf8');
      // Service metadata is a viewer fixture; Linux execution has its own native acceptance drill.
      current = JSON.stringify({
        ...JSON.parse(current),
        services: [
          {
            name: 'reference-service',
            pid: 9001,
            status: 'stopped',
            log: '.garden/system/reference-service.log',
            startedAt: '2026-09-27T10:00:00.000Z',
            finishedAt: '2026-09-27T10:01:00.000Z',
            exitCode: 0
          }
        ]
      });
      const saved = current;
      const record = JSON.parse(current);
      const failed = JSON.stringify({
        ...record,
        status: 'failed',
        replayedFrom: record.id,
        outputsMatchPrevious: false,
        error: 'Output checksums differ from the original run'
      });
      const root = path.resolve(import.meta.dirname, '../apps/web');
      const output = path.join(directory, 'dist');
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          react(),
          {
            name: 'analysis-view-entry',
            resolveId: (id) => (id === 'virtual:analysis-proof' ? '\0analysis-proof.js' : null),
            load: (id) =>
              id === '\0analysis-proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import React from 'react';import {createRoot} from 'react-dom/client';import SourceInspector from ${JSON.stringify(path.join(root, 'src/computer/SourceInspector.tsx'))};import {ResultPreview} from ${JSON.stringify(path.join(root, 'src/computer/ResultPreview.tsx'))};const root=createRoot(document.getElementById('root'));window.showFile=()=>root.render(React.createElement(SourceInspector,{workspaceId:'project',path:'workspace/analysis/records/run.json'}));window.showArtifact=(id,size)=>root.render(React.createElement(ResultPreview,{key:id,artifact:{id,workspaceId:'project',taskId:null,name:'run.json',mimeType:'application/json',sizeBytes:size,version:1,sha256:'x',createdAt:new Date().toISOString()}}));window.showFile();`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:analysis-proof', output: { entryFileNames: 'proof.js' } }
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
        .join('');
      const writes = [],
        downloads = [];
      const hash = () => createHash('sha256').update(current).digest('hex');
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        } else if (url.pathname === '/v1/workspaces/project/file') {
          assert.equal(url.searchParams.get('path'), 'workspace/analysis/records/run.json');
          if (req.method === 'PUT') {
            assert.equal(url.searchParams.get('expectSha256'), hash());
            const parts = [];
            for await (const part of req) parts.push(part);
            current = Buffer.concat(parts).toString();
            writes.push(current);
            res.setHeader('content-type', 'application/json');
            res.end('{}');
          } else {
            res.setHeader('x-content-sha256', hash());
            res.setHeader('x-truncated', 'false');
            res.end(current);
          }
        } else if (url.pathname === '/v1/workspaces/project/download') {
          downloads.push(url.searchParams.get('path'));
          res.setHeader('content-disposition', 'attachment; filename="result.txt"');
          res.end('42\n');
        } else if (url.pathname.startsWith('/v1/artifacts/')) {
          res.setHeader('content-type', 'application/json');
          res.end(url.pathname.includes('/failed/') ? failed : saved);
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
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      await page.getByText('Recorded: completed', { exact: true }).waitFor();
      await page.getByText('Rebuilt from verified local packages', { exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox').count(), 0);
      const downloadReady = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Download current result.txt', exact: true }).click();
      await downloadReady;
      assert.deepEqual(downloads, ['workspace/analysis/result.txt']);
      await page.getByText('Recorded services (1)', { exact: true }).click();
      await page.getByText('Recorded: stopped · process 9001', { exact: true }).waitFor();
      const logLink = page.getByRole('link', { name: 'Download current log', exact: true });
      assert.equal(
        new URL(await logLink.getAttribute('href'), page.url()).searchParams.get('path'),
        'workspace/analysis/.garden/system/reference-service.log'
      );

      await page.getByRole('button', { name: 'Source JSON', exact: true }).click();
      const editor = page.getByRole('textbox');
      await editor.fill(saved.replace('Reference analysis', 'Renamed analysis'));
      assert.equal(
        await page.getByRole('button', { name: 'Run overview', exact: true }).isDisabled(),
        true
      );
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByText('Saved.', { exact: true }).waitFor();
      assert.equal(writes.length, 1);
      await page.getByRole('button', { name: 'Run overview', exact: true }).click();
      await page.getByRole('heading', { name: 'Renamed analysis', exact: true }).waitFor();
      await page.evaluate((size) => window.showArtifact('saved', size), Buffer.byteLength(saved));
      await page.getByRole('heading', { name: 'Reference analysis', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: /Download current/ }).count(), 0);
      await page.evaluate((size) => window.showArtifact('failed', size), Buffer.byteLength(failed));
      await page.getByText('Recorded: failed', { exact: true }).waitFor();
      await page.getByText('Different checksums', { exact: true }).waitFor();
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByText('Environment and command', { exact: true }).click();
      await page.getByText('Garden rebuilt Python environment', { exact: true }).click();
      await page.getByText(/garden-view-science/).waitFor();
      await page.getByText('Record identity and scope', { exact: true }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      await page.getByRole('button', { name: 'Source JSON', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.locator('pre.computer-log').waitFor();
      await page.getByRole('button', { name: 'Run overview', exact: true }).click();
      if (report) {
        await mkdir(report, { recursive: true });
        await page.screenshot({ path: path.join(report, 'analysis-phone.png'), fullPage: true });
        await writeFile(
          path.join(report, 'accessibility.txt'),
          await page.locator('main').ariaSnapshot()
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
