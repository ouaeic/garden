import type { WorkflowProgress, WorkflowStage } from '@athanor/contracts';
import { openDownloadFile } from './open-download-file.js';

const PAGE_BYTES = 1024 * 1024;
const RECORD_BYTES = 64 * 1024;
const RECENT_TASKS = 50;
const STATES: Readonly<Record<string, WorkflowStage['status']>> = {
  COMPLETED: 'completed',
  CACHED: 'cached',
  FAILED: 'failed',
  ABORTED: 'aborted'
};
const REQUIRED = ['task_id', 'hash', 'name', 'status', 'exit', 'duration', 'peak_rss'];
interface Cursor {
  identity: string;
  offset: number;
  pending: Buffer;
  fields: string[] | null;
  progress: WorkflowProgress;
}
const empty = (): WorkflowProgress => ({
  recordedTasks: 0,
  completed: 0,
  cached: 0,
  failed: 0,
  aborted: 0,
  recent: [],
  catchingUp: false,
  pendingRecord: false,
  observedAt: new Date().toISOString()
});
const number = (value: string | undefined): number | null => {
  if (!value || value === '-') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Incremental trace reads bound both history scanning and retained rows; no cache database is opened. */
export class WorkflowTraceReader {
  readonly #cursors = new Map<string, Cursor>();
  async read(root: string, requested: string): Promise<WorkflowProgress> {
    const key = `${root}\0${requested}`;
    let file;
    try {
      file = await openDownloadFile(root, requested);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty();
      throw error;
    }
    try {
      const identity = `${file.stat.dev}:${file.stat.ino}:${file.stat.birthtimeMs}`;
      let cursor = this.#cursors.get(key);
      if (!cursor || cursor.identity !== identity || file.stat.size < cursor.offset) {
        cursor = { identity, offset: 0, pending: Buffer.alloc(0), fields: null, progress: empty() };
      }
      // Working copies make a partial or malformed record retryable without double-counting rows.
      const current: Cursor = {
        ...cursor,
        progress: { ...cursor.progress, recent: [...cursor.progress.recent] }
      };
      const buffer = Buffer.alloc(
        Math.min(PAGE_BYTES, Math.max(0, file.stat.size - current.offset))
      );
      const read = await file.handle.read(buffer, 0, buffer.length, current.offset);
      current.offset += read.bytesRead;
      const text = Buffer.concat([current.pending, buffer.subarray(0, read.bytesRead)]);
      let start = 0;
      while (true) {
        const end = text.indexOf(10, start);
        if (end === -1) break;
        if (end - start > RECORD_BYTES) throw new Error('Workflow trace record is too large');
        const line = new TextDecoder('utf-8', { fatal: true })
          .decode(text.subarray(start, end))
          .replace(/\r$/, '');
        start = end + 1;
        if (!line) continue;
        if (!current.fields) {
          current.fields = line.split('\t');
          if (REQUIRED.some((field) => !current.fields!.includes(field)))
            throw new Error('Workflow trace fields do not match the configured reader');
          continue;
        }
        const values = line.split('\t');
        if (values.length !== current.fields.length)
          throw new Error('Workflow trace record is incomplete');
        const row = Object.fromEntries(
          current.fields.map((field, index) => [field, values[index]])
        );
        const status = STATES[row.status ?? ''] ?? 'unknown';
        const stage: WorkflowStage = {
          taskId: (row.task_id ?? '').slice(0, 100),
          name: (row.name ?? '').slice(0, 512),
          hash: (row.hash ?? '').slice(0, 100),
          status,
          exitCode: number(row.exit),
          durationMs: number(row.duration),
          peakMemoryBytes: number(row.peak_rss)
        };
        current.progress.recordedTasks++;
        if (status !== 'unknown') current.progress[status]++;
        current.progress.recent.push(stage);
        if (current.progress.recent.length > RECENT_TASKS) current.progress.recent.shift();
      }
      current.pending = Buffer.from(text.subarray(start));
      if (current.pending.length > RECORD_BYTES)
        throw new Error('Workflow trace record is too large');
      current.progress.catchingUp = current.offset < file.stat.size;
      current.progress.pendingRecord = current.pending.length > 0;
      current.progress.observedAt = new Date().toISOString();
      this.#cursors.delete(key);
      this.#cursors.set(key, current);
      if (this.#cursors.size > 64) this.#cursors.delete(this.#cursors.keys().next().value!);
      return { ...current.progress, recent: [...current.progress.recent] };
    } finally {
      await file.handle.close();
    }
  }
}
