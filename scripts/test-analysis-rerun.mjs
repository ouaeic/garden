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
const web = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(web.resolve('vite'));
const { default: react } = await import(web.resolve('@vitejs/plugin-react'));
const runner = createRequire(new URL('../services/workspace-runner/package.json', import.meta.url));
const { chromium } = runner('playwright-core');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = process.env.GARDEN_RERUN_REPORT;

test(
  'selected scientific reruns survive reload, check drift, and submit through the conversation',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-rerun-view-'));
    let server, browser;
    try {
      const run = path.join(directory, 'run');
      await mkdir(run);
      await writeFile(
        path.join(run, 'analysis.py'),
        "from pathlib import Path\nPath('counts.txt').write_text('25')\n"
      );
      await writeFile(
        path.join(run, 'spec.json'),
        JSON.stringify({
          name: 'Base counts',
          command: ['python3', 'analysis.py'],
          sources: ['analysis.py'],
          inputs: [],
          outputs: ['counts.txt'],
          environment: {
            lockFiles: [],
            runtimeOnly: true,
            probes: [{ name: 'Python', command: ['python3', '--version'] }]
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
          'run.json'
        ],
        { cwd: run, stdio: 'pipe' }
      );
      const record = await readFile(path.join(run, 'run.json'));
      const workspace = {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Analysis',
        status: 'running',
        securityMode: 'autonomous'
      };
      const task = {
        id: '20000000-0000-4000-8000-000000000002',
        workspaceId: workspace.id,
        projectId: '20000000-0000-4000-8000-000000000002',
        status: 'completed',
        modelId: 'test/model',
        privacyRoute: 'provider_zdr',
        securityMode: 'autonomous',
        reasoningEffort: 'auto'
      };
      const bootstrap = {
        user: { id: 'user' },
        instance: { enforceZeroDataRetention: false },
        models: [
          {
            id: 'test/model',
            displayName: 'Test model',
            provider: 'test',
            privacyRoute: 'provider_zdr',
            availability: 'available'
          }
        ]
      };
      const manifestPath = 'workspace/analysis/run.json';
      const root = path.resolve(import.meta.dirname, '../apps/web'),
        output = path.join(directory, 'dist');
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          react(),
          {
            name: 'rerun-proof',
            resolveId: (id) => (id === 'virtual:rerun-proof' ? '\0rerun-proof.js' : null),
            load: (id) =>
              id === '\0rerun-proof.js'
                ? `
import ${JSON.stringify(path.join(root, 'src/styles.css'))};
import ${JSON.stringify(path.join(root, 'src/garden.css'))};
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import SourceInspector from ${JSON.stringify(path.join(root, 'src/computer/SourceInspector.tsx'))};
import Composer from ${JSON.stringify(path.join(root, 'src/Composer.tsx'))};
import {recoverDeviceDrafts} from ${JSON.stringify(path.join(root, 'src/draft-storage.ts'))};
const recovered=await recoverDeviceDrafts('user');const serverDraft=await fetch('/v1/drafts').then(r=>r.json());const draft=recovered.at(-1)??serverDraft;
function Proof(){const[context,setContext]=useState(draft.controls?.context??null);return React.createElement(React.Fragment,null,
 React.createElement(SourceInspector,{workspaceId:${JSON.stringify(workspace.id)},path:${JSON.stringify(manifestPath)},onRerunAnalysis:setContext}),
 React.createElement('button',{onClick:()=>setContext({kind:'selection',text:'Keep this selected passage'})},'Select passage'),
 React.createElement(Composer,{workspace:${JSON.stringify(workspace)},task:${JSON.stringify(task)},bootstrap:${JSON.stringify(bootstrap)},initialDraft:draft,context,onContextChange:setContext,onDraft:()=>{},onSent:()=>setContext(null)}));}
createRoot(document.getElementById('root')).render(React.createElement(Proof));`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:rerun-proof', output: { entryFileNames: 'proof.js' } },
          target: 'esnext'
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((n) => n.endsWith('.css'))
        .map((n) => `<link rel="stylesheet" href="/assets/${n}">`)
        .join('');
      let draft = {
        workspaceId: workspace.id,
        taskId: task.id,
        body: '',
        attachments: [],
        revision: 0
      };
      let drift = false,
        conflict = false,
        offlineDraft = false;
      const sent = [],
        requests = [],
        writes = [];
      const json = (res, status, value) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          if (url.pathname.startsWith('/v1/'))
            requests.push({ method: req.method, path: url.pathname });
          if (url.pathname === '/')
            return res.end(
              `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:800px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
            );
          if (url.pathname === '/v1/drafts/device-key')
            return json(res, 200, {
              userId: 'user',
              sessionId: 'session',
              key: Buffer.alloc(32, 7).toString('base64url')
            });
          if (url.pathname === '/v1/drafts') {
            if (req.method === 'GET') return json(res, 200, draft);
            assert.equal(req.method, 'PUT');
            let chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const input = JSON.parse(Buffer.concat(chunks));
            if (offlineDraft)
              return json(res, 503, {
                error: { code: 'unavailable', message: 'Draft service unavailable' }
              });
            if (conflict || input.expectedRevision !== draft.revision)
              return json(res, 409, {
                error: { code: 'draft_conflict', message: 'A newer draft exists' }
              });
            draft = { ...input, revision: draft.revision + 1 };
            writes.push(structuredClone(draft));
            return json(res, 200, {
              revision: draft.revision,
              updatedAt: new Date().toISOString()
            });
          }
          if (url.pathname === `/v1/workspaces/${workspace.id}/file`) {
            assert.equal(req.method, 'GET');
            assert.equal(url.searchParams.get('path'), manifestPath);
            const bytes = drift ? Buffer.concat([record, Buffer.from('\n')]) : record;
            return res
              .writeHead(200, { 'x-content-sha256': sha(bytes), 'x-truncated': 'false' })
              .end(bytes);
          }
          if (url.pathname === `/v1/tasks/${task.id}/model-preferences`)
            return json(res, 200, { revision: 0, purposes: [], projectTaskId: task.projectId });
          if (url.pathname === `/v1/tasks/${task.id}/messages`) {
            assert.equal(req.method, 'POST');
            let chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            sent.push({
              payload: JSON.parse(Buffer.concat(chunks)),
              key: req.headers['idempotency-key']
            });
            return json(res, 200, task);
          }
          if (!/^\/(?:assets\/[^/]+|proof.js)$/.test(url.pathname)) return res.writeHead(404).end();
          res.setHeader(
            'content-type',
            url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'
          );
          res.end(await readFile(path.join(output, url.pathname)));
        } catch (error) {
          json(res, 500, { message: String(error) });
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', (e) => {
        errors.push(e.message);
        console.error(e.message);
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const select = () =>
        page.getByRole('button', { name: 'Rerun with changes', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Add direction to this work', exact: true });
      const context = page.getByRole('region', { name: 'Selected analysis', exact: true });
      const synced = () => page.getByText('Draft synced', { exact: true }).waitFor();
      const saveAction = async (action, matches) => {
        await Promise.all([
          page.waitForResponse(
            (response) =>
              response.url().endsWith('/v1/drafts') &&
              response.request().method() === 'PUT' &&
              response.status() === 200 &&
              matches(response.request().postDataJSON())
          ),
          action()
        ]);
        await synced();
      };

      await page.getByRole('region', { name: 'Analysis run record', exact: true }).waitFor();
      await saveAction(select, (value) => value.controls?.context?.kind === 'analysis');
      assert.equal(draft.body, '');
      assert.equal(draft.controls.context.sha256, sha(record));
      assert.equal(sent.length, 0, 'Selecting a run never starts a model or process');
      await saveAction(
        () => input.fill('Use a minimum sequence length of 20.'),
        (value) => value.body === 'Use a minimum sequence length of 20.'
      );
      await page.reload();
      await context.waitFor();
      assert.equal(await input.inputValue(), 'Use a minimum sequence length of 20.');
      drift = true;
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByText(/The selected analysis record has changed/).waitFor();
      assert.equal(sent.length, 0, 'Changed record blocks submission before model spend');
      drift = false;
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await context.waitFor({ state: 'hidden' });
      assert.equal(sent.length, 1);
      assert.ok(sent[0].key);
      assert.equal(sent[0].payload.securityMode, 'autonomous');
      assert.equal(sent[0].payload.privacyRoute, 'provider_zdr');
      assert.ok(sent[0].payload.prompt.startsWith('Use a minimum sequence length of 20.'));
      assert.deepEqual(
        JSON.parse(sent[0].payload.prompt.split('Selected analysis reference: ')[1]),
        {
          kind: 'analysis',
          workspaceId: workspace.id,
          manifestPath,
          sha256: sha(record),
          runId: JSON.parse(record).id,
          name: 'Base counts'
        }
      );
      await page.reload();
      assert.equal(await input.inputValue(), '');
      assert.equal(await context.count(), 0);
      await saveAction(
        () => page.getByRole('button', { name: 'Select passage', exact: true }).click(),
        (value) => value.controls?.context?.kind === 'selection'
      );
      await page.reload();
      await page.getByRole('region', { name: 'Selected context', exact: true }).waitFor();
      await saveAction(
        () => page.getByRole('button', { name: 'Clear selected context', exact: true }).click(),
        (value) => !value.controls?.context
      );
      await page.reload();
      assert.equal(
        await page.getByRole('region', { name: 'Selected context', exact: true }).count(),
        0
      );
      offlineDraft = true;
      await select();
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().endsWith('/v1/drafts') && response.status() === 503
        ),
        input.fill('Use a minimum length of 30.')
      ]);
      await page.getByText(/Saved on this device/).waitFor();
      await page.reload();
      await context.waitFor();
      assert.equal(await input.inputValue(), 'Use a minimum length of 30.');
      offlineDraft = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await synced();
      const serverContext = { kind: 'selection', text: 'Direction from another device' };
      draft = {
        ...draft,
        body: 'Keep the server direction',
        controls: { ...draft.controls, context: serverContext },
        revision: draft.revision + 1
      };
      conflict = true;
      await input.fill('A conflicting local edit');
      await page.getByText('Choose a draft version', { exact: true }).waitFor();
      conflict = false;
      await page.getByRole('button', { name: 'Use other draft', exact: true }).click();
      await page.getByRole('region', { name: 'Selected context', exact: true }).waitFor();
      assert.equal(await input.inputValue(), 'Keep the server direction');
      await saveAction(select, (value) => value.controls?.context?.kind === 'analysis');
      await page.setViewportSize({ width: 360, height: 760 });
      await context.waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      assert.deepEqual(errors, []);
      assert.ok(writes.length > 0);
      if (report) {
        await mkdir(report, { recursive: true });
        await page.screenshot({ path: path.join(report, 'rerun-phone.png'), fullPage: true });
        await writeFile(
          path.join(report, 'proof.json'),
          JSON.stringify(
            {
              passed: true,
              modelCalls: 0,
              checks: [
                'native run selection',
                'context-only draft',
                'server reload',
                'encrypted device recovery',
                'changed record refusal',
                'existing conversation submission',
                'settings retained',
                'clear survives reload',
                'server conflict context',
                '360px layout'
              ],
              requests,
              submissions: sent.length
            },
            null,
            2
          ) + '\n'
        );
      }
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
