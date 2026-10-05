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
const { WebSocketServer } = createRequire(new URL('../apps/api/package.json', import.meta.url))(
  'ws'
);
const { chromium } = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
)('playwright-core');

test(
  'voice reconnect stays in the same session, retains mute and exposes Stop at phone width',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'garden-voice-ui-'));
    let server, sockets, browser;
    const taskId = '00000000-0000-4000-8000-000000000001',
      id = '00000000-0000-4000-8000-000000000002',
      workspaceId = '00000000-0000-4000-8000-000000000003';
    const task = {
      id: taskId,
      workspaceId,
      title: 'Review analysis results',
      status: 'running',
      modelId: 'fixture',
      maxSpendUsd: 5,
      spentUsd: 0
    };
    const session = {
      id,
      taskId,
      workspaceId,
      provider: 'openai',
      providerModelId: 'fixture',
      privacyRoute: 'provider_zdr',
      retention: 'Fixture',
      voice: 'marin',
      reasoningEffort: 'low',
      status: 'preparing',
      createdAt: new Date().toISOString(),
      connectedAt: null,
      deadlineAt: new Date(Date.now() + 300_000).toISOString(),
      endedAt: null,
      maxSpendUsd: 1,
      settledUsd: 0,
      pendingUsd: 0,
      inputSeconds: 0,
      outputSeconds: 0,
      currentResponseId: null,
      cleanupPending: false,
      errorCode: null,
      note: null
    };
    const prefix = `/v1/tasks/${taskId}/voice-sessions`,
      recoveryKey = 'private-browser-fixture-recovery-key';
    let starts = 0,
      reconnects = 0,
      stops = 0,
      connections = 0,
      epoch = 1,
      latest;
    const errors = [];
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
            name: 'voice-recovery-proof',
            enforce: 'pre',
            resolveId: (id, importer) =>
              id === 'virtual:proof'
                ? '\0proof.js'
                : id === './voice-audio' && importer?.endsWith('/voice-session.ts')
                  ? '\0audio.js'
                  : null,
            load: (id) =>
              id === '\0proof.js'
                ? `import ${JSON.stringify(path.join(root, 'src/styles/index.css'))};import React from 'react';import{createRoot}from'react-dom/client';import Voice from ${JSON.stringify(path.join(root, 'src/voice/VoiceSession.tsx'))};createRoot(document.getElementById('root')).render(React.createElement(Voice,{task:${JSON.stringify(task)},onClose:()=>{},onTaskChanged:()=>{}}));`
                : id === '\0audio.js'
                  ? `globalThis.voiceFixture={enabled:false,stops:0};export function createVoiceAudio(callbacks,unused,admission){return{ready:admission,stop(){voiceFixture.stops++;voiceFixture.enabled=false;},setInput(epoch,enabled){voiceFixture.epoch=epoch;voiceFixture.enabled=enabled;},startOutput(){},enqueue(){},done(){},flush(){return 0;}}}`
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
      const connection = () => ({
        session,
        ticket: `one-use-connection-ticket-${reconnects}`,
        recoveryKey,
        ticketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        socketPath: `/v1/voice-sessions/${id}/socket`
      });
      server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const json = (value, code = 200) =>
          res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (url.pathname === '/')
          return res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${assets.map((name) => `<link rel="stylesheet" href="/assets/${name}">`).join('')}<div id="root"></div><script type="module" src="/proof.js"></script>`
          );
        if (url.pathname === '/v1/voice/models')
          return json({
            options: [
              {
                id: 'fixture',
                provider: 'openai',
                providerModelId: 'fixture',
                displayName: 'Voice fixture',
                available: true,
                reason: null,
                routeProof: 'fixture-proof',
                privacyRoutes: ['provider_zdr'],
                requiresExternalConsent: false,
                supportedEfforts: ['low'],
                defaultEffort: 'low',
                voices: ['marin'],
                defaultVoice: 'marin',
                pricing: [],
                priceUpdatedAt: new Date().toISOString(),
                minimumReservationUsd: 0.1,
                maxDurationSeconds: 1800,
                maxInputSegmentSeconds: 60
              }
            ],
            reason: null
          });
        if (url.pathname === `/v1/tasks/${taskId}/voice-discussion`) return json(null);
        if (url.pathname === prefix) {
          if (req.method === 'GET') return json(starts ? [session] : []);
          starts++;
          return json(connection());
        }
        if (url.pathname.endsWith('/reconnect')) {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          assert.equal(JSON.parse(Buffer.concat(chunks).toString()).recoveryKey, recoveryKey);
          reconnects++;
          if (reconnects === 1)
            return json({ error: { code: 'temporary', message: 'Connection recovering' } }, 503);
          return json(connection());
        }
        if (url.pathname.endsWith('/stop')) {
          stops++;
          session.status = 'ended';
          session.endedAt = new Date().toISOString();
          return json(session);
        }
        if (url.pathname.endsWith('/proposals') || url.pathname.endsWith('/receipts'))
          return json([]);
        try {
          const file = path.join(output, url.pathname);
          res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
          res.end(await readFile(file));
        } catch {
          res.writeHead(404).end();
        }
      });
      sockets = new WebSocketServer({ server });
      sockets.on('connection', (socket) => {
        latest = socket;
        connections++;
        const send = (value) => socket.send(JSON.stringify(value));
        socket.on('message', (data, binary) => {
          assert.equal(binary, false);
          const control = JSON.parse(data.toString());
          if (control.type === 'ticket') {
            assert.equal(control.ticket, connection().ticket);
            session.status = 'listening';
            session.connectedAt ??= new Date().toISOString();
            send({ type: 'ready', session, inputEpoch: epoch++, sampleRate: 24000 });
          } else if (control.type === 'mute' || control.type === 'unmute')
            send({ type: 'input', inputEpoch: epoch++, muted: control.type === 'mute' });
          else if (control.type === 'ping') send({ type: 'pong' });
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('button', { name: 'Start live voice', exact: true }).click();
      await page
        .getByText('Microphone active', { exact: true })
        .waitFor({ timeout: 5000 })
        .catch(async (error) => {
          console.log(
            JSON.stringify({
              starts,
              reconnects,
              connections,
              errors,
              body: await page.locator('body').innerText()
            })
          );
          throw error;
        });
      await page.getByRole('button', { name: 'Mute', exact: true }).click();
      await page.getByText('Microphone muted', { exact: true }).waitFor();
      assert.ok(latest);
      latest.terminate();
      await page.getByText('Reconnecting · microphone paused…', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.voiceFixture.enabled), false);
      const end = page.getByRole('button', { name: 'End voice', exact: true });
      await end.focus();
      assert.equal(await end.evaluate((element) => element === document.activeElement), true);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      if (process.env.GARDEN_VOICE_SCREENSHOT)
        await page.screenshot({ path: process.env.GARDEN_VOICE_SCREENSHOT });
      await page.getByText('Microphone muted', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.voiceFixture.enabled), false);
      assert.equal(starts, 1);
      assert.equal(reconnects, 2);
      assert.equal(connections, 2);
      await end.click();
      await page.waitForFunction(() => window.voiceFixture.stops === 1);
      assert.equal(stops, 1);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      for (const socket of sockets?.clients ?? []) socket.terminate();
      await new Promise((resolve) => (sockets ? sockets.close(resolve) : resolve()));
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
);
