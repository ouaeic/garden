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
  'Git controls recover the same creation request, scope downloads and fit phone and keyboard use',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-git-ui-'));
    let server, browser;
    const project = '00000000-0000-4000-8000-000000000001',
      revision = '00000000-0000-4000-8000-000000000002';
    const connectorId = '00000000-0000-4000-8000-000000000003';
    const transfers = [];
    const head = 'a'.repeat(40),
      prior = 'b'.repeat(40);
    const base = `/v1/projects/${project}`;
    const data = {
      repositories: [],
      operations: [],
      exports: [],
      removals: [],
      workingCopies: [],
      remoteOperations: []
    };
    const creations = [],
      removals = [],
      retries = [],
      errors = [];
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
            name: 'git-proof',
            resolveId: (id) => (id === 'virtual:proof' ? '\0proof.js' : null),
            load: (id) =>
              id === '\0proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import ${JSON.stringify(path.join(root, 'src/project-updates.css'))};import React from 'react';import{createRoot}from'react-dom/client';import Repositories from ${JSON.stringify(path.join(root, 'src/ProjectRepositories.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(Repositories,{projectId:${JSON.stringify(project)},revisionId:${JSON.stringify(revision)},conversations:[{id:${JSON.stringify(project)},title:"Analysis"}]}));`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:proof', output: { entryFileNames: 'proof.js' } }
        }
      });
      const assets = (await readdir(path.join(output, 'assets'))).filter((name) =>
        name.endsWith('.css')
      );
      assert.ok(assets.length);
      const css = assets.map((name) => `<link rel="stylesheet" href="/assets/${name}">`).join('');
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (value, code = 200) =>
          res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (url.pathname === '/')
          return res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script>`
          );
        if (url.pathname === '/v1/connectors')
          return json([
            {
              id: connectorId,
              kind: 'github',
              label: 'Repository account',
              enabled: true,
              scopes: ['github:repository.read', 'github:repository.write']
            }
          ]);
        if (url.pathname === base + '/git-remote') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(input.connectorId, connectorId);
          if (input.operation.action === 'github_git_status') {
            const record = data.remoteOperations.find(
              (item) => item.input.requestId === input.operation.requestId
            );
            assert.ok(record);
            record.state = 'succeeded';
            record.detail = null;
            record.commit = head;
            return json(record);
          }
          transfers.push(input);
          const push = input.operation.action === 'github_git_push';
          if (push) {
            assert.equal(input.operation.commit, head);
            assert.equal(input.operation.expectedHead, prior);
            assert.equal(input.operation.revisionId, revision);
            if (
              transfers.filter((item) => item.operation.action === 'github_git_push').length === 1
            )
              return json({ error: { code: 'interrupted', message: 'Transfer reply lost.' } }, 502);
            assert.deepEqual(transfers.at(-1), transfers.at(-2));
          }
          const record = {
            input: { ...input.operation, action: push ? 'push' : 'fetch', connectorId },
            taskId: project,
            workspaceId: revision,
            state: push ? 'uncertain' : 'succeeded',
            phase: 'finished',
            commit: prior,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            detail: push ? 'Inspect this remote outcome.' : null,
            bundlePath: push ? null : 'workspace/.garden/remotes/captured.bundle'
          };
          data.remoteOperations.unshift(record);
          return json(record);
        }
        if (url.pathname === base + '/repositories') {
          if (req.method === 'GET') return json(data);
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          creations.push(input);
          if (creations.length === 1)
            return json(
              { error: { code: 'lost_acknowledgement', message: 'The response was interrupted.' } },
              502
            );
          assert.deepEqual(input, creations[0]);
          data.repositories = [
            { id: input.requestId, ...input, head, createdAt: new Date().toISOString() }
          ];
          data.workingCopies = [
            {
              repositoryId: input.requestId,
              taskId: project,
              workspaceId: revision,
              revisionId: revision,
              path: 'src',
              branch: 'garden/conversations/' + project,
              base: head,
              state: 'failed',
              createdAt: new Date().toISOString(),
              detail: 'The Git copy needs its conversation configuration.'
            }
          ];
          return json({ input, state: 'preparing' });
        }
        if (url.pathname === base + '/updates' && req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          assert.deepEqual(input, {
            taskId: project,
            operation: {
              action: 'checkout',
              paths: ['workspace/src'],
              revisionId: revision,
              gitOnly: true
            }
          });
          retries.push(input);
          data.workingCopies[0].state = 'ready';
          data.workingCopies[0].detail = null;
          return json({ revisionId: revision, files: [], workingCopies: data.workingCopies });
        }
        const repository = data.repositories[0];
        if (repository && url.pathname === `${base}/repositories/${repository.id}/remove`) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          removals.push(input);
          assert.equal(input.head, head);
          assert.ok(input.requestId);
          data.repositories = [];
          return json({
            ...input,
            repositoryId: repository.id,
            name: repository.name,
            state: 'removing'
          });
        }
        if (repository && url.pathname === `${base}/repositories/${repository.id}/exports`) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(input.commit, head);
          const receipt = {
            ...input,
            repositoryId: repository.id,
            state: 'ready',
            bytes: 4096,
            createdAt: new Date().toISOString(),
            detail: null
          };
          data.exports = [receipt];
          return json(receipt);
        }
        if (
          url.pathname.startsWith(base + '/repository-exports/') &&
          url.pathname.endsWith('/remove')
        ) {
          data.exports = [];
          return json({ removed: true });
        }
        if (repository && url.pathname === `${base}/repositories/${repository.id}`)
          return json({
            repository,
            commits: [
              {
                id: head,
                parents: [prior],
                date: new Date().toISOString(),
                subject: 'Checked source update'
              }
            ],
            next: null,
            branches: [{ name: 'main', commit: head }],
            branchesTruncated: false
          });
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
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: 'Add source repository' }).focus();
      await page.keyboard.press('Enter');
      await page.getByLabel('Repository name').fill('Analysis sources');
      await page.getByLabel('Published source directory').fill('src');
      await page.getByRole('button', { name: 'Create repository', exact: true }).click();
      await page.getByText('The response was interrupted.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Create repository', exact: true }).click();
      await page.getByRole('button', { name: 'Retry Git setup' }).click();
      await page.getByText('Independent Git working copy prepared', { exact: false }).waitFor();
      assert.equal(retries.length, 1);
      await page.getByText('garden/conversations/' + project, { exact: true }).waitFor();
      await page.getByText('Remote Git', { exact: true }).click();
      await page.getByLabel('GitHub owner').fill('fixture');
      await page.getByLabel('Repository', { exact: true }).fill('analysis');
      await page.getByRole('button', { name: 'Fetch branch', exact: true }).click();
      await page.getByText('workspace/.garden/remotes/captured.bundle', { exact: true }).waitFor();
      assert.equal(transfers[0].taskId, project);
      await page.getByRole('button', { name: 'Publish version…' }).click();
      await page.getByRole('button', { name: 'Publish this commit' }).click();
      await page.getByRole('dialog').getByText('Transfer reply lost.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Publish this commit' }).click();
      await page.getByRole('button', { name: 'Inspect remote outcome' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Fetch branch', exact: true }).isDisabled(),
        false
      );
      await page.getByRole('button', { name: 'Inspect remote outcome' }).click();
      await page.getByText('Publish · Complete', { exact: true }).waitFor();
      assert.equal(
        transfers.filter((item) => item.operation.action === 'github_git_push').length,
        2
      );
      await page.getByRole('button', { name: 'View history' }).click();
      await page.getByText('Checked source update', { exact: true }).waitFor();
      assert.equal(creations.length, 2);
      assert.equal(creations[0].revisionId, revision);
      await page.getByRole('button', { name: 'Prepare branch download' }).click();
      const download = page.getByRole('link', { name: 'Download Git bundle' });
      await download.waitFor();
      assert.equal(
        await download.getAttribute('href'),
        `${base}/repository-exports/${data.exports[0].requestId}/download`
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      if (process.env.GARDEN_GIT_SCREENSHOT)
        await page.screenshot({ path: process.env.GARDEN_GIT_SCREENSHOT, fullPage: true });
      await page.getByRole('button', { name: 'Remove prepared download' }).click();
      await download.waitFor({ state: 'detached' });
      assert.equal(await download.count(), 0);
      await page.getByRole('button', { name: 'Close history' }).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.getByText('Checked source update', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Remove Git history…' }).click();
      await page.getByRole('button', { name: 'Keep Git history' }).click();
      assert.equal(removals.length, 0);
      await page.getByRole('button', { name: 'Remove Git history…' }).click();
      await page.getByRole('button', { name: 'Permanently remove Git history' }).click();
      await page.getByRole('button', { name: 'View history' }).waitFor({ state: 'detached' });
      assert.equal(removals.length, 1);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
