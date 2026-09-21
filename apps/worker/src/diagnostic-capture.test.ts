import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptJson,
  DIAGNOSTIC_EMPTY_HASH,
  diagnosticCipherHash,
  recordPrivateDiagnostic,
  withPrivateDiagnostics,
  wrapDataKey
} from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import { TaskDiagnosticCapture } from './diagnostic-capture.js';

const task = {
  id: randomUUID(),
  userId: randomUUID(),
  workspaceId: randomUUID(),
  attempt: 0,
  securityMode: 'balanced'
} as TaskRecord;
const key = Buffer.alloc(32, 1),
  master = Buffer.alloc(32, 2);
function setup(enabled = true) {
  const rows: unknown[] = [];
  let previous = DIAGNOSTIC_EMPTY_HASH;
  const append = vi.fn(async (input: Parameters<DataStore['diagnostics']['append']>[0]) => {
    const envelope = input.seal(rows.length + 1, previous);
    expect(JSON.stringify(envelope)).not.toContain('private canary');
    rows.push(decryptJson(envelope, key, envelope.aad));
    previous = diagnosticCipherHash(envelope);
    return true;
  });
  const get = vi.fn(async () =>
    enabled
      ? {
          status: { id: randomUUID(), state: 'recording' },
          workspaceId: task.workspaceId,
          epoch: randomUUID()
        }
      : null
  );
  const fail = vi.fn(async () => undefined);
  const store = {
    diagnostics: { get, append, fail },
    getWorkspace: async () => ({
      id: task.workspaceId,
      wrappedKey: wrapDataKey(key, master, task.workspaceId)
    })
  } as unknown as DataStore;
  return { store, rows, append, get, fail };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('worker private recording', () => {
  it('does nothing by default and captures only within its explicitly enabled async scope', async () => {
    const off = setup(false);
    expect(await TaskDiagnosticCapture.open(off.store, task, 'worker', master)).toBeNull();
    await recordPrivateDiagnostic('harness_event', { secret: 'private canary' });
    expect(off.append).not.toHaveBeenCalled();
    expect(off.get).toHaveBeenCalledTimes(1);
    const on = setup();
    const capture = await TaskDiagnosticCapture.open(on.store, task, 'worker', master);
    expect(capture).not.toBeNull();
    expect(
      await capture!.run(async () => {
        await recordPrivateDiagnostic('harness_event', { secret: 'private canary' });
        return 17;
      })
    ).toBe(17);
    expect(on.rows).toHaveLength(3);
    expect(on.rows[1]).toMatchObject({
      kind: 'harness_event',
      data: { value: { secret: 'private canary' } }
    });
    await recordPrivateDiagnostic('harness_event', {});
    expect(on.rows).toHaveLength(3);
  });
  it('keeps concurrent conversations separate and clears capture for nested work with recording off', async () => {
    const left = setup(),
      right = setup();
    const a = await TaskDiagnosticCapture.open(left.store, task, 'worker-a', master);
    const b = await TaskDiagnosticCapture.open(right.store, task, 'worker-b', master);
    await Promise.all([
      a!.run(async () => {
        await recordPrivateDiagnostic('harness_event', { side: 'left' });
        await withPrivateDiagnostics(undefined, () =>
          recordPrivateDiagnostic('harness_event', { side: 'off' })
        );
      }),
      b!.run(async () => {
        await recordPrivateDiagnostic('harness_event', { side: 'right' });
      })
    ]);
    expect(left.rows).toHaveLength(3);
    expect(right.rows).toHaveLength(3);
    expect(JSON.stringify(left.rows)).toContain('left');
    expect(JSON.stringify(left.rows)).not.toContain('right');
    expect(JSON.stringify(right.rows)).toContain('right');
    expect(JSON.stringify(right.rows)).not.toContain('left');
    expect(JSON.stringify([...left.rows, ...right.rows])).not.toContain('off');
  });
  it('preserves task errors and stops recording after storage failure', async () => {
    const fixture = setup();
    const capture = await TaskDiagnosticCapture.open(fixture.store, task, 'worker', master);
    fixture.append.mockRejectedValueOnce(Error('database unavailable'));
    await expect(
      capture!.run(async () => {
        await recordPrivateDiagnostic('harness_event', {});
        throw Error('Task failure');
      })
    ).rejects.toThrow('Task failure');
    expect(fixture.fail).toHaveBeenCalledWith(
      expect.any(String),
      task.id,
      'worker',
      capture!.segmentId,
      'write_failed',
      expect.any(String)
    );
    expect(capture!.active).toBe(false);
  });
  it('bounds a stalled write and prevents a late callback from encrypting with a cleared key', async () => {
    const fixture = setup();
    const capture = await TaskDiagnosticCapture.open(fixture.store, task, 'worker', master);
    vi.useFakeTimers();
    fixture.append.mockImplementationOnce(() => new Promise(() => {}));
    const work = capture!.run(async () => {
      await recordPrivateDiagnostic('harness_event', {});
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(work).resolves.toBe('done');
    expect(capture!.active).toBe(false);
    const late = fixture.append.mock.calls[1]![0];
    expect(() => late.seal(2, DIAGNOSTIC_EMPTY_HASH)).toThrow('stopped');
  });
});
