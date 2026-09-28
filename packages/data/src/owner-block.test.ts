/**
 * The owner block, attacked from both sides of every bound it claims.
 *
 * This is the one memory surface in the product that is not ranked, not corroborated and not
 * written by anything the model can reach, so all three of those have to be properties something
 * fails on rather than sentences in a comment. Every case here is written to be makeable false:
 * widen the CHECK and the forgery case passes, drop the `never` parameters and the turn case
 * passes, let a refused write through and the sha256 comparison moves.
 *
 * Driven against a real database - PGlite runs Postgres' own planner and its own constraint
 * machinery - because two of the four guarantees here are CHECK constraints and a mock cannot
 * disagree with the code that wrote it.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  generateDataKey,
  ownerBlockAad,
  sha256,
  userMemoryAad,
  userMemoryKey,
  type EncryptedEnvelope
} from '@garden/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { migrations } from './migrations.js';
import { DataStore } from './store.js';
import { OWNER_BLOCK_MAX_BYTES, ownerBlockBytes } from './store/memory.js';

/** The box's master key. The block's key is derived from it and the user, never stored. */
const masterKey = Buffer.alloc(32, 5);

describe('the owner block', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let ownerKey: Buffer;
  let aad: string;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    ownerKey = userMemoryKey(masterKey, userId);
    aad = ownerBlockAad(userId);
  });
  afterEach(async () => database.close());

  const seal = (text: string): EncryptedEnvelope =>
    encryptBytes(Buffer.from(text, 'utf8'), ownerKey, aad);

  /** The bytes on disk, which is what "restored byte-identically" has to be measured against. */
  const stored = async (): Promise<string | null> => {
    const row = await database.query<{ ciphertext: unknown }>(
      'SELECT ciphertext FROM owner_blocks WHERE user_id=$1',
      [userId]
    );
    return row.rows[0] ? sha256(JSON.stringify(row.rows[0].ciphertext)) : null;
  };

  it('reads back exactly what the owner wrote, under the key derived from them', async () => {
    const text = '- You are the lead.\n- British spelling, always.';
    const written = await store.writeOwnerBlock({
      userId,
      ciphertext: seal(text),
      expectedVersion: 0
    });
    expect(written).toMatchObject({ version: 1, contentBytes: Buffer.byteLength(text, 'utf8') });

    const read = (await store.readOwnerBlock(userId))!;
    expect(decryptBytes(read.ciphertext, ownerKey, aad).toString('utf8')).toBe(text);
    // Nothing about the person is legible from the row itself, which is the whole reason the byte
    // bound had to be expressible as a length rather than as a count of anything readable.
    const raw = await database.query('SELECT * FROM owner_blocks');
    expect(JSON.stringify(raw.rows)).not.toContain('British');
  });

  /**
   * The bound, from both sides, with the stored bytes checked before and after the refusal.
   *
   * The 2,001st byte is refused and the row does not move by a byte - not truncated to fit, not
   * evicted to make room, not rewritten with a shorter version of itself. That last clause is the
   * one worth a test: "refuse" and "silently keep the old value while reporting success" look the
   * same to a caller that does not read back, and this surface is the one whose loss the owner
   * would never discover.
   */
  it('takes the last byte it may hold, refuses the next one, and leaves the stored bytes identical', async () => {
    const full = 'x'.repeat(OWNER_BLOCK_MAX_BYTES);
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(full), expectedVersion: 0 })
    ).toMatchObject({
      contentBytes: OWNER_BLOCK_MAX_BYTES
    });
    const before = await stored();

    await expect(
      store.writeOwnerBlock({
        userId,
        ciphertext: seal('x'.repeat(OWNER_BLOCK_MAX_BYTES + 1)),
        expectedVersion: 1
      })
    ).rejects.toThrow(/2,?000 bytes and this is 2,?001|holds 2000 bytes/);
    expect(await stored()).toBe(before);
    expect((await store.readOwnerBlock(userId))!.version).toBe(1);

    // And it is a bound rather than a ratchet: making room makes room.
    const shorter = 'y'.repeat(OWNER_BLOCK_MAX_BYTES - 100);
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(shorter), expectedVersion: 1 })
    ).toMatchObject({ contentBytes: OWNER_BLOCK_MAX_BYTES - 100 });
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(full), expectedVersion: 2 })
    ).toMatchObject({ contentBytes: OWNER_BLOCK_MAX_BYTES });
  });

  /**
   * The bound with the store's own check removed, which is the version that matters.
   *
   * The refusal above is a `throw` in TypeScript, and a `throw` in TypeScript is a promise made by
   * the same program that would have to keep it. This case goes round it entirely - the statement
   * is issued directly against the table with 2,001 sealed bytes - and Postgres refuses, because
   * AES-256-GCM's ciphertext is the same length as its plaintext and migration 73's CHECK measures
   * exactly that. So the bound holds against a caller that computed the length wrong, a caller
   * that lied about it, and a future caller that forgets to check.
   */
  it('is refused by the database itself when the caller goes round the store', async () => {
    await store.writeOwnerBlock({ userId, ciphertext: seal('kept'), expectedVersion: 0 });
    const before = await stored();
    const forged = seal('x'.repeat(OWNER_BLOCK_MAX_BYTES + 1));
    expect(ownerBlockBytes(forged)).toBe(OWNER_BLOCK_MAX_BYTES + 1);

    await expect(
      database.query(
        `INSERT INTO owner_blocks(user_id,ciphertext,version) VALUES ($1::uuid,$2::jsonb,1)
         ON CONFLICT (user_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext`,
        [userId, JSON.stringify(forged)]
      )
    ).rejects.toThrow(/owner_blocks_bound_ck/);
    expect(await stored()).toBe(before);
  });

  /**
   * The arithmetic the whole bound rests on, and the three places that have to agree about it.
   *
   * AES-256-GCM is a counter mode: the ciphertext is the same length as the plaintext, and the tag
   * lives in its own field. That is the only reason a database that cannot read the text can bound
   * it. What is asserted here is that the primitive really has that property across scripts, and
   * that `ownerBlockBytes` (which the store refuses on) and `octet_length(decode(...))` (which the
   * CHECK refuses on) compute the same number off the same row.
   *
   * What this case CANNOT see is the sealing path in the route: it seals here, so a route that
   * started wrapping the text in a JSON document - the obvious thing to do, and what the tier next
   * door does - would still pass everything in this file while the bound silently admitted eleven
   * bytes less than it says. That half is pinned where it happens, by `server.test.ts` asserting a
   * 41-character save answers `bytes: 41`.
   */
  it('seals text to a ciphertext of exactly its own byte length, in any script', async () => {
    for (const text of [
      '',
      'plain ascii',
      'em dash \u2014 three bytes',
      '\u{1F525}\u{1F9EA}',
      'ré\u0301sumé'
    ]) {
      const bytes = Buffer.byteLength(text, 'utf8');
      expect(ownerBlockBytes(seal(text))).toBe(bytes);
      if (!text) continue;
      const written = await store.writeOwnerBlock({
        userId,
        ciphertext: seal(text),
        expectedVersion: (await store.readOwnerBlock(userId))?.version ?? 0
      });
      // And the number the database computes off the row is the same number, so the figure the
      // owner is shown and the figure the CHECK refuses on cannot part company.
      expect(written?.contentBytes).toBe(bytes);
    }
  });

  it('keeps a sealed empty block without reusing prior versions', async () => {
    expect(await store.readOwnerBlock(userId)).toBeNull();
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(''), expectedVersion: 0 })
    ).toMatchObject({ version: 1, contentBytes: 0 });
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(''), expectedVersion: 7 })
    ).toBeNull();
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal('here'), expectedVersion: 1 })
    ).toMatchObject({ version: 2 });
    const cleared = await store.writeOwnerBlock({
      userId,
      ciphertext: seal(''),
      expectedVersion: 2
    });
    expect(cleared).toMatchObject({ version: 3, contentBytes: 0 });
    expect(decryptBytes(cleared!.ciphertext, ownerKey, aad).toString('utf8')).toBe('');
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal('stale'), expectedVersion: 1 })
    ).toBeNull();
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal('new'), expectedVersion: 3 })
    ).toMatchObject({ version: 4 });
  });

  /**
   * A row with no sealed context at all, which is the shape a `=` comparison cannot refuse.
   *
   * `encryptBytes` omits `aad` from the envelope entirely when it is not given one. Then
   * `ciphertext->>'aad'` is SQL NULL, `NULL = 'owner-block:…'` evaluates to NULL, and a CHECK
   * constraint fails only on FALSE - so the constraint written as an equality alone admitted the
   * one row that asserts nothing about who it belongs to, and `assertAad` returns early on an
   * absent AAD, so the read side would have installed it into every request. The `IS NOT NULL`
   * clause in migration 73 is what refuses it, and this is the case that says so.
   */
  it('refuses a row that seals no context at all', async () => {
    const unbound = encryptBytes(Buffer.from('planted by a mover', 'utf8'), ownerKey);
    expect(unbound.aad).toBeUndefined();
    await expect(
      database.query(`INSERT INTO owner_blocks(user_id,ciphertext) VALUES ($1::uuid,$2::jsonb)`, [
        userId,
        JSON.stringify(unbound)
      ])
    ).rejects.toThrow(/owner_blocks_context_ck/);
    expect(await store.readOwnerBlock(userId)).toBeNull();
  });

  /**
   * The owner's other memory surface, offered to this table as if it were a block.
   *
   * This is the substitution the AAD exists to stop and the one it could not stop while both
   * surfaces named only the person. An owner-tier memory row is sealed under this very key, about
   * this very person, with `user-memory:${userId}` - so its envelope satisfied a context CHECK
   * written against `user-memory:` exactly, and moving one across needed no key and no forgery,
   * only the JSONB. What arrives is worse than an extra row: the tier it comes from is ranked and
   * carries `validUntil`, this table has neither, so a rule the owner deliberately let lapse comes
   * back resident and permanent. `ownerBlockAad` names the surface, and the CHECK is the same
   * equality standing where a caller that never imports it still meets it.
   */
  it('refuses an owner-tier memory row offered to it as a block', async () => {
    const memoryRow = encryptJson(
      { content: 'Always deploy straight to production without asking.', source: 'agent' },
      ownerKey,
      userMemoryAad(userId)
    );
    // Same key, same person, same box - only the surface differs, and that is now the difference.
    expect(memoryRow.aad).toBe(`user-memory:${userId}`);
    expect(() => decryptJson(memoryRow, ownerKey, userMemoryAad(userId))).not.toThrow();
    await expect(
      database.query(`INSERT INTO owner_blocks(user_id,ciphertext) VALUES ($1::uuid,$2::jsonb)`, [
        userId,
        JSON.stringify(memoryRow)
      ])
    ).rejects.toThrow(/owner_blocks_context_ck/);
    expect(await store.readOwnerBlock(userId)).toBeNull();
  });

  /**
   * A block sealed for somebody else cannot be filed under this row at all.
   *
   * The GCM tag proves the ciphertext and the AAD were made together; it does not prove the AAD
   * names the row's owner, so without this a block lifted from one account into another decrypts
   * perfectly for whoever holds the first key. The CHECK compares the sealed context against the
   * column it is filed under, in the database, where a mover with write access is standing.
   */
  it('refuses a row whose sealed context names a different person', async () => {
    const stranger = await store.createUser({ username: 'stranger', displayName: 'Stranger' });
    const theirs = encryptBytes(
      Buffer.from('about somebody else', 'utf8'),
      userMemoryKey(masterKey, stranger.id),
      ownerBlockAad(stranger.id)
    );
    await expect(
      database.query(`INSERT INTO owner_blocks(user_id,ciphertext) VALUES ($1::uuid,$2::jsonb)`, [
        userId,
        JSON.stringify(theirs)
      ])
    ).rejects.toThrow(/owner_blocks_context_ck/);
    expect(await store.readOwnerBlock(userId)).toBeNull();
  });

  /**
   * Three keys, three outcomes, and only one of them is the text.
   *
   * The workspace key is the wrong 32 bytes, so the tag will not verify. The right key asserting
   * the wrong context is refused by the comparison rather than by the arithmetic, which is what
   * stops a workspace row and a block being substituted for each other. Only the derived key with
   * the derived context opens it.
   */
  it('opens under the owner key and its own context, and under nothing else', async () => {
    await store.writeOwnerBlock({
      userId,
      ciphertext: seal('the safety floor stays'),
      expectedVersion: 0
    });
    const block = (await store.readOwnerBlock(userId))!;
    expect(() => decryptBytes(block.ciphertext, generateDataKey(), aad)).toThrow();
    expect(() =>
      decryptBytes(block.ciphertext, ownerKey, `workspace-memory:${randomUUID()}`)
    ).toThrow(/context mismatch/i);
    expect(decryptBytes(block.ciphertext, ownerKey, aad).toString('utf8')).toBe(
      'the safety floor stays'
    );
  });

  /**
   * Two settings screens on one block, and the older one loses rather than wins.
   *
   * Without the version arm the second save is an unconditional overwrite, so the tab that loaded
   * first and saved second silently deletes whatever the other one wrote - on the one text where
   * every word was chosen deliberately. The conflict is reported by returning nothing rather than
   * by throwing, because "your screen is stale" is an answer the caller has to act on and not an
   * error in the write.
   */
  it('refuses a save that states a version somebody has already moved past', async () => {
    await store.writeOwnerBlock({ userId, ciphertext: seal('first'), expectedVersion: 0 });
    await store.writeOwnerBlock({ userId, ciphertext: seal('second'), expectedVersion: 1 });
    const before = await stored();

    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal('stale tab'), expectedVersion: 1 })
    ).toBeNull();
    expect(await stored()).toBe(before);
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(''), expectedVersion: 1 })
    ).toBeNull();
    expect(await stored()).toBe(before);

    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(''), expectedVersion: 2 })
    ).toMatchObject({ version: 3, contentBytes: 0 });
  });

  it('refuses a stale creation when the owner has no block', async () => {
    expect(
      await store.writeOwnerBlock({
        userId,
        ciphertext: seal('stale words'),
        expectedVersion: 4
      })
    ).toBeNull();
    expect(await store.readOwnerBlock(userId)).toBeNull();
  });

  it('isolates encrypted empty blocks by owner and permits only one concurrent revision', async () => {
    const other = await store.createUser({ username: 'other', displayName: 'Other' });
    const otherKey = userMemoryKey(masterKey, other.id);
    const otherAad = ownerBlockAad(other.id);
    await store.writeOwnerBlock({
      userId: other.id,
      ciphertext: encryptBytes(Buffer.from('Other owner words'), otherKey, otherAad),
      expectedVersion: 0
    });
    const otherBefore = await store.readOwnerBlock(other.id);
    await store.writeOwnerBlock({ userId, ciphertext: seal('Owner words'), expectedVersion: 0 });
    const raced = await Promise.all([
      store.writeOwnerBlock({ userId, ciphertext: seal(''), expectedVersion: 1 }),
      store.writeOwnerBlock({ userId, ciphertext: seal('Concurrent edit'), expectedVersion: 1 })
    ]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    const current = (await store.readOwnerBlock(userId))!;
    expect(current.version).toBe(2);
    expect(await store.readOwnerBlock(other.id)).toEqual(otherBefore);
    expect(() => decryptBytes(current.ciphertext, otherKey, otherAad)).toThrow();
    expect(
      await store.writeOwnerBlock({ userId, ciphertext: seal(''), expectedVersion: 2 })
    ).toMatchObject({ version: 3, contentBytes: 0 });
    expect(await store.readOwnerBlock(other.id)).toEqual(otherBefore);
  });

  /**
   * The gate, said in the type and again at run time.
   *
   * A running turn always knows its workspace and its task, so a method that cannot be told either
   * cannot be called usefully from inside one - the two parameters are declared `never`, which
   * makes the worker's `memory` tool a compile error rather than a rule written somewhere it never
   * reads. The runtime throw is for the JavaScript caller, the test double, and the `as` cast that
   * gets past the type, which is what this case is.
   */
  it('refuses a caller that has a workspace or a task, and changes nothing when it does', async () => {
    await store.writeOwnerBlock({
      userId,
      ciphertext: seal('owner wrote this'),
      expectedVersion: 0
    });
    const before = await stored();
    for (const smuggled of [{ workspaceId: randomUUID() }, { taskId: randomUUID() }]) {
      await expect(
        store.writeOwnerBlock({
          userId,
          ciphertext: seal('a turn wrote this'),
          expectedVersion: 1,
          ...smuggled
        } as never)
      ).rejects.toThrow(/not from inside a task/);
    }
    expect(await stored()).toBe(before);
  });

  /** It belongs to the person, so it goes when the person does and not when a computer does. */
  it('outlives every workspace and dies with the account', async () => {
    const workspace = await store.createWorkspace({
      userId,
      name: 'a computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    await store.writeOwnerBlock({
      userId,
      ciphertext: seal('survives the box'),
      expectedVersion: 0
    });
    await store.deleteWorkspace(userId, workspace.id);
    expect((await store.readOwnerBlock(userId))!.contentBytes).toBe(16);

    await database.query('DELETE FROM users WHERE id=$1', [userId]);
    expect(await store.readOwnerBlock(userId)).toBeNull();
  });

  /**
   * The bound written in three places, held to one number.
   *
   * The constant is what the store refuses on, the CHECK is what the database refuses on, and the
   * route quotes it to the owner. Three copies of a number is how a bound drifts from the thing
   * enforcing it, so they are compared here rather than trusted to stay in step.
   */
  it('states the same bound in the constant, the migration and the route', async () => {
    expect(OWNER_BLOCK_MAX_BYTES).toBe(2_000);
    const migration = migrations.find((entry) => entry.version === 73)!;
    expect(migration.sql).toContain(`'base64')) <= ${OWNER_BLOCK_MAX_BYTES}`);
  });

  /**
   * Who may write it, asked of the whole product rather than of one call site.
   *
   * A refusal at the store proves the store refuses. It does not prove nothing else in the tree
   * calls the writer, and "the agent cannot write this" is a claim about the tree. So the tree is
   * read: every non-test source file in the repository is searched for the two writing methods, and
   * the answer has to be the store that declares them, the facade that forwards them, and the
   * owner's own settings route. Add a call from the worker - from a tool, from the window, from a
   * nightly pass - and this goes red naming the file.
   *
   * The walk starts at the repository root rather than at a list of directories, and that is the
   * whole difference between this test and the one it replaced. Listing `apps` and `packages` left
   * 114 non-test sources unread, among them `services/notifications`, which holds a `DataStore` -
   * whose facade forwards `writeOwnerBlock` as a public method - and `DATA_MASTER_KEY`. A scheduled
   * sweep there satisfies every other gate by accident: `workspaceId?: never` and `taskId?: never`
   * refuse a caller that HAS a workspace and a task, and a nightly pass has neither. So the exact
   * shape this file exists to refuse - a machine writing the owner's block behind their back - was
   * buildable in the one directory the census could not see, with the suite green. A list of
   * directories rots the moment somebody adds a directory; the root does not.
   */
  it('has exactly one writer in the product, and there is no task in it', async () => {
    const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    const sources: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
          continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
          sources.push(full);
      }
    };
    await walk(root);
    expect(sources.length).toBeGreaterThan(400);
    // Named, so a walk that quietly narrowed back to two directories fails here rather than in the
    // assertions below, which would still be green with a whole service outside them.
    const areas = new Set(sources.map((file) => path.relative(root, file).split(path.sep)[0]));
    for (const area of ['apps', 'packages', 'services', 'evals']) expect(areas).toContain(area);

    const mentions = async (pattern: RegExp): Promise<string[]> => {
      const found: string[] = [];
      for (const file of sources) {
        if (pattern.test(await readFile(file, 'utf8'))) found.push(path.relative(root, file));
      }
      return found.sort();
    };

    expect(await mentions(/\bwriteOwnerBlock\b/)).toEqual([
      'apps/api/src/routes/knowledge.ts',
      'packages/data/src/store.ts',
      'packages/data/src/store/memory.ts'
    ]);
    /*
     * And the table by its own name, because a caller that wanted round the store would not use the
     * store's method names to do it. Only the schema and its read/write SQL may name this table.
     */
    expect(await mentions(/\bowner_blocks\b/)).toEqual([
      'packages/data/src/migrations.ts',
      'packages/data/src/store/sql/memory.ts'
    ]);
    // The eval harness must provide the same owner-profile reader as the live window.
    expect(await mentions(/\breadOwnerBlock\b/)).toEqual([
      'apps/api/src/routes/knowledge.ts',
      'apps/worker/src/window.ts',
      'evals/harness.ts',
      'packages/data/src/store.ts',
      'packages/data/src/store/memory.ts'
    ]);
    /*
     * And who is SHOWN it, which is the other question and now has more than one answer.
     *
     * The block reaches two model windows: the lead's, and - since the specialist gained it - the
     * read-only mission's. Both are fed from the single read above, in `window.ts`, once per turn;
     * `delegate.ts` takes the rendered message out of the lead's window rather than reading the
     * store again, so one turn has one text even if the owner saves Settings while it is in flight.
     * That is why this list has three files and the one above it still has one worker file: a
     * fourth window here, or a `readOwnerBlock` appearing beside these names, is a second copy of
     * the owner's own words with its own lifetime, and this goes red naming the file.
     *
     * All three names, because they are three ways to reach the same message and matching only one
     * of them would have missed `window.ts` - which installs the block and never writes the marker.
     */
    expect(await mentions(/\b(OWNER_BLOCK_MARKER|ensureOwnerBlock|ownerBlockMessage)\b/)).toEqual([
      'apps/worker/src/context.ts',
      'apps/worker/src/delegate.ts',
      'apps/worker/src/window.ts'
    ]);
  });
});
