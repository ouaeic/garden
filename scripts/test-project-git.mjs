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
    const head = 'a'.repeat(40),
      prior = 'b'.repeat(40);
    const base = `/v1/projects/${project}`;
    const data = { repositories: [], operations: [], exports: [], removals: [] };
    const creations = [],
      removals = [],
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
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import ${JSON.stringify(path.join(root, 'src/project-updates.css'))};import React from 'react';import{createRoot}from'react-dom/client';import Repositories from ${JSON.stringify(path.join(root, 'src/ProjectRepositories.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(Repositories,{projectId:${JSON.stringify(project)},revisionId:${JSON.stringify(revision)}}));`
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
          return json({ input, state: 'preparing' });
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
