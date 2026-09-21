import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { afterEach, expect, it } from 'vitest';
import { DatabaseFixtures } from './database-fixtures.js';

const factories: DatabaseFixtures[] = [];
const factory = () => {
  const fixtures = new DatabaseFixtures();
  factories.push(fixtures);
  return fixtures;
};
afterEach(async () => {
  await Promise.all(factories.splice(0).map((fixtures) => fixtures.close()));
});

it('keeps concurrent database copies and every later fixture independent', async () => {
  const fixtures = factory();
  const [first, second] = await Promise.all([fixtures.create(), fixtures.create()]);
  const schema = await first.database.query(
    'SELECT version,name FROM schema_migrations ORDER BY version'
  );
  expect(schema.rows.length).toBeGreaterThan(0);
  expect(
    (await second.database.query('SELECT version,name FROM schema_migrations ORDER BY version'))
      .rows
  ).toEqual(schema.rows);
  const identities = await Promise.all(
    [first, second].map((item) => stat(path.join(item.directory, 'database/PG_VERSION')))
  );
  expect(
    identities[0]!.dev === identities[1]!.dev && identities[0]!.ino === identities[1]!.ino
  ).toBe(false);
  await first.database.exec('CREATE TABLE fixture_identity (value text)');
  await first.database.query('INSERT INTO fixture_identity(value) VALUES ($1)', ['only first']);
  expect(
    (await second.database.query("SELECT to_regclass('public.fixture_identity') AS relation")).rows
  ).toEqual([{ relation: null }]);
  const third = await fixtures.create();
  expect(
    (await third.database.query("SELECT to_regclass('public.fixture_identity') AS relation")).rows
  ).toEqual([{ relation: null }]);
  expect((await first.database.query('SELECT value FROM fixture_identity')).rows).toEqual([
    { value: 'only first' }
  ]);
  await first.dispose();
  await first.dispose();
  await expect(stat(first.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await second.database.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
  const root = path.dirname(second.directory);
  await fixtures.close();
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fixtures.create()).rejects.toThrow('closed');
});

it('refuses changed template identity without invalidating an existing fixture', async () => {
  const fixtures = factory();
  const first = await fixtures.create();
  await writeFile(path.join(path.dirname(first.directory), 'schema.identity'), 'changed');
  await expect(fixtures.create()).rejects.toThrow('schema identity changed');
  expect((await first.database.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }]);
});

it('joins creation during shutdown and removes its unfinished copy', async () => {
  const fixtures = factory();
  const first = await fixtures.create();
  const pending = fixtures.create();
  const rejected = expect(pending).rejects.toThrow('closed');
  await fixtures.close();
  await rejected;
  await expect(stat(path.dirname(first.directory))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('hands independent closed copies to callers without overwriting or owning their state', async () => {
  const fixtures = factory();
  const root = await mkdtemp(path.join(tmpdir(), 'garden-db-copy-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const open: Database[] = [];
  try {
    await Promise.all([fixtures.copyTo(first), fixtures.copyTo(second)]);
    await writeFile(path.join(first, 'caller-marker'), 'keep me');
    await expect(fixtures.copyTo(first)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(first, 'caller-marker'), 'utf8')).toBe('keep me');
    await fixtures.close();
    await expect(fixtures.copyTo(path.join(root, 'late'))).rejects.toThrow('closed');
    for (const directory of [first, second]) {
      const database = createDatabase({ driver: 'pglite', pglitePath: directory });
      open.push(database);
      await migrateDatabase(database);
      expect((await database.query('SELECT COUNT(*)::int AS count FROM users')).rows).toEqual([
        { count: 0 }
      ]);
    }
    await open[0]!.exec('CREATE TABLE fixture_identity (value text)');
    await open[0]!.query('INSERT INTO fixture_identity(value) VALUES ($1)', ['caller owned']);
    expect(
      (await open[1]!.query("SELECT to_regclass('public.fixture_identity') AS relation")).rows
    ).toEqual([{ relation: null }]);
    await open.shift()!.close();
    const reopened = createDatabase({ driver: 'pglite', pglitePath: first });
    open.push(reopened);
    expect((await reopened.query('SELECT value FROM fixture_identity')).rows).toEqual([
      { value: 'caller owned' }
    ]);
  } finally {
    await Promise.all(open.map((database) => database.close()));
    await rm(root, { recursive: true, force: true });
  }
});
