import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, migrateDatabase, type Database } from '../database.js';
import { migrations } from '../migrations.js';

export interface DatabaseFixture {
  database: Database;
  directory: string;
  dispose(): Promise<void>;
}

const schemaIdentity = () => createHash('sha256').update(JSON.stringify(migrations)).digest('hex');

async function copyTemplate(source: string, destination: string): Promise<void> {
  const files: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    if (relative) await mkdir(path.join(destination, relative), { mode: 0o700 });
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
      else throw Error('A test database template must contain only ordinary files and directories');
    }
  };
  await visit('');
  if (!files.length) throw Error('The test database template is empty');
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(16, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++]!;
        await copyFile(
          path.join(source, file),
          path.join(destination, file),
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
        );
      }
    })
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Closed, blank templates for domain tests. Installation and migration tests use fresh databases. */
export class DatabaseFixtures {
  #root: string | undefined;
  #template: Promise<{ directory: string; identity: string }> | undefined;
  #pending = new Set<Promise<unknown>>();
  #fixtures = new Set<DatabaseFixture>();
  #closing: Promise<void> | undefined;

  async #prepare(): Promise<{ directory: string; identity: string }> {
    if (!migrations.length) throw Error('A test template requires declared migrations');
    this.#root = await mkdtemp(path.join(tmpdir(), 'garden-db-fixtures-'));
    const directory = path.join(this.#root, 'template');
    const identity = schemaIdentity();
    const database = createDatabase({ driver: 'pglite', pglitePath: directory });
    try {
      await migrateDatabase(database);
      const rows = await database.query<{ version: number; name: string }>(
        'SELECT version,name FROM schema_migrations ORDER BY version'
      );
      const expected = migrations
        .map(({ version, name }) => ({ version, name }))
        .sort((a, b) => a.version - b.version);
      if (JSON.stringify(rows.rows) !== JSON.stringify(expected))
        throw Error('The test template does not have the declared schema');
    } finally {
      await database.close();
    }
    await writeFile(path.join(this.#root, 'schema.identity'), identity, {
      mode: 0o600,
      flag: 'wx'
    });
    return { directory, identity };
  }

  create(): Promise<DatabaseFixture> {
    if (this.#closing) return Promise.reject(Error('Database fixtures are closed'));
    const pending = this.#create();
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  /** Copies only a closed blank schema; the caller owns opening and removing the destination. */
  copyTo(directory: string): Promise<void> {
    if (this.#closing) return Promise.reject(Error('Database fixtures are closed'));
    const pending = this.#copyTo(directory);
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  async #copyTo(directory: string): Promise<void> {
    const template = await (this.#template ??= this.#prepare());
    if (this.#closing) throw Error('Database fixtures are closed');
    if (
      template.identity !== schemaIdentity() ||
      (await readFile(path.join(this.#root!, 'schema.identity'), 'utf8')) !== template.identity
    )
      throw Error('The test template schema identity changed');
    await mkdir(directory, { mode: 0o700 });
    try {
      await copyTemplate(template.directory, directory);
      if (this.#closing) throw Error('Database fixtures are closed');
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async #create(): Promise<DatabaseFixture> {
    await (this.#template ??= this.#prepare());
    if (this.#closing) throw Error('Database fixtures are closed');
    const directory = await mkdtemp(path.join(this.#root!, 'fixture-'));
    let database: Database | undefined;
    try {
      const databasePath = path.join(directory, 'database');
      await this.#copyTo(databasePath);
      database = createDatabase({ driver: 'pglite', pglitePath: databasePath });
      await migrateDatabase(database);
      if (this.#closing) throw Error('Database fixtures are closed');
      let disposed: Promise<void> | undefined;
      const fixture: DatabaseFixture = {
        database,
        directory,
        dispose: () => {
          disposed ??= (async () => {
            try {
              await fixture.database.close();
            } finally {
              await rm(directory, { recursive: true, force: true });
              this.#fixtures.delete(fixture);
            }
          })();
          return disposed;
        }
      };
      this.#fixtures.add(fixture);
      return fixture;
    } catch (error) {
      try {
        await database?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await Promise.allSettled([...this.#pending]);
      await this.#template?.catch(() => undefined);
      const disposed = await Promise.allSettled([...this.#fixtures].map((item) => item.dispose()));
      if (this.#root) await rm(this.#root, { recursive: true, force: true });
      const failed = disposed.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return this.#closing;
  }
}
