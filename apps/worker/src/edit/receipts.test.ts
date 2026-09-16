import { describe, expect, it } from 'vitest';
import type { DataStore } from '@athanor/data';
import { recordPatchReceipt, recoverPatchReceipts } from './receipts.js';

describe('durable edit reconciliation', () => {
  it('recovers confirmed writes and uncertain intents after losing process memory', async () => {
    const rows: unknown[] = [];
    const store = {
      appendTaskEvent: async (value: unknown) => {
        rows.push(value);
      },
      listTaskEvents: async () => rows
    } as unknown as DataStore;
    const key = new Uint8Array(32).fill(3);
    await recordPatchReceipt(store, 'task', key, 'batch', {
      path: 'workspace/a.txt',
      expectedSha256: 'a'.repeat(64),
      status: 'uncertain'
    });
    await recordPatchReceipt(store, 'task', key, 'batch', {
      path: 'workspace/a.txt',
      expectedSha256: 'a'.repeat(64),
      status: 'applied'
    });
    await recordPatchReceipt(store, 'task', key, 'batch', {
      path: 'workspace/b.txt',
      expectedSha256: 'b'.repeat(64),
      status: 'uncertain'
    });
    await recordPatchReceipt(store, 'task', key, 'other-batch', {
      path: 'workspace/a.txt',
      expectedSha256: 'c'.repeat(64),
      status: 'applied'
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('workspace/a.txt');
    expect(await recoverPatchReceipts(store, 'task', key, 'batch')).toMatchObject([
      { path: 'workspace/a.txt', status: 'applied', expectedSha256: 'a'.repeat(64) },
      { path: 'workspace/b.txt', status: 'uncertain', expectedSha256: 'b'.repeat(64) }
    ]);
  });
});
