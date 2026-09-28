import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuiNamespaceManager } from './gui-namespace.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const setup = () => {
  const stop = vi.fn(async (): Promise<void> => undefined);
  const start = vi.fn(async (root: string) => ({ environment: { HOME: root }, stop }));
  return { stop, start, manager: new GuiNamespaceManager('/trusted/gui', start) };
};

describe('project GUI ownership', () => {
  it('shares a single namespace across simultaneous users and stops only after the last release', async () => {
    const { manager, start, stop } = setup();
    const [desktop, browser] = await Promise.all([
      manager.acquire('/project'),
      manager.acquire('/project')
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    await desktop.release();
    await desktop.release();
    expect(stop).not.toHaveBeenCalled();
    await browser.release();
    expect(stop).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it('separates roots and refuses aliases before launching anything', async () => {
    const { manager, start } = setup();
    const [one, two] = await Promise.all([manager.acquire('/one'), manager.acquire('/two')]);
    expect(one.environment.HOME).toBe('/one');
    expect(two.environment.HOME).toBe('/two');
    await expect(manager.acquire('/one/../two')).rejects.toThrow('canonical');
    await expect(manager.acquire('relative')).rejects.toThrow('canonical');
    expect(start).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('retains failed cleanup and refuses a replacement until the old namespace exits', async () => {
    const { manager, start, stop } = setup();
    const lease = await manager.acquire('/project');
    stop.mockRejectedValue(new Error('busy'));
    await expect(lease.release()).rejects.toThrow('busy');
    await expect(manager.acquire('/project')).rejects.toThrow('busy');
    expect(start).toHaveBeenCalledTimes(1);
    stop.mockResolvedValue();
    const next = await manager.acquire('/project');
    expect(start).toHaveBeenCalledTimes(2);
    await lease.release();
    expect(stop).toHaveBeenCalledTimes(3);
    await next.release();
    expect(stop).toHaveBeenCalledTimes(4);
    await manager.close();
  });

  it('waits for teardown before reusing a root, while other projects remain usable', async () => {
    const { manager, start, stop } = setup();
    const lease = await manager.acquire('/project');
    let finish!: () => void;
    stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const closing = lease.release();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    const next = manager.acquire('/project');
    const other = await manager.acquire('/other');
    expect(start.mock.calls.map(([root]) => root)).toEqual(['/project', '/other']);
    finish();
    await closing;
    await (await next).release();
    await other.release();
    await manager.close();
  });

  it('a failed forced close blocks reuse even while old leases still exist', async () => {
    const { manager, start, stop } = setup();
    const lease = await manager.acquire('/project');
    stop.mockRejectedValue(new Error('busy'));
    await expect(manager.closeRoot('/project')).rejects.toThrow('GUI project cleanup failed');
    await expect(manager.acquire('/project')).rejects.toThrow('busy');
    expect(start).toHaveBeenCalledTimes(1);
    stop.mockResolvedValue();
    await manager.closeRoot('/project');
    const next = await manager.acquire('/project');
    await lease.release();
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(3);
    await next.release();
    await manager.close();
  });

  it('destroys research namespaces and their private files without closing the project desktop', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gui-research-')));
    roots.push(root);
    const { manager, start, stop } = setup();
    const desktop = await manager.acquire(root);
    const research = await manager.acquireTemporary(root);
    const researchRoot = start.mock.calls[1]?.[0];
    expect(researchRoot).toContain(`${root}/.garden/gui/research/session-`);
    await research.release();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await readdir(path.join(root, '.garden/gui/research'))).toEqual([]);
    const next = await manager.acquireTemporary(root);
    await manager.closeRoot(root);
    expect(stop).toHaveBeenCalledTimes(3);
    await Promise.all([desktop.release(), next.release()]);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(await readdir(path.join(root, '.garden/gui/research'))).toEqual([]);
    await manager.close();
  });

  it('shutdown waits for startup, releases every root, and refuses new leases', async () => {
    const { manager, start, stop } = setup();
    let finish!: () => void;
    start.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { environment: { HOME: '/project' }, stop };
    });
    const acquiring = manager.acquire('/project');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    const closing = manager.close();
    finish();
    await acquiring;
    await closing;
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(manager.acquire('/other')).rejects.toThrow('closed');
  });
});
