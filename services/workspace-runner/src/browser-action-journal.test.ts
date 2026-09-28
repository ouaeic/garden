import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserActionJournal, type BrowserActionProgress } from './browser-action-journal.js';
const secret = 'test-browser-receipt-secret';
const id = 'a'.repeat(64),
  other = 'b'.repeat(64);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-receipts-'));
  roots.push(root);
  return { root, journal: new BrowserActionJournal(secret) };
}
it('returns a completed receipt after restart without repeating its effect and seals page data', async () => {
  const { root, journal } = await fixture();
  const result = {
    url: 'https://jobs.invalid/receipt?secret=private-canary',
    title: 'Application received'
  };
  const perform = vi.fn(async (progress: BrowserActionProgress) => {
    progress.begin(0, 'click');
    progress.complete(0);
    return result;
  });
  expect(
    await journal.run(root, 'agent:one', id, { type: 'click', selector: '#submit' }, perform)
  ).toEqual(result);
  const restarted = new BrowserActionJournal(secret);
  expect(
    await restarted.run(root, 'agent:one', id, { type: 'click', selector: '#submit' }, perform)
  ).toEqual(result);
  expect(perform).toHaveBeenCalledOnce();
  expect(await restarted.read(root, 'agent:one', id)).toMatchObject({
    status: 'completed',
    steps: [{ index: 0, type: 'click', status: 'completed' }],
    result
  });
  expect(await restarted.read(root, 'agent:two', id)).toBeNull();
  expect(await restarted.read(root, 'user:one', id)).toBeNull();
  await expect(
    restarted.run(root, 'agent:one', id, { type: 'click', selector: '#delete' }, perform)
  ).rejects.toThrow('different arguments');
  const filename = path.join(root, '.garden/browser-actions/receipts.sqlite');
  expect((await stat(filename)).mode & 0o777).toBe(0o600);
  const stored = await readFile(filename);
  expect(stored.includes(Buffer.from('private-canary'))).toBe(false);
  await expect(new BrowserActionJournal('wrong key').read(root, 'agent:one', id)).rejects.toThrow();
});
it('records completed batch steps and refuses to repeat an uncertain final step', async () => {
  const { root, journal } = await fixture();
  const perform = vi.fn(async (progress: BrowserActionProgress) => {
    progress.begin(0, 'type');
    progress.complete(0);
    progress.begin(1, 'click');
    throw new Error('lost acknowledgement');
  });
  await expect(journal.run(root, 'agent:one', id, { type: 'batch' }, perform)).rejects.toThrow(
    'lost acknowledgement'
  );
  expect(await journal.read(root, 'agent:one', id)).toMatchObject({
    status: 'uncertain',
    steps: [
      { index: 0, status: 'completed' },
      { index: 1, status: 'started' }
    ]
  });
  await expect(
    new BrowserActionJournal(secret).run(root, 'agent:one', id, { type: 'batch' }, perform)
  ).rejects.toThrow('not repeated');
  expect(perform).toHaveBeenCalledOnce();
});
it('joins concurrent same-instance calls and refuses another instance while the first owns intent', async () => {
  const { root, journal } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const perform = vi.fn(async () => {
    began();
    await gate;
    return { ok: true };
  });
  const first = journal.run(root, 'a', id, {}, perform);
  const joined = journal.run(root, 'a', id, {}, perform);
  await started;
  try {
    await expect(new BrowserActionJournal(secret).run(root, 'a', id, {}, perform)).rejects.toThrow(
      'not repeated'
    );
  } finally {
    release();
  }
  expect(await first).toEqual(await joined);
  expect(perform).toHaveBeenCalledOnce();
});
it('keeps durable intent through a killed runner process', async () => {
  const { root, journal } = await fixture();
  const moduleUrl = new URL('./browser-action-journal.ts', import.meta.url).href;
  const program = `import { BrowserActionJournal } from ${JSON.stringify(moduleUrl)};
    await new BrowserActionJournal(${JSON.stringify(secret)}).run(${JSON.stringify(root)}, 'agent:killed', ${JSON.stringify(other)}, {}, async (progress) => {
      progress.begin(0, 'click'); process.stdout.write('intent-ready\\n'); await new Promise(() => {setInterval(()=>{},1000)});
    });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '--conditions=development' }
  });
  const closed = once(child, 'close');
  let output = '',
    error = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    error += chunk.toString();
  });
  try {
    await vi.waitFor(
      () => {
        expect(output, error).toContain('intent-ready');
      },
      { timeout: 10000 }
    );
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  expect(await journal.read(root, 'agent:killed', other)).toMatchObject({
    status: 'started',
    steps: [{ index: 0, status: 'started' }]
  });
  const perform = vi.fn(async () => ({}));
  await expect(journal.run(root, 'agent:killed', other, {}, perform)).rejects.toThrow(
    'not repeated'
  );
  expect(perform).not.toHaveBeenCalled();
}, 15000);
it('refuses invalid identities and symlink receipt stores before executing', async () => {
  const { root, journal } = await fixture();
  const perform = vi.fn(async () => ({}));
  await expect(journal.run(root, 'a', '../bad', {}, perform)).rejects.toThrow();
  await journal.read(root, 'a', id);
  const file = path.join(root, '.garden/browser-actions/receipts.sqlite');
  await rm(file);
  await symlink(path.join(root, 'outside'), file);
  await expect(journal.run(root, 'a', id, {}, perform)).rejects.toThrow('Invalid browser receipt');
  expect(perform).not.toHaveBeenCalled();
});
