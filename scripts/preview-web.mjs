#!/usr/bin/env node
/**
 * The interface against the fixture scene, with no server behind it.
 *
 *   node scripts/preview-web.mjs            # API on 127.0.0.1:4100, for `pnpm --filter @garden/web dev`
 *   node scripts/preview-web.mjs --dist     # also serves apps/web/dist on 127.0.0.1:4173
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGardenFixtures } from './garden-fixtures.mjs';

const fixtures = createGardenFixtures();
const dist = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};

const serve = (withDist) =>
  createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/v1/')) {
        if (await fixtures.handle(request, response)) return;
        console.error(`not in fixture: ${request.method} ${request.url}`);
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'not_in_fixture', message: request.url }));
        return;
      }
      if (!withDist || request.url === '/sw.js') return void response.writeHead(404).end();
      const pathname = new URL(request.url ?? '/', 'http://local').pathname;
      const file = resolve(dist, '.' + (extname(pathname) ? pathname : '/index.html'));
      if (!file.startsWith(dist + sep)) return void response.writeHead(403).end();
      response.writeHead(200, {
        'content-type': types[extname(file)] ?? 'application/octet-stream'
      });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });

serve(false).listen(4100, '127.0.0.1', () => console.log('fixture API on http://127.0.0.1:4100'));
if (process.argv.includes('--dist'))
  serve(true).listen(4173, '127.0.0.1', () => console.log('interface on http://127.0.0.1:4173'));
