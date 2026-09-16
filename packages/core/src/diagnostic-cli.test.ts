import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiagnosticProjector } from './diagnostics.js';

const cli = fileURLToPath(new URL('./diagnostic-cli.ts', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function run(contents: string) {
  const root = await mkdtemp(join(tmpdir(), 'garden-diagnostic-test-'));
  roots.push(root);
  const file = join(root, 'trace.ndjson');
  await writeFile(file, contents);
  return spawnSync(process.execPath, ['--import', 'tsx', cli, file], {
    encoding: 'utf8',
    timeout: 10000
  });
}
const projector = createDiagnosticProjector();
const header = projector.header(
  {
    id: 'task',
    modelId: 'model',
    status: 'failed',
    securityMode: 'autonomous',
    spentUsd: 0,
    attempt: 0
  },
  {},
  1,
  '2026-09-17T00:00:00.000Z'
);
const row = projector.event(
  { sequence: 1, kind: 'error', createdAt: '2026-09-17T00:00:00.000Z' },
  { toolCallId: 'call' }
);
const footer = { type: 'footer', events: 1, lastSequence: 1, unreadableEvents: 0, complete: true };
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
describe('offline diagnostic reader', () => {
  it('reconstructs a recorded failure without repeating it', async () => {
    const result = await run(encode([header, row, footer]));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      failedEvents: 1,
      status: 'failed',
      commandsRun: 0,
      providerCalls: 0,
      complete: true
    });
  });
  it('exits nonzero for an explicit partial export', async () => {
    const result = await run(
      encode([header, { ...footer, events: 0, lastSequence: 0, complete: false }])
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, missingEvents: 1 });
  });
  it('refuses malformed and truncated input without echoing the offending contents', async () => {
    const canary = 'VERY_PRIVATE_UNSTRUCTURED_VALUE';
    const malformed = await run(canary),
      truncated = await run(encode([header, row]));
    expect(malformed.status).toBe(1);
    expect(truncated.status).toBe(1);
    expect(malformed.stdout + malformed.stderr).not.toContain(canary);
    expect(malformed.stdout).toBe('');
    expect(truncated.stdout).toBe('');
  });
});
