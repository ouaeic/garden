import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decryptJson,
  diagnosticCipherHash,
  diagnosticRecordAad,
  encryptJson,
  DIAGNOSTIC_EMPTY_HASH
} from '@garden/core';
import { DIAGNOSTIC_CAPTURE_BYTES, DIAGNOSTIC_RECORD_BYTES } from '@garden/contracts';
import { DatabaseFixtures, type DatabaseFixture } from '../test-support/database-fixtures.js';
import { DataStore } from '../store.js';

const fixtures = new DatabaseFixtures();
let fixture: DatabaseFixture, store: DataStore;
const key = Buffer.alloc(32, 17),
  canary = 'PRIVATE_RECORD_BODY_CANARY';
beforeAll(async () => {
  fixture = await fixtures.create();
  store = new DataStore(fixture.database);
});
afterAll(() => fixtures.close());
async function setup() {
  const user = await store.createUser({ username: randomUUID(), displayName: 'Diagnostic test' });
  const workspace = await store.createWorkspace({
    userId: user.id,
    name: 'Diagnostic test',
    storageLimitBytes: 1e9,
    imageRevision: 'test',
    region: 'auto',
    wrappedKey: 'unused'
  });
  const task = await store.createTask({
    userId: user.id,
    workspaceId: workspace.id,
    titleCiphertext: encryptJson('test', key),
    promptCiphertext: encryptJson('test', key),
    nameIndex: { nameTokens: '', openingTokens: '' },
    modelId: 'test',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1
  });
  const id = randomUUID(),
    workerId = randomUUID(),
    segmentId = randomUUID();
  await fixture.database.query(
    "UPDATE tasks SET lease_owner=$2,lease_expires_at=NOW()+interval '1 hour' WHERE id=$1",
    [task.id, workerId]
  );
  await store.diagnostics.control(user.id, task.id, id, 'start');
  const capture = (await store.diagnostics.get(user.id, task.id))!;
  const writer = {
    id,
    taskId: task.id,
    workerId,
    segmentId,
    epoch: capture.epoch,
    seal: (sequence: number, hash: string) =>
      encryptJson({ canary }, key, diagnosticRecordAad(id, sequence, hash))
  };
  return { user, task, id, writer, capture };
}
describe('private diagnostic storage', () => {
  it('seals bodies, serializes concurrent records and rejects foreign access', async () => {
    const { user, task, writer, id } = await setup();
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(true);
    expect(
      await Promise.all([store.diagnostics.append(writer), store.diagnostics.append(writer)])
    ).toEqual([true, true]);
    const rows = await store.diagnostics.page(user.id, task.id, id, 0, 3);
    expect(rows).toHaveLength(3);
    let previous = DIAGNOSTIC_EMPTY_HASH;
    for (const row of rows) {
      expect(row.previousHash).toBe(previous);
      expect(row.hash).toBe(diagnosticCipherHash(row.envelope));
      expect(JSON.stringify(row)).not.toContain(canary);
      expect(
        decryptJson(row.envelope, key, diagnosticRecordAad(id, row.sequence, previous))
      ).toEqual({ canary });
      previous = row.hash;
    }
    const other = randomUUID();
    expect(await store.diagnostics.get(other, task.id)).toBeNull();
    expect(await store.diagnostics.page(other, task.id, id, 0, 100)).toEqual([]);
    await expect(store.diagnostics.control(other, task.id, id, 'delete')).rejects.toMatchObject({
      code: 'task_not_found'
    });
    expect((await store.diagnostics.get(user.id, task.id))!.lastHash).toBe(previous);
  });
  it('fences stop/resume, stale begins, deletion/recreation and mismatched identities', async () => {
    const { user, task, id, writer } = await setup();
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(true);
    await store.diagnostics.control(user.id, task.id, id, 'start');
    expect(await store.diagnostics.append(writer)).toBe(true);
    await store.diagnostics.control(user.id, task.id, id, 'stop');
    expect(await store.diagnostics.append(writer)).toBe(false);
    await store.diagnostics.control(user.id, task.id, id, 'start');
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(false);
    const resumed = {
      ...writer,
      epoch: (await store.diagnostics.get(user.id, task.id))!.epoch,
      segmentId: randomUUID()
    };
    expect(await store.diagnostics.append({ ...resumed, begin: true })).toBe(true);
    expect(await store.diagnostics.append(writer)).toBe(false);
    await expect(
      store.diagnostics.control(user.id, task.id, randomUUID(), 'delete')
    ).rejects.toMatchObject({ code: 'diagnostic_changed' });
    await store.diagnostics.control(user.id, task.id, id, 'delete');
    expect(await store.diagnostics.page(user.id, task.id, id, 0, 100)).toEqual([]);
    await store.diagnostics.control(user.id, task.id, id, 'start');
    expect(await store.diagnostics.append({ ...resumed, begin: true })).toBe(false);
  });
  it('allows a finishing segment after lease release and rejects a replacement worker', async () => {
    const { task, writer } = await setup();
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(true);
    await fixture.database.query(
      'UPDATE tasks SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',
      [task.id]
    );
    expect(await store.diagnostics.append(writer)).toBe(true);
    expect(await store.diagnostics.append({ ...writer, final: true })).toBe(true);
    expect(await store.diagnostics.append(writer)).toBe(false);
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(false);
    await fixture.database.query(
      "UPDATE tasks SET lease_owner=$2,lease_expires_at=NOW()+interval '1 hour' WHERE id=$1",
      [task.id, randomUUID()]
    );
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(false);
  });
  it('stops explicitly at storage and record limits without appending', async () => {
    const first = await setup();
    await fixture.database.query('UPDATE diagnostic_captures SET stored_bytes=$2 WHERE id=$1', [
      first.id,
      DIAGNOSTIC_CAPTURE_BYTES
    ]);
    expect(await store.diagnostics.append({ ...first.writer, begin: true })).toBe(false);
    expect((await store.diagnostics.get(first.user.id, first.task.id))!.status).toMatchObject({
      state: 'failed',
      reason: 'storage_limit',
      records: 0
    });
    await expect(
      store.diagnostics.control(first.user.id, first.task.id, first.id, 'start')
    ).rejects.toMatchObject({ code: 'diagnostic_incomplete' });
    const second = await setup();
    expect(
      await store.diagnostics.append({
        ...second.writer,
        begin: true,
        seal: (seq, previous) => ({
          ...second.writer.seal(seq, previous),
          ciphertext: 'a'.repeat(DIAGNOSTIC_RECORD_BYTES)
        })
      })
    ).toBe(false);
    expect((await store.diagnostics.get(second.user.id, second.task.id))!.status.reason).toBe(
      'record_too_large'
    );
  });
  it('records failure before the first segment and fences a changed workspace', async () => {
    const { user, task, id, writer } = await setup();
    await store.diagnostics.fail(
      id,
      task.id,
      writer.workerId,
      writer.segmentId,
      'write_failed',
      writer.epoch
    );
    expect((await store.diagnostics.get(user.id, task.id))!.status).toMatchObject({
      state: 'failed',
      reason: 'write_failed',
      records: 0
    });
    const second = await setup();
    const workspace = await store.createWorkspace({
      userId: second.user.id,
      name: 'Replacement',
      storageLimitBytes: 1e9,
      imageRevision: 'test',
      region: 'auto',
      wrappedKey: 'unused'
    });
    await fixture.database.query('UPDATE tasks SET workspace_id=$2 WHERE id=$1', [
      second.task.id,
      workspace.id
    ]);
    expect(await store.diagnostics.append({ ...second.writer, begin: true })).toBe(false);
    await expect(
      store.diagnostics.control(second.user.id, second.task.id, second.id, 'start')
    ).rejects.toMatchObject({ code: 'diagnostic_workspace_changed' });
    await store.diagnostics.control(second.user.id, second.task.id, second.id, 'delete');
    expect(await store.diagnostics.get(second.user.id, second.task.id)).toBeNull();
  });
  it('rejects incorrect encryption binding and preserves owner stop against a delayed failure', async () => {
    const { user, task, id, writer } = await setup();
    await expect(
      store.diagnostics.append({
        ...writer,
        begin: true,
        seal: () => encryptJson({}, key, 'wrong')
      })
    ).rejects.toThrow('context mismatch');
    expect((await store.diagnostics.get(user.id, task.id))!.status.records).toBe(0);
    expect(await store.diagnostics.append({ ...writer, begin: true })).toBe(true);
    await store.diagnostics.control(user.id, task.id, id, 'stop');
    await store.diagnostics.fail(id, task.id, writer.workerId, writer.segmentId, 'write_failed');
    expect((await store.diagnostics.get(user.id, task.id))!.status.state).toBe('stopped');
  });
});
