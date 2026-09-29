import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface GpuStats {
  id: string;
  name: string;
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
}
const value = (text: string | undefined): number | null => {
  if (!text?.trim() || !/^\d+(?:\.\d+)?$/.test(text.trim())) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};
const percent = (text: string | undefined) => {
  const number = value(text);
  return number !== null && number <= 100 ? number : null;
};
const mib = (text: string | undefined) => {
  const number = value(text);
  return number === null ? null : number * 1024 * 1024;
};

export const parseNvidiaStats = (output: string): GpuStats[] =>
  output.split('\n').flatMap((line) => {
    const fields = line.split(',').map((part) => part.trim());
    const [id, name, busy, used, total, temperature] = fields;
    if (fields.length !== 6 || !id?.startsWith('GPU-') || !name) return [];
    return [
      {
        id,
        name,
        utilizationPercent: percent(busy),
        memoryUsedBytes: mib(used),
        memoryTotalBytes: mib(total),
        temperatureC: value(temperature)
      }
    ];
  });

const execute = promisify(execFile);
const read = (path: string) => readFile(path, 'utf8').catch(() => '');
export const readAmdStats = async (root = '/sys/class/drm'): Promise<GpuStats[]> => {
  const cards = (await readdir(root).catch(() => []))
    .filter((name) => /^card\d+$/.test(name))
    .slice(0, 32);
  const devices = await Promise.all(
    cards.map(async (card) => {
      const base = `${root}/${card}/device`;
      if ((await read(`${base}/vendor`)).trim() !== '0x1002') return null;
      const [busy, used, total, identity] = await Promise.all([
        read(`${base}/gpu_busy_percent`),
        read(`${base}/mem_info_vram_used`),
        read(`${base}/mem_info_vram_total`),
        read(`${base}/uevent`)
      ]);
      return {
        id: card,
        name: `AMD ${/^PCI_SLOT_NAME=(.+)$/m.exec(identity)?.[1] ?? card}`,
        utilizationPercent: percent(busy),
        memoryUsedBytes: value(used),
        memoryTotalBytes: value(total),
        temperatureC: null
      };
    })
  );
  return devices.filter((device) => device !== null);
};

export const readGpuStats = async (): Promise<GpuStats[]> => {
  const [nvidia, amd] = await Promise.all([
    execute(
      'nvidia-smi',
      [
        '--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits'
      ],
      { timeout: 1000, maxBuffer: 64 * 1024, encoding: 'utf8' }
    )
      .then(({ stdout }) => parseNvidiaStats(stdout))
      .catch(() => []),
    readAmdStats()
  ]);
  return [...nvidia, ...amd];
};

/** Share in-flight probes and keep polling clients from spawning a process each. */
export const createGpuSampler = (probe = readGpuStats, now = Date.now) => {
  type Sample = { sampledAt: string; devices: GpuStats[] };
  let cached: Sample | null = null;
  let expires = 0;
  let pending: Promise<Sample> | undefined;
  return async () => {
    if (cached && now() < expires) return cached;
    pending ??= probe()
      .catch(() => [])
      .then((devices) => {
        cached = { sampledAt: new Date(now()).toISOString(), devices };
        expires = now() + 5000;
        return cached;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
};
