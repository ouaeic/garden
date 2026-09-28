import type * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import type * as fileSystem from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopManager } from './desktop.js';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

class Child extends EventEmitter {
  readonly pid = 12345;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = {
    end: () => queueMicrotask(() => this.finish()),
    write: vi.fn((_data: string, callback: (error?: Error | null) => void) => {
      callback(null);
      return true;
    })
  };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => {
    this.finish();
    return true;
  });
  finish(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit('exit', 0, null);
    this.emit('close', 0, null);
  }
}

const sessionExecutable = '/nonexistent/garden-test-desktop';
const starts: Array<{ root: string; display: string; child: Child }> = [];
const spawned: Array<{ executable: string; args: readonly string[]; child: Child }> = [];
const bridgeRequests: string[] = [];
let blockedOperation = '';
let windowList = '_NET_CLIENT_LIST(WINDOW): window id #\n';
const environment = (display: string) =>
  `DISPLAY=:${display}\nXAUTHORITY=/nonexistent/authority\nDBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/bus\nXDG_RUNTIME_DIR=/nonexistent/runtime\n`;
let readEnvironment = (root: string): Promise<string> =>
  Promise.resolve(environment([...starts].reverse().find((entry) => entry.root === root)!.display));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    spawn: (executable: string, args: readonly string[]) => {
      const child = new Child();
      if (executable === '/usr/bin/xprop') queueMicrotask(() => child.stdout.write(windowList));
      spawned.push({ executable, args, child });
      if (executable === sessionExecutable)
        starts.push({ root: args[0]!, display: args[1]!, child });
      if (args.includes('--serve'))
        child.stdin.write.mockImplementation((data, callback) => {
          const request = JSON.parse(data) as { operation: string };
          bridgeRequests.push(request.operation);
          callback(null);
          if (request.operation !== blockedOperation)
            queueMicrotask(() =>
              child.stdout.write(
                JSON.stringify({ result: { atspi: true }, nodes: [], windows: [] }) + '\n'
              )
            );
          return true;
        });
      return child;
    }
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fileSystem>();
  return {
    ...actual,
    rm: (file: string, ...args: unknown[]) => {
      if (file.endsWith('/.garden/desktop/environment')) return Promise.resolve();
      return Reflect.apply(actual.rm, actual, [file, ...args]) as unknown;
    },
    readFile: (file: string, ...args: unknown[]) => {
      if (file.endsWith('/.garden/desktop/environment'))
        return readEnvironment(file.slice(0, -'/.garden/desktop/environment'.length));
      return Reflect.apply(actual.readFile, actual, [file, ...args]) as unknown;
    }
  };
});

const roots: string[] = [];
const managers: DesktopManager[] = [];
const workspace = 'desktop-lifecycle';
const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'garden-desktop-lifecycle-'));
  roots.push(root);
  const manager = new DesktopManager('/nonexistent/bridge', sessionExecutable);
  managers.push(manager);
  return { manager, root };
};

afterEach(async () => {
  vi.useRealTimers();
  for (const entry of starts) entry.child.finish();
  await Promise.all(managers.splice(0).map((manager) => manager.close(workspace)));
  starts.splice(0);
  for (const entry of spawned.splice(0)) entry.child.finish();
  bridgeRequests.splice(0);
  blockedOperation = '';
  windowList = '_NET_CLIENT_LIST(WINDOW): window id #\n';
  readEnvironment = (root) =>
    Promise.resolve(
      environment([...starts].reverse().find((entry) => entry.root === root)!.display)
    );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('desktop session ownership', () => {
  it('retires an unused empty display while preserving browsers, programs, and windows', async () => {
    const { manager, root } = await setup();
    const session = await manager.ensure(workspace, root);
    expect(await manager.retireIdle(() => true, 0)).toEqual([]);
    session.applicationGroups.add(99999);
    expect(await manager.retireIdle(() => false, 0)).toEqual([]);
    session.applicationGroups.clear();
    windowList = '_NET_CLIENT_LIST(WINDOW): window id # 0x2001\n';
    expect(await manager.retireIdle(() => false, 0)).toEqual([]);
    windowList = 'unknown display';
    expect(await manager.retireIdle(() => false, 0)).toEqual([]);
    windowList = '_NET_CLIENT_LIST(WINDOW): window id #\n';
    expect(await manager.retireIdle(() => false, 0)).toEqual([workspace]);
    expect(session.process.exitCode).toBe(0);
  });
  for (const ending of ['close', 'exit'] as const)
    for (const operation of ['ping', 'observe', 'act'] as const) {
      it(`rejects an active ${operation} and queued observation on ${ending} without fallback`, async () => {
        const { manager, root } = await setup();
        const session = await manager.ensure(workspace, root);
        blockedOperation = operation;
        if (operation === 'act') await manager.setHolder(workspace, root, 'user');
        const first =
          operation === 'act'
            ? manager.act(workspace, root, { type: 'focus', nodeId: '0' }, 'user')
            : manager.snapshot(workspace, root, 'user');
        const queued = manager.snapshot(workspace, root, 'user');
        const outcomes = Promise.allSettled([first, queued]);
        await vi.waitFor(() => expect(bridgeRequests).toContain(operation));
        const count = spawned.length;
        if (ending === 'close') await manager.close(workspace);
        else starts[0]!.child.finish();
        const result = await Promise.race([
          outcomes,
          new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50))
        ]);
        expect(result).not.toBe('hung');
        if (result === 'hung') return;
        expect(result.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
        expect(spawned).toHaveLength(count);
        await expect(session.bridgeQueue).resolves.toBeUndefined();
      });
    }

  it.each(['close', 'exit'] as const)(
    'does not let a late unsubscribe or control callback touch a display reused after %s',
    async (ending) => {
      const { manager, root } = await setup();
      const session = await manager.ensure(workspace, root);
      session.geometry = { width: 1600, height: 900 };
      const subscriber = { state: vi.fn(), frame: vi.fn() };
      const unsubscribe = await manager.subscribeStream(workspace, root, subscriber);
      if (ending === 'close') await manager.close(workspace);
      else starts[0]!.child.finish();
      const otherRoot = await mkdtemp(path.join(tmpdir(), 'garden-desktop-lifecycle-'));
      roots.push(otherRoot);
      const other = await manager.ensure('other-workspace', otherRoot);
      expect(other.env.DISPLAY).toBe(session.env.DISPLAY);
      const count = spawned.length;
      const stateCalls = subscriber.state.mock.calls.length;
      vi.useFakeTimers();
      session.control.bumpGeneration();
      await unsubscribe();
      await vi.advanceTimersByTimeAsync(60_001);
      expect(spawned).toHaveLength(count);
      expect(subscriber.state).toHaveBeenCalledTimes(stateCalls);
      expect(session.restore).toBeUndefined();
      await manager.close('other-workspace');
    }
  );

  it('cancels an active wait and refuses its queued action when the session closes', async () => {
    const { manager, root } = await setup();
    const session = await manager.ensure(workspace, root);
    const waiting = manager.act(workspace, root, { type: 'wait', milliseconds: 10_000 }, 'agent');
    const queued = manager.act(workspace, root, { type: 'press', key: 'Escape' }, 'agent');
    const outcomes = Promise.allSettled([waiting, queued]);
    await vi.waitFor(() => expect(session.control.pending).toBeGreaterThan(0));
    const count = spawned.length;
    await manager.close(workspace);
    const result = await Promise.race([
      outcomes,
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50))
    ]);
    expect(result).not.toBe('hung');
    if (result === 'hung') return;
    expect(result.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    expect(spawned).toHaveLength(count);
  });

  it('restores the boot geometry after the final viewer leaves a live session', async () => {
    const { manager, root } = await setup();
    const session = await manager.ensure(workspace, root);
    session.geometry = { width: 1600, height: 900 };
    const unsubscribe = await manager.subscribeStream(workspace, root, {
      state: vi.fn(),
      frame: vi.fn()
    });
    vi.useFakeTimers();
    await unsubscribe();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(session.geometry).toEqual(session.bootGeometry);
    expect(
      spawned.filter(
        (entry) => entry.executable === '/usr/bin/xrandr' && entry.args.includes('--output')
      )
    ).not.toHaveLength(0);
  });

  it('shares one ready process across simultaneous cold reads', async () => {
    const { manager, root } = await setup();
    const [first, second] = await Promise.all([
      manager.ensure(workspace, root),
      manager.ensure(workspace, root)
    ]);
    expect(starts).toHaveLength(1);
    expect(first).toBe(second);
  });

  it('reserves different displays for different workspaces starting concurrently', async () => {
    const { manager, root } = await setup();
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'garden-desktop-lifecycle-'));
    roots.push(otherRoot);
    const [first, second] = await Promise.all([
      manager.ensure(workspace, root),
      manager.ensure('other-workspace', otherRoot)
    ]);
    expect(starts).toHaveLength(2);
    expect(first.env.DISPLAY).not.toBe(second.env.DISPLAY);
    await manager.close('other-workspace');
  });

  it('stops a pending startup before close returns and can reopen afterwards', async () => {
    const { manager, root } = await setup();
    const gate = deferred<string>();
    readEnvironment = () => gate.promise;
    const starting = manager.ensure(workspace, root);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const closing = manager.close(workspace);
    gate.resolve(environment(starts[0]!.display));
    const first = await starting;
    await closing;
    expect(starts[0]!.child.kill).toHaveBeenCalled();
    expect(starts[0]!.child.exitCode).not.toBeNull();
    readEnvironment = () => Promise.resolve(environment(starts.at(-1)!.display));
    const second = await manager.ensure(workspace, root);
    expect(second).not.toBe(first);
    expect(starts).toHaveLength(2);
  });

  it('waits for the old process to exit before a concurrent reopen', async () => {
    const { manager, root } = await setup();
    const first = await manager.ensure(workspace, root);
    const child = starts[0]!.child;
    child.kill.mockImplementationOnce(() => true);
    const closing = manager.close(workspace);
    let returned = false;
    const reopening = manager.ensure(workspace, root).then((session) => {
      returned = true;
      return session;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const returnedBeforeClose = returned;
    child.finish();
    await closing;
    const second = await reopening;
    expect(returnedBeforeClose).toBe(false);
    expect(second).not.toBe(first);
    expect(starts).toHaveLength(2);
  });

  it('kills a process whose startup environment is malformed before retrying', async () => {
    const { manager, root } = await setup();
    readEnvironment = () => Promise.resolve(environment('90') + 'malformed-line');
    await expect(manager.ensure(workspace, root)).rejects.toThrow('environment is malformed');
    expect(starts[0]!.child.kill).toHaveBeenCalled();
    expect(starts[0]!.child.exitCode).not.toBeNull();
    readEnvironment = () => Promise.resolve(environment(starts.at(-1)!.display));
    await expect(manager.ensure(workspace, root)).resolves.toBeDefined();
    expect(starts).toHaveLength(2);
  });

  it('refuses a desktop without authorization and passes the private authority path to the browser', async () => {
    const { manager, root } = await setup();
    readEnvironment = () =>
      Promise.resolve(environment('90').replace('XAUTHORITY=/nonexistent/authority\n', ''));
    await expect(manager.ensure(workspace, root)).rejects.toThrow('no X11 authorization');
    expect(starts[0]!.child.kill).toHaveBeenCalled();
    readEnvironment = () => Promise.resolve(environment('90'));
    expect(await manager.displayEnvironment(workspace, root)).toMatchObject({
      XAUTHORITY: '/nonexistent/authority'
    });
  });

  it('rejects an incomplete environment and reaps the process after readiness expires', async () => {
    const { manager, root } = await setup();
    vi.useFakeTimers();
    readEnvironment = () => Promise.resolve('DISPLAY=:90\n');
    const rejected = expect(manager.ensure(workspace, root)).rejects.toThrow(
      'did not become ready'
    );
    await vi.runAllTimersAsync();
    await rejected;
    expect(starts).toHaveLength(1);
    expect(starts[0]!.child.kill).toHaveBeenCalled();
    expect(starts[0]!.child.exitCode).not.toBeNull();
  });

  it('recreates an exited session on the next read', async () => {
    const { manager, root } = await setup();
    const first = await manager.ensure(workspace, root);
    starts[0]!.child.finish();
    const second = await manager.ensure(workspace, root);
    expect(second).not.toBe(first);
    expect(starts).toHaveLength(2);
  });

  it('retains an unresponsive startup process until cleanup succeeds', async () => {
    const { manager, root } = await setup();
    vi.useFakeTimers();
    readEnvironment = () => {
      starts[0]!.child.kill.mockImplementation(() => true);
      return Promise.resolve(environment('90') + 'malformed-line');
    };
    const rejected = expect(manager.ensure(workspace, root)).rejects.toThrow();
    await vi.runAllTimersAsync();
    await rejected;
    expect(starts).toHaveLength(1);
    const child = starts[0]!.child;
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.exitCode).toBeNull();
    vi.useRealTimers();
    readEnvironment = (workspaceRoot) =>
      Promise.resolve(
        environment([...starts].reverse().find((entry) => entry.root === workspaceRoot)!.display)
      );
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'garden-desktop-lifecycle-'));
    roots.push(otherRoot);
    const other = await manager.ensure('other-workspace', otherRoot);
    expect(other.env.DISPLAY).not.toBe(`:${starts[0]!.display}`);
    child.kill.mockImplementation(() => {
      child.finish();
      return true;
    });
    await expect(manager.ensure(workspace, root)).resolves.toBeDefined();
    expect(child.kill).toHaveBeenCalledTimes(3);
    expect(child.exitCode).not.toBeNull();
    await manager.close('other-workspace');
  });
});
