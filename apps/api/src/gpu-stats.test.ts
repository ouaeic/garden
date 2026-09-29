import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGpuSampler, parseNvidiaStats, readAmdStats } from './gpu-stats.js';

describe('host GPU telemetry', () => {
  it('reads multiple NVIDIA devices and preserves unavailable readings', () => {
    const devices = parseNvidiaStats(
      'GPU-one, Example GPU, 35, 2048, 8192, 61\nGPU-two, Another GPU, [N/A], [Not Supported], 16384, N/A\n'
    );
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      utilizationPercent: 35,
      memoryUsedBytes: 2147483648,
      memoryTotalBytes: 8589934592,
      temperatureC: 61
    });
    expect(devices[1]).toMatchObject({
      utilizationPercent: null,
      memoryUsedBytes: null,
      temperatureC: null
    });
    expect(parseNvidiaStats('Driver unavailable')).toEqual([]);
    expect(parseNvidiaStats('GPU-x, Broken, 101, -1, NaN, -4')[0]).toMatchObject({
      utilizationPercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      temperatureC: null
    });
  });

  it('reads AMD sysfs counters without interpreting a missing counter as zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garden-gpu-'));
    try {
      const device = join(root, 'card0/device');
      await mkdir(device, { recursive: true });
      for (const [file, content] of Object.entries({
        vendor: '0x1002\n',
        gpu_busy_percent: '0\n',
        mem_info_vram_total: '8589934592\n',
        uevent: 'PCI_SLOT_NAME=0000:03:00.0\n'
      }))
        await writeFile(join(device, file), content);
      expect(await readAmdStats(root)).toEqual([
        {
          id: 'card0',
          name: 'AMD 0000:03:00.0',
          utilizationPercent: 0,
          memoryUsedBytes: null,
          memoryTotalBytes: 8589934592,
          temperatureC: null
        }
      ]);
      expect(await readAmdStats(join(root, 'missing'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('coalesces probes, expires samples and recovers after driver failures', async () => {
    let clock = 0;
    const probe = vi
      .fn()
      .mockResolvedValueOnce(parseNvidiaStats('GPU-one, Test, 25, 10, 100, 40'))
      .mockRejectedValueOnce(new Error('driver stopped'))
      .mockResolvedValue([]);
    const sample = createGpuSampler(probe, () => clock);
    const first = await Promise.all([sample(), sample()]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(first[0].devices).toHaveLength(1);
    clock = 4999;
    expect(await sample()).toEqual(first[0]);
    clock = 5000;
    expect((await sample()).devices).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(2);
    clock = 10000;
    expect((await sample()).devices).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
