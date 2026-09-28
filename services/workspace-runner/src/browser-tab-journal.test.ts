import { mkdtemp, readFile, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserTabJournal, recoverableTabUrl } from './browser-tab-journal.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), 'garden-tab-journal-'));
  roots.push(dir);
  return dir;
}
const tab = {
  tabId: 'tab-old',
  url: 'https://example.com/research',
  title: 'private research title',
  lastSeenAt: '2026-09-17T00:00:00.000Z'
};
describe('encrypted browser tab recovery', () => {
  it('preserves metadata across journal replacement, with private content sealed and root-bound', async () => {
    const one = await root(),
      two = await root();
    const store = new BrowserTabJournal('local-test-key');
    expect(await store.read(one)).toEqual({ tabs: [], omitted: 0 });
    await store.save(one, [tab]);
    expect(await new BrowserTabJournal('local-test-key').read(one)).toEqual({
      tabs: [tab],
      omitted: 0
    });
    const filename = path.join(one, '.garden/browser-tabs/state.json');
    const raw = await readFile(filename, 'utf8');
    expect(raw).not.toContain(tab.title);
    expect(raw).not.toContain(tab.url);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    await store.save(two, []);
    await copyFile(filename, path.join(two, '.garden/browser-tabs/state.json'));
    await expect(store.read(two)).rejects.toThrow();
  });
  it('serializes updates and reports bounded history rather than silently dropping tabs', async () => {
    const directory = await root(),
      store = new BrowserTabJournal('local-test-key');
    const tabs = Array.from({ length: 205 }, (_, i) => ({ ...tab, tabId: 'tab-' + i }));
    await Promise.all([store.save(directory, [tab]), store.save(directory, tabs)]);
    const state = await store.read(directory);
    expect(state.tabs).toHaveLength(200);
    expect(state.omitted).toBe(5);
    await store.save(directory, []);
    expect(await store.read(directory)).toEqual({ tabs: [], omitted: 0 });
  });
  it.each([
    'file:///etc/passwd',
    'http://127.0.0.1:4100',
    'https://name:password@example.com',
    'https://example.com/#private',
    'https://example.com/?access_token=SECRET',
    'https://example.com/?code=SECRET'
  ])('omits private or credential-bearing addresses: %s', (url) => {
    expect(recoverableTabUrl(url)).toBe(false);
  });
});
