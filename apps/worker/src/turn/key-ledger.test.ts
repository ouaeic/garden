import { describe, expect, it, vi } from 'vitest';
import { decryptJson } from '@garden/core';
import type { TaskRecord } from '@garden/data';
import { recordKeyAuthorized } from './key-ledger.js';

const key = Buffer.alloc(32, 3);
const task = (securityMode: TaskRecord['securityMode']) =>
  ({ id: 'task-1', userId: 'user-1', securityMode }) as TaskRecord;
const consequential = { id: 'c1', name: 'process', arguments: { action: 'write', session: 's' } };
const read = { id: 'c2', name: 'file_read', arguments: { path: 'workspace/a.md' } };

describe('the receipt for an action a lent key allowed', () => {
  it('writes one when Autonomous runs what Balanced would have carded as consequential', async () => {
    const recordKeyAuthorizedAction = vi.fn(async () => undefined);
    await recordKeyAuthorized(
      { recordKeyAuthorizedAction },
      task('autonomous'),
      key,
      consequential
    );
    expect(recordKeyAuthorizedAction).toHaveBeenCalledTimes(1);
    const [input] = recordKeyAuthorizedAction.mock.calls[0] as unknown as [
      { sideEffect: string; previewCiphertext: Parameters<typeof decryptJson>[0] }
    ];
    expect(input.sideEffect).toBe('external_consequential');
    expect(decryptJson(input.previewCiphertext, key, 'approval:task-1')).toMatchObject({
      tool: 'process',
      authorizedBy: 'key'
    });
  });

  it('writes none for a read, nor in a mode where the card itself is the record', async () => {
    const recordKeyAuthorizedAction = vi.fn(async () => undefined);
    await recordKeyAuthorized({ recordKeyAuthorizedAction }, task('autonomous'), key, read);
    await recordKeyAuthorized({ recordKeyAuthorizedAction }, task('balanced'), key, consequential);
    expect(recordKeyAuthorizedAction).not.toHaveBeenCalled();
  });

  it('never holds the action hostage to its own receipt', async () => {
    const recordKeyAuthorizedAction = vi.fn(async () => {
      throw new Error('database unavailable');
    });
    await expect(
      recordKeyAuthorized({ recordKeyAuthorizedAction }, task('autonomous'), key, consequential)
    ).resolves.toBeUndefined();
  });

  it('writes one for a card a lent key answered, in whatever mode the goal is in', async () => {
    const recordKeyAuthorizedAction = vi.fn(async () => undefined);
    const publish = {
      id: 'c3',
      name: 'publish_preview',
      arguments: { label: 'site', port: '5173', reach: 'public' }
    };
    await recordKeyAuthorized(
      { recordKeyAuthorizedAction },
      { ...task('balanced'), lentKeys: ['publish'] } as TaskRecord,
      key,
      publish
    );
    await recordKeyAuthorized(
      { recordKeyAuthorizedAction },
      { ...task('balanced'), lentKeys: ['rules'] } as TaskRecord,
      key,
      publish
    );
    expect(recordKeyAuthorizedAction).toHaveBeenCalledTimes(1);
    expect(recordKeyAuthorizedAction.mock.calls[0]).toMatchObject([
      { action: 'Publish site publicly' }
    ]);
  });
});
