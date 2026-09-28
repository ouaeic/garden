import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandLimitArguments,
  commandLimits,
  defaultMemoryLimitBytes,
  limitedInvocation,
  resolveCommandLimiter
} from './limits.js';

const limits = {
  memoryBytes: 2 * 1024 ** 3,
  processes: 1024,
  openFiles: 4096
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('command resource limits', () => {
  it('caps committed memory, processes and descriptors', () => {
    expect(commandLimitArguments(limits)).toEqual([
      '--core=0',
      `--data=${2 * 1024 ** 3}`,
      '--nproc=1024',
      '--nofile=4096'
    ]);
  });

  it('never uses an address-space limit, which would kill every runtime that reserves', () => {
    expect(commandLimitArguments(limits).join(' ')).not.toContain('--as');
  });

  /*
   * The pin on the limit that is gone, in the shape of the one above it, because the argument for
   * removing it is not an argument a later reader can reconstruct from an absence.
   *
   * RLIMIT_FSIZE was 4 GiB. A human BAM is 60-200 GB and a CRAM download reaches 4 GiB in under a
   * minute, so this was the first ceiling in the system the owner's own work met - and what it did
   * there is why it is not merely a larger number now. The kernel raises SIGXFSZ, so the result is
   * `signal: "SIGXFSZ"` with an empty stderr and a truncated file that `ls` reports as present;
   * inside the `bash -lc` pipeline the tool catalogue tells the model to use, where the writer is
   * not the last stage, the outer shell exits 0 and the truncation is reported as success. There
   * is no note that can be attached to a per-file rlimit that survives that.
   *
   * What guards the disk instead is the host-storage floor, polled every five seconds on both
   * execution paths, which also covers the case an rlimit cannot see at all: ten thousand files of
   * three gigabytes each. And the rule was never one this box believed in - the owner's own
   * terminal spawns its pty with no limiter, so the same account could always write a 700 GB file
   * by hand while the agent could not.
   */
  it('sets no file-size limit, which killed a large write mutely and mid-file', () => {
    expect(commandLimitArguments(limits).join(' ')).not.toContain('--fsize');
  });

  it('wraps the command so the limits are inherited by everything it execs', () => {
    expect(
      limitedInvocation(
        { executable: '/bin/sh', args: ['-c', 'echo hi'] },
        limits,
        '/usr/bin/prlimit'
      )
    ).toEqual({
      executable: '/usr/bin/prlimit',
      args: [...commandLimitArguments(limits), '--', '/bin/sh', '-c', 'echo hi']
    });
  });

  it('wraps outside the network namespace wrapper rather than inside it', () => {
    const isolated = limitedInvocation(
      { executable: '/usr/bin/unshare', args: ['--net', '--', 'curl', 'https://example.invalid'] },
      limits,
      '/usr/bin/prlimit'
    );
    expect(isolated.executable).toBe('/usr/bin/prlimit');
    expect(isolated.args.indexOf('/usr/bin/unshare')).toBeGreaterThan(
      isolated.args.indexOf('--nproc=1024')
    );
  });

  it('runs the command unchanged when the host has no limiter', () => {
    const plain = { executable: '/bin/sh', args: ['-c', 'echo hi'] };
    expect(limitedInvocation(plain, limits, undefined)).toEqual(plain);
    expect(limitedInvocation(plain, undefined, '/usr/bin/prlimit')).toEqual(plain);
  });

  /*
   * Seven tenths, not half: `MemoryMax=80%` in infra/native/garden-runner.service is what really
   * stops one command from taking the memory PostgreSQL needs, because it counts the runner and
   * every command it started together. RLIMIT_DATA is per process and cannot make that promise at
   * all - sixty-four children of `parallel -j 64` get sixty-four allowances of it - so at half the
   * box it bound nothing except the single-process case, which is exactly an assembler, and put
   * 9.4 GiB of the owner's 31.34 GiB out of reach for a guarantee it was not providing.
   */
  it('derives the memory ceiling from the host rather than a fixed number', () => {
    expect(defaultMemoryLimitBytes(32 * 1024 ** 3)).toBe(Math.floor((32 * 1024 ** 3 * 7) / 10));
    // A small server still gets a usable floor instead of a limit no build could run under.
    expect(defaultMemoryLimitBytes(1024 ** 3)).toBe(1024 ** 3);
  });

  /*
   * And the property the fraction is FOR, on the box it was measured against: 31.34 GiB, with the
   * unit's two percentages resolved by systemd to these byte counts.
   *
   * Strictly between them, both ways. Above `MemoryHigh` because the unit says crossing the
   * throttle should mean a heavy build finishes slowly rather than dying, so a per-command ceiling
   * at or below it refuses what the cgroup was written to allow. Below `MemoryMax` because only
   * one of the two stops can be reported: an exhausted RLIMIT_DATA makes an allocation fail and
   * the program says so in its own words, where the cgroup's stop is a SIGKILL with nothing on
   * either stream. It was four fifths for one commit - `MemoryMax` exactly - which measured 2,457
   * bytes ABOVE the cgroup ceiling here, so the legible stop could never fire at all.
   */
  it('leaves the per-command ceiling reachable inside the cgroup that surrounds it', () => {
    const ownerBoxBytes = 33_646_661_632;
    const memoryHigh = 20_187_996_160;
    const memoryMax = 26_917_326_848;
    const ceiling = defaultMemoryLimitBytes(ownerBoxBytes);

    expect(ceiling).toBeGreaterThan(memoryHigh);
    expect(ceiling).toBeLessThan(memoryMax);
  });

  it('prefers an explicitly configured memory ceiling', () => {
    const configured = commandLimits(
      {
        COMMAND_MEMORY_LIMIT_BYTES: 512 * 1024 ** 2,
        COMMAND_PROCESS_LIMIT: 64,
        COMMAND_OPEN_FILE_LIMIT: 256
      },
      8 * 1024 ** 3
    );
    expect(configured.memoryBytes).toBe(512 * 1024 ** 2);
    expect(configured.processes).toBe(64);
  });

  it('reports a missing limiter instead of throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garden-limiter-'));
    temporaryRoots.push(root);
    expect(await resolveCommandLimiter(path.join(root, 'prlimit'))).toBeUndefined();

    const present = path.join(root, 'prlimit');
    await writeFile(present, '#!/bin/sh\nexit 0\n');
    await chmod(present, 0o755);
    expect(await resolveCommandLimiter(present)).toBe(present);
  });
});
