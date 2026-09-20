import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  parseProcessStat,
  parseAccountScan,
  ACCOUNT_PROCESS_SCAN,
  ProcessResources,
  PROCESS_SAMPLE_MS,
  type ProcessScan,
  type ProcessStat
} from './process-resources.js';

const stat = (pid: number, extra: Partial<ProcessStat> = {}): ProcessStat => ({
  pid,
  parent: 1,
  group: pid,
  session: pid,
  name: 'analysis',
  state: 'S',
  ticks: 0,
  started: 10,
  residentPages: 128,
  threads: 1,
  ...extra
});
const target = { id: 'job', pid: 40, generation: 'initial' };
const scanAt = (at: number, processes: ProcessStat[]): ProcessScan => ({
  at,
  processes,
  ticksPerSecond: 100,
  pageBytes: 4096
});

describe('project process resource observations', () => {
  it.each([false, true])(
    'accounts for a private namespace with visible init=%s without counting CPU twice',
    async (visibleInit) => {
      let now = 1_000;
      let reapedTicks = 100;
      const child = stat(90, { parent: 70, namespace: '555', ticks: 200 });
      const sameGroupElsewhere = stat(99, { parent: 70, group: 40, session: 40, namespace: '777' });
      let observed = true;
      const namespace = vi.fn(async () => {
        if (!observed) return null;
        const columns = Array.from({ length: 22 }, () => '0');
        columns[0] = 'S';
        columns[1] = '69';
        columns[2] = '69';
        columns[3] = '69';
        columns[11] = String(reapedTicks);
        columns[17] = '1';
        columns[19] = '100';
        return { id: '555', stat: `70 (namespace init) ${columns.join(' ')}` };
      });
      const sampler = new ProcessResources(
        async () => ({
          ...scanAt(now, [
            ...(visibleInit ? [stat(70, { namespace: '555', ticks: reapedTicks })] : []),
            child,
            sameGroupElsewhere
          ]),
          accountScoped: true
        }),
        () => now
      );
      await sampler.refresh([{ ...target, namespace }]);
      expect(sampler.sample('job')?.children.map((item) => item.pid)).toEqual(
        visibleInit ? [70, 90] : [90]
      );
      expect(sampler.sample('job')?.residentBytes).toBe((visibleInit ? 2 : 1) * 128 * 4096);
      now += PROCESS_SAMPLE_MS;
      reapedTicks += 6_000;
      child.ticks += 6_000;
      await sampler.refresh([{ ...target, namespace }]);
      expect(sampler.sample('job')?.cpuPercent).toBe(100);
      await sampler.refresh([{ ...target, namespace }]);
      expect(namespace).toHaveBeenCalledTimes(2);
      observed = false;
      now += PROCESS_SAMPLE_MS;
      await sampler.refresh([{ ...target, namespace }]);
      expect(sampler.state('job')).toBe('unavailable');
      expect(sampler.sample('job')?.sampledAt).toBe(
        new Date(now - PROCESS_SAMPLE_MS).toISOString()
      );
    }
  );
  it('executes the fixed unprivileged observer against accounting fixtures without reading arguments or environment', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-account-proc-'));
    try {
      await mkdir(path.join(root, '101'));
      await writeFile(path.join(root, 'uptime'), '1000.0 200.0');
      const columns = Array.from({ length: 22 }, () => '0');
      columns[0] = 'R';
      columns[1] = '40';
      columns[2] = '40';
      columns[3] = '40';
      columns[11] = '20';
      columns[12] = '10';
      columns[17] = '4';
      columns[19] = '100';
      columns[21] = '256';
      await writeFile(path.join(root, '101/stat'), `101 (analysis) ${columns.join(' ')}`);
      await writeFile(path.join(root, '101/environ'), 'PRIVATE_ENV_CANARY');
      await writeFile(path.join(root, '101/cmdline'), 'PRIVATE_ARGUMENT_CANARY');
      const marker = 'pathlib.Path("/proc")';
      expect(ACCOUNT_PROCESS_SCAN.split(marker)).toHaveLength(2);
      const fixture = ACCOUNT_PROCESS_SCAN.replace(marker, `pathlib.Path(${JSON.stringify(root)})`);
      const { stdout } = await promisify(execFile)('/usr/bin/python3', ['-I', '-S', '-c', fixture]);
      const observed = parseAccountScan(JSON.parse(stdout));
      expect(observed.processes).toHaveLength(1);
      expect(observed.processes[0]).toMatchObject({
        pid: 101,
        group: 40,
        ticks: 30,
        residentPages: 256
      });
      expect(stdout).not.toContain('CANARY');
      await expect(
        promisify(execFile)('/usr/bin/python3', [
          '-I',
          '-S',
          '-c',
          `import os; os.geteuid=lambda:0\n${fixture}`
        ])
      ).rejects.toThrow('unprivileged');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('parses accounting fields without splitting a name containing parentheses or spaces', () => {
    const columns = Array.from({ length: 22 }, () => '0');
    columns[0] = 'R';
    columns[1] = '39';
    columns[2] = '40';
    columns[3] = '40';
    columns[11] = '100';
    columns[12] = '20';
    columns[13] = '70';
    columns[14] = '10';
    columns[17] = '8';
    columns[19] = '1234';
    columns[21] = '512';
    expect(parseProcessStat(`40 (align (part 2)) ${columns.join(' ')}`)).toEqual({
      pid: 40,
      parent: 39,
      group: 40,
      session: 40,
      name: 'align (part 2)',
      state: 'R',
      ticks: 200,
      threads: 8,
      started: 1234,
      residentPages: 512
    });
    expect(parseProcessStat('40 malformed')).toBeNull();
    columns[21] = '-10';
    expect(parseProcessStat(`40 (align) ${columns.join(' ')}`)).toBeNull();
  });
  it('counts the whole tree, including a new child session, without including sibling work', async () => {
    let now = 1_000;
    const processes = [
      stat(40),
      stat(41, { parent: 40, group: 40, session: 40, threads: 8 }),
      stat(42, { parent: 41 }),
      stat(50)
    ];
    const scan = vi.fn(async () => scanAt(now, processes));
    const sampler = new ProcessResources(scan, () => now);
    await sampler.refresh([target]);
    expect(sampler.sample('job')).toMatchObject({
      cpuPercent: null,
      processCount: 3,
      threadCount: 10,
      residentBytes: 3 * 128 * 4096
    });
    expect(sampler.sample('job')!.children.map((item) => item.pid)).toEqual([40, 41, 42]);
    now += PROCESS_SAMPLE_MS;
    processes[1]!.ticks += 24_000;
    await sampler.refresh([target]);
    expect(sampler.sample('job')).toMatchObject({ cpuPercent: 200, intervalMs: PROCESS_SAMPLE_MS });
  });
  it('coalesces simultaneous requests and caches reads between sample intervals', async () => {
    let now = 1_000;
    const scan = vi.fn(async () => scanAt(now, [stat(40)]));
    const sampler = new ProcessResources(scan, () => now);
    await Promise.all([
      sampler.refresh([target]),
      sampler.refresh([target]),
      sampler.refresh([target])
    ]);
    await sampler.refresh([target]);
    expect(scan).toHaveBeenCalledTimes(1);
    now += PROCESS_SAMPLE_MS;
    await sampler.refresh([target]);
    expect(scan).toHaveBeenCalledTimes(2);
  });
  it('samples analysis children while ProtectProc hides their live control wrapper', async () => {
    let now = 1000;
    const child = stat(41, { parent: 40, group: 40, session: 40 });
    const scanner = new ProcessResources(
      async () => ({ ...scanAt(now, [child, stat(99)]), accountScoped: true }),
      () => now
    );
    await scanner.refresh([target]);
    expect(scanner.sample('job')?.children.map((item) => item.pid)).toEqual([41]);
    now += PROCESS_SAMPLE_MS;
    child.ticks += 12_000;
    await scanner.refresh([target]);
    expect(scanner.sample('job')?.cpuPercent).toBe(100);
    now += PROCESS_SAMPLE_MS;
    await scanner.refresh([]);
    expect(scanner.sample('job')).toBeUndefined();
    const unreadable = new ProcessResources(
      async () => scanAt(now, [child]),
      () => now
    );
    await unreadable.refresh([target]);
    expect(unreadable.sample('job')).toBeUndefined();
    expect(() =>
      parseAccountScan({
        at: now,
        uid: 0,
        ticksPerSecond: 100,
        pageBytes: 4096,
        uptimeSeconds: 1000,
        stats: []
      })
    ).toThrow();
    expect(() =>
      parseAccountScan({
        at: now,
        uid: 1001,
        ticksPerSecond: 0,
        pageBytes: 4096,
        uptimeSeconds: 1000,
        stats: []
      })
    ).toThrow();
  });
  it('does not attribute a reused PID to the original run, but accepts an explicit service restart', async () => {
    let now = 1_000;
    let process = stat(40);
    const sampler = new ProcessResources(
      async () => scanAt(now, [process]),
      () => now
    );
    await sampler.refresh([target]);
    process = stat(40, { started: 20 });
    for (let i = 0; i < 2; i++) {
      now += PROCESS_SAMPLE_MS;
      await sampler.refresh([target]);
      expect(sampler.sample('job')).toBeUndefined();
    }
    now += PROCESS_SAMPLE_MS;
    await sampler.refresh([{ ...target, generation: 'restarted' }]);
    expect(sampler.sample('job')).toMatchObject({ cpuPercent: null });
  });
  it('preserves sample time through read failures and does not invent zero CPU on decreasing counters', async () => {
    let now = 1_000;
    let observation: ProcessScan | null = scanAt(now, [stat(40, { ticks: 100 })]);
    const sampler = new ProcessResources(
      async () => observation,
      () => now
    );
    await sampler.refresh([target]);
    const original = sampler.sample('job');
    observation = null;
    now += PROCESS_SAMPLE_MS;
    await sampler.refresh([target]);
    expect(sampler.available).toBe(false);
    expect(sampler.sample('job')).toEqual(original);
    now += PROCESS_SAMPLE_MS;
    observation = scanAt(now, [stat(40, { ticks: 50 })]);
    await sampler.refresh([target]);
    expect(sampler.sample('job')?.cpuPercent).toBeNull();
  });
  it('drops state for retired records without scanning an idle machine', async () => {
    let now = 1_000;
    const scan = vi.fn(async () => scanAt(now, [stat(40)]));
    const sampler = new ProcessResources(scan, () => now);
    await sampler.refresh([target]);
    now += PROCESS_SAMPLE_MS;
    await sampler.refresh([]);
    expect(sampler.sample('job')).toBeUndefined();
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
