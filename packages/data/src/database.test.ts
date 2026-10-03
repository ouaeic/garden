import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.js';

/**
 * Every test in this repository runs on pglite and every installed box runs on postgres, so any
 * behaviour the two drivers do not share is a behaviour the suite can prove and the product does
 * not have. Nesting is one of those. A transaction callback handed the database itself would issue
 * a second BEGIN on a nested call - which PostgreSQL answers with a warning and ignores - and the
 * nested COMMIT would then commit the *outer* transaction for real. By the time the outer rollback
 * ran there would be no transaction left to undo, and both writes would have landed.
 *
 * Both drivers flatten nesting onto the one transaction the outermost call opened, and these cases
 * pin that, so a test asserting atomicity across a nested write proves something true of the
 * product and not only of the test driver.
 */
describe('transaction nesting', () => {
  let database: Database;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await database.exec('CREATE TABLE nesting(note TEXT PRIMARY KEY)');
  });

  afterEach(async () => database.close());

  const notes = async (): Promise<string[]> => {
    const result = await database.query<{ note: string }>('SELECT note FROM nesting ORDER BY note');
    return result.rows.map((row) => row.note);
  };

  it('undoes a write made inside a nested transaction when the outer one rolls back', async () => {
    await expect(
      database.transaction(async (outer) => {
        await outer.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
        await outer.transaction(async (inner) => {
          await inner.query('INSERT INTO nesting(note) VALUES ($1)', ['inner']);
        });
        throw new Error('the caller changed its mind');
      })
    ).rejects.toThrow('the caller changed its mind');

    expect(await notes()).toEqual([]);
  });

  it('rolls the outer transaction back when the nested callback is what throws', async () => {
    await expect(
      database.transaction(async (outer) => {
        await outer.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
        await outer.transaction(async (inner) => {
          await inner.query('INSERT INTO nesting(note) VALUES ($1)', ['inner']);
          throw new Error('the nested write is not allowed');
        });
      })
    ).rejects.toThrow('the nested write is not allowed');

    expect(await notes()).toEqual([]);
  });

  it('commits the nested write together with the outer one when nothing throws', async () => {
    await database.transaction(async (outer) => {
      await outer.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
      await outer.transaction(async (inner) => {
        await inner.query('INSERT INTO nesting(note) VALUES ($1)', ['inner']);
      });
    });

    expect(await notes()).toEqual(['inner', 'outer']);
  });

  it('keeps root-handle domain calls inside their active transaction', async () => {
    await expect(
      database.transaction(async () => {
        await database.query('INSERT INTO nesting(note) VALUES ($1)', ['root-query']);
        await database.exec("INSERT INTO nesting(note) VALUES ('root-exec')");
        await database.transaction(async (nested) => {
          await nested.query('INSERT INTO nesting(note) VALUES ($1)', ['root-nested']);
        });
        throw new Error('roll back domain calls');
      })
    ).rejects.toThrow('roll back domain calls');
    expect(await notes()).toEqual([]);
  }, 5_000);

  /**
   * A transaction handle owns nothing it could close: the pool, the socket and the embedded backend
   * outlive it and belong to everything else in the process. `PostgresDatabase` makes the scoped
   * `close` a no-op for that reason, and a caller that reaches for it on pglite - one of the store's
   * own methods handed a transaction instead of the database, say - must not take the whole
   * database down with it.
   */
  it('leaves the database open when a transaction handle is closed', async () => {
    await database.transaction(async (scoped) => {
      await scoped.close();
      await scoped.query('INSERT INTO nesting(note) VALUES ($1)', ['outer']);
    });

    expect(await notes()).toEqual(['outer']);
  });
  it('isolates concurrent callbacks so one rollback cannot commit another transaction', async () => {
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseFirst = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = database.transaction(async (transaction) => {
      await transaction.query('INSERT INTO nesting(note) VALUES ($1)', ['rolled-back']);
      entered();
      await releaseFirst;
      throw new Error('roll back first');
    });
    await firstEntered;
    const second = database.transaction(async (transaction) => {
      const visible = await transaction.query('SELECT note FROM nesting');
      expect(visible.rows).toEqual([]);
      await transaction.query('INSERT INTO nesting(note) VALUES ($1)', ['committed']);
    });
    // Let the competing BEGIN reach the backend while the first callback still owns its scope.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(await notes()).toEqual(['committed']);
  });
});
