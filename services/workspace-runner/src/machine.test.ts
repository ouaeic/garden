/**
 * The machine block, attacked from both sides of the one claim it makes: that every number in it
 * is what this process may ACTUALLY have.
 *
 * Two failures are available here and they are not the same size. Saying nothing costs the agent a
 * line and it goes and checks. Saying sixteen cores on a box quota'd to two, or 21.9 GiB on a
 * container capped at 2, costs the agent nothing until the job is already running - a model that
 * is handed a number does not go and check it, which is the whole reason the line is worth having
 * and the whole reason a wrong one is worse than none. So every case below either proves the
 * cgroup wins over the hardware, or proves a field that cannot be established is absent.
 *
 * The cgroup files are REAL FILES in a real directory with the kernel's own formats in them -
 * `max 100000`, `200000 100000`, `0-3,8`, the `0::` line of /proc/self/cgroup. Parsing those four
 * shapes is the whole of what this can get wrong, and a stub handing back pre-parsed objects would
 * prove none of it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityAudience, signCapabilityToken } from '@garden/core';
import type { RunnerConfig } from './config.js';
import { ensureWorkspace } from './files.js';
import {
  cpuSetCount,
  machineReport,
  machineSummary,
  readCgroup,
  type MachineReport
} from './machine.js';
import { buildServer } from './server.js';

const GIB = 1024 ** 3;

/** The owner's box, which is the shape every number in the brief was measured on. */
const OWNER_CORES = 16;
const OWNER_COMMAND_MEMORY = Math.floor((31.34 * GIB * 7) / 10);
const OWNER_DISK_TOTAL = 832_000_000_000;
const OWNER_DISK_FREE = 800_600_000_000;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

/**
 * A cgroup v2 hierarchy on disk, written the way the kernel writes one.
 *
 * `levels` is root-first: each entry is one directory down from the hierarchy root, and each may
 * set any of the three files or none of them. That shape is what makes the ancestor cases sayable
 * - on the owner's box the ceiling that kills is on the unit and the one on `system.slice` above
 * it could just as easily be the tighter of the two.
 */
const cgroupTree = async (
  levels: ReadonlyArray<{
    name: string;
    cpuMax?: string;
    memoryMax?: string;
    cpuSet?: string;
  }>,
  options: {
    selfLine?: string;
    omitLeafDirectory?: boolean;
    /**
     * Names at the leaf that are THERE and will not answer, written as directories.
     *
     * A directory where the kernel would have put a file is `EISDIR` for every uid, which is what
     * makes this the right way to say "unreadable" in a suite: `chmod 000` says nothing at all
     * when the suite runs as root, and this file's whole subject is the difference between a limit
     * that is absent and one that cannot be seen. It is also a shape a real box produces - a bind
     * mount over `/sys/fs/cgroup` leaves exactly this.
     */
    unreadable?: readonly string[];
    /** The same, for `/proc/self/cgroup` itself. */
    selfUnreadable?: boolean;
  } = {}
): Promise<{ root: string; self: string }> => {
  const base = await mkdtemp(path.join(tmpdir(), 'garden-cgroup-'));
  disposers.push(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'cgroup');
  await mkdir(root, { recursive: true });
  let at = root;
  for (const [index, level] of levels.entries()) {
    at = path.join(at, level.name);
    const last = index === levels.length - 1;
    if (last && options.omitLeafDirectory) break;
    await mkdir(at, { recursive: true });
    const blocked = new Set(last ? (options.unreadable ?? []) : []);
    const put = async (name: string, value: string | undefined) => {
      if (blocked.has(name)) return mkdir(path.join(at, name), { recursive: true });
      if (value !== undefined) await writeFile(path.join(at, name), `${value}\n`);
    };
    await put('cpu.max', level.cpuMax);
    await put('memory.max', level.memoryMax);
    await put('cpuset.cpus.effective', level.cpuSet);
  }
  const self = path.join(base, 'self-cgroup');
  if (options.selfUnreadable) await mkdir(self, { recursive: true });
  else
    await writeFile(
      self,
      options.selfLine ?? `0::/${levels.map((level) => level.name).join('/')}\n`
    );
  return { root, self };
};

describe('what the control group actually allows', () => {
  it('reads a quota, a ceiling and a pinning out of the kernel’s own formats', async () => {
    const { root, self } = await cgroupTree([
      { name: 'system.slice', memoryMax: String(25 * GIB) },
      { name: 'garden-runner.service', cpuMax: '200000 100000', cpuSet: '0-3,8' }
    ]);
    // 200000/100000 is two cores; the pinning offers five; the tighter of the two is the answer.
    await expect(readCgroup({ root, self })).resolves.toEqual({
      state: 'read',
      cpuCores: 2,
      memoryMaxBytes: 25 * GIB
    });
  });

  /**
   * `CPUWeight=50` is the directive the owner's unit actually carries, and it is a SHARE.
   *
   * It changes how the scheduler splits a contended processor and takes no core away, so a report
   * that let it reduce the count would understate the box by half on the one machine this ships
   * to. systemd renders it into `cpu.weight`, never into `cpu.max`, so the proof is that a
   * hierarchy carrying a weight and no quota reports no CPU ceiling at all.
   */
  it('does not mistake a weight for a quota', async () => {
    const { root, self } = await cgroupTree([
      { name: 'system.slice' },
      { name: 'garden-runner.service', cpuMax: 'max 100000', memoryMax: String(25 * GIB) }
    ]);
    await writeFile(path.join(root, 'system.slice', 'garden-runner.service', 'cpu.weight'), '50\n');
    await expect(readCgroup({ root, self })).resolves.toMatchObject({ cpuCores: null });
  });

  /** A limit on an ancestor binds a descendant that does not restate it, so the minimum wins. */
  it('takes the tightest limit down the chain, not the nearest one', async () => {
    const { root, self } = await cgroupTree([
      { name: 'system.slice', cpuMax: '100000 100000', memoryMax: String(4 * GIB) },
      { name: 'garden-runner.service', cpuMax: '800000 100000', memoryMax: String(25 * GIB) }
    ]);
    await expect(readCgroup({ root, self })).resolves.toEqual({
      state: 'read',
      cpuCores: 1,
      memoryMaxBytes: 4 * GIB
    });
  });

  it('says it does not know rather than guessing when the cgroup is not there to read', async () => {
    const { root, self } = await cgroupTree(
      [{ name: 'system.slice' }, { name: 'garden-runner.service' }],
      { omitLeafDirectory: true }
    );
    await expect(readCgroup({ root, self })).resolves.toEqual({ state: 'unreadable' });
  });

  /** A v1-only host has the file and no `0::` line, and v1 can carry a quota this never reads. */
  it('treats a hierarchy it cannot speak as unreadable, not as unlimited', async () => {
    const { root, self } = await cgroupTree([{ name: 'garden' }], {
      selfLine: '1:cpu,cpuacct:/garden\n2:memory:/garden\n'
    });
    await expect(readCgroup({ root, self })).resolves.toEqual({ state: 'unreadable' });
  });

  it('reports no cgroup at all where there is none', async () => {
    await expect(
      readCgroup({
        root: '/nonexistent-cgroup-root',
        self: '/nonexistent-proc-self-cgroup',
        // Named rather than inherited, so this case says something about the code on every host
        // rather than about the host the suite happens to be running on.
        platform: 'darwin'
      })
    ).resolves.toEqual({ state: 'absent' });
  });

  /**
   * THE OTHER HALF OF THE CASE ABOVE, AND THE ONE THAT WAS WRONG.
   *
   * There is no Linux host without `/proc/self/cgroup`. A process that cannot see it is one whose
   * `/proc` has been masked, which is a container - precisely the box where a quota binds and the
   * hardware's sixteen cores and 21.9 GiB are lies. This answered `absent` and handed both of them
   * over.
   */
  it('treats a Linux host with no proc/self/cgroup as a masked one, not as a laptop', async () => {
    await expect(
      readCgroup({
        root: '/nonexistent-cgroup-root',
        self: '/nonexistent-proc-self-cgroup',
        platform: 'linux'
      })
    ).resolves.toEqual({ state: 'unreadable' });
  });

  /*
   * ── THE FOUR CASES THAT FAIL IF A FILE THAT WILL NOT ANSWER READS AS ONE THAT SETS NO LIMIT ──
   *
   * Every case above this point reads files that are all there and all readable, which is the one
   * shape that cannot tell the two apart. Driven against a hierarchy with a real unreadable file
   * in it, the module reported: 21.9 GiB where the cgroup allowed 2.0, sixteen cores where it
   * allowed two, and a macOS laptop where there was a control group it could not open. Every one
   * of those contradicted this file's own header, which is why the repair is in the type.
   */
  it('withholds the ceiling it could not read, and keeps the one it could', async () => {
    const { root, self } = await cgroupTree(
      [
        { name: 'system.slice' },
        { name: 'garden.service', cpuMax: '200000 100000', memoryMax: String(2 * GIB) }
      ],
      { unreadable: ['memory.max'] }
    );
    await expect(readCgroup({ root, self })).resolves.toEqual({
      state: 'read',
      cpuCores: 2,
      memoryMaxBytes: 'unknown'
    });
  });

  /** And contagious down the chain: a readable cpuset beside an unreadable quota answers neither. */
  it('withholds the cores when the quota is there and will not answer', async () => {
    const { root, self } = await cgroupTree(
      [
        {
          name: 'garden.service',
          cpuMax: '200000 100000',
          memoryMax: String(2 * GIB),
          cpuSet: '0-1'
        }
      ],
      { unreadable: ['cpu.max'] }
    );
    await expect(readCgroup({ root, self })).resolves.toEqual({
      state: 'read',
      cpuCores: 'unknown',
      memoryMaxBytes: 2 * GIB
    });
  });

  it('treats a proc it cannot read as a control group that binds', async () => {
    const { root, self } = await cgroupTree(
      [{ name: 'garden.service', memoryMax: String(2 * GIB) }],
      { selfUnreadable: true }
    );
    await expect(readCgroup({ root, self })).resolves.toEqual({ state: 'unreadable' });
  });

  /** A byte count that will not parse is the same fact arriving by a different route. */
  it('does not read a ceiling it cannot parse as no ceiling at all', async () => {
    const { root, self } = await cgroupTree([
      { name: 'garden.service', cpuMax: '200000 100000', memoryMax: 'not-a-number' }
    ]);
    await expect(readCgroup({ root, self })).resolves.toEqual({
      state: 'read',
      cpuCores: 2,
      memoryMaxBytes: 'unknown'
    });
  });

  it('counts a cpuset list the way the kernel writes one', () => {
    expect(cpuSetCount('0-3,8')).toBe(5);
    expect(cpuSetCount('0')).toBe(1);
    // Empty is the hierarchy root saying nothing is pinned; `2-` is a file that did not parse, and
    // the two must not both be "no limit".
    expect(cpuSetCount('')).toBeNull();
    expect(cpuSetCount('2-')).toBe('unknown');
  });
});

describe('the three numbers the runtime block states', () => {
  const storage =
    (available: number, total = OWNER_DISK_TOTAL) =>
    async () => ({
      hostStorageTotalBytes: total,
      hostStorageAvailableBytes: available
    });

  /**
   * THE CASE THAT FAILS IF THE NUMBERS ARE THE HOST'S.
   *
   * Both inputs are the owner's real hardware - sixteen cores of affinity and a 21.94 GiB
   * per-command rlimit derived from 31.34 GiB of RAM - and the cgroup allows a fiftieth of it. A
   * report built from `os.availableParallelism()` and `commandLimits` alone passes every other
   * case in this file and fails this one, which is the only reason it is written this way round.
   */
  it('reports what the cgroup allows, never what the hardware has', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({
        state: 'read',
        cpuCores: 2,
        memoryMaxBytes: 2 * GIB
      }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.cores).toBe(2);
    expect(report.memoryBytes).toBe(2 * GIB);
    expect(report.summary).toContain('2 cores');
    expect(report.summary).toContain('2.0 GiB memory per command');
    // The hardware's own numbers, named here so this case fails loudly rather than by a digit.
    expect(report.summary).not.toContain('16 cores');
    expect(report.summary).not.toContain('21.9 GiB');
  });

  /** The mirror: with no cgroup ceiling the hardware IS the answer and must not be withheld. */
  it('reports the whole box when the control group takes nothing away', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({ state: 'read', cpuCores: null, memoryMaxBytes: null }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.cores).toBe(OWNER_CORES);
    expect(report.memoryBytes).toBe(OWNER_COMMAND_MEMORY);
    expect(report.summary).toContain('16 cores');
    expect(report.summary).toContain('21.9 GiB memory per command');
  });

  /**
   * The per-command rlimit is the other ceiling and it is usually the lower one.
   *
   * `MemoryMax=80%` and RLIMIT_DATA at 70% are set by different mechanisms and either can fire
   * first, so the report takes the smaller. On the owner's box that is the rlimit, which is the
   * number a single-process job actually dies at - and it dies saying so, where the cgroup's stop
   * is a mute SIGKILL. @see defaultMemoryLimitBytes in `limits.ts`.
   */
  it('takes the per-command ceiling when it is under the cgroup’s', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({
        state: 'read',
        cpuCores: null,
        memoryMaxBytes: Math.floor(31.34 * GIB * 0.8)
      }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.memoryBytes).toBe(OWNER_COMMAND_MEMORY);
  });

  /**
   * A cgroup that cannot be read withholds BOTH numbers, and this is the case that makes the
   * whole file worth writing rather than an obvious one.
   *
   * The tempting fallback - "we could not read the cgroup, so report the hardware" - is exactly
   * the container case: sixteen cores of affinity, a rlimit derived from the host's RAM, and a
   * quota nobody could see. Silence is the only honest answer, and the disk figure survives it
   * because `statfs` measured the filesystem rather than inferring it.
   */
  it('withholds both numbers when there is a control group it could not read', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({ state: 'unreadable' }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.cores).toBeNull();
    expect(report.memoryBytes).toBeNull();
    expect(report.summary).not.toContain('cores');
    expect(report.summary).not.toContain('memory per command');
    expect(report.summary).toContain('GiB free disk');
  });

  /**
   * "EVERY FIELD IS DROPPED INDEPENDENTLY", which the header promised and the arithmetic did not.
   *
   * The whole reading being unreadable withholds both numbers, above. One ceiling being unreadable
   * must withhold that one and leave the other standing - and above all must not answer it from
   * the rlimit, which is what produced `21.9 GiB` on a box the control group held to 2.0.
   */
  it('withholds only the number the cgroup could not answer', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({ state: 'read', cpuCores: 2, memoryMaxBytes: 'unknown' }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.cores).toBe(2);
    expect(report.memoryBytes).toBeNull();
    expect(report.summary).toContain('2 cores');
    expect(report.summary).not.toContain('memory per command');
    expect(report.summary).toContain('GiB free disk');
  });

  it('withholds the cores the same way, and keeps the ceiling it was given', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({
        state: 'read',
        cpuCores: 'unknown',
        memoryMaxBytes: 2 * GIB
      }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.cores).toBeNull();
    expect(report.memoryBytes).toBe(2 * GIB);
    expect(report.summary).not.toContain('cores');
    expect(report.summary).toContain('2.0 GiB memory per command');
  });

  /** No cgroup v2 at all is a different fact: a macOS laptop has no second ceiling to miss. */
  it('answers from affinity on a host that has no control groups', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: 8 * GIB,
      parallelism: () => 10,
      readCgroupLimits: async () => ({ state: 'absent' }),
      storage: storage(OWNER_DISK_FREE)
    });
    expect(report.cores).toBe(10);
    expect(report.memoryBytes).toBe(8 * GIB);
  });

  /**
   * The disk figure is the headroom the write guard will allow, not the headroom `df` prints.
   *
   * A write that would take the filesystem under `hostStorageFloorBytes` is refused, so the floor
   * is already spent from the agent's side. On the owner's 832 GB disk the floor is 2% - 16.64 GB
   * - so 800.6 GB free is 730.1 GiB the agent may actually write, and a block that said 745.6
   * would be promising 15.5 GiB that `assertHostStorageWrite` throws on.
   */
  it('states the disk the guard will let it write, not the disk that is free', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      parallelism: () => OWNER_CORES,
      readCgroupLimits: async () => ({ state: 'absent' }),
      storage: storage(OWNER_DISK_FREE)
    });
    const floor = OWNER_DISK_TOTAL * 0.02;
    expect(report.diskBytes).toBe(OWNER_DISK_FREE - floor);
    expect(report.summary).toContain(
      `${((OWNER_DISK_FREE - floor) / GIB).toFixed(1)} GiB free disk`
    );
    expect(report.summary).not.toContain((OWNER_DISK_FREE / GIB).toFixed(1));
  });

  /** A disk already under its floor has no headroom, and the number for that is zero, not a debt. */
  it('never reports negative headroom', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      readCgroupLimits: async () => ({ state: 'absent' }),
      storage: storage(1_000_000_000)
    });
    expect(report.diskBytes).toBe(0);
  });

  /**
   * Nothing establishable means no line at all, which is what the worker's empty-string branch
   * needs to be true for the block to stay byte-identical on a box that cannot answer.
   */
  it('says nothing at all rather than a line with nothing in it', async () => {
    const report = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      readCgroupLimits: async () => ({ state: 'unreadable' }),
      storage: async () => {
        throw new Error('no filesystem');
      }
    });
    expect(report).toMatchObject({ cores: null, memoryBytes: null, diskBytes: null });
    expect(report.summary).toBe('');
  });

  /** Three numbers and their units, and the sentence that says what they are for. */
  it('is one line, and it says why the numbers are there', () => {
    const line = machineSummary({
      cores: 16,
      memoryBytes: OWNER_COMMAND_MEMORY,
      diskBytes: 730 * GIB
    });
    expect(line).toBe(
      '16 cores, 21.9 GiB memory per command, 730.0 GiB free disk. Size parallel work, memory and output to these rather than to a default.'
    );
    expect(line.split('\n')).toHaveLength(1);
  });
});

/**
 * THE PRODUCTION CALL SITE.
 *
 * Everything above proves `machineReport`. This proves the route, through `buildServer`, with the
 * runner's own config deciding the per-command ceiling - which is the join this repository has got
 * wrong three times, most recently a disk floor that was proved on its helper while `buildServer`
 * never passed `hostStorage` into `guards`. The seam here is the kernel, not the report: the
 * cgroup reading is injected, and every number the route answers with is computed by the same code
 * production runs.
 */
describe('the route the worker actually asks', () => {
  const runnerConfig = (workspaceRoot: string, secret: string): RunnerConfig => ({
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: 4300,
    RUNNER_SHARED_SECRET: secret,
    WORKSPACE_ROOT: workspaceRoot,
    TAR_EXECUTABLE: '/usr/bin/tar',
    SNAPSHOT_EXECUTABLE: path.resolve('../../scripts/garden-snapshot'),
    BROWSER_USE_DESKTOP_DISPLAY: false,
    BROWSER_CPU_NICE: 0,
    MAX_EXECUTION_SECONDS: 30,
    RESOURCE_LIMIT_EXECUTABLE: '/usr/bin/prlimit',
    IMAGE_CONVERT_EXECUTABLE: 'magick',
    MAX_BACKGROUND_SECONDS: 120,
    COMMAND_PROCESS_LIMIT: 1024,
    COMMAND_OPEN_FILE_LIMIT: 4096,
    // Pinned so the ceiling the route reports is this number rather than seven tenths of whatever
    // the machine running the suite happens to have.
    COMMAND_MEMORY_LIMIT_BYTES: OWNER_COMMAND_MEMORY,
    MAX_FILE_BYTES: 1024 * 1024,
    RESERVED_PREVIEW_PORTS: [],
    CHECKPOINT_BTRFS_EXECUTABLE: '/nonexistent/btrfs',
    CHECKPOINT_ZFS_EXECUTABLE: '/nonexistent/zfs',
    CHECKPOINT_PACKAGE_MANIFEST: '/nonexistent/status',
    CHECKPOINT_INCLUDE_BROWSER_PROFILE: false,
    CHECKPOINT_RETAIN_TURNS: 20,
    CHECKPOINT_RETAIN_DAILY_DAYS: 14,
    CHECKPOINT_MAX_FILES: 250_000,
    CHECKPOINT_MAX_FILE_BYTES: 2 * 1024 ** 3,
    ISOLATE_AGENT_NETWORK: false
  });

  const harness = async (options: Parameters<typeof buildServer>[1]) => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'garden-machine-route-'));
    disposers.push(() => rm(workspaceRoot, { recursive: true, force: true }));
    const secret = 'runner-machine-route-secret-at-least-32-characters';
    const app = await buildServer(runnerConfig(workspaceRoot, secret), options);
    disposers.push(() => app.close());
    const id = '00000000-0000-4000-8000-000000000011';
    await ensureWorkspace(path.join(workspaceRoot, id));
    let issued = 0;
    const token = (audience: { method: string; path: string }) =>
      signCapabilityToken(
        {
          sub: 'user',
          workspaceId: id,
          role: 'user',
          scopes: ['exec'],
          aud: capabilityAudience(audience.method, audience.path),
          nonce: `machine-${(issued += 1)}`
        },
        secret
      );
    const ask = async () => {
      const url = `/v1/workspaces/${id}/machine`;
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${token({ method: 'GET', path: url })}` }
      });
      return response;
    };
    return { ask, id, secret, app };
  };

  it('answers the cgroup’s numbers, through the server that production builds', async () => {
    const { ask } = await harness({
      cgroup: async () => ({ state: 'read', cpuCores: 2, memoryMaxBytes: 2 * GIB }),
      hostStorage: async () => ({
        hostStorageTotalBytes: OWNER_DISK_TOTAL,
        hostStorageAvailableBytes: OWNER_DISK_FREE
      })
    });
    const response = await ask();
    expect(response.statusCode).toBe(200);
    const body: { cores: number; memoryBytes: number; summary: string } = response.json();
    expect(body.cores).toBe(2);
    expect(body.memoryBytes).toBe(2 * GIB);
    // The route joined the config's rlimit to the cgroup and took the smaller. Had it reported the
    // configured ceiling instead, this is the number that would be here.
    expect(body.memoryBytes).not.toBe(OWNER_COMMAND_MEMORY);
    expect(body.summary).toContain('2 cores, 2.0 GiB memory per command');
  });

  /**
   * The join, proved in the direction that catches a route reporting a second derivation of the
   * ceiling instead of the one the runner applies: with the cgroup taking nothing away, the number
   * on the wire has to be `COMMAND_MEMORY_LIMIT_BYTES` from this runner's own config, to the byte.
   */
  it('reports the ceiling this runner actually puts on a command', async () => {
    const { ask } = await harness({
      cgroup: async () => ({ state: 'read', cpuCores: null, memoryMaxBytes: null }),
      hostStorage: async () => ({
        hostStorageTotalBytes: OWNER_DISK_TOTAL,
        hostStorageAvailableBytes: OWNER_DISK_FREE
      })
    });
    const body: { memoryBytes: number; diskBytes: number } = (await ask()).json();
    expect(body.memoryBytes).toBe(OWNER_COMMAND_MEMORY);
    expect(body.diskBytes).toBe(OWNER_DISK_FREE - OWNER_DISK_TOTAL * 0.02);
  });

  /**
   * THE CASE THAT FAILS IF THE ROUTE'S DEFAULT STOPS BEING A KERNEL READ.
   *
   * Every case above this one injects `cgroup`, so until it was written nothing anywhere asserted
   * that a server built WITHOUT that seam asks the machine at all. Measured before writing it:
   * replacing the default with a constant left all 38 files and 662 cases of this package green.
   * That is the fourth time this repository has proved a bound on a helper whose production caller
   * had no case, and half the repair is not this case but the `??` that is no longer in
   * `server.ts` - one default, in the module that owns the kernel, instead of two.
   *
   * WHAT IT CAN AND CANNOT SEE, because the second half is a real limit rather than an omission.
   * It compares the route's answer against `readCgroup` run here, so any default that answers
   * differently on this host fails: a constant `unreadable` withholds both numbers and a constant
   * `read` states somebody else's. What it cannot distinguish is a constant that happens to agree
   * with the truth on the machine the suite runs on - on a host with no cgroup v2 that is `absent`
   * and only `absent`. On Linux, where this ships, there is no such constant.
   */
  it('asks the kernel when nothing injects an answer', async () => {
    const disk = async () => ({
      hostStorageTotalBytes: OWNER_DISK_TOTAL,
      hostStorageAvailableBytes: OWNER_DISK_FREE
    });
    const { ask } = await harness({ hostStorage: disk });
    const expected = await machineReport({
      root: '/tmp',
      commandMemoryBytes: OWNER_COMMAND_MEMORY,
      readCgroupLimits: () => readCgroup(),
      storage: disk
    });
    const body: MachineReport = (await ask()).json();
    expect(body.cores).toEqual(expected.cores);
    expect(body.memoryBytes).toEqual(expected.memoryBytes);
    expect(body.summary).toBe(expected.summary);
    // And the answer both sides agree on is not the empty one, or every constant would pass this.
    expect(expected.cores).not.toBeNull();
    expect(expected.memoryBytes).not.toBeNull();
  });

  it('refuses a token that was not issued for this route', async () => {
    const { ask, id, secret, app } = await harness({
      cgroup: async () => ({ state: 'absent' })
    });
    expect((await ask()).statusCode).toBe(200);
    const wrong = await app.inject({
      method: 'GET',
      url: `/v1/workspaces/${id}/machine`,
      headers: {
        authorization: `Bearer ${signCapabilityToken(
          {
            sub: 'user',
            workspaceId: id,
            role: 'user',
            scopes: ['exec'],
            aud: capabilityAudience('GET', `/v1/workspaces/${id}/toolchain`),
            nonce: 'machine-wrong'
          },
          secret
        )}`
      }
    });
    expect(wrong.statusCode).toBe(403);
  });
});
