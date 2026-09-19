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
  'account connection consent, popup completion, scoped access and phone layout',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-account-view-'));
    let browser, server;
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
            name: 'account-view-entry',
            resolveId: (id) => (id === 'virtual:account-proof' ? '\0account-proof.js' : null),
            load: (id) =>
              id === '\0account-proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles.css'))};import ${JSON.stringify(path.join(root, 'src/library.css'))};import React from 'react';import {createRoot} from 'react-dom/client';import {ConnectionsLibrary} from ${JSON.stringify(path.join(root, 'src/library/Connections.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(ConnectionsLibrary,{onChange:()=>{}}));`
                : null
          }
        ],
        build: {
          outDir: output,
          emptyOutDir: true,
          rollupOptions: { input: 'virtual:account-proof', output: { entryFileNames: 'proof.js' } }
        }
      });
      const css = (await readdir(path.join(output, 'assets')))
        .filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
        .join('');
      const connections = [],
        attempts = [],
        external = [],
        errors = [];
      let origin;
      const catalog = ['google', 'microsoft'].map((kind) => ({
        kind,
        name: kind === 'google' ? 'Google mail and calendar' : 'Microsoft mail and calendar',
        description: 'Read your selected account.',
        dataAccess: 'Only granted access.',
        tokenLocation: 'Encrypted on your server.',
        providerLogging: 'Provider account policy.',
        scopes: [
          { id: 'mail:mailbox.read', label: 'Read mail and attachments', sideEffect: 'read' },
          { id: 'calendar:calendars.read', label: 'Read calendars', sideEffect: 'read' },
          { id: 'calendar:events.write', label: 'Create calendar events', sideEffect: 'write' }
        ]
      }));
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (value) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(value));
        };
        if (url.pathname === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(
            `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">${css}<main style="max-width:900px;margin:auto;padding:16px"><div id="root"></div></main><script type="module" src="/proof.js"></script></html>`
          );
        } else if (url.pathname === '/v1/connectors/catalog') json(catalog);
        else if (url.pathname === '/v1/connectors/accounts/oauth/config')
          json({ redirectUrl: `${origin}/v1/connectors/accounts/oauth/callback` });
        else if (url.pathname === '/v1/connectors/accounts/oauth/start') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const input = JSON.parse(Buffer.concat(chunks).toString());
          attempts.push(input);
          json({
            connectorId: `${input.provider}-connection`,
            authorizationUrl: `${origin}/authorize?attempt=${attempts.length - 1}`,
            authorizationHost: 'fixture account provider',
            expiresAt: new Date(Date.now() + 600_000).toISOString()
          });
        } else if (url.pathname === '/authorize') {
          const input = attempts[Number(url.searchParams.get('attempt'))];
          connections.push({
            id: `${input.provider}-connection`,
            kind: input.provider,
            label: input.label,
            enabled: true,
            scopes: input.scopes,
            authMode: 'oauth',
            baseUrl: 'https://account.example',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastUsedAt: null
          });
          res.setHeader('content-type', 'text/html');
          res.end(
            `<script>${input.provider === 'google' ? `window.opener.postMessage({source:'athanor-account-oauth',ok:true,message:'Account connected'},${JSON.stringify(origin)});` : 'window.opener=null;'}setTimeout(()=>window.close(),20)</script>`
          );
        } else if (url.pathname === '/v1/connectors') json(connections);
        else if (url.pathname === '/v1/connectors/audit') json([]);
        else {
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
      origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === origin) await route.continue();
        else {
          external.push(route.request().url());
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin);
      for (const provider of ['google', 'microsoft']) {
        if (provider === 'microsoft') await page.setViewportSize({ width: 360, height: 740 });
        await page.getByRole('button', { name: 'Add a connection', exact: true }).click();
        await page.getByLabel('Service', { exact: true }).selectOption(provider);
        await page.getByLabel('Connection name', { exact: true }).fill(`${provider} personal`);
        await page.getByLabel('Application client ID', { exact: true }).fill('client-id');
        await page.getByLabel('Client secret', { exact: true }).fill(' SECRET_CANARY ');
        assert.equal(
          await page.getByLabel('Registered redirect URI', { exact: true }).inputValue(),
          `${origin}/v1/connectors/accounts/oauth/callback`
        );
        assert.equal(await page.getByLabel('Service URL', { exact: true }).count(), 0);
        await page.getByLabel('Read calendars', { exact: false }).uncheck();
        assert.equal(
          await page.getByLabel('Create calendar events', { exact: false }).isChecked(),
          false
        );
        if (provider === 'microsoft')
          await page.getByLabel('Create calendar events', { exact: false }).check();
        assert.equal(
          await page
            .getByRole('dialog')
            .getByText('Complete authorization in the service window', { exact: true })
            .count(),
          0
        );
        assert.equal(await page.getByRole('dialog').getByText('read', { exact: true }).count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true
        );
        if (provider === 'microsoft' && process.env.GARDEN_ACCOUNT_REPORT) {
          await mkdir(process.env.GARDEN_ACCOUNT_REPORT, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.GARDEN_ACCOUNT_REPORT, 'account-phone.png'),
            fullPage: true
          });
          await writeFile(
            path.join(process.env.GARDEN_ACCOUNT_REPORT, 'accessibility.txt'),
            await page.getByRole('dialog').ariaSnapshot()
          );
        }
        const popup = page.waitForEvent('popup');
        await page.getByRole('button', { name: 'Choose account and connect', exact: true }).click();
        const opened = await popup;
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.getByText(`${provider} personal`, { exact: true }).waitFor();
        assert.equal(opened.isClosed() || opened.url().startsWith(origin), true);
        assert.deepEqual(attempts.at(-1), {
          provider,
          label: `${provider} personal`,
          scopes: [
            'mail:mailbox.read',
            ...(provider === 'microsoft' ? ['calendar:events.write'] : [])
          ],
          clientId: 'client-id',
          clientSecret: ' SECRET_CANARY '
        });
        assert.equal(
          await page
            .getByRole('button', { name: 'Add a connection', exact: true })
            .evaluate((node) => document.activeElement === node),
          true
        );
        assert.equal((await page.locator('body').innerText()).includes('SECRET_CANARY'), false);
      }
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      assert.equal(attempts.length, 2);
    } finally {
      await browser?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
