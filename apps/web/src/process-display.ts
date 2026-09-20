import type { ManagedProcess } from '@athanor/contracts';

export const processState = (process: ManagedProcess): string =>
  process.job?.state ?? process.service?.state ?? process.status;
export const processActive = (process: ManagedProcess): boolean =>
  ['running', 'restarting'].includes(processState(process));
export const processNeedsAttention = (process: ManagedProcess): boolean =>
  ['interrupted', 'crash_looped'].includes(processState(process));
export const processName = (process: ManagedProcess): string => {
  const name = process.job?.name ?? process.service?.name;
  if (name && name !== 'Command') return name;
  const parts = Array.isArray(process.command) ? process.command : [process.command];
  const command = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return command.length > 90 ? `${command.slice(0, 89)}…` : command || name || process.sessionId;
};
export const processElapsed = (
  process: ManagedProcess,
  observedAt: string | undefined,
  now: number
): number => {
  const observed = observedAt ? Date.parse(observedAt) : now;
  return Math.max(
    0,
    process.ranForMs +
      (process.status === 'running' &&
      processState(process) === 'running' &&
      Number.isFinite(observed)
        ? Math.max(0, now - observed)
        : 0)
  );
};
export const processDuration = (milliseconds: number): string => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
};
export const processMemory = (bytes: number): string => {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
};

export const computationActive = (state: string): boolean =>
  ['starting', 'idle', 'busy', 'interrupted'].includes(state);
