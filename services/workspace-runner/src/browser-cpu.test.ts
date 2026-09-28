/**
 * The walk that finds one workspace's Chromium tree and pushes it down the scheduler.
 *
 * Tested against a fake `/proc` because the behaviour worth pinning is which processes it picks and
 * which it leaves alone - a browser belonging to another workspace, a process already further down
 * than the target, one that exits mid-walk. The measured problem it exists for is the GPU process:
 * on a host with no GPU that is the one holding thirteen cores, and it is a child Playwright never
 * hands back, so matching has to be on the profile every Chromium process carries.
 */
import { describe, expect, it } from 'vitest';
import { dampenBrowserCpu, type BrowserCpuDeps } from './browser-cpu.js';

const PROFILE = '/home/garden/ws-1/.garden/browser';

const fakeProc = (
  processes: Record<number, { cmd: string; nice?: number }>,
  onSet?: (pid: number, priority: number) => void
): { deps: BrowserCpuDeps; moved: Map<number, number> } => {
  const moved = new Map<number, number>();
  const deps: BrowserCpuDeps = {
    listProcessIds: async () => Object.keys(processes).map(Number),
    commandLineOf: async (pid) => processes[pid]?.cmd ?? '',
    currentPriority: (pid) => {
      const entry = processes[pid];
      if (!entry) throw new Error('gone');
      return entry.nice ?? 0;
    },
    setPriority: (pid, priority) => {
      onSet?.(pid, priority);
      moved.set(pid, priority);
    }
  };
  return { deps, moved };
};

describe('pushing a browser down the scheduler', () => {
  it('moves the whole tree of one profile, the GPU process included', async () => {
    const { deps, moved } = fakeProc({
      10: { cmd: `chrome --user-data-dir=${PROFILE}` },
      11: { cmd: `chrome --type=gpu-process --user-data-dir=${PROFILE}` },
      12: { cmd: `chrome --type=renderer --user-data-dir=${PROFILE}` }
    });
    expect(await dampenBrowserCpu(deps, PROFILE, 10)).toBe(3);
    expect([...moved.entries()]).toEqual([
      [10, 10],
      [11, 10],
      [12, 10]
    ]);
  });

  it('leaves another workspace`s browser and unrelated processes alone', async () => {
    const { deps, moved } = fakeProc({
      10: { cmd: `chrome --user-data-dir=${PROFILE}` },
      20: { cmd: 'chrome --user-data-dir=/home/garden/ws-2/.garden/browser' },
      30: { cmd: 'postgres: writer process' }
    });
    expect(await dampenBrowserCpu(deps, PROFILE, 10)).toBe(1);
    expect([...moved.keys()]).toEqual([10]);
  });

  it('never pulls a process back up that is already further down', async () => {
    // Raising priority needs privileges the runner does not have, and a process somebody pushed
    // down deliberately is not this function's to move.
    const { deps, moved } = fakeProc({
      10: { cmd: `chrome --user-data-dir=${PROFILE}`, nice: 15 },
      11: { cmd: `chrome --type=gpu-process --user-data-dir=${PROFILE}`, nice: 10 }
    });
    expect(await dampenBrowserCpu(deps, PROFILE, 10)).toBe(0);
    expect(moved.size).toBe(0);
  });

  it('carries on when a process exits between the listing and the call', async () => {
    const { deps, moved } = fakeProc({
      10: { cmd: `chrome --user-data-dir=${PROFILE}` },
      11: { cmd: `chrome --type=gpu-process --user-data-dir=${PROFILE}` }
    });
    const guarded: BrowserCpuDeps = {
      ...deps,
      setPriority: (pid, priority) => {
        if (pid === 10) throw new Error('no such process');
        deps.setPriority(pid, priority);
      }
    };
    expect(await dampenBrowserCpu(guarded, PROFILE, 10)).toBe(1);
    expect([...moved.keys()]).toEqual([11]);
  });

  it('does nothing at all when it is switched off', async () => {
    const { deps, moved } = fakeProc({ 10: { cmd: `chrome --user-data-dir=${PROFILE}` } });
    expect(await dampenBrowserCpu(deps, PROFILE, 0)).toBe(0);
    expect(moved.size).toBe(0);
  });
});
