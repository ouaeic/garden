import { PGlite } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { unwrapDataKey } from '@athanor/core';
import { migrations } from './migrations.js';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export type AdvisoryConnection = Pick<Database, 'query' | 'exec'> & {
  readonly signal: AbortSignal;
};
export interface AdvisoryLockOptions {
  autocommit?: boolean;
}

export interface Database {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(callback: (database: Database) => Promise<T>): Promise<T>;
  /** Runs the callback while holding a lock that every process sharing this database respects. */
  withAdvisoryLock<T>(
    key: number,
    callback: (connection?: AdvisoryConnection) => Promise<T>,
    options?: AdvisoryLockOptions
  ): Promise<T>;
  /**
   * Wakes the other processes sharing this database.
   *
   * The API, the worker and the notifier are separate units on a real box, and the only thing all
   * three already have in common is the database - so "a reply just arrived" travels the same way,
   * rather than each of them re-reading a table on a clock and adding its own second of delay.
   */
  notify(channel: string, payload: string): Promise<void>;
  /** Subscribes to `notify` from any process. Resolves to an unsubscribe. */
  listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/**
 * LISTEN and NOTIFY take an identifier, not a bound parameter, so a channel name is interpolated
 * into the statement. Every name in the product is a constant in this repository; this is the
 * check that keeps it that way.
 */
const assertChannel = (channel: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(channel))
    throw new Error(`Invalid notify channel: ${channel}`);
  return channel;
};

const acquireAdvisoryLock = async <T>(
  client: pg.ClientBase,
  key: number,
  callback: () => Promise<T>
): Promise<T> => {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
  try {
    return await callback();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
  }
};

class PostgresDatabase implements Database {
  readonly #transaction = new AsyncLocalStorage<Database>();
  readonly #pool: pg.Pool;
  readonly #connectionString: string;
  /**
   * LISTEN belongs to a session, so it cannot use the pool: a pooled client goes back into the
   * pool and the subscription goes with it. One dedicated connection carries every channel.
   */
  #listener: pg.Client | null = null;
  #listenerReady: Promise<pg.Client> | null = null;
  readonly #handlers = new Map<string, Set<(payload: string) => void>>();
  #closed = false;

  constructor(connectionString: string) {
    this.#connectionString = connectionString;
    this.#pool = new pg.Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000 });
    // node-postgres emits 'error' on the pool when an *idle* connection dies - a PostgreSQL
    // restart, an unattended upgrade, a `pg_terminate_backend`, a loopback blip. EventEmitter
    // throws on an unhandled 'error', and no try/catch around a query can intercept it, so
    // without this listener a routine database restart takes down the API, the worker and every
    // other service at once. The pool discards the dead client and reconnects on the next query;
    // the only thing needed here is to not let the event become an uncaught exception.
    this.#pool.on('error', (error) => {
      process.stderr.write(
        `[athanor] idle database connection dropped, pool will reconnect: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    });
  }

  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const transaction = this.#transaction.getStore();
    if (transaction) return transaction.query<T>(sql, params);
    const result = await this.#pool.query<T>(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string) {
    const transaction = this.#transaction.getStore();
    if (transaction) return transaction.exec(sql);
    await this.#pool.query(sql);
  }

  async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    const active = this.#transaction.getStore();
    if (active) return callback(active);
    const client = await this.#pool.connect();
    const scoped: Database = {
      query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const result = await client.query<R>(sql, params);
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
      transaction: async <R>(nested: (database: Database) => Promise<R>) => nested(scoped),
      withAdvisoryLock: async <R>(
        key: number,
        locked: (connection?: AdvisoryConnection) => Promise<R>,
        options?: AdvisoryLockOptions
      ) => {
        if (options?.autocommit)
          throw new Error('A durable operation cannot run inside a database transaction');
        return acquireAdvisoryLock(client, key, locked);
      },
      notify: (channel, payload) => this.notify(channel, payload),
      listen: (channel, handler) => this.listen(channel, handler),
      close: async () => undefined
    };
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await this.#transaction.run(scoped, () => callback(scoped));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Preserve the original failure, but reuse the session only after rollback confirms it is idle.
      await client.query('ROLLBACK').catch(() => {
        discard = true;
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async withAdvisoryLock<T>(
    key: number,
    callback: (connection?: AdvisoryConnection) => Promise<T>,
    options?: AdvisoryLockOptions
  ): Promise<T> {
    if (options?.autocommit && this.#transaction.getStore())
      throw new Error('A durable operation cannot run inside a database transaction');
    const client = await this.#pool.connect();
    const lifetime = new AbortController();
    const lost = () => lifetime.abort(new Error('The database lock session was lost'));
    client.on('error', lost);
    client.on('end', lost);
    let discard = false;
    try {
      // Autocommit checkpoints share the held session, leaving pool slots available to other work.
      return await acquireAdvisoryLock(client, key, () =>
        callback({
          signal: lifetime.signal,
          query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            lifetime.signal.throwIfAborted();
            const result = await client.query<R>(sql, params);
            return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
          },
          exec: async (sql: string) => {
            lifetime.signal.throwIfAborted();
            await client.query(sql);
          }
        })
      );
    } catch (error) {
      // Destroy an uncertain session so an unreleased advisory lock cannot return to the pool.
      discard = true;
      throw error;
    } finally {
      lifetime.abort(new Error('The database lock was released'));
      client.removeListener('error', lost);
      client.removeListener('end', lost);
      client.release(discard);
    }
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.#pool.query('SELECT pg_notify($1, $2)', [assertChannel(channel), payload]);
  }

  async listen(channel: string, handler: (payload: string) => void): Promise<() => Promise<void>> {
    assertChannel(channel);
    const handlers = this.#handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(channel, handlers);
    const client = await this.#listenerClient();
    await client.query(`LISTEN ${channel}`);
    return async () => {
      const set = this.#handlers.get(channel);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.#handlers.delete(channel);
        await this.#listener?.query(`UNLISTEN ${channel}`).catch(() => undefined);
      }
    };
  }

  async #listenerClient(): Promise<pg.Client> {
    if (this.#listener) return this.#listener;
    this.#listenerReady ??= (async () => {
      const client = new pg.Client({ connectionString: this.#connectionString });
      // A dropped listener is silent - no query fails, notifications simply stop arriving - so the
      // connection re-establishes itself and re-subscribes to every channel that is still wanted.
      // Callers keep their 'poll anyway' safety net for exactly the window this takes.
      client.on('error', () => {
        this.#listener = null;
        this.#listenerReady = null;
        client.end().catch(() => undefined);
        if (!this.#closed && this.#handlers.size > 0)
          setTimeout(() => void this.#relisten(), 1_000).unref();
      });
      client.on('notification', (message) => {
        for (const handler of this.#handlers.get(message.channel) ?? [])
          handler(message.payload ?? '');
      });
      await client.connect();
      // A close that landed while this connection was still being opened has already emptied the
      // handler set and ended the pool; keeping this one would leave a live session behind after
      // everything that could use it is gone.
      if (this.#closed) {
        await client.end().catch(() => undefined);
        throw new Error('Database is closed');
      }
      this.#listener = client;
      return client;
    })();
    try {
      return await this.#listenerReady;
    } catch (error) {
      this.#listenerReady = null;
      throw error;
    }
  }

  async #relisten(): Promise<void> {
    if (this.#closed || this.#handlers.size === 0) return;
    try {
      const client = await this.#listenerClient();
      for (const channel of this.#handlers.keys()) await client.query(`LISTEN ${channel}`);
    } catch {
      if (!this.#closed) setTimeout(() => void this.#relisten(), 5_000).unref();
    }
  }

  async close() {
    this.#closed = true;
    this.#handlers.clear();
    const listener = this.#listener;
    this.#listener = null;
    this.#listenerReady = null;
    if (listener) await listener.end().catch(() => undefined);
    await this.#pool.end();
  }
}

class EmbeddedDatabase implements Database {
  readonly #db: PGlite;
  readonly #locks = new Map<number, Promise<void>>();
  readonly #transaction = new AsyncLocalStorage<Database>();

  constructor(databasePath: string) {
    if (databasePath !== ':memory:')
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.#db = new PGlite(databasePath === ':memory:' ? undefined : databasePath);
  }

  async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const transaction = this.#transaction.getStore();
    if (transaction) return transaction.query<T>(sql, params);
    const result = await this.#db.query<T>(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rows.length > 0 ? result.rows.length : (result.affectedRows ?? 0)
    };
  }

  async exec(sql: string) {
    const transaction = this.#transaction.getStore();
    if (transaction) return transaction.exec(sql);
    await this.#db.exec(sql);
  }

  async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    const active = this.#transaction.getStore();
    if (active) return callback(active);
    // The native scope queues competing callers; nested domain calls share this one transaction.
    return this.#db.transaction(async (transaction) => {
      const scoped: Database = {
        query: async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const result = await transaction.query<R>(sql, params);
          return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
        },
        exec: async (sql: string) => {
          await transaction.exec(sql);
        },
        transaction: async <R>(nested: (database: Database) => Promise<R>) => nested(scoped),
        withAdvisoryLock: <R>(
          key: number,
          locked: (connection?: AdvisoryConnection) => Promise<R>,
          options?: AdvisoryLockOptions
        ) => this.withAdvisoryLock(key, locked, options),
        notify: (channel: string) => this.notify(channel),
        listen: (channel: string) => this.listen(channel),
        close: async () => undefined
      };
      return this.#transaction.run(scoped, () => callback(scoped));
    });
  }

  // PGlite is a single backend embedded in this process, so pg_advisory_lock would be taken and
  // re-taken on the one session and never block anybody. Queueing on a promise chain gives the
  // same exclusion for the only concurrency that can exist here: two callers in one process.
  async withAdvisoryLock<T>(
    key: number,
    callback: (connection?: AdvisoryConnection) => Promise<T>,
    options?: AdvisoryLockOptions
  ): Promise<T> {
    if (options?.autocommit && this.#transaction.getStore())
      throw new Error('A durable operation cannot run inside a database transaction');
    const queued = (this.#locks.get(key) ?? Promise.resolve()).then(async () => {
      const lifetime = new AbortController();
      try {
        return await callback({
          signal: lifetime.signal,
          query: <R extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            lifetime.signal.throwIfAborted();
            return this.query<R>(sql, params);
          },
          exec: (sql: string) => {
            lifetime.signal.throwIfAborted();
            return this.exec(sql);
          }
        });
      } finally {
        lifetime.abort(new Error('The database lock was released'));
      }
    });
    const tail = queued.then(
      () => undefined,
      () => undefined
    );
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return queued;
  }

  // PGlite is one backend inside one process, so there is no second process to wake: everything
  // that would have listened here is already reached by the store's in-process signal. Accepting
  // the call and doing nothing keeps every caller free of a driver check.
  async notify(channel: string): Promise<void> {
    assertChannel(channel);
  }

  async listen(channel: string): Promise<() => Promise<void>> {
    assertChannel(channel);
    return async () => undefined;
  }

  async close() {
    await this.#db.close();
  }
}

export interface DatabaseConfig {
  driver: 'postgres' | 'pglite';
  url?: string;
  pglitePath?: string;
}

export const createDatabase = (config: DatabaseConfig): Database => {
  if (config.driver === 'postgres') {
    if (!config.url) throw new Error('DATABASE_URL is required for the postgres driver');
    return new PostgresDatabase(config.url);
  }
  return new EmbeddedDatabase(config.pglitePath ?? '.athanor/postgres');
};

/**
 * Fixed key for the schema-migration lock. Arbitrary, but it must never change: it is the only
 * thing that makes two processes agree they are migrating the same database.
 */
const MIGRATION_LOCK_KEY = 0x4174_4861;

// Every service migrates at startup and the installer restarts them back to back, so on a fresh
// database several processes reach this at the same moment. Without the lock they each see an
// empty schema_migrations and race to apply the same CREATE TABLE and INSERT.
export const migrateDatabase = async (database: Database): Promise<void> =>
  database.withAdvisoryLock(MIGRATION_LOCK_KEY, async () => {
    await database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const applied = await database.query<{ version: number }>(
      'SELECT version FROM schema_migrations'
    );
    const versions = new Set(applied.rows.map((row) => Number(row.version)));
    /**
     * A database that has been through migrations this build has never heard of belongs to a newer
     * athanor. `athanor update` restores the pre-update dump alongside the pre-update revision, so
     * the pairing is normally kept for us; a checkout moved back by hand is where the two part
     * company. Older code against a newer schema does not fail cleanly - it writes rows that
     * satisfy the constraints it remembers - so the process stops here, while everything is still
     * intact, rather than at the first write that happens to notice.
     */
    const declared = new Set<number>(migrations.map((migration) => migration.version));
    const unknown = [...versions].filter((version) => !declared.has(version)).sort((a, b) => a - b);
    if (unknown.length)
      throw new Error(
        `This database has been migrated by a newer athanor: it carries schema version ${unknown.at(
          -1
        )}, and this build knows ${Math.max(...declared)}. Move back to the newer build, or restore the backup taken before the update.`
      );
    for (const migration of migrations) {
      if (versions.has(migration.version)) continue;
      await database.transaction(async (transaction) => {
        await transaction.exec(migration.sql);
        await transaction.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name
        ]);
      });
    }
  });

/**
 * A dump and the key that opens it are two halves of one backup, and only `athanor restore` keeps
 * them together. A hand-run `pg_restore` onto a fresh install pairs old ciphertext with the key the
 * installer minted minutes earlier, and nothing about that fails loudly: the key still decodes to
 * 32 bytes, migrations still apply, /healthz still answers. The first sign is the conversation list
 * itself returning 500, because every task title is encrypted.
 *
 * The reason this refuses to boot rather than reporting itself unready is that a server on the
 * wrong key keeps writing. New workspaces get wrapped under the new key while the old rows stay
 * sealed under the old one, and once both generations exist, finding the original key no longer
 * rescues anything - there is no single key that opens both. Stopping here is what keeps an hour's
 * mistake reversible instead of permanent.
 */
export const assertMasterKeyOpensDatabase = async (
  database: Database,
  masterKey: Uint8Array
): Promise<void> => {
  const existing = await database.query<{ workspace_id: string; wrapped_key: string }>(
    'SELECT workspace_id, wrapped_key FROM workspace_keys LIMIT 1'
  );
  const row = existing.rows[0];
  // A fresh install has nothing to disagree with yet, and has to boot in order to get a workspace.
  if (!row) return;
  try {
    unwrapDataKey(row.wrapped_key, masterKey, row.workspace_id);
  } catch {
    throw new Error(
      'This database was encrypted with a different DATA_MASTER_KEY: the key in /etc/athanor/control.env does not open it. Restore the control.env that was taken alongside this database - the installer generates a fresh key whenever it does not find one, and nothing already stored can be read without the original.'
    );
  }
};
