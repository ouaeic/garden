#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const nginx = process.env.NGINX_EXECUTABLE || 'nginx';
const check = spawnSync(nginx, ['-v'], { encoding: 'utf8' });
assert.equal(check.status, 0, 'Install nginx or set NGINX_EXECUTABLE to run the real proxy drill');
const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'garden-preview-proxy-'));
const cleanups = [];
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};
const close = (server) =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const freePort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
};
const request = (url) =>
  new Promise((resolve, reject) => {
    const outgoing = https.get(url, { rejectUnauthorized: false, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body })
      );
    });
    outgoing.setTimeout(2_000, () => outgoing.destroy(new Error('Proxy request timed out')));
    outgoing.on('error', reject);
  });

try {
  let apiRequests = 0;
  const api = http.createServer((_request, response) => {
    apiRequests += 1;
    response.end('authenticated control plane fixture');
  });
  const apiPort = await listen(api);
  cleanups.push(() => close(api));
  const gatewayRequests = [];
  const gateway = http.createServer((incoming, response) => {
    gatewayRequests.push({
      url: incoming.url,
      host: incoming.headers.host,
      protocol: incoming.headers['x-forwarded-proto']
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ app: 'private preview fixture' }));
  });
  const gatewayPort = await listen(gateway);
  cleanups.push(() => close(gateway));
  const [appPort, previewPort, redirectPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort()
  ]);
  assert.equal(
    new Set([appPort, previewPort, redirectPort]).size,
    3,
    'Listener ports must be distinct'
  );
  const appOrigin = `https://127.0.0.1:${appPort}`;
  const previewOrigin = `https://127.0.0.1:${previewPort}`;
  const certificate = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      path.join(temporary, 'server.key'),
      '-out',
      path.join(temporary, 'server.crt')
    ],
    { encoding: 'utf8' }
  );
  assert.equal(certificate.status, 0, 'The drill needs a temporary TLS certificate');
  const generated = {
    'garden-https-listen.conf': `listen 127.0.0.1:${appPort} ssl;\n`,
    'garden-preview-origin.conf': `set $garden_preview_origin "${previewOrigin}";\n`,
    'garden-hsts.conf': '',
    'mime.types': 'types { text/html html; application/javascript js; }\n'
  };
  for (const name of ['security-headers', 'app-csp']) {
    generated[`garden-${name}.conf`] = await readFile(
      path.join(root, 'infra/native', `nginx-${name}.conf`),
      'utf8'
    );
  }
  for (const [name, text] of Object.entries(generated)) {
    await writeFile(
      path.join(temporary, name),
      text.replaceAll('/etc/nginx/snippets/', `${temporary}/`)
    );
  }
  let site = await readFile(path.join(root, 'infra/native/nginx.conf'), 'utf8');
  site = site
    .replace('listen 80 default_server;', `listen 127.0.0.1:${redirectPort};`)
    .replace('listen [::]:80 default_server;', '')
    .replace('listen 8443 ssl;', `listen 127.0.0.1:${previewPort} ssl;`)
    .replace('listen [::]:8443 ssl;', '')
    .replaceAll('/etc/nginx/snippets/', `${temporary}/`)
    .replaceAll('/etc/nginx/mime.types', `${temporary}/mime.types`)
    .replaceAll('/etc/garden/tls/', `${temporary}/`)
    .replaceAll('/opt/garden/apps/web/dist', temporary)
    .replaceAll('127.0.0.1:4100', `127.0.0.1:${apiPort}`)
    .replaceAll('127.0.0.1:4400', `127.0.0.1:${gatewayPort}`);
  await writeFile(path.join(temporary, 'index.html'), '<p>garden application fixture</p>');
  const config = path.join(temporary, 'nginx.conf');
  await writeFile(
    config,
    `daemon off;\nmaster_process off;\npid ${temporary}/nginx.pid;\nerror_log ${temporary}/error.log;\nevents {}\nhttp { ${site}\n}\n`
  );
  const syntax = spawnSync(nginx, ['-p', `${temporary}/`, '-c', config, '-t'], {
    encoding: 'utf8'
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const child = spawn(nginx, ['-p', `${temporary}/`, '-c', config], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  let available = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await request(`${appOrigin}/healthz`)).status === 200) {
        available = true;
        break;
      }
    } catch {
      /* The child has not bound yet. */
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(available, `nginx never became ready: ${stderr}`);
  const previewPath = `/__garden/preview/${'a'.repeat(32)}/api/state?grant=synthetic%2Btoken&x=1`;
  const oldLink = await request(appOrigin + previewPath);
  assert.equal(oldLink.status, 308);
  assert.equal(
    oldLink.headers.location,
    previewOrigin + previewPath,
    'Legacy redirect must retain exact path and grant query'
  );
  const preview = await request(previewOrigin + previewPath);
  assert.equal(preview.status, 200);
  assert.deepEqual(JSON.parse(preview.body), { app: 'private preview fixture' });
  assert.equal(gatewayRequests.length, 1);
  assert.deepEqual(gatewayRequests[0], {
    url: previewPath,
    host: `127.0.0.1:${previewPort}`,
    protocol: 'https'
  });
  assert(
    !preview.headers['content-security-policy']?.includes('sandbox'),
    'Isolated preview must not receive an opaque origin from nginx'
  );
  const apiBefore = apiRequests;
  for (const forbidden of [
    '/v1/healthz',
    '/runner/v1/workspaces/00000000-0000-4000-8000-000000000001/browser/stream',
    '/assets/index.js',
    '/',
    '/__garden/preview/not-a-preview'
  ]) {
    assert.equal(
      (await request(previewOrigin + forbidden)).status,
      404,
      `Preview origin exposed ${forbidden}`
    );
  }
  assert.equal(apiRequests, apiBefore, 'Preview origin must never contact the control plane');
  assert.equal(gatewayRequests.length, 1, 'Only valid preview paths may reach the gateway');
  const app = await request(`${appOrigin}/`);
  assert.equal(app.status, 200);
  assert(app.body.includes('garden application fixture'));
  assert(app.headers['content-security-policy'].includes(`frame-src 'self' ${previewOrigin};`));
  assert(
    !app.headers['content-security-policy'].includes('frame-src https:'),
    'Frame policy must use the configured origin'
  );
  process.stdout.write(
    'nginx preview proxy: TLS, exact legacy redirect, full forwarded origin, preview app response, five forbidden paths and exact frame policy passed.\n'
  );
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(temporary, { recursive: true, force: true });
}
