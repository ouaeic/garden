import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ComputationLedger, type ComputationReceipt } from './computation-ledger.js';

let root: string, ledger: ComputationLedger;
const session = `kernel-${randomUUID()}`;
const receipt: ComputationReceipt = {
  cellId: '../Unicode α/cell',
  hash: createHash('sha256').update('request').digest('hex'),
  state: 'running'
};
const filename = () =>
  path.join(root, session, `${createHash('sha256').update(receipt.cellId).digest('hex')}.json`);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'garden-cell-ledger-'));
  ledger = new ComputationLedger(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('preserves request identity and settled state across delayed writes and a fresh reader', async () => {
  await ledger.put(session, receipt);
  await Promise.all([
    ledger.put(session, { ...receipt, state: 'completed' }),
    ledger.put(session, receipt)
  ]);
  expect(await new ComputationLedger(root).get(session, receipt.cellId)).toEqual({
    ...receipt,
    state: 'completed'
  });
  await expect(ledger.put(session, { ...receipt, hash: 'f'.repeat(64) })).rejects.toThrow(
    'different code'
  );
});

it('treats corruption and a mismatched cell identity as errors, not as an unseen request', async () => {
  await ledger.put(session, receipt);
  await writeFile(filename(), '{');
  await expect(ledger.get(session, receipt.cellId)).rejects.toThrow();
  await expect(ledger.put(session, receipt)).rejects.toThrow();
  expect(await readFile(filename(), 'utf8')).toBe('{');
  await writeFile(filename(), JSON.stringify({ ...receipt, cellId: 'different' }));
  await expect(ledger.get(session, receipt.cellId)).rejects.toThrow('identity mismatch');
});

it('bounds reads, refuses symlink entries and rejects a foreign session path', async () => {
  await ledger.put(session, receipt);
  await writeFile(filename(), ' '.repeat(256 * 1024 + 1));
  await expect(ledger.get(session, receipt.cellId)).rejects.toThrow('Invalid computation receipt');
  await rm(filename());
  const outside = path.join(root, 'outside.json');
  await writeFile(outside, JSON.stringify(receipt));
  await symlink(outside, filename());
  await expect(ledger.get(session, receipt.cellId)).rejects.toThrow();
  await expect(ledger.put('../outside', receipt)).rejects.toThrow('Invalid computation session');
  expect(await readFile(outside, 'utf8')).toBe(JSON.stringify(receipt));
});
