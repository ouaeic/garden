#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../packages/core/src/index.ts';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, DataStore, migrateDatabase } from '../packages/data/src/index.ts';
import { registerAuthRoutes } from '../apps/api/src/auth-routes.ts';
import { registerAuthHooks } from '../apps/api/src/http/auth-hook.ts';
import { registerErrorHandler } from '../apps/api/src/http/errors.ts';
import { silentLogger } from '../apps/api/src/log.ts';
import { hasRecentStepUp, sessionCookieName } from '../apps/api/src/session.ts';
import { GardenError } from '../packages/core/src/errors.ts';

const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Fastify = requireApi('fastify');
const cookie = requireApi('@fastify/cookie');
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));
const requireRunner = createRequire(
  new URL('../services/workspace-runner/package.json', import.meta.url)
);
const { chromium, webkit } = requireRunner('playwright-core');
const engine = process.env.GARDEN_UI_ENGINE || 'chromium';
assert(['chromium', 'webkit'].includes(engine));
const directory = await mkdtemp(path.join(tmpdir(), 'garden-password-ui-'));
const root = path.resolve(import.meta.dirname, '../apps/web');
const output = path.join(directory, 'dist');
const database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
const store = new DataStore(database);
const app = Fastify();
let browser;
try {
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      react(),
      {
        name: 'password-workflow-entry',
        resolveId: (id) => (id === 'virtual:password-proof' ? '\0password-proof.js' : null),
        load: (id) =>
          id === '\0password-proof.js'
            ? `
      import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
      import ${JSON.stringify(path.join(root, 'src/styles/index.css'))};
      import Login from ${JSON.stringify(path.join(root, 'src/Login.tsx'))};
      import {useAuthEntry} from ${JSON.stringify(path.join(root, 'src/auth-entry.ts'))};
      import {stepUp,signOut} from ${JSON.stringify(path.join(root, 'src/auth.ts'))};
      import {get,post} from ${JSON.stringify(path.join(root, 'src/client.ts'))};
      function Proof(){const [entry,setEntry]=useAuthEntry();const [user,setUser]=useState(null),[loading,setLoading]=useState(true),[confirmed,setConfirmed]=useState(false),[error,setError]=useState('');
        const refresh=()=>get('/v1/auth/me').then(r=>setUser(r.user)).catch(()=>setUser(null)).finally(()=>setLoading(false));useEffect(()=>{void refresh()},[]);
        if(loading)return null;if(!user||entry.startsWith('#password-reset='))return React.createElement(Login,{pairingCode:'',theme:'dark',toggleTheme:()=>{},onAuthenticated:()=>{setEntry('');void refresh()}});
        return React.createElement('main',{},React.createElement('h1',{},'Signed in as '+user.displayName),
          React.createElement('button',{onClick:()=>stepUp(true).then(()=>post('/v1/probe/sensitive',{})).then(()=>setConfirmed(true)).catch(e=>setError(e.message))},'Confirm account change'),
          React.createElement('button',{onClick:()=>signOut().then(refresh)},'Sign out'),
          confirmed&&React.createElement('p',{},'Account change confirmed'),error&&React.createElement('p',{},error));}
      createRoot(document.getElementById('root')).render(React.createElement(Proof));`
            : null
      }
    ],
    build: {
      outDir: output,
      emptyOutDir: true,
      rollupOptions: { input: 'virtual:password-proof', output: { entryFileNames: 'proof.js' } }
    }
  });
  const css = (await readdir(path.join(output, 'assets')))
    .filter((file) => file.endsWith('.css'))
    .map((file) => `<link rel="stylesheet" href="/assets/${file}">`)
    .join('');
  await migrateDatabase(database);
  await app.register(cookie);
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);
  const config = {
    PUBLIC_APP_URL: '',
    WEBAUTHN_ORIGIN: '',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'Garden',
    REGISTRATION_BOOTSTRAP_TOKEN: 'local-password-workflow-pairing-code',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 3600
  };
  const context = {
    app,
    database,
    store,
    secure: false,
    config,
    log: silentLogger,
    requestStarted: new WeakMap(),
    checkAuthRate: () => {},
    checkShareRate: () => {}
  };
  registerErrorHandler(context);
  registerAuthHooks(context);
  registerAuthRoutes(app, store, config);
  app.get('/v1/legal', async () => ({
    registrationAvailable: (await store.countUsers()) === 0,
    passkeysUsable: false
  }));
  app.get('/v1/auth/me', async (request) => ({
    user: { id: request.user.id, displayName: request.user.displayName }
  }));
  app.post('/v1/probe/sensitive', async (request) => {
    if (!(await hasRecentStepUp(store, request.user.id, request.cookies[sessionCookieName(false)])))
      throw new GardenError('step_up_required', 'Confirm your identity', 403);
    return { ok: true };
  });
  // Static assets do not carry owner data; the real auth hooks protect every API request above.
  const staticServer = Fastify();
  staticServer.all('/v1/*', async (request, reply) => {
    const result = await app.inject({
      method: request.method,
      url: request.url,
      headers: request.headers,
      payload: request.body
    });
    reply.code(result.statusCode);
    for (const [key, value] of Object.entries(result.headers))
      if (value !== undefined) reply.header(key, value);
    return reply.send(result.rawPayload);
  });
  staticServer.get('/*', async (request, reply) => {
    if (request.url === '/')
      return reply
        .type('text/html')
        .send(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="root"></div><script type="module" src="/proof.js"></script></body></html>`
        );
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(output, '.' + pathname);
    if (!file.startsWith(output + path.sep)) return reply.code(404).send();
    return reply
      .type(pathname.endsWith('.css') ? 'text/css' : 'text/javascript')
      .send(await readFile(file));
  });
  await staticServer.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${staticServer.server.address().port}`;
  config.PUBLIC_APP_URL = origin;
  config.WEBAUTHN_ORIGIN = origin;
  try {
    browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
    const first = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    const watch = async (context) => {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
      );
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      return page;
    };
    const page = await watch(first);
    await page.goto(origin);
    await page.getByLabel('Your name').fill('Garden owner');
    await page.getByLabel('Installer pairing code').fill(config.REGISTRATION_BOOTSTRAP_TOKEN);
    const password = 'several words for a private garden';
    await page.getByLabel('New password', { exact: true }).fill('short password');
    await page.getByRole('button', { name: 'Create your account', exact: true }).click();
    await page
      .getByText('Use at least 15 characters for your password. A few words work well.', {
        exact: true
      })
      .waitFor();
    await page.getByLabel('New password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create your account', exact: true }).click();
    await page.getByRole('heading', { name: 'Save your recovery code.' }).waitFor();
    const recovery = await page.locator('.recovery-record code').textContent();
    assert(recovery);
    await page.getByRole('button', { name: 'I have saved it' }).click();
    await page.getByRole('heading', { name: 'Signed in as Garden owner' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Signed in as Garden owner' }).waitFor();
    const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await watch(second);
    await phone.goto(origin);
    await phone.getByLabel('Password', { exact: true }).fill('incorrect');
    await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
    await phone.getByText('That password is not correct.', { exact: true }).waitFor();
    await phone.getByLabel('Password', { exact: true }).fill(password);
    await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
    await phone.getByRole('heading', { name: 'Signed in as Garden owner' }).waitFor();
    const owner = await store.soleUser();
    assert.equal((await store.listSessions(owner.id)).length, 2);
    await database.query("UPDATE sessions SET step_up_at=NOW()-INTERVAL '1 hour'");
    await phone.getByRole('button', { name: 'Confirm account change' }).click();
    await phone.getByRole('dialog', { name: 'Confirm it’s you' }).waitFor();
    await phone.getByLabel('Password', { exact: true }).fill(password);
    await phone.getByRole('button', { name: 'Continue', exact: true }).click();
    await phone.getByText('Account change confirmed', { exact: true }).waitFor();
    await phone.getByRole('button', { name: 'Sign out', exact: true }).click();
    await phone.getByRole('button', { name: 'Recover access', exact: true }).click();
    await phone.getByLabel('Recovery or setup code').fill(recovery);
    await phone
      .getByLabel('New password', { exact: true })
      .fill('a different password for this garden');
    await phone.getByRole('button', { name: 'Set password and sign in' }).click();
    await phone.getByRole('heading', { name: 'Save your recovery code.' }).waitFor();
    await phone.getByRole('button', { name: 'I have saved it' }).click();
    await phone.getByRole('heading', { name: 'Signed in as Garden owner' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Welcome back.' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    if (process.env.GARDEN_AUTH_REPORT) {
      await mkdir(process.env.GARDEN_AUTH_REPORT, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.GARDEN_AUTH_REPORT, 'password-sign-in-phone.png'),
        fullPage: true
      });
    }
    const resetToken = randomBytes(32).toString('base64url');
    await store.createPasswordReset(owner.id, sha256(resetToken));
    await page.goto(`${origin}/#password-reset=${resetToken}`);
    await page.getByRole('heading', { name: 'Recover access.' }).waitFor();
    assert.equal(await page.getByLabel('Recovery or setup code').inputValue(), resetToken);
    assert.equal(new URL(page.url()).hash, '');
    await page.getByLabel('New password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Set password and sign in' }).click();
    await page.getByRole('heading', { name: 'Save your recovery code.' }).waitFor();
    await page.getByRole('button', { name: 'I have saved it' }).click();
    await page.getByRole('heading', { name: 'Signed in as Garden owner' }).waitFor();
    const nextToken = randomBytes(32).toString('base64url');
    await store.createPasswordReset(owner.id, sha256(nextToken));
    await page.goto(`${origin}/#password-reset=${nextToken}`);
    await page.getByRole('heading', { name: 'Recover access.' }).waitFor();
    assert.equal(await page.getByLabel('Recovery or setup code').inputValue(), nextToken);
    assert.deepEqual(errors, []);
    console.log(
      'Password browser workflows passed: first-owner setup, independent devices, remembered session after reload, wrong-password retry, password step-up, recovery, old-session revocation, setup links in open signed-in and signed-out tabs, and phone layout.'
    );
  } finally {
    await staticServer.close();
  }
} finally {
  await browser?.close();
  await app.close();
  await database.close();
  await rm(directory, { recursive: true, force: true });
}
