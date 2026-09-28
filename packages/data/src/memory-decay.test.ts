/**
 * The usage term, attacked from both sides of every property it claims.
 *
 * Three things the owner asked of this score, and one they said was already missing:
 *
 *   1. nothing becomes unretrievable however old it is;
 *   2. fifty uses massed into a week rank below fifty spread over a year;
 *   3. a memory heavily used in one project fades rather than holding its weight;
 *   4. "positive as well as negative reinforcement" - a use that failed has to cost something.
 *
 * Every case below scores the SAME rows a second way, under the rule that shipped before it, and
 * asserts that the other rule gets the property wrong. That is what stops these being assertions
 * about arithmetic: the 90-day count and the un-decayed count are computed here over the real
 * `mem.item_use` rows the production writer left, so if the new score ever degenerates into either
 * of them the comparison collapses and the case fails.
 *
 * Everything runs through `recordMemoryUse` and `consolidateMemory` - the two methods
 * `apps/worker/src/memory-capture.ts` calls - against a real PGlite database with the shipped SQL.
 * Nothing here reimplements the score; the numbers come back off `mem.item.salience` and out of
 * `mem.prior` itself.
 */
import { randomUUID } from 'node:crypto';
import {
  MEMORY_SALIENCE_CITE_WEIGHT,
  MEMORY_SALIENCE_FAIL_WEIGHT,
  MEMORY_SALIENCE_USE_WEIGHT,
  MEMORY_USE_AGE_FLOOR_DAYS,
  MEMORY_USE_DECAY_EXPONENT,
  buildMemoryItemIndex,
  memoryIndexKey,
  planMemoryQuery
} from '@garden/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { DataStore } from './store.js';

const key = memoryIndexKey(Buffer.alloc(32, 11));
const NOW = new Date('2026-08-31T12:00:00.000Z');
const at = (daysAgo: number): Date => new Date(NOW.getTime() - daysAgo * 86_400_000);
/** Longer than any history a case here builds, so a pass folds nothing. */
const NEVER_FOLD = 100_000;

describe('the usage term', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let workspaceId: string;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace({
      userId,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  const add = async (subject: string, body: string): Promise<string> =>
    (
      await store.createMemoryItem({
        id: randomUUID(),
        userId,
        workspaceId,
        kind: 'fact',
        trust: 'stated',
        documentCiphertext: { v: 1, iv: 'x', tag: 'x', ciphertext: body },
        index: buildMemoryItemIndex(
          { title: subject, tags: [], body, subject, object: 'value' },
          key
        ),
        predicate: 'related_to',
        // Every row in every case shares one observation date, so the decay term in `mem.prior`
        // that is NOT under test here is identical across the rows being compared.
        observedAt: at(400),
        validFrom: at(400),
        pin: false
      })
    ).id;

  const use = (
    id: string,
    daysAgo: number,
    options: { cited?: boolean; failed?: boolean } = {}
  ): Promise<number> =>
    store.recordMemoryUse({
      workspaceId,
      itemIds: [id],
      usedAt: at(daysAgo),
      cited: options.cited ?? false,
      outcome: options.failed ? 'fail' : 'ok'
    });

  /** Salience and the prior it produces, off the rows, after the real nightly pass. */
  const scores = async (): Promise<Map<string, { salience: number; prior: number }>> => {
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const rows = await database.query<{ id: string; salience: number; prior: number }>(
      `SELECT id, salience,
              mem.prior(kind,trust,valid_to,observed_at,salience,pin,$2::timestamptz,FALSE) AS prior
       FROM mem.item WHERE workspace_id=$1`,
      [workspaceId, NOW]
    );
    return new Map(
      rows.rows.map((row) => [row.id, { salience: Number(row.salience), prior: Number(row.prior) }])
    );
  };

  /**
   * The two rules this replaces, computed over the same rows.
   *
   * `windowed` is the shipped statement's `count(*) FILTER (WHERE used_at > now - INTERVAL '90
   * days')` verbatim; `total` is the same count with no window at all, which is what "sum over
   * every prior use" degenerates to if the decay is dropped. Each property below has to be wrong
   * under at least one of them, or the property is not doing any work.
   */
  const counts = async (): Promise<Map<string, { windowed: number; total: number }>> => {
    const rows = await database.query<{ id: string; windowed: string; total: string }>(
      `SELECT i.id,
              count(u.id) FILTER (
                WHERE u.used_at > $2::timestamptz - INTERVAL '90 days') AS windowed,
              count(u.id) AS total
       FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
       WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId, NOW]
    );
    return new Map(
      rows.rows.map((row) => [row.id, { windowed: Number(row.windowed), total: Number(row.total) }])
    );
  };

  it('leaves nothing at zero however old it is, where the 90-day window left everything there', async () => {
    const never = await add('alpha', 'never used at all');
    const decade = await add('bravo', 'used once ten years ago');
    const justOut = await add('charlie', 'used once ninety-one days ago');
    const justIn = await add('delta', 'used once eighty-nine days ago');

    await use(decade, 3650);
    await use(justOut, 91);
    await use(justIn, 89);

    const score = await scores();
    const salience = (id: string): number => score.get(id)!.salience;
    const prior = (id: string): number => score.get(id)!.prior;

    // Property 1, in the order it has to hold: more recent beats less recent, and the oldest use
    // in the workspace still beats no use at all. Every one of these is strict.
    expect(salience(justIn)).toBeGreaterThan(salience(justOut));
    expect(salience(justOut)).toBeGreaterThan(salience(decade));
    expect(salience(decade)).toBeGreaterThan(salience(never));
    expect(prior(decade)).toBeGreaterThan(prior(never));

    // The step across the old boundary is now two days of a power law rather than all of it.
    // 89d^-0.5 = 0.10600, 91d^-0.5 = 0.10483: a 1.1% difference in the activation, against the
    // 100% the window produced. Asserted as a bound rather than an equality so the number can be
    // read: if the decay were ever re-cliffed here this ratio would go to zero or to one.
    const activation = await database.query<{ id: string; s: number }>(
      `SELECT i.id, COALESCE(SUM(power(GREATEST(
                EXTRACT(EPOCH FROM $2::timestamptz - u.used_at)::float8/86400.0, $3::float8),
                -$4::float8)) FILTER (WHERE u.id IS NOT NULL), 0) AS s
       FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
       WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId, NOW, MEMORY_USE_AGE_FLOOR_DAYS, MEMORY_USE_DECAY_EXPONENT]
    );
    const raw = new Map(activation.rows.map((row) => [row.id, Number(row.s)]));
    expect(raw.get(justOut)! / raw.get(justIn)!).toBeGreaterThan(0.98);
    expect(raw.get(justOut)! / raw.get(justIn)!).toBeLessThan(1);
    // A single use ten years old is small and is not absent: 3650^-0.5.
    expect(raw.get(decade)).toBeCloseTo(0.016552, 6);
    expect(raw.get(never)).toBe(0);

    // AND THE RULE THIS REPLACES GETS IT WRONG. Under the 90-day count the ten-year-old use, the
    // ninety-one-day-old use and the row that was never used once are the same number, so no
    // ranking downstream of it could tell them apart.
    const count = await counts();
    expect(count.get(decade)!.windowed).toBe(0);
    expect(count.get(justOut)!.windowed).toBe(0);
    expect(count.get(never)!.windowed).toBe(0);
    expect(count.get(justIn)!.windowed).toBe(1);
  });

  it('ranks fifty uses spread over a year above fifty massed into a week of it', async () => {
    const massed = await add('echo', 'fifty uses inside one week, a year ago');
    const spread = await add('foxtrot', 'fifty uses spread across the same year');

    // Both histories hold fifty uses and both begin 365 days ago. The only difference is how they
    // are distributed, which is exactly the difference a count inside a window cannot see.
    for (let i = 0; i < 50; i += 1) await use(massed, 365 - (i * 7) / 49);
    for (let i = 0; i < 50; i += 1) await use(spread, 365 - (i * 365) / 49);

    const score = await scores();
    expect(score.get(spread)!.salience).toBeGreaterThan(score.get(massed)!.salience);
    expect(score.get(spread)!.prior).toBeGreaterThan(score.get(massed)!.prior);

    // AND THE RULE THIS REPLACES GETS IT WRONG. An un-decayed sum over every prior use - what is
    // left of ACT-R if the exponent goes to zero - scores the two histories identically at fifty,
    // and the 90-day window scores the massed history at zero, which is right for the wrong
    // reason: it is not ranking it lower, it is discarding it.
    const count = await counts();
    expect(count.get(massed)!.total).toBe(count.get(spread)!.total);
    expect(count.get(massed)!.total).toBe(50);
    expect(count.get(massed)!.windowed).toBe(0);
  });

  it('lets a burst from a finished project fade below a thinner history that is still running', async () => {
    // The owner's own words: "a particular memory may be very useful short term for a particular
    // project or two, but long term may be useless, and shouldn't have such high weight long term
    // just because it was used a lot short term."
    const burst = await add('golf', 'twenty-six uses in a project that ended seven months ago');
    const trickle = await add('hotel', 'five uses, one every two months, most recent today');

    for (let i = 0; i < 26; i += 1) await use(burst, 300 - (i * 87) / 25);
    for (let i = 0; i < 5; i += 1) await use(trickle, 240 - i * 60);

    const score = await scores();
    expect(score.get(trickle)!.salience).toBeGreaterThan(score.get(burst)!.salience);
    expect(score.get(trickle)!.prior).toBeGreaterThan(score.get(burst)!.prior);

    // AND THE RULE THIS REPLACES GETS IT WRONG, in both directions. A flat count over all history
    // puts the finished project five times ahead; the 90-day count throws away twenty-six of the
    // thirty-one uses in this workspace to reach the same ordering by deleting the evidence.
    const count = await counts();
    expect(count.get(burst)!.total).toBe(26);
    expect(count.get(trickle)!.total).toBe(5);
    expect(count.get(burst)!.windowed).toBe(0);
    expect(count.get(trickle)!.windowed).toBe(2);
  });

  it('charges a use that failed, which the retracted-only negative term never could', async () => {
    const never = await add('india', 'never used at all');
    const clean = await add('juliett', 'ten uses, every one cited, none failed');
    const failing = await add('kilo', 'ten uses, every one cited, every one failed');

    for (let i = 0; i < 10; i += 1) await use(clean, 10 - i, { cited: true });
    for (let i = 0; i < 10; i += 1) await use(failing, 10 - i, { cited: true, failed: true });

    const score = await scores();
    // The two histories are identical in every respect except the grade the harness watched, so
    // the whole distance between them is the negative term.
    expect(score.get(clean)!.salience).toBeGreaterThan(score.get(failing)!.salience);
    // And it is a real charge rather than a discount: a row that failed every time it was used
    // ranks BELOW a row that has never been used at all, which is what makes it reinforcement.
    // `use` and `fail` partition the uses, so ten failures leave the positive sum as empty as a
    // row with no history AND carry the whole of the negative one.
    expect(score.get(failing)!.salience).toBeLessThan(score.get(never)!.salience);
    expect(score.get(failing)!.prior).toBeLessThan(score.get(never)!.prior);
    // The old formula had this exactly inverted: +0.70 for the row that failed every time, the
    // highest in its workspace, and -0.70 for the row that never failed.
    expect(score.get(clean)!.salience).toBeGreaterThan(0);
    expect(score.get(failing)!.salience).toBeLessThan(0);

    // AND THE TERM THIS REPLACES COULD NOT HAVE FIRED. `neg_count` has one writer,
    // `retractMemoryItem`, which sets `status='retracted'` in the same statement - and no
    // admission predicate admits a retracted row. So the failing row here, ten failures out of
    // ten recorded through the production writer, carries neg_count = 0 and the old
    // `- 0.30 * (neg_count / use_count)` contributed exactly nothing to it.
    const counters = await database.query<{
      neg_count: number;
      fail_count: number;
      use_count: number;
      status: string;
    }>('SELECT neg_count, fail_count, use_count, status FROM mem.item WHERE id=$1', [failing]);
    expect(counters.rows[0]).toMatchObject({
      neg_count: 0,
      fail_count: 10,
      use_count: 10,
      status: 'active'
    });
    // The evidence the new term reads is on the use rows, where the writer actually put it.
    const graded = await database.query<{ n: string }>(
      "SELECT count(*) AS n FROM mem.item_use WHERE item_id=$1 AND outcome='fail'",
      [failing]
    );
    expect(Number(graded.rows[0]!.n)).toBe(10);
  });

  it('lets a negative salience reach the prior, which greatest(salience,0) clipped away', async () => {
    // `mem.prior` read `1.0 + 0.15 * ln(1 + greatest(salience, 0))`. Every negative salience -
    // which is what negative reinforcement produces - mapped onto the factor of a never-used row,
    // so fixing the term above without this would have changed nothing the ranking can see.
    const factor = await database.query<{
      neg: number;
      zero: number;
      pos: number;
      far: number;
      small: number;
    }>(
      `SELECT mem.prior('fact','stated',NULL,$1::timestamptz,(-1.0)::real,FALSE,$1::timestamptz,FALSE) AS neg,
              mem.prior('fact','stated',NULL,$1::timestamptz,(0.0)::real,FALSE,$1::timestamptz,FALSE) AS zero,
              mem.prior('fact','stated',NULL,$1::timestamptz,(1.0)::real,FALSE,$1::timestamptz,FALSE) AS pos,
              mem.prior('fact','stated',NULL,$1::timestamptz,(-1000.0)::real,FALSE,$1::timestamptz,FALSE) AS far,
              mem.prior('fact','stated',NULL,$1::timestamptz,(0.01)::real,FALSE,$1::timestamptz,FALSE) AS small`,
      [NOW]
    );
    const { neg, zero, pos, far, small } = factor.rows[0]!;
    expect(Number(neg)).toBeLessThan(Number(zero));
    expect(Number(zero)).toBeLessThan(Number(pos));
    // Strictly positive at every finite salience. A prior that crossed zero would invert the
    // ranking it multiplies, and salience is an unbounded weighted sum of z-scores: with a
    // workspace large enough, one row's z can reach sqrt(n-1) and drag another's far negative.
    expect(Number(far)).toBeGreaterThan(0);
    // Unchanged to first order at the origin, which is what makes this a repair rather than a
    // retune: exp(0.15*asinh(s)) and the 1 + 0.15*ln(1+s) it replaces agree to within 1e-5 at
    // s = 0.01, and diverge only where the old shape was clipping or flattening anyway.
    expect(Number(small) / Number(zero)).toBeCloseTo(1.0 + 0.15 * Math.log(1.01), 4);
  });

  it('keeps the activation across the retention horizon, where a bare delete lost it', async () => {
    // `consolidateMemory` used to DELETE `mem.item_use` past `useRetentionDays`. A sum over every
    // prior use cannot be taken against a table that forgets, so the rows are folded into
    // `mem.item_use_fold` and their contribution recovered from the span in closed form.
    const long = await add('lima', 'a hundred uses across two years');
    const short = await add('mike', 'ten recent uses');
    for (let i = 0; i < 100; i += 1) await use(long, 730 - i * 7, { cited: i % 3 === 0 });
    for (let i = 0; i < 10; i += 1) await use(short, 10 - i);

    const before = await scores();
    const liveBefore = await database.query<{ n: string }>(
      'SELECT count(*) AS n FROM mem.item_use WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(liveBefore.rows[0]!.n)).toBe(110);

    // The real retention pass, at the shipped horizon, twice - a second fold must widen the span
    // rather than count the same block again.
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: 180 });
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: 180 });

    const folds = await database.query<{
      item_id: string;
      uses: number;
      cites: number;
      fails: number;
    }>('SELECT item_id,uses,cites,fails FROM mem.item_use_fold');
    expect(folds.rows).toHaveLength(1);
    expect(folds.rows[0]!.item_id).toBe(long);
    expect(folds.rows[0]!.uses).toBe(79);
    expect(folds.rows[0]!.cites).toBe(27);
    const liveAfter = await database.query<{ n: string }>(
      'SELECT count(*) AS n FROM mem.item_use WHERE workspace_id=$1',
      [workspaceId]
    );
    expect(Number(liveAfter.rows[0]!.n)).toBe(31);

    // Same instant, same history, 79 of its 110 rows now living as one aggregate: the score has
    // to be the same score. The bound is three decimal places of salience, and the measured worst
    // case across every row in this workspace is an order of magnitude inside it.
    const after = await scores();
    for (const [id, row] of after)
      expect(Math.abs(row.salience - before.get(id)!.salience)).toBeLessThan(1e-3);

    // AND WITHOUT THE FOLD IT IS LOST. Deleting the aggregate is exactly what the old DELETE did
    // to those seventy-nine uses, and it takes two years of history down to the last six months.
    const withFold = (await scores()).get(long)!.salience;
    await database.query('DELETE FROM mem.item_use_fold WHERE item_id=$1', [long]);
    const withoutFold = (await scores()).get(long)!.salience;
    expect(withoutFold).toBeLessThan(withFold);
  });

  it('returns the difference through the recall query the worker actually calls', async () => {
    // Everything above reads `mem.item.salience` off the row. This reads the pack: two rows that
    // answer the same question, distinguished only by a use history the 90-day window scored as a
    // tie, ranked by the shipped fusion SQL through the shipped public method.
    const stale = await add('november', 'the relay listens on port 8443 in the amber deployment');
    const livelier = await add('oscar', 'the relay listens on port 8443 in the beryl deployment');
    for (let i = 0; i < 12; i += 1) await use(stale, 400 - i * 5);
    for (let i = 0; i < 12; i += 1) await use(livelier, 300 - i * 15);

    const count = await counts();
    expect(count.get(stale)!.windowed).toBe(0);
    expect(count.get(livelier)!.windowed).toBe(0);
    expect(count.get(stale)!.total).toBe(count.get(livelier)!.total);

    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const plan = planMemoryQuery('which port does the relay listen on', key);
    const pack = await store.recallMemoryCandidates({ workspaceId, plan, now: NOW });
    const scored = new Map(pack.map((row) => [row.id, row.score]));
    expect(scored.has(stale)).toBe(true);
    expect(scored.has(livelier)).toBe(true);
    // `score` is `rrf * mem.prior(...)` out of the shipped statement. Both rows match the question
    // identically and were observed on the same day, so the whole difference is the use history.
    expect(scored.get(livelier)!).toBeGreaterThan(scored.get(stale)!);

    // And it survives the cut. A pack with room for one row keeps the livelier history; under the
    // 90-day count both rows scored zero uses and the tie was broken by row id.
    const one = await store.recallMemoryCandidates({
      workspaceId,
      plan,
      now: NOW,
      maxItems: 1,
      order: 'relevance'
    });
    expect(one.map((row) => row.id)).toEqual([livelier]);
  });

  it('states the two shapes the weights and the exponent have to keep', async () => {
    // The fold's closed form divides by (1 - d) and the sum diverges at t = 0, so the exponent has
    // to sit strictly inside the unit interval and the age floor strictly above zero. Neither is a
    // range anybody would choose from, and both are what the SQL silently assumes.
    expect(MEMORY_USE_DECAY_EXPONENT).toBeGreaterThan(0);
    expect(MEMORY_USE_DECAY_EXPONENT).toBeLessThan(1);
    expect(MEMORY_USE_AGE_FLOOR_DAYS).toBeGreaterThan(0);

    // "I agree with positive as well as negative reinforcement", and negative has to carry more
    // per unit than citation - which is a comparison that can only be made because all three are
    // now z-scores of the same construction rather than two z-scores and a rate.
    expect(MEMORY_SALIENCE_FAIL_WEIGHT).toBeGreaterThan(MEMORY_SALIENCE_CITE_WEIGHT);
    // And the same event graded the other way moves the score by the same magnitude, because
    // `use` and `fail` partition the uses and nothing measures a success as bigger than a failure.
    expect(MEMORY_SALIENCE_FAIL_WEIGHT).toBe(MEMORY_SALIENCE_USE_WEIGHT);
  });
});

/**
 * The recall feedback loop, run rather than described.
 *
 * `recallMemory` writes a `mem.item_use` row for every row it RETURNS - uncited, outcome
 * `unknown` - and `recordMemoryPackOutcome` writes the same row for every packed entry the
 * finished turn never touched, its comment saying such an entry must be left ungraded in both
 * directions. The salience recompute did not leave it ungraded: `s_use` filtered on
 * `outcome <> 'fail'`, which admits `unknown`, so the ranking read its own selections back as
 * evidence at exactly the weight of a use the model had cited.
 *
 * Everything here runs the loop through the two methods the worker calls - `recallMemoryCandidates`
 * to choose, `recordMemoryUse` to record, `consolidateMemory` to score - against a real PGlite
 * database with the shipped SQL. Nothing reimplements the score.
 */
describe('an ungraded use', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let workspaceId: string;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace({
      userId,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  const add = async (subject: string, body: string): Promise<string> =>
    (
      await store.createMemoryItem({
        id: randomUUID(),
        userId,
        workspaceId,
        kind: 'fact',
        trust: 'stated',
        documentCiphertext: { v: 1, iv: 'x', tag: 'x', ciphertext: body },
        index: buildMemoryItemIndex(
          { title: subject, tags: [], body, subject, object: 'value' },
          key
        ),
        predicate: 'related_to',
        // One observation date across every row, so the decay term in `mem.prior` that is not
        // under test here is identical for everything being compared.
        observedAt: at(400),
        validFrom: at(400),
        pin: false
      })
    ).id;

  const scores = async (): Promise<Map<string, { salience: number; prior: number }>> => {
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const rows = await database.query<{ id: string; salience: number; prior: number }>(
      `SELECT id, salience,
              mem.prior(kind,trust,valid_to,observed_at,salience,pin,$2::timestamptz,FALSE) AS prior
       FROM mem.item WHERE workspace_id=$1`,
      [workspaceId, NOW]
    );
    return new Map(
      rows.rows.map((row) => [row.id, { salience: Number(row.salience), prior: Number(row.prior) }])
    );
  };

  /**
   * The positive activation under the filter this replaces, computed over the same rows.
   *
   * `outcome <> 'fail'` is the shipped statement's `s_use` filter verbatim; `= 'ok'` is what it
   * is now. Every case below has to separate the two, or it is not testing the change.
   */
  const activations = async (): Promise<Map<string, { was: number; now: number }>> => {
    const rows = await database.query<{ id: string; was: number; s_now: number }>(
      `SELECT i.id,
              COALESCE(SUM(power(GREATEST(
                EXTRACT(EPOCH FROM $2::timestamptz - u.used_at)::float8/86400.0, $3::float8),
                -$4::float8)) FILTER (WHERE u.outcome <> 'fail'), 0) AS was,
              COALESCE(SUM(power(GREATEST(
                EXTRACT(EPOCH FROM $2::timestamptz - u.used_at)::float8/86400.0, $3::float8),
                -$4::float8)) FILTER (WHERE u.outcome = 'ok'), 0) AS s_now
       FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
       WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId, NOW, MEMORY_USE_AGE_FLOOR_DAYS, MEMORY_USE_DECAY_EXPONENT]
    );
    return new Map(
      rows.rows.map((row) => [row.id, { was: Number(row.was), now: Number(row.s_now) }])
    );
  };

  it('scores as nothing, where it used to score as a success', async () => {
    const never = await add('alpha', 'never used at all');
    const graded = await add('bravo', 'ten uses the harness watched succeed');
    // Exactly what `recallMemory` writes: the ids it returned, no `cited`, no `outcome`. Written
    // through the production writer with its own defaults rather than by naming `unknown` here,
    // so a change to those defaults breaks this case.
    const echo = await add('charlie', 'ten uses nobody graded');
    for (let i = 0; i < 10; i += 1)
      await store.recordMemoryUse({
        workspaceId,
        itemIds: [graded],
        usedAt: at(10 - i),
        outcome: 'ok'
      });
    for (let i = 0; i < 10; i += 1)
      await store.recordMemoryUse({ workspaceId, itemIds: [echo], usedAt: at(10 - i) });

    const stored = await database.query<{ n: string }>(
      "SELECT count(*) AS n FROM mem.item_use WHERE item_id=$1 AND outcome='unknown' AND NOT cited",
      [echo]
    );
    expect(Number(stored.rows[0]!.n)).toBe(10);

    const score = await scores();
    // Ungraded is worth what no history at all is worth. Not approximately: the two rows have the
    // same empty positive sum, the same empty citation sum and the same empty failure sum, so
    // every z-score they enter is the same z-score.
    expect(score.get(echo)!.salience).toBe(score.get(never)!.salience);
    expect(score.get(echo)!.prior).toBe(score.get(never)!.prior);
    // And a use somebody actually watched still counts, or this would be a way of switching the
    // usage tier off rather than of cleaning it.
    expect(score.get(graded)!.salience).toBeGreaterThan(score.get(echo)!.salience);
    expect(score.get(graded)!.prior).toBeGreaterThan(score.get(echo)!.prior);

    // AND THE FILTER THIS REPLACES GETS IT WRONG. Under `outcome <> 'fail'` the ungraded history
    // and the graded one are the same activation to the last bit, so no ranking downstream of it
    // could tell a use the model cited from a row the ranker had merely handed itself.
    const raw = await activations();
    expect(raw.get(echo)!.was).toBe(raw.get(graded)!.was);
    expect(raw.get(echo)!.was).toBeGreaterThan(0);
    expect(raw.get(echo)!.now).toBe(0);
    expect(raw.get(graded)!.now).toBe(raw.get(graded)!.was);
  });

  it('stops the ranker reading its own choice back as a reason to choose again', async () => {
    /*
     * Two pairs of rows. Within a pair the two answer the same question, were observed on the same
     * day and differ in one word the question does not mention, so their fusion scores start a
     * fraction apart and `ORDER BY score DESC, id` hands the top slot to one of them for reasons
     * that have nothing to do with use. Byte-identical bodies would be a cleaner tie and are the
     * wrong fixture: they share a `dedupe_key`, the `DISTINCT ON (dedupe_key)` in the fusion query
     * collapses them to one row, and the loop then has nothing to compound.
     *
     * Then the loop, through the two methods the worker calls: ask, record a use for what came
     * back, consolidate, ask again. Thirty rounds, one a day, and only the leader is ever asked
     * about. The `relay` pair records the use the way `recallMemory` records it - defaults, so
     * uncited and `unknown`. The `printer` pair records the same use graded `ok`, which is exactly
     * what the old `outcome <> 'fail'` filter scored an ungraded use as - so the second pair is
     * the first pair under the rule this replaces, run through the same statements.
     *
     * What is measured is the GAP between the pair, before the loop and after it. A ranking that
     * reads its own output back as evidence widens it; one that does not leaves it where the text
     * put it.
     */
    const relayA = await add('relay', 'the relay listens on port 8443 in the amber deployment');
    const relayB = await add('relay', 'the relay listens on port 8443 in the beryl deployment');
    const printA = await add(
      'printer',
      'the printer feeds from the upper tray in the amber office'
    );
    const printB = await add(
      'printer',
      'the printer feeds from the upper tray in the beryl office'
    );
    const RELAY = 'which port does the relay listen on';
    const PRINTER = 'which tray does the printer feed from';

    /*
     * How far apart a pair sits in the shipped fusion query, as the RATIO of the two scores rather
     * than their difference.
     *
     * `score` is `rrf * mem.prior(...)`, and the prior carries the whole workspace's salience
     * moments - so a use recorded against ANY row rescales every score in the workspace, including
     * a pair that has not moved relative to each other. A difference reads that rescaling as
     * movement; a ratio divides it out and leaves exactly the question being asked, which is
     * whether one row of the pair has gained on the other.
     */
    const spread = async (question: string, pair: readonly [string, string]): Promise<number> => {
      const ranked = await store.recallMemoryCandidates({
        workspaceId,
        plan: planMemoryQuery(question, key),
        now: NOW,
        order: 'relevance'
      });
      const byId = new Map(ranked.map((row) => [row.id, row.score]));
      // Both rows have to be in the answer, or a spread between them is not a thing this can read.
      expect(byId.has(pair[0]) && byId.has(pair[1])).toBe(true);
      const [high, low] = [byId.get(pair[0])!, byId.get(pair[1])!].sort((l, r) => r - l);
      return high! / low!;
    };

    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const relayBefore = await spread(RELAY, [relayA, relayB]);
    const printerBefore = await spread(PRINTER, [printA, printB]);
    // The starting spread is the text and nothing else: no row here has ever been used.
    expect(relayBefore).toBeGreaterThan(1);
    expect(printerBefore).toBeGreaterThan(1);

    const round = async (
      question: string,
      pair: readonly [string, string],
      graded: boolean,
      day: number
    ): Promise<string> => {
      await store.consolidateMemory(workspaceId, { now: at(day), useRetentionDays: NEVER_FOLD });
      const top = await store.recallMemoryCandidates({
        workspaceId,
        plan: planMemoryQuery(question, key),
        now: at(day),
        maxItems: 1,
        order: 'relevance'
      });
      const won = top[0]!.id;
      // The loop only means anything if the pair is what the question reaches.
      expect(pair).toContain(won);
      await (graded
        ? store.recordMemoryUse({
            workspaceId,
            itemIds: [won],
            usedAt: at(day),
            cited: true,
            outcome: 'ok'
          })
        : // Defaults, as `recallMemory` calls it: no `cited`, no `outcome`.
          store.recordMemoryUse({ workspaceId, itemIds: [won], usedAt: at(day) }));
      return won;
    };

    const ROUNDS = 30;
    const ungraded: string[] = [];
    const gradedRun: string[] = [];
    for (let day = ROUNDS; day > 0; day -= 1) {
      ungraded.push(await round(RELAY, [relayA, relayB], false, day));
      gradedRun.push(await round(PRINTER, [printA, printB], true, day));
    }

    // Each loop locks onto one row - it has to, because only the top slot is ever asked for - and
    // the whole question is whether that is a fact about the text or a fact the loop manufactured.
    expect(new Set(ungraded).size).toBe(1);
    expect(new Set(gradedRun).size).toBe(1);
    const echoWinner = ungraded[0]!;
    const echoLoser = echoWinner === relayA ? relayB : relayA;
    const gradedWinner = gradedRun[0]!;
    const gradedLoser = gradedWinner === printA ? printB : printA;

    const counted = await database.query<{ item_id: string; n: string }>(
      `SELECT i.id AS item_id, count(u.id) AS n FROM mem.item i
       LEFT JOIN mem.item_use u ON u.item_id=i.id WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId]
    );
    const uses = new Map(counted.rows.map((row) => [row.item_id, Number(row.n)]));
    expect(uses.get(echoWinner)).toBe(ROUNDS);
    expect(uses.get(echoLoser)).toBe(0);
    expect(uses.get(gradedWinner)).toBe(ROUNDS);
    expect(uses.get(gradedLoser)).toBe(0);

    const score = await scores();
    // THE POINT. Thirty rounds of self-agreement, thirty uses against nought, and the two rows
    // still carry the same salience and the same prior - so the pair sits exactly as far apart in
    // the pack as the text alone put them, and the leader's thirty rounds bought nothing.
    expect(score.get(echoWinner)!.salience).toBe(score.get(echoLoser)!.salience);
    expect(score.get(echoWinner)!.prior).toBe(score.get(echoLoser)!.prior);
    expect(await spread(RELAY, [relayA, relayB])).toBeCloseTo(relayBefore, 12);

    // AND THE SAME LOOP UNDER THE RULE THIS REPLACES DIVERGES. Identical construction, identical
    // thirty rounds, the only difference being the grade the old filter handed an ungraded use for
    // free - and the row that happened to start ahead ends a whole salience ahead, sitting further
    // apart in the pack than the text alone ever put it.
    expect(score.get(gradedWinner)!.salience).toBeGreaterThan(score.get(gradedLoser)!.salience);
    expect(score.get(gradedWinner)!.prior).toBeGreaterThan(score.get(gradedLoser)!.prior);
    expect(await spread(PRINTER, [printA, printB])).toBeGreaterThan(printerBefore);
  }, 120_000);

  it('stays ungraded across the retention horizon, where the fold could only count uses', async () => {
    // `mem.item_use_fold` held `uses`, `cites` and `fails`, and the score recovered the positive
    // block as `uses - fails` - every use the harness did not watch fail, which is the same
    // mistake the live half was making, arriving a hundred and eighty days later. Migration 78
    // adds `oks` so the fold can say which of its uses were graded.
    const never = await add('delta', 'never used at all');
    const echo = await add('echo', 'forty ungraded uses, all of them past the horizon');
    const graded = await add('foxtrot', 'forty graded uses, all of them past the horizon');
    for (let i = 0; i < 40; i += 1) {
      await store.recordMemoryUse({ workspaceId, itemIds: [echo], usedAt: at(365 - i * 4) });
      await store.recordMemoryUse({
        workspaceId,
        itemIds: [graded],
        usedAt: at(365 - i * 4),
        outcome: 'ok'
      });
    }

    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: 180 });
    const folds = await database.query<{
      item_id: string;
      uses: number;
      oks: number;
      fails: number;
    }>('SELECT item_id,uses,oks,fails FROM mem.item_use_fold ORDER BY item_id');
    const fold = new Map(folds.rows.map((row) => [row.item_id, row]));
    // Every use here is between 209 and 365 days old, so both histories fold whole and the two
    // blocks are the same size by construction - which is what leaves the outcome as the only
    // thing that can separate them.
    expect(fold.get(echo)!.uses).toBe(40);
    expect(fold.get(graded)!.uses).toBe(40);
    expect(fold.get(echo)!.oks).toBe(0);
    expect(fold.get(graded)!.oks).toBe(fold.get(graded)!.uses);
    // `uses - fails` is what the score used to read, and it cannot tell the two blocks apart.
    expect(fold.get(echo)!.uses - fold.get(echo)!.fails).toBe(
      fold.get(graded)!.uses - fold.get(graded)!.fails
    );

    const score = await scores();
    expect(score.get(echo)!.salience).toBe(score.get(never)!.salience);
    expect(score.get(graded)!.salience).toBeGreaterThan(score.get(echo)!.salience);
  }, 120_000);
});

/**
 * Volume against age, which is the other thing this owner said was broken.
 *
 * "110 uses three years ago beats 5 uses this week" was measured on this computer and filed as a
 * defect: volume buying age without bound. It was measured against a lifetime `use_count`, and it
 * is not what the shipped score does - so this case exists to hold the repair rather than to make
 * one, and to leave the number where the next person can re-read it instead of re-measuring it.
 *
 * The claim is bounded dominance, not absence. ACT-R's sum is linear in the number of uses and
 * `t^-d` in each one's age, so enough ancient uses will always out-activate a few recent ones;
 * what matters is the exchange rate and whether the term that is supposed to answer age - recency
 * in `mem.prior` - can still overturn it. Both are measured below.
 */
describe('a large old history', () => {
  let database: Database;
  let store: DataStore;
  let userId: string;
  let workspaceId: string;

  beforeEach(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    await store.syncMemoryPredicates();
    const user = await store.createUser({ username: 'owner', displayName: 'Owner' });
    userId = user.id;
    const workspace = await store.createWorkspace({
      userId,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
  });

  afterEach(async () => database.close());

  /** Unlike the helpers above, the observation date is the variable: it is what recency reads. */
  const add = async (subject: string, body: string, observedDaysAgo: number): Promise<string> =>
    (
      await store.createMemoryItem({
        id: randomUUID(),
        userId,
        workspaceId,
        kind: 'fact',
        trust: 'stated',
        documentCiphertext: { v: 1, iv: 'x', tag: 'x', ciphertext: body },
        index: buildMemoryItemIndex(
          { title: subject, tags: [], body, subject, object: 'value' },
          key
        ),
        predicate: 'related_to',
        observedAt: at(observedDaysAgo),
        validFrom: at(observedDaysAgo),
        pin: false
      })
    ).id;

  it('buys a few percent of activation with twenty-two times the volume, and loses to recency', async () => {
    // A hundred and ten uses spread across a month three years ago, against five uses this week.
    // Both rows observed when their history began, which is the honest arrangement: a fact used
    // heavily three years ago was almost always learned three years ago.
    const ancient = await add('golf', 'a hundred and ten uses three years ago', 1100);
    const recent = await add('hotel', 'five uses this week', 30);
    for (let i = 0; i < 110; i += 1)
      await store.recordMemoryUse({
        workspaceId,
        itemIds: [ancient],
        usedAt: at(1095 + (i % 30)),
        outcome: 'ok'
      });
    for (let i = 0; i < 5; i += 1)
      await store.recordMemoryUse({
        workspaceId,
        itemIds: [recent],
        usedAt: at(1 + i),
        outcome: 'ok'
      });

    const raw = await database.query<{ id: string; s: number; n: string }>(
      `SELECT i.id, COALESCE(SUM(power(GREATEST(
                EXTRACT(EPOCH FROM $2::timestamptz - u.used_at)::float8/86400.0, $3::float8),
                -$4::float8)), 0) AS s, count(u.id) AS n
       FROM mem.item i LEFT JOIN mem.item_use u ON u.item_id=i.id
       WHERE i.workspace_id=$1 GROUP BY i.id`,
      [workspaceId, NOW, MEMORY_USE_AGE_FLOOR_DAYS, MEMORY_USE_DECAY_EXPONENT]
    );
    const activation = new Map(raw.rows.map((row) => [row.id, Number(row.s)]));
    const uses = new Map(raw.rows.map((row) => [row.id, Number(row.n)]));

    // The volume ratio is 22:1 and the age ratio is about 300:1.
    expect(uses.get(ancient)! / uses.get(recent)!).toBe(22);
    // The old history does still out-activate the new one, and saying otherwise would be a claim
    // ACT-R does not make: the sum is linear in the count. What it buys is 2.2%. Measured
    // 3.3038 against 3.2317; the break-even is at 107 ancient uses, and to DOUBLE the recent
    // row's activation the old one would need about 220. That is the exchange rate, and it is
    // bounded in the sense that matters - sublinear once `ln` takes it, and a z-score after that.
    expect(activation.get(ancient)!).toBeGreaterThan(activation.get(recent)!);
    expect(activation.get(ancient)! / activation.get(recent)!).toBeLessThan(1.05);

    // AND THE TERM THAT ANSWERS AGE OVERTURNS IT. Recency in `mem.prior` reads `observed_at`, and
    // across three years it is worth 2.86x against the 0.94x-1.25x the salience factor can reach,
    // so the row with five uses this week finishes strictly ahead of the row with a hundred and
    // ten three years ago. Measured: 0.9200 against 0.7463.
    await store.consolidateMemory(workspaceId, { now: NOW, useRetentionDays: NEVER_FOLD });
    const priors = await database.query<{ id: string; salience: number; prior: number }>(
      `SELECT id, salience,
              mem.prior(kind,trust,valid_to,observed_at,salience,pin,$2::timestamptz,FALSE) AS prior
       FROM mem.item WHERE workspace_id=$1`,
      [workspaceId, NOW]
    );
    const prior = new Map(priors.rows.map((row) => [row.id, Number(row.prior)]));
    const salience = new Map(priors.rows.map((row) => [row.id, Number(row.salience)]));
    expect(salience.get(ancient)!).toBeGreaterThan(salience.get(recent)!);
    expect(prior.get(recent)!).toBeGreaterThan(prior.get(ancient)!);

    // AND THE RULE THIS REPLACES GETS IT WRONG. A lifetime count - `mem.item.use_count`, which is
    // what the original measurement was taken against and which is still maintained for the review
    // surface - puts the finished project twenty-two times ahead of the live one, with no term
    // anywhere able to answer it.
    const counters = await database.query<{ id: string; use_count: number }>(
      'SELECT id, use_count FROM mem.item WHERE workspace_id=$1',
      [workspaceId]
    );
    const lifetime = new Map(counters.rows.map((row) => [row.id, Number(row.use_count)]));
    expect(lifetime.get(ancient)!).toBe(110);
    expect(lifetime.get(recent)!).toBe(5);
  }, 120_000);
});
