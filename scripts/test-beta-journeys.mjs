#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const report = process.env.GARDEN_BETA_REPORT || (await mkdtemp(resolve(tmpdir(), 'garden-beta-')));
await mkdir(report, { recursive: true });
const journeys = [
  {
    id: 'browser-error-controls',
    command: ['node', 'scripts/test-browser-errors.mjs'],
    engine: 'both'
  },
  { id: 'chromium-complete', command: ['pnpm', 'test:ui'], engine: 'chromium' },
  { id: 'webkit-complete', command: ['node', 'scripts/test-web-layout.mjs'], engine: 'webkit' },
  { id: 'webkit-owner-devices', command: ['pnpm', 'test:auth-ui'], engine: 'webkit' },
  ...['chromium', 'webkit'].flatMap((engine) =>
    ['memory', 'models', 'updates'].map((focus) => ({
      id: `${engine}-${focus}`,
      engine,
      focus,
      command: ['node', 'scripts/test-web-layout.mjs']
    }))
  )
];
assert(journeys.length > 0);
const results = [];
for (const journey of journeys) {
  console.log(`Beta journey: ${journey.id}`);
  const folder = resolve(report, journey.id);
  await mkdir(folder, { recursive: true });
  const started = Date.now();
  const output = createWriteStream(resolve(folder, 'run.log'));
  const child = spawn(journey.command[0], journey.command.slice(1), {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      GARDEN_UI_ENGINE: journey.engine,
      GARDEN_UI_FOCUS: journey.focus ?? '',
      GARDEN_UI_REPORT: folder,
      GARDEN_AUTH_REPORT: folder
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const result = await new Promise((done) => {
    child.once('error', (error) => done({ code: null, error: error.message }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
  await new Promise((done) => output.end(done));
  results.push({
    id: journey.id,
    engine: journey.engine,
    ...result,
    durationMs: Date.now() - started
  });
  await writeFile(resolve(report, 'journeys.json'), JSON.stringify({ results }, null, 2) + '\n');
  if (result.code !== 0) {
    console.error(`Failed ${journey.id}; inspect ${folder}/run.log`);
    process.exitCode = 1;
    break;
  }
}
console.log(`Beta journey evidence: ${report}`);
