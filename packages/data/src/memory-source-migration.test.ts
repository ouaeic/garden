import { randomUUID } from 'node:crypto';
import {
  buildMemoryItemIndex,
  buildMemorySourceIndex,
  decryptJson,
  encryptJson,
  memoryIndexKey,
  memoryOriginKey,
  sha256
} from '@garden/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { migrations } from './migrations.js';
import { DataStore } from './store.js';
import { MemoryStore } from './store/memory.js';

describe('memory source provenance upgrades', () => {
  let database: Database;
  afterEach(async () => database?.close());

  it.each([true, false])(
    'keeps source history and supports new sealed provenance when columns are missing=%s',
    async (missingColumns) => {
      database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
      const installed = migrations.filter((migration) => migration.version <= 82);
      expect(installed.length).toBeGreaterThan(0);
      for (const migration of installed) {
        await database.transaction(async (transaction) => {
          await transaction.exec(migration.sql);
          await transaction.query('INSERT INTO schema_migrations(version,name) VALUES ($1,$2)', [
            migration.version,
            migration.name
          ]);
        });
      }
      const store = new DataStore(database);
      const memory = new MemoryStore(database);
      const user = await store.createUser({
        username: 'source-owner',
        displayName: 'Source owner'
      });
      const workspace = await store.createWorkspace({
        userId: user.id,
        name: 'Source room',
        storageLimitBytes: 1024 ** 3,
        imageRevision: 'dev',
        region: 'auto',
        wrappedKey: 'unused by this store test'
      });
      const key = Buffer.alloc(32, 31);
      const indexKey = memoryIndexKey(key);
      const aad = `memory-source:${workspace.id}`;
      const content = { body: 'The acceptance command passed before the upgrade.' };
      const sealedBody = encryptJson(content, key, aad);
      const episode = await memory.createMemoryItem({
        userId: user.id,
        workspaceId: workspace.id,
        kind: 'episode',
        trust: 'stated',
        documentCiphertext: encryptJson(content, key, `memory-item:${workspace.id}`),
        index: buildMemoryItemIndex(content, indexKey)
      });
      const origin = { path: 'workspace/retained-proof.txt' };
      const originCiphertext = encryptJson(origin, key, aad);
      const originKey = memoryOriginKey(origin.path, key);
      const prior = await memory.createMemorySource({
        userId: user.id,
        workspaceId: workspace.id,
        episodeId: episode.id,
        channel: 'file',
        bodyCiphertext: sealedBody,
        ...buildMemorySourceIndex(content.body, indexKey),
        originCiphertext,
        originKey
      });
      await memory.attachMemoryEvidence(episode.id, [{ sourceId: prior.id, span: [0, 12] }]);
      if (missingColumns) {
        await database.exec(`
          ALTER TABLE mem.source DROP COLUMN origin_ciphertext;
          ALTER TABLE mem.source DROP COLUMN origin_key;
        `);
      }
      const beforeColumns = await database.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='mem' AND table_name='source'
           AND column_name IN ('origin_ciphertext','origin_key')`
      );
      expect(beforeColumns.rows).toHaveLength(missingColumns ? 0 : 2);
      const beforeBodyHash = sha256(JSON.stringify(prior.bodyCiphertext));
      const beforeEvidence = (await database.query('SELECT * FROM mem.evidence')).rows;
      expect(beforeEvidence).toHaveLength(1);

      await migrateDatabase(database);
      const saved = await memory.createMemorySource({
        userId: user.id,
        workspaceId: workspace.id,
        episodeId: episode.id,
        channel: 'file',
        bodyCiphertext: sealedBody,
        ...buildMemorySourceIndex(content.body, indexKey),
        originCiphertext,
        originKey
      });
      expect(saved.originKey).toBe(originKey);
      expect(decryptJson(saved.originCiphertext!, key, aad)).toEqual(origin);
      const located = await memory.listMemorySourcesByOrigin(workspace.id, originKey);
      expect(located.map((row) => row.id)).toContain(saved.id);
      expect(located).toHaveLength(missingColumns ? 1 : 2);
      await expect(memory.listMemorySourcesByOrigin(randomUUID(), originKey)).resolves.toEqual([]);

      const history = await memory.listMemorySourceWindow(workspace.id, prior.id, {
        before: 0,
        after: 0
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ id: prior.id, userId: user.id, episodeId: episode.id });
      expect(sha256(JSON.stringify(history[0]!.bodyCiphertext))).toBe(beforeBodyHash);
      expect(decryptJson(history[0]!.bodyCiphertext, key, aad)).toEqual(content);
      expect(history[0]!.originCiphertext).toEqual(missingColumns ? null : originCiphertext);
      expect((await database.query('SELECT * FROM mem.evidence')).rows).toEqual(beforeEvidence);
      const allSources = (await database.query('SELECT * FROM mem.source ORDER BY id')).rows;
      expect(allSources).toHaveLength(2);
      const retainedHash = sha256(JSON.stringify(allSources));
      await migrateDatabase(database);
      expect(
        sha256(JSON.stringify((await database.query('SELECT * FROM mem.source ORDER BY id')).rows))
      ).toBe(retainedHash);
      const indexes = await database.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='mem' AND tablename='source'
          AND indexname='mem_source_origin_idx'`
      );
      expect(indexes.rows).toHaveLength(1);
    }
  );
});
