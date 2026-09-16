import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowTraceReader } from './workflow-trace.js';

const header = 'task_id\thash\tname\tstatus\texit\tduration\tpeak_rss\n';
const row = (id: number, status = 'COMPLETED') =>
  `${id}\tab/cd${id}\tStage (${id})\t${status}\t${status === 'FAILED' ? 31 : 0}\t120\t4096\n`;
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garden-workflow-trace-'));
  await mkdir(path.join(root, 'workspace'));
  return { root, file: path.join(root, 'workspace', 'trace.tsv') };
};
describe('incremental workflow traces', () => {
  it('counts complete records once, waits for partial writes, and bounds visible history', async () => {
    const f = await fixture();
    try {
      const reader = new WorkflowTraceReader();
      expect((await reader.read(f.root, 'trace.tsv')).recordedTasks).toBe(0);
      await writeFile(f.file, header + row(1) + row(2, 'CACHED') + row(3, 'FAILED').slice(0, -1));
      const first = await reader.read(f.root, 'trace.tsv');
      expect(first).toMatchObject({
        recordedTasks: 2,
        completed: 1,
        cached: 1,
        failed: 0,
        pendingRecord: true
      });
      expect((await reader.read(f.root, 'trace.tsv')).recordedTasks).toBe(2);
      await appendFile(f.file, '\n' + Array.from({ length: 70 }, (_, i) => row(i + 4)).join(''));
      const next = await reader.read(f.root, 'trace.tsv');
      expect(next).toMatchObject({
        recordedTasks: 73,
        completed: 71,
        cached: 1,
        failed: 1,
        pendingRecord: false
      });
      expect(next.recent).toHaveLength(50);
      expect(next.recent.at(-1)).toMatchObject({
        taskId: '73',
        durationMs: 120,
        peakMemoryBytes: 4096
      });
      next.recent.length = 0;
      expect((await reader.read(f.root, 'trace.tsv')).recent).toHaveLength(50);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('bounds catch-up work and resets a replaced or truncated trace', async () => {
    const f = await fixture();
    try {
      const reader = new WorkflowTraceReader();
      const rows = 50_000;
      await writeFile(f.file, header + Array.from({ length: rows }, (_, i) => row(i)).join(''));
      let progress = await reader.read(f.root, 'trace.tsv');
      expect(progress.catchingUp).toBe(true);
      expect(progress.recordedTasks).toBeGreaterThan(0);
      expect(progress.recordedTasks).toBeLessThan(rows);
      for (let i = 0; progress.catchingUp && i < 10; i++)
        progress = await reader.read(f.root, 'trace.tsv');
      expect(progress.recordedTasks).toBe(rows);
      expect(progress.catchingUp).toBe(false);
      await rename(f.file, f.file + '.old');
      await writeFile(f.file, header + row(1, 'FAILED'));
      expect(await reader.read(f.root, 'trace.tsv')).toMatchObject({
        recordedTasks: 1,
        completed: 0,
        failed: 1
      });
      await writeFile(f.file, header);
      expect((await reader.read(f.root, 'trace.tsv')).recordedTasks).toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it('refuses private paths, links, unknown formats and oversized rows', async () => {
    const f = await fixture();
    try {
      const reader = new WorkflowTraceReader();
      await writeFile(f.file, 'name,status\nwrong,format\n');
      await expect(reader.read(f.root, 'trace.tsv')).rejects.toThrow(/fields/);
      await writeFile(f.file, header + 'x'.repeat(70_000));
      await expect(reader.read(f.root, 'trace.tsv')).rejects.toThrow(/too large/);
      await expect(reader.read(f.root, '.home/secret')).rejects.toThrow();
      await symlink(f.file, path.join(f.root, 'workspace', 'link.tsv'));
      await expect(reader.read(f.root, 'link.tsv')).rejects.toThrow();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
