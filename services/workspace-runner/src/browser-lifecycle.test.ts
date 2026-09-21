import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserDownloadHistory, BrowserManager } from './browser.js';
import { DesktopControl } from './holder.js';
import { runnerLogger } from './log.js';
import { TAB_IDLE_MS } from './browser-tabs.js';
import { GuiNamespaceManager } from './gui-namespace.js';
import { BrowserTabJournal } from './browser-tab-journal.js';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const driver = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));
vi.mock('./playwright.js', () => ({ chromiumDriver: () => Promise.resolve(driver) }));

class Page extends EventEmitter {
  readonly keyboard = { up: vi.fn(async () => undefined) };
  readonly mouse = { up: vi.fn(async () => undefined) };
  readonly url = vi.fn(() => 'about:blank');
  readonly title = vi.fn(async () => '');
  readonly locator = vi.fn(() => ({ innerText: async () => '' }));
  readonly frames = vi.fn(() => []);
  readonly isClosed = vi.fn(() => false);
  readonly evaluate = vi.fn(async () => []);
  readonly screenshot = vi.fn(async () => Buffer.from('captured frame'));
}

class Context extends EventEmitter {
  readonly page = new Page();
  readonly close = vi.fn(async () => {
    this.emit('close');
  });
  readonly pages = vi.fn(() => [this.page]);
  readonly newPage = vi.fn(() => Promise.resolve(this.page));
}

const roots: string[] = [];
const contexts: Context[] = [];
const managers: BrowserManager[] = [];
const workspace = 'browser-lifecycle';
const setup = async (options: Partial<ConstructorParameters<typeof BrowserManager>[0]> = {}) => {
  const root = await mkdtemp(path.join(tmpdir(), 'athanor-browser-lifecycle-'));
  roots.push(root);
  const manager = new BrowserManager({ maxFileBytes: 1_000_000, ...options });
  managers.push(manager);
  driver.launchPersistentContext.mockImplementation(() => {
    const context = new Context();
    contexts.push(context);
    return Promise.resolve(context);
  });
  return { manager, root };
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close(workspace)));
  for (const context of contexts.splice(0)) context.emit('close');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  driver.launchPersistentContext.mockReset();
});

describe('persistent browser ownership', () => {
  it('keeps the project boundary through every launch attempt and releases it after close', async () => {
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => ({
      environment: { ATHANOR_GUI_ROOT: '/project', HOME: '/private/gui' },
      stop
    }));
    const gui = new GuiNamespaceManager('/trusted/gui', start);
    const { manager, root } = await setup({ gui, executablePath: '/usr/bin/chromium' });
    await manager.ensure(workspace, root);
    expect(driver.launchPersistentContext).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executablePath: '/trusted/gui',
        chromiumSandbox: true,
        env: expect.objectContaining({
          ATHANOR_GUI_ROOT: '/project',
          ATHANOR_GUI_BROWSER: '/usr/bin/chromium',
          HOME: '/private/gui'
        }) as unknown
      })
    );
    expect(stop).not.toHaveBeenCalled();
    await manager.close(workspace);
    expect(stop).toHaveBeenCalledTimes(1);
    await gui.close();
  });

  it('never launches unconfined after a project namespace failure', async () => {
    const gui = new GuiNamespaceManager('/trusted/gui', async () => {
      throw new Error('boundary unavailable');
    });
    const { manager, root } = await setup({ gui, executablePath: '/usr/bin/chromium' });
    await expect(manager.ensure(workspace, root)).rejects.toThrow('boundary unavailable');
    expect(driver.launchPersistentContext).not.toHaveBeenCalled();
    await gui.close();
  });

  it('retains lost tab metadata without reopening or replaying a page', async () => {
    const { manager, root } = await setup({ recoverySecret: 'test-recovery-key' });
    const first = await manager.ensure(workspace, root);
    const oldId = [...first.tabs.keys()][0]!;
    contexts[0]!.page.url.mockReturnValue('https://example.com/result');
    contexts[0]!.page.title.mockResolvedValue('Completed application');
    contexts[0]!.page.emit('load');
    await vi.waitFor(() => expect(first.tabLifecycle!.title(oldId)).toBe('Completed application'));
    await manager.close(workspace);
    const next = await manager.ensure(workspace, root);
    const snapshot = await manager.snapshot(workspace, root, 'agent');
    expect(next.tabs.has(oldId)).toBe(false);
    expect(next.page.url()).toBe('about:blank');
    expect(snapshot.recovery?.tabs).toEqual([
      expect.objectContaining({
        tabId: oldId,
        title: 'Completed application',
        url: 'https://example.com/result'
      })
    ]);
    expect(snapshot.recovery?.note).toMatch(/Never repeat a submission/);
    contexts[1]!.page.url.mockReturnValue('https://example.com/result');
    expect((await manager.snapshot(workspace, root, 'agent')).recovery?.tabs).toEqual([]);
  });

  it('does not erase remembered tabs when page-close events precede a browser crash', async () => {
    const { manager, root } = await setup({ recoverySecret: 'test-recovery-key' });
    await manager.ensure(workspace, root);
    contexts[0]!.page.url.mockReturnValue('https://example.com/report');
    contexts[0]!.page.emit('load');
    const journal = new BrowserTabJournal('test-recovery-key');
    await vi.waitFor(async () => expect((await journal.read(root)).tabs).toHaveLength(1));
    contexts[0]!.page.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 350));
    contexts[0]!.emit('close');
    const snapshot = await manager.snapshot(workspace, root, 'agent');
    expect(snapshot.recovery?.tabs[0]?.url).toBe('https://example.com/report');
  });

  it('excludes private-input state and reports unavailable recovery without blocking current work', async () => {
    const { manager, root } = await setup({ recoverySecret: 'test-recovery-key' });
    await mkdir(path.join(root, '.athanor/browser-tabs'), { recursive: true });
    await writeFile(path.join(root, '.athanor/browser-tabs/state.json'), 'invalid encrypted state');
    const session = await manager.ensure(workspace, root);
    expect((await manager.snapshot(workspace, root, 'agent')).recovery?.unavailable).toBe(true);
    await session.control.transfer('secure_input');
    contexts[0]!.page.url.mockReturnValue('https://example.com/?code=PRIVATE_CANARY');
    contexts[0]!.page.emit('load');
    expect(await manager.snapshot(workspace, root, 'user')).not.toHaveProperty('recovery');
    await manager.close(workspace);
    expect(
      await readFile(path.join(root, '.athanor/browser-tabs/state.json'), 'utf8')
    ).not.toContain('PRIVATE_CANARY');
  });

  it('retires only idle unpinned agent sessions and can reopen them', async () => {
    let now = 1;
    const { manager, root } = await setup({ now: () => now });
    const session = await manager.ensure(workspace, root);
    const tabId = [...session.tabs.keys()][0]!;
    session.tabLifecycle!.adopt(tabId, { owner: 'agent', taskId: 'task' });
    now += TAB_IDLE_MS + 1;
    expect(await manager.retireIdle((id) => id === workspace)).toEqual([]);
    session.tabLifecycle!.pin(tabId, true);
    expect(await manager.retireIdle()).toEqual([]);
    session.tabLifecycle!.pin(tabId, false);
    await session.control.transfer('user');
    expect(await manager.retireIdle()).toEqual([]);
    await session.control.transfer('agent');
    const gate = deferred<void>();
    const active = session.control.submit('agent', () => gate.promise);
    expect(await manager.retireIdle()).toEqual([]);
    gate.resolve();
    await active;
    expect(await manager.retireIdle()).toEqual([workspace]);
    expect(contexts[0]!.close).toHaveBeenCalledTimes(1);
    const restarted = await manager.ensure(workspace, root);
    expect(restarted).not.toBe(session);
    expect(restarted.tabs.size).toBeGreaterThan(0);
    expect(restarted.tabs.has(tabId)).toBe(false);
    await expect(
      manager.act(workspace, root, { type: 'close_tab', tabId }, 'agent')
    ).rejects.toThrow();
    expect(restarted.tabs.size).toBeGreaterThan(0);
  });

  it('keeps owner tabs and a recently accessed session', async () => {
    let now = 1;
    const { manager, root } = await setup({ now: () => now });
    const session = await manager.ensure(workspace, root);
    now += TAB_IDLE_MS + 1;
    expect(await manager.retireIdle()).toEqual([]);
    const tabId = [...session.tabs.keys()][0]!;
    session.tabLifecycle!.adopt(tabId, { owner: 'agent', taskId: 'task' });
    await manager.ensure(workspace, root);
    expect(await manager.retireIdle()).toEqual([]);
    expect(contexts[0]!.close).not.toHaveBeenCalled();
  });
  it('shares one completed startup across simultaneous cold reads', async () => {
    const { manager, root } = await setup();
    const [first, second] = await Promise.all([
      manager.ensure(workspace, root),
      manager.ensure(workspace, root)
    ]);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('closes a startup already in flight and permits a fresh session afterwards', async () => {
    const { manager, root } = await setup();
    const gate = deferred<Context>();
    const context = new Context();
    contexts.push(context);
    driver.launchPersistentContext.mockImplementationOnce(() => gate.promise);
    const starting = manager.ensure(workspace, root);
    await vi.waitFor(() => expect(driver.launchPersistentContext).toHaveBeenCalledTimes(1));
    const closing = manager.close(workspace);
    gate.resolve(context);
    const first = await starting;
    await closing;
    expect(context.close).toHaveBeenCalledTimes(1);
    const reopened = await manager.ensure(workspace, root);
    expect(reopened).not.toBe(first);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('does not hand out the closing session to a concurrent reopen', async () => {
    const { manager, root } = await setup();
    const first = await manager.ensure(workspace, root);
    const context = contexts[0]!;
    const gate = deferred<void>();
    context.close.mockImplementationOnce(async () => {
      await gate.promise;
      context.emit('close');
    });
    const closing = manager.close(workspace);
    let returned = false;
    const reopening = manager.ensure(workspace, root).then((session) => {
      returned = true;
      return session;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeClose = returned;
    gate.resolve();
    await closing;
    const second = await reopening;
    expect(returnedBeforeClose).toBe(false);
    expect(second).not.toBe(first);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('closes a context when page initialization fails and allows a later retry', async () => {
    const { manager, root } = await setup();
    const context = new Context();
    contexts.push(context);
    context.pages.mockReturnValue([]);
    context.newPage.mockRejectedValueOnce(new Error('Page creation failed'));
    driver.launchPersistentContext.mockResolvedValueOnce(context);
    await expect(manager.ensure(workspace, root)).rejects.toThrow('Page creation failed');
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(manager.ensure(workspace, root)).resolves.toBeDefined();
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('evicts a closed context so the next read can recreate the browser', async () => {
    const { manager, root } = await setup();
    const first = await manager.ensure(workspace, root);
    const detach = vi.fn(first.detachControl);
    first.detachControl = detach;
    contexts[0]!.emit('close');
    expect(detach).toHaveBeenCalledTimes(1);
    const second = await manager.ensure(workspace, root);
    expect(second).not.toBe(first);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it.each(['page creation', 'desktop control'])(
    'rejects a context closed during pending %s and reopens without attaching stale control',
    async (phase) => {
      const gate = deferred<void>();
      const shared = new DesktopControl();
      const attach = vi.spyOn(shared, 'attach');
      const desktopControl = vi.fn(async () => {
        if (phase === 'desktop control') await gate.promise;
        return shared;
      });
      const { manager, root } = await setup({ desktopControl });
      const context = new Context();
      contexts.push(context);
      if (phase === 'page creation') {
        context.pages.mockReturnValue([]);
        context.newPage.mockImplementationOnce(async () => {
          await gate.promise;
          return context.page;
        });
      }
      driver.launchPersistentContext.mockResolvedValueOnce(context);
      const starting = manager.ensure(workspace, root);
      await vi.waitFor(() =>
        expect(phase === 'page creation' ? context.newPage : desktopControl).toHaveBeenCalledOnce()
      );
      context.emit('close');
      gate.resolve();
      await expect(starting).rejects.toThrow('Browser context closed during startup');
      expect(attach).not.toHaveBeenCalled();
      expect(context.close).toHaveBeenCalledOnce();

      const reopened = await manager.ensure(workspace, root);
      expect(reopened.context).toBe(contexts[1]);
      expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
      expect(attach).toHaveBeenCalledOnce();
      context.emit('close');
      expect(await manager.ensure(workspace, root)).toBe(reopened);
      await manager.close(workspace);
      await manager.ensure(workspace, root);
      expect(driver.launchPersistentContext).toHaveBeenCalledTimes(3);
    }
  );

  it('clears a failed launch so a later request can retry', async () => {
    const { manager, root } = await setup();
    driver.launchPersistentContext.mockRejectedValue(new Error('Launch refused'));
    const outcomes = await Promise.allSettled([
      manager.ensure(workspace, root),
      manager.ensure(workspace, root)
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(outcomes[0]).toEqual(outcomes[1]);
    const context = new Context();
    contexts.push(context);
    driver.launchPersistentContext.mockResolvedValue(context);
    await expect(manager.ensure(workspace, root)).resolves.toMatchObject({ context });
  });

  it('retries failed startup cleanup before launching a replacement context', async () => {
    const { manager, root } = await setup();
    const context = new Context();
    contexts.push(context);
    context.pages.mockReturnValue([]);
    context.newPage.mockRejectedValue(new Error('Page creation failed'));
    context.close.mockRejectedValueOnce(new Error('Close refused'));
    driver.launchPersistentContext.mockResolvedValueOnce(context);
    await expect(manager.ensure(workspace, root)).rejects.toThrow();
    expect(context.close).toHaveBeenCalledTimes(1);
    await expect(manager.ensure(workspace, root)).resolves.toBeDefined();
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(driver.launchPersistentContext).toHaveBeenCalledTimes(2);
  });
});

describe('first browser frame recovery', () => {
  const unavailable = () =>
    new Error(
      'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot'
    );

  it('captures a real frame after the compositor first refuses a screenshot', async () => {
    const { manager, root } = await setup();
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const frame = Buffer.from('newly rendered frame');
    page.screenshot.mockRejectedValueOnce(unavailable()).mockResolvedValueOnce(frame);
    const snapshot = await manager.snapshot(workspace, root, 'user');
    expect(snapshot.screenshotBase64).toBe(frame.toString('base64'));
    expect(page.screenshot).toHaveBeenCalledTimes(2);
    expect(page.screenshot.mock.invocationCallOrder[0]).toBeLessThan(
      page.evaluate.mock.invocationCallOrder[0]!
    );
    expect(page.evaluate.mock.invocationCallOrder[0]).toBeLessThan(
      page.screenshot.mock.invocationCallOrder[1]!
    );
  });

  it('saves the recovered PNG through the screenshot action file boundary', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const frame = Buffer.from('recovered PNG bytes');
    page.screenshot.mockRejectedValueOnce(unavailable()).mockResolvedValueOnce(frame);
    const result = await manager.act(
      workspace,
      root,
      { type: 'screenshot', path: 'proof.png' },
      'agent'
    );
    expect('path' in result && result.path).toBe(path.join('workspace', 'proof.png'));
    expect(await readFile(path.join(root, 'workspace', 'proof.png'))).toEqual(frame);
    expect(page.screenshot).toHaveBeenNthCalledWith(1, { type: 'png' });
    expect(page.screenshot).toHaveBeenNthCalledWith(2, { type: 'png' });
  });

  it.each([
    'Timeout 30000ms exceeded',
    'Permission denied',
    'Target page, context or browser has been closed'
  ])('propagates %s without a retry', async (message) => {
    const { manager, root } = await setup();
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const failure = new Error(`page.screenshot: ${message}`);
    page.screenshot.mockRejectedValue(failure);
    await expect(manager.snapshot(workspace, root, 'user')).rejects.toBe(failure);
    expect(page.screenshot).toHaveBeenCalledOnce();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('propagates a repeated compositor failure after one retry', async () => {
    const { manager, root } = await setup();
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const failure = unavailable();
    page.screenshot.mockRejectedValue(failure);
    await expect(manager.snapshot(workspace, root, 'user')).rejects.toBe(failure);
    expect(page.screenshot).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled rendering opportunity before retrying the frame', async () => {
    const { manager, root } = await setup();
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    page.screenshot.mockRejectedValueOnce(unavailable());
    page.evaluate.mockImplementationOnce(() => new Promise<[]>(() => {}));
    const snapshot = await manager.snapshot(workspace, root, 'user');
    expect(snapshot.screenshotBase64).toBe(Buffer.from('captured frame').toString('base64'));
    expect(page.screenshot).toHaveBeenCalledTimes(2);
  });

  it('does not retry a page closed while waiting for rendering', async () => {
    const { manager, root } = await setup();
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const failure = unavailable();
    page.screenshot.mockRejectedValueOnce(failure);
    page.evaluate.mockImplementationOnce(async () => {
      page.isClosed.mockReturnValue(true);
      return [];
    });
    await expect(manager.snapshot(workspace, root, 'user')).rejects.toBe(failure);
    expect(page.screenshot).toHaveBeenCalledOnce();
    expect(page.evaluate).toHaveBeenCalledOnce();
  });

  it('does not retry a page closed while its first capture was pending', async () => {
    const { manager, root } = await setup();
    await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const failure = unavailable();
    page.screenshot.mockImplementationOnce(async () => {
      page.isClosed.mockReturnValue(true);
      throw failure;
    });
    await expect(manager.snapshot(workspace, root, 'user')).rejects.toBe(failure);
    expect(page.screenshot).toHaveBeenCalledOnce();
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe('download event receipts', () => {
  const download = (body: string, filename = 'report.txt') => ({
    url: () => 'https://93.184.216.34/report.txt',
    suggestedFilename: () => filename,
    createReadStream: async () => Readable.from([Buffer.from(body)]),
    saveAs: async (destination: string) => writeFile(destination, body),
    delete: vi.fn(async () => {}),
    cancel: vi.fn(async () => {})
  });

  it('refuses a download directory symlink without creating anything outside the workspace', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const outside = await mkdtemp(path.join(tmpdir(), 'athanor-download-outside-'));
    roots.push(outside);
    await symlink(outside, path.join(root, 'workspace', 'downloads'));
    const session = await manager.ensure(workspace, root);
    const item = download('private export');
    contexts[0]!.page.emit('download', item);
    await Promise.all(session.pendingDownloads);
    expect(session.downloads.recent).toHaveLength(1);
    expect(session.downloads.recent[0]?.path).toBeNull();
    expect(session.downloads.recent[0]?.error).toEqual(expect.any(String));
    expect(await readdir(outside)).toEqual([]);
    expect(item.delete).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized download and releases its browser artifact', async () => {
    const { manager, root } = await setup({ maxFileBytes: 8 });
    await mkdir(path.join(root, 'workspace'));
    const session = await manager.ensure(workspace, root);
    const item = download('more than eight bytes');
    contexts[0]!.page.emit('download', item);
    await Promise.all(session.pendingDownloads);
    expect(session.downloads.recent).toHaveLength(1);
    expect(session.downloads.recent[0]).toMatchObject({ path: null, url: item.url() });
    expect(session.downloads.recent[0]?.error).toContain('8 byte file limit');
    await expect(lstat(path.join(root, session.downloadsDirectory))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(item.delete).toHaveBeenCalledTimes(1);
  });

  it('does not follow a dangling symlink at the downloaded filename', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const outside = await mkdtemp(path.join(tmpdir(), 'athanor-download-outside-'));
    roots.push(outside);
    const session = await manager.ensure(workspace, root);
    const directory = path.join(root, session.downloadsDirectory);
    await mkdir(directory, { recursive: true });
    await symlink(path.join(outside, 'target.txt'), path.join(directory, 'report.txt'));
    const item = download('private export');
    contexts[0]!.page.emit('download', item);
    await Promise.all(session.pendingDownloads);
    expect(session.downloads.recent).toHaveLength(1);
    expect(session.downloads.recent[0]?.path).toBeNull();
    expect(session.downloads.recent[0]?.error).toEqual(expect.any(String));
    expect(await readdir(outside)).toEqual([]);
    expect(item.delete).toHaveBeenCalledTimes(1);
  });

  it('preserves existing files while concurrent downloads choose the same name', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const session = await manager.ensure(workspace, root);
    const directory = path.join(root, session.downloadsDirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'report.txt'), 'owner copy');
    const items = [download('first export'), download('second export')];
    for (const item of items) contexts[0]!.page.emit('download', item);
    await Promise.all(session.pendingDownloads);
    expect(session.downloads.recent).toHaveLength(2);
    expect(session.downloads.recent.every((receipt) => receipt.path !== null)).toBe(true);
    const files = await readdir(directory);
    expect(files).toHaveLength(3);
    expect(await readFile(path.join(directory, 'report.txt'), 'utf8')).toBe('owner copy');
    expect(
      new Set(await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8'))))
    ).toEqual(new Set(['owner copy', 'first export', 'second export']));
    for (const item of items) expect(item.delete).toHaveBeenCalledTimes(1);
  });

  it('does not publish a partial stream and continues with the next download', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const session = await manager.ensure(workspace, root);
    const broken = download('partial', 'broken.txt');
    broken.createReadStream = async () =>
      Readable.from(
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('transfer failed');
        })()
      );
    const valid = download('complete', 'valid.txt');
    contexts[0]!.page.emit('download', broken);
    contexts[0]!.page.emit('download', valid);
    await Promise.all(session.pendingDownloads);
    expect(session.downloads.recent).toHaveLength(2);
    expect(session.downloads.recent[0]).toMatchObject({ path: null, error: 'transfer failed' });
    expect(await readdir(path.join(root, session.downloadsDirectory))).toEqual(['valid.txt']);
    expect(await readFile(path.join(root, session.downloadsDirectory, 'valid.txt'), 'utf8')).toBe(
      'complete'
    );
    expect(broken.delete).toHaveBeenCalledTimes(1);
    expect(valid.delete).toHaveBeenCalledTimes(1);
  });

  it('buffers only one completed download at a time', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const session = await manager.ensure(workspace, root);
    const reading = deferred<void>();
    const release = deferred<void>();
    let secondRead = false;
    const first = download('first', 'first.txt');
    first.createReadStream = async () =>
      Readable.from(
        (async function* () {
          reading.resolve();
          yield Buffer.from('first');
          await release.promise;
        })()
      );
    const second = download('second', 'second.txt');
    second.createReadStream = async () =>
      Readable.from(
        (async function* () {
          secondRead = true;
          yield Buffer.from('second');
        })()
      );
    contexts[0]!.page.emit('download', first);
    contexts[0]!.page.emit('download', second);
    try {
      await reading.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(secondRead).toBe(false);
    } finally {
      release.resolve();
    }
    await Promise.all(session.pendingDownloads);
    expect(secondRead).toBe(true);
    expect(session.downloads.recent).toHaveLength(2);
    expect(session.downloads.recent.every((receipt) => receipt.path !== null)).toBe(true);
  });

  it('reports failed temporary download cleanup without losing the saved receipt or logging its content', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const session = await manager.ensure(workspace, root);
    const item = download('complete');
    item.delete.mockRejectedValueOnce(new Error('Private export at /owner/private-report.csv'));
    const warning = vi.spyOn(runnerLogger, 'warn').mockImplementation(() => {});
    try {
      contexts[0]!.page.emit('download', item);
      await Promise.all(session.pendingDownloads);
      expect(session.downloads.recent).toHaveLength(1);
      expect(session.downloads.recent[0]?.path).toEqual(expect.any(String));
      expect(session.downloads.recent[0]?.error).toBeUndefined();
      expect(warning).toHaveBeenCalledExactlyOnceWith('browser.download_cleanup_failed', {
        code: 'Error'
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('stops retaining receipts when an action is aborted before its underlying work settles', async () => {
    const history = new BrowserDownloadHistory();
    const controller = new AbortController();
    const gate = deferred<void>();
    const first = { path: 'workspace/first.txt', url: 'https://93.184.216.34/first.txt' };
    const work = history.collect(async (receipts) => {
      await gate.promise;
      return receipts;
    }, controller.signal);
    history.record(first);
    controller.abort();
    history.record({ path: 'workspace/later.txt', url: 'https://93.184.216.34/later.txt' });
    gate.resolve();
    expect((await work).downloads).toEqual([first]);
    expect(history.recent).toHaveLength(2);
  });

  it('caps pending saves and accounts for cancelled overflow without growing receipts', async () => {
    const { manager, root } = await setup();
    await mkdir(path.join(root, 'workspace'));
    const session = await manager.ensure(workspace, root);
    const page = contexts[0]!.page;
    const gate = deferred<void>();
    const cancel = vi.fn(async () => {});
    page.screenshot.mockImplementationOnce(async () => {
      for (let index = 0; index < 180; index += 1) {
        page.emit('download', {
          url: () => `https://93.184.216.34/part-${index}.txt`,
          suggestedFilename: () => `part-${index}.txt`,
          cancel,
          delete: async () => {},
          createReadStream: async () => {
            await gate.promise;
            return Readable.from([Buffer.from(`part ${index}`)]);
          },
          saveAs: async (destination: string) => {
            await gate.promise;
            await writeFile(destination, `part ${index}`);
          }
        });
      }
      return Buffer.from('frame');
    });
    const action = manager.act(workspace, root, { type: 'screenshot', path: 'burst.png' }, 'agent');
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(116));
      expect(session.pendingDownloads.size).toBe(64);
    } finally {
      gate.resolve();
    }
    const result = await action;
    expect(result.downloads).toHaveLength(100);
    expect(result.downloadsCancelled).toBe(116);
    expect(result.downloadsOmitted + result.downloadErrorsOmitted + result.downloads.length).toBe(
      180
    );
    expect(
      result.downloads.filter((record) => record.path !== null).length + result.downloadsOmitted
    ).toBe(64);
    expect(
      result.downloads.filter((record) => record.error).length + result.downloadErrorsOmitted
    ).toBe(116);
    expect(await readdir(path.join(root, result.downloadsDirectory))).toHaveLength(64);
    expect(session.pendingDownloads.size).toBe(0);
    expect(session.downloads.recent).toHaveLength(25);
  });

  it.each([30, 120])(
    'accounts for %i saved files and releases finished action receipts',
    async (count) => {
      const { manager, root } = await setup();
      await mkdir(path.join(root, 'workspace'));
      const session = await manager.ensure(workspace, root);
      const page = contexts[0]!.page;
      page.screenshot.mockImplementationOnce(async () => {
        for (let index = 0; index < count; index += 1) {
          page.emit('download', {
            url: () => `https://93.184.216.34/part-${index}.txt`,
            suggestedFilename: () => `part-${index}.txt`,
            delete: async () => {},
            createReadStream: async () => Readable.from([Buffer.from(`part ${index}`)]),
            saveAs: async (destination: string) => writeFile(destination, `part ${index}`)
          });
          await Promise.all(session.pendingDownloads);
        }
        return Buffer.from('frame');
      });
      const first = await manager.act(
        workspace,
        root,
        { type: 'screenshot', path: 'first.png' },
        'agent'
      );
      expect(first.downloads).toHaveLength(Math.min(count, 100));
      expect(session.downloads.recent).toHaveLength(25);
      expect(first.downloadsOmitted).toBe(Math.max(0, count - 100));
      expect(first.downloadErrorsOmitted).toBe(0);
      expect(first.downloadsCancelled).toBe(0);
      expect(path.isAbsolute(first.downloadsDirectory)).toBe(false);
      expect(first.downloadsDirectory.startsWith('workspace/')).toBe(true);
      const files = await readdir(path.join(root, first.downloadsDirectory));
      expect(files).toHaveLength(count);
      const bodies = await Promise.all(
        files.map((file) => readFile(path.join(root, first.downloadsDirectory, file), 'utf8'))
      );
      expect(new Set(bodies)).toEqual(
        new Set(Array.from({ length: count }, (_, index) => `part ${index}`))
      );
      const second = await manager.act(
        workspace,
        root,
        { type: 'screenshot', path: 'second.png' },
        'agent'
      );
      expect(second.downloads).toEqual([]);
      session.downloads.record({ path: null, url: 'https://93.184.216.34/later.txt' });
      expect(first.downloads).toHaveLength(Math.min(count, 100));
    }
  );
});
