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
const report = process.env.GARDEN_PROVENANCE_REPORT;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test(
  'producer navigation checks real receipts, stays scoped, and discards stale requests',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-provenance-view-'));
    let server, browser;
    let releaseDelayed;
    try {
      const run = path.join(directory, 'run');
      await mkdir(run);
      execFileSync('python3', [
        '-c',
        String.raw`import sys,json,subprocess,hashlib
from pathlib import Path
runner=Path(sys.argv[1]);root=Path(sys.argv[2])
for number,name in enumerate(['Counts','Percentage','Plot']):
 stem=name.lower();source=stem+'.py';output=stem+'.txt';inputs=[]
 if number:
  previous=['counts','percentage'][number-1]
  inputs=[{'path':previous+'.txt','producer':{'manifest':previous+'-run.json','output':previous+'.txt','sha256':hashlib.sha256((root/(previous+'-run.json')).read_bytes()).hexdigest()}}]
 (root/source).write_text('from pathlib import Path\nPath('+repr(output)+').write_text('+repr(str(number+1))+')\n')
 spec={'name':name,'command':[sys.executable,source],'sources':[source],'inputs':inputs,'outputs':[output],'environment':{'runtimeOnly':True,'lockFiles':[],'probes':[{'name':'Python','command':[sys.executable,'--version']}]}}
 (root/'spec.json').write_text(json.dumps(spec))
 subprocess.run([sys.executable,str(runner),'run','--spec','spec.json','--manifest',stem+'-run.json'],cwd=root,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
`,
        path.resolve(import.meta.dirname, 'reproducible-run.py'),
        run
      ]);
      const names = ['counts-run.json', 'percentage-run.json', 'plot-run.json'];
      const files = new Map(
        await Promise.all(
          names.map(async (name) => [
            'workspace/analysis/' + name,
            await readFile(path.join(run, name))
          ])
        )
      );
      assert.equal(files.size, 3);
      const root = path.resolve(import.meta.dirname, '../apps/web');
      const output = path.join(directory, 'dist');
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          react(),
          {
            name: 'provenance-view-entry',
            resolveId: (id) => (id === 'virtual:provenance-proof' ? '\0provenance-proof.js' : null),
            load: (id) =>
              id === '\0provenance-proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles/index.css'))};import React from 'react';import {createRoot} from 'react-dom/client';import SourceInspector from ${JSON.stringify(path.join(root, 'src/computer/SourceInspector.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(SourceInspector,{workspaceId:'project',path:'workspace/analysis/plot-run.json'}));`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: {
            input: 'virtual:provenance-proof',
            output: { entryFileNames: 'proof.js' }
          }
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((n) => n.endsWith('.css'))
        .map((n) => `<link rel="stylesheet" href="/assets/${n}">`)
        .join('');
      const requests = [];
      let changed = false,
        missing = false,
        delay = false,
        delayedArrived;
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        } else if (url.pathname === '/v1/workspaces/project/file') {
          requests.push({ method: req.method, path: url.searchParams.get('path') });
          assert.equal(req.method, 'GET');
          const name = url.searchParams.get('path');
          assert.ok(files.has(name), 'Only declared files in this project are read');
          if (name === 'workspace/analysis/percentage-run.json') {
            if (delay) {
              delayedArrived?.();
              await new Promise((resolve) => {
                releaseDelayed = resolve;
              });
            }
            if (missing) {
              res
                .writeHead(404, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: { message: 'Producer record is unavailable' } }));
              return;
            }
          }
          const original = files.get(name);
          const content =
            changed && name === 'workspace/analysis/percentage-run.json'
              ? Buffer.concat([original, Buffer.from('\n')])
              : original;
          res.setHeader('x-content-sha256', sha(content));
          res.setHeader('x-truncated', 'false');
          res.end(content);
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
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const preview = page.getByRole('region', { name: 'Analysis run record', exact: true });
      const nav = page.getByRole('region', { name: 'Producer navigation', exact: true });
      await preview.getByRole('heading', { name: 'Plot', exact: true }).waitFor();
      assert.deepEqual(requests, [{ method: 'GET', path: 'workspace/analysis/plot-run.json' }]);
      const inspect = async () => {
        await preview
          .locator('summary')
          .filter({ hasText: /^Inputs / })
          .click();
        await preview
          .locator('summary')
          .filter({ hasText: /^Recorded producer / })
          .click();
        await preview.getByRole('button', { name: 'Inspect producer', exact: true }).click();
      };
      await inspect();
      await preview.getByRole('heading', { name: 'Percentage', exact: true }).waitFor();
      await nav.getByRole('status').filter({ hasText: 'matches the recorded producer' }).waitFor();
      assert.equal(requests.length, 2, 'Only the selected parent is fetched');
      await inspect();
      await preview.getByRole('heading', { name: 'Counts', exact: true }).waitFor();
      changed = true;
      await nav.getByRole('button', { name: 'Previous producer', exact: true }).click();
      await nav.getByRole('alert').filter({ hasText: 'has changed' }).waitFor();
      assert.equal(
        await preview.count(),
        0,
        'Changed producer is never presented as matching evidence'
      );
      changed = false;
      await nav.getByRole('button', { name: 'Check again', exact: true }).click();
      await preview.getByRole('heading', { name: 'Percentage', exact: true }).waitFor();
      await nav.getByRole('button', { name: 'Original run', exact: true }).click();
      await preview.getByRole('heading', { name: 'Plot', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Analysis provenance'
      );
      delay = true;
      const arrival = new Promise((resolve) => {
        delayedArrived = resolve;
      });
      await inspect();
      await arrival;
      await nav.getByRole('button', { name: 'Original run', exact: true }).click();
      delay = false;
      releaseDelayed();
      await preview.getByRole('heading', { name: 'Plot', exact: true }).waitFor();
      missing = true;
      await inspect();
      await nav.getByRole('alert').waitFor();
      assert.equal(await preview.count(), 0);
      missing = false;
      await nav.getByRole('button', { name: 'Check again', exact: true }).click();
      await preview.getByRole('heading', { name: 'Percentage', exact: true }).waitFor();
      await page.setViewportSize({ width: 360, height: 760 });
      await nav.getByRole('button', { name: 'Original run', exact: true }).focus();
      await page.keyboard.press('Enter');
      await preview.getByRole('heading', { name: 'Plot', exact: true }).waitFor();
      await inspect();
      await preview.getByRole('heading', { name: 'Percentage', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      assert.ok(requests.length > 0);
      assert.ok(requests.every((r) => r.method === 'GET' && files.has(r.path)));
      assert.deepEqual(errors, []);
      if (report) {
        await mkdir(report, { recursive: true });
        await page.screenshot({ path: path.join(report, 'provenance-phone.png'), fullPage: true });
        await writeFile(
          path.join(report, 'proof.json'),
          JSON.stringify(
            {
              passed: true,
              requests,
              checks: [
                'native receipts',
                'one hop per click',
                'changed checksum refusal',
                'missing record recovery',
                'late response discarded',
                'keyboard return',
                '360px layout',
                'GET-only project scope'
              ]
            },
            null,
            2
          ) + '\n'
        );
      }
    } finally {
      releaseDelayed?.();
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
