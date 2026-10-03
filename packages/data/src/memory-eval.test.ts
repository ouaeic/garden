import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY_KINDS, MEMORY_PACK_QUOTAS, memoryIndexKey, planMemoryQuery } from '@garden/core';
import { createDatabase, migrateDatabase, type Database } from './database.js';
import { DataStore } from './store.js';
import {
  ALWAYS_ON_REFS,
  MEMORY_EVAL_ITEMS,
  MEMORY_EVAL_CORPUS_PRESSURE,
  MEMORY_EVAL_PACK_CAPACITY,
  MEMORY_EVAL_PADDED_PRESSURE,
  MEMORY_EVAL_PADDING_ITEMS,
  MEMORY_EVAL_PADDING_SOURCES,
  MEMORY_EVAL_PROBES,
  MEMORY_EVAL_SESSION_PROBES,
  MEMORY_EVAL_SESSION_SEARCH_K,
  MEMORY_EVAL_SOURCES,
  MEMORY_EVAL_UNBOUNDED_QUOTAS,
  formatMemoryEvalReport,
  formatMemoryEvalSearchReport,
  measureMemoryChannelPressure,
  runMemoryRecallEval,
  runMemorySessionSearchEval,
  runSubstringSessionSearchEval,
  seedMemoryEvalCorpus,
  seedMemoryEvalPadding,
  type MemoryEvalReport,
  type MemoryEvalSearchReport,
  type MemoryEvalSeed
} from './memory-eval.js';

/**
 * The committed numbers.
 *
 * These are measurements, not aspirations - what this corpus scores today, so that a change which
 * lowers any of them fails here rather than being argued about. That is the whole reason this file
 * exists: every claim the memory code made about its own retrieval was unfalsifiable before it.
 *
 * Recall alone is not enough to hold, because recall is buyable. A pack that returns everything
 * scores one, so it is committed alongside two numbers that a bigger pack cannot move in its
 * favour: the rank of the answer, which a wider net leaves exactly where it was, and the tokens
 * spent getting there. All three move together or the change is a trade someone has to justify.
 *
 * A drop is a regression to investigate, not a number to lower - and a probe the store genuinely
 * cannot answer yet is not a reason to move one either. That probe is marked `expectedMiss` and
 * scored out, so these stay at exactly what answerable retrieval achieves; lowering a floor for it
 * would leave room underneath for a real regression on a different probe to net out and pass.
 */
const MIN_PACK_RECALL = 1;
const MIN_CANDIDATE_RECALL = 1;
/** Today's 0.469: the answer is around second or third of everything the pack came back with. */
const MIN_MRR = 0.43;
/** Today's 364, against a 6,000 token budget. The budget is not what is keeping this small. */
const MAX_PACK_TOKENS = 450;

/**
 * The controls, which are what make every number above a measurement rather than a statistic.
 *
 * Today: ranked scores 100.0% at MRR 0.469; the same budget filled from the same reachable rows in
 * a seeded arbitrary order scores 12.5% at 0.020; an empty pack scores 7.5%, which is exactly the
 * abstention probes whose correct answer is no pack at all.
 *
 * Committed as ceilings. A control drifting upward means it has stopped controlling - the corpus
 * has grown guessable, or a probe has - and the headline number above it stops meaning what it
 * says long before it visibly falls.
 */
const MAX_RANDOM_RECALL = 0.25;

/** Today's 0.020, against the ranked arm's 0.469. */
const MAX_RANDOM_MRR = 0.08;
/** Today's 0.075, which is the three abstention probes and nothing else. */
const MAX_EMPTY_RECALL = 0.12;

describe('memory retrieval eval', () => {
  let database: Database;
  let store: DataStore;
  let seed: MemoryEvalSeed;
  let workspaceId: string;
  let packRun: MemoryEvalReport;

  const key = memoryIndexKey(Buffer.alloc(32, 11));
  const now = new Date('2026-07-31T08:00:00.000Z');

  const run = async (
    options: {
      budgetTokens?: number;
      maxItems?: number;
      quotas?: typeof MEMORY_PACK_QUOTAS;
      pack?: 'ranked' | 'empty' | 'random';
    } = {}
  ): Promise<MemoryEvalReport> =>
    runMemoryRecallEval({ store, workspaceId, key, now, seed, ...options });

  // Seeded once rather than per test: every probe here reads, none writes, and standing the corpus
  // up eleven times was most of this file's runtime.
  beforeAll(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    const user = await store.createUser({ username: 'eval-owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
    seed = await seedMemoryEvalCorpus({
      store,
      userId: user.id,
      workspaceId,
      key,
      now
    });
    packRun = await run();
  }, 120_000);

  afterAll(async () => database.close());

  it('beats an empty pack and a pack nobody ranked, which is what makes the rest a measurement', async () => {
    /**
     * The denominator. Every other number in this file is an absolute - recall 1.0 at 410 tokens -
     * and an absolute is unreadable without knowing two things: whether the questions answer
     * themselves, and what the same 410 tokens of the same corpus would have scored if nobody had
     * ranked them.
     *
     * The empty arm answers the first. It sends no pack at all, so anything it scores is a probe
     * measuring its own question rather than the store, and the number is committed as a ceiling.
     *
     * The random arm answers the second. It fills the identical budget from the identical
     * reachable rows in a seeded arbitrary order, so the only difference from the ranked arm is
     * the ordering. It is committed as a ceiling too: if the ranked arm ever fails to clear it,
     * the ranking is decoration and this test says so rather than the numbers merely looking
     * respectable on their own.
     */
    const empty = await run({ pack: 'empty' });
    const random = await run({ pack: 'random' });

    // An empty pack can still "hit" the abstention probes, whose correct answer is nothing at all -
    // so this is bounded rather than zero, and the answerable probes are what it must not reach.
    const answerable = MEMORY_EVAL_PROBES.filter((probe) => probe.gold.length > 0).map(
      (probe) => probe.id
    );
    const emptyAnswered = empty.probes.filter(
      (result) => result.hit && answerable.includes(result.id)
    );
    expect(emptyAnswered, 'a probe that scores with no pack is measuring its own question').toEqual(
      []
    );

    // The ranking has to be worth its place against arbitrary rows at the same price.
    expect(random.recall).toBeLessThan(packRun.recall);
    expect(random.mrr).toBeLessThan(packRun.mrr);
    // And the gap has to be large rather than incidental.
    expect(packRun.recall - random.recall).toBeGreaterThan(0.3);

    // Today's measurements, committed as ceilings rather than floors. A control that drifts upward
    // is a control that has stopped controlling: if the random arm starts scoring well, either the
    // corpus has become small enough that any rows answer anything, or a probe has become
    // guessable - and either way the ranked number above it has stopped meaning what it says.
    expect(random.recall).toBeLessThan(MAX_RANDOM_RECALL);
    expect(random.mrr).toBeLessThan(MAX_RANDOM_MRR);
    expect(empty.recall).toBeLessThan(MAX_EMPTY_RECALL);
  }, 120_000);

  it('holds more rows than the pack can carry, so every number below is a choice', () => {
    // Without this the eval measures nothing. Twenty-eight rows against a pack that holds
    // fifty-two let every channel admit everything it matched, and quotas, fusion weights, the
    // prior and the per-subject cap were all scored by a corpus that never made them decide.
    expect(MEMORY_EVAL_ITEMS.length + MEMORY_EVAL_SOURCES.length).toBeGreaterThan(
      MEMORY_EVAL_PACK_CAPACITY
    );
    expect(packRun.pressure).toBe(MEMORY_EVAL_CORPUS_PRESSURE);
    expect(packRun.pressure).toBeGreaterThan(1);
  });

  it('retrieves the gold row into the emitted pack for the committed share of probes', () => {
    expect(packRun.recall, formatMemoryEvalReport(packRun)).toBeGreaterThanOrEqual(MIN_PACK_RECALL);
    // A retired value coming back for a present-tense question is worse than retrieving nothing.
    expect(packRun.leaks).toEqual([]);
  });

  it('holds the paraphrase gap open in both directions rather than tolerating it', () => {
    // A probe scored out of every number above is only honest while it really does miss. Asserting
    // that is the half worth having: if some later change reaches it, this fails and says to
    // promote the probe, instead of the gap closing and the eval still describing it as open.
    const known = MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss);
    expect(known.length).toBeGreaterThan(0);
    expect(packRun.expectedMisses).toEqual(known.map((probe) => probe.id));
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    for (const probe of known)
      expect(
        byId.get(probe.id)?.hit,
        `${probe.id} now hits - drop its expectedMiss and let it be scored`
      ).toBe(false);
  });

  it('ranks the answer near the top, which membership in a large pack does not show', () => {
    // The metric for a recall the agent asks for mid-task: it reads from the top and stops. A
    // change that widens the net lifts recall and leaves this untouched, which is the point.
    expect(packRun.mrr, formatMemoryEvalReport(packRun)).toBeGreaterThanOrEqual(MIN_MRR);
    for (const probe of packRun.probes)
      if (probe.hit && probe.rank !== null)
        expect(probe.rank, `${probe.id} answered at rank ${probe.rank}`).toBeLessThanOrEqual(12);
  });

  it('pays for that recall in tokens the owner would not begrudge', () => {
    expect(packRun.packTokens, formatMemoryEvalReport(packRun)).toBeLessThanOrEqual(
      MAX_PACK_TOKENS
    );
  });

  it('admits the gold row into some channel at all, which is the ceiling every k sits under', async () => {
    // Budget, item cap and every quota lifted: what is left is purely the tokenizer, the planner
    // and the admission predicates. A row that misses here is unreachable at any k, not merely
    // outranked. Lifting the budget alone was not enough - the per-kind and per-subject caps are
    // separate limits, so that run scored the same rows as the pack and agreed with itself.
    const result = await run({
      budgetTokens: 1_000_000,
      maxItems: 200,
      quotas: MEMORY_EVAL_UNBOUNDED_QUOTAS
    });
    expect(result.recall, formatMemoryEvalReport(result)).toBeGreaterThanOrEqual(
      MIN_CANDIDATE_RECALL
    );
    // The known gap is read off the same run, because this is where it means something: the probe
    // is unreachable rather than outranked, which is what makes it a missing channel and not a
    // tuning loss the next weight change could fix.
    const admitted = new Map(result.probes.map((probe) => [probe.id, probe]));
    for (const probe of MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss))
      expect(admitted.get(probe.id)?.found, formatMemoryEvalReport(result)).toEqual([]);
    // The ceiling must be a different measurement from the pack, or one of them is redundant.
    expect(result.packTokens).toBeGreaterThan(packRun.packTokens);
  });

  it('returns the same rows in stable order as in relevance order', async () => {
    // The eval reads in relevance order because that is the surface an agent-initiated recall uses
    // and the only one that yields a rank. That is sound only while `order` reaches the final
    // ORDER BY and nothing else - if it ever starts selecting rows, every number here shifts
    // underneath the pack the agent is actually given, which is built in stable order.
    const plan = planMemoryQuery('what port does the relay listen on', key);
    const [stable, relevance] = await Promise.all([
      store.recallMemoryCandidates({ workspaceId, plan, now }),
      store.recallMemoryCandidates({ workspaceId, plan, now, order: 'relevance' })
    ]);
    expect([...stable].map((row) => row.id).sort()).toEqual(
      [...relevance].map((row) => row.id).sort()
    );
    // (kind, id), where kind sorts in the order mem.kind declares rather than alphabetically -
    // which is also the order the rendered pack lays its sections out in.
    const stably = (row: { kind: (typeof MEMORY_KINDS)[number]; id: string }): string =>
      `${MEMORY_KINDS.indexOf(row.kind)}:${row.id}`;
    expect(stable.map(stably)).toEqual([...stable].map(stably).sort());
    expect(relevance.map((row) => row.score)).toEqual(
      [...relevance.map((row) => row.score)].sort((left, right) => right - left)
    );
  });

  it('ranks a fact by the words of the question, not by which fact is newest', () => {
    // A structural channel that admitted every fact about a matched subject, ranked them by
    // recency and fused them at the heaviest weight of any channel would return the nine facts
    // about `owner` - the subject of every stated preference - in date order, and the per-subject
    // cap would keep the newest four. The row titled "working languages" would be eighth, and
    // unreachable at any k.
    const probe = packRun.probes.find((entry) => entry.id === 'owner-language');
    expect(probe?.missed).toEqual([]);
    expect(probe?.rank ?? Infinity).toBeLessThanOrEqual(4);
  });

  it('finds a fact about a named service from the words a person asks it by', () => {
    // Subject 'garden-relay' shares no lexeme with 'relay', so before the alias surface this
    // question reached no channel at all.
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    expect(byId.get('relay-port-plain')?.missed).toEqual([]);
    expect(byId.get('relay-down-after-reboot')?.found.length).toBeGreaterThan(0);
    expect(byId.get('idle-setting-by-words')?.found.length).toBeGreaterThan(0);
  });

  it('keeps a question with no answer in the store from filling the pack with near misses', () => {
    const abstentions = packRun.probes.filter((probe) => probe.type === 'abstention');
    expect(abstentions.length).toBeGreaterThan(0);
    // Only what the owner pinned, which is a standing instruction rather than an answer.
    for (const probe of abstentions) {
      expect(probe.hit, `${probe.id} returned ${probe.returned} rows`).toBe(true);
      expect(probe.returned).toBeLessThanOrEqual(ALWAYS_ON_REFS.size);
    }
  });

  it('answers a present-tense and a past-tense question about the same fact differently', () => {
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    expect(byId.get('shell-now')?.hit).toBe(true);
    expect(byId.get('shell-now')?.leaked).toEqual([]);
    expect(byId.get('shell-before')?.hit).toBe(true);
  });

  it('searches the verbatim layer and reads the turns around a hit', async () => {
    const hits = await store.searchMemorySources({
      workspaceId,
      // Stemming is the whole point: the transcript says "restart", the question says "restarted".
      plan: planMemoryQuery('relay restarted and did not come back', key),
      limit: 10
    });
    const refOf = new Map([...seed.sourceIds].map(([ref, id]) => [id, ref]));
    const found = hits.map((hit) => refOf.get(hit.id)).filter(Boolean);
    expect(found).toContain('relay-turn-user');
    expect(hits.every((hit) => hit.score > 0)).toBe(true);

    const anchorId = seed.sourceIds.get('relay-turn-agent')!;
    const window = await store.listMemorySourceWindow(workspaceId, anchorId, {
      before: 1,
      after: 1
    });
    const windowRefs = window.map((row) => refOf.get(row.id));
    expect(windowRefs).toEqual(['relay-turn-user', 'relay-turn-agent', 'relay-turn-tool']);
  });

  it('restricts a verbatim search to one past conversation when asked to', async () => {
    const conversation = seed.conversations.get('mail-morning')!;
    const hits = await store.searchMemorySources({
      workspaceId,
      plan: planMemoryQuery('how often does the connector poll', key),
      taskId: conversation,
      limit: 10
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.taskId === conversation)).toBe(true);
  });

  it('reports write cost beside accuracy so a slower write path cannot hide behind recall', () => {
    expect(packRun.writeCost.items).toBe(MEMORY_EVAL_ITEMS.length);
    expect(packRun.writeCost.sources).toBe(MEMORY_EVAL_SOURCES.length);
    expect(packRun.writeCost.indexedBytes).toBeGreaterThan(0);
    expect(formatMemoryEvalReport(packRun)).toContain('recall ');
  });

  it('covers every question type and gives every probe a resolvable gold set', () => {
    const types = new Set(MEMORY_EVAL_PROBES.map((probe) => probe.type));
    expect([...types].sort()).toEqual([
      'abstention',
      'knowledge_update',
      'multi_session',
      'preference',
      'single_session_fact',
      'temporal_reasoning'
    ]);
    const refs = new Set([
      ...MEMORY_EVAL_ITEMS.map((item) => item.ref),
      ...MEMORY_EVAL_SOURCES.map((source) => source.ref)
    ]);
    for (const probe of MEMORY_EVAL_PROBES)
      for (const ref of [...probe.gold, ...(probe.forbidden ?? [])])
        expect(refs.has(ref), `${probe.id} references unknown ${ref}`).toBe(true);
  });

  /**
   * Which half of a quota is actually deciding anything, measured rather than argued about.
   *
   * `MEMORY_PACK_QUOTAS` gives each kind three numbers: a `share` of the token budget, a `cap` on
   * rows, and a `perSubject` cap. Today they are fact 0.35/25/4, procedure 0.15/5/5, episode
   * 0.30/8/6 and source 0.20/6/6 - four kinds, because `entity` was removed and is not a
   * `MemoryKind` any more.
   *
   * The shares do not bind, and the padded run is what settles that: at 92x pressure the pack is
   * 758 tokens of a 6,000 budget, so no kind ever reaches its fraction of it. What selects is the
   * row caps, which total 44 and are reached on nearly every probe. That is the honest reading of
   * these four rows - `share` is a ceiling nothing has yet touched, `cap` and `perSubject` are the
   * pack - and it is the reason the pressured numbers below are worth having: without them this
   * paragraph would still be describing a corpus that never made any of the three decide.
   */
  it('gives every declared memory kind a quota, so none can be ranked and then dropped', () => {
    const quota = new Set(MEMORY_PACK_QUOTAS.map((entry) => entry.kind));
    for (const kind of MEMORY_KINDS) expect(quota.has(kind), `no quota for ${kind}`).toBe(true);
    // The shares are a budget fraction, so they only mean anything while they sum to about one.
    const shares = MEMORY_PACK_QUOTAS.reduce((total, entry) => total + entry.share, 0);
    expect(shares).toBeCloseTo(1, 5);
  });

  /* --- searching past conversations --------------------------------------- *
   *
   * The committed numbers, measured on this corpus at k=5, against the substring scan they
   * replaced:
   *
   *   recall@5   83.3% -> 100%    (10/12 -> 12/12)
   *   mrr        0.556 -> 0.642
   *   opened     23.0  -> 2.8     bodies decrypted per question
   *
   * Both misses the scan had are ranking, not admission: "where did the database dump get written"
   * and "can the runner be reached from outside the box" both share words with their answer, and
   * both lost the top five to turns that shared more common words. That is what a score with no
   * document frequency in it does.
   *
   * The accuracy delta is the smaller half of this, and saying otherwise on twenty-three turns
   * would be dishonest - almost anything finds an answer in a corpus that small. The number that
   * does not flatter the corpus is the last one: the scan opens every stored body in the workspace
   * to score it, because its score is computed over plaintext, and that grows with the owner's
   * whole history for every question they ever ask. The index opens what it returns. */
  const MIN_SESSION_RECALL = 1;
  /** Today's 0.642: the answer is first or second of what came back. */
  const MIN_SESSION_MRR = 0.62;
  /** Today's 2.8, against a k of 5. Nothing is opened that was not returned. */
  const MAX_SESSION_DECRYPTED = 3;

  let sessionRun: MemoryEvalSearchReport;
  const baseline = runSubstringSessionSearchEval();

  beforeAll(async () => {
    sessionRun = await runMemorySessionSearchEval({ store, workspaceId, key, seed });
  }, 120_000);

  it('finds the turn that answers a question worded months later', async () => {
    expect(
      sessionRun.recall,
      formatMemoryEvalSearchReport('index', sessionRun)
    ).toBeGreaterThanOrEqual(MIN_SESSION_RECALL);
    expect(
      sessionRun.mrr,
      formatMemoryEvalSearchReport('index', sessionRun)
    ).toBeGreaterThanOrEqual(MIN_SESSION_MRR);
    for (const probe of sessionRun.probes)
      expect(probe.returned).toBeLessThanOrEqual(MEMORY_EVAL_SESSION_SEARCH_K);
  });

  it('beats the substring scan it replaced, and opens a fraction of the store to do it', () => {
    const report = [
      formatMemoryEvalSearchReport('substring', baseline),
      formatMemoryEvalSearchReport('index', sessionRun)
    ].join('\n');
    expect(sessionRun.recall, report).toBeGreaterThan(baseline.recall);
    expect(sessionRun.mrr, report).toBeGreaterThan(baseline.mrr);
    // The structural difference, and the only one that does not depend on the corpus being small.
    expect(sessionRun.decryptedPerProbe, report).toBeLessThanOrEqual(MAX_SESSION_DECRYPTED);
    expect(baseline.decryptedPerProbe).toBe(MEMORY_EVAL_SOURCES.length);
  });

  it('asks every session probe in words the transcript does not use', () => {
    // The probe set only measures ranking if the questions are paraphrases. A probe whose wording
    // is lifted from its own gold turn passes on any retrieval at all and reports nothing.
    const bodyOf = new Map(MEMORY_EVAL_SOURCES.map((source) => [source.ref, source.body]));
    // A probe set with nothing in it measures nothing, and reports it as a pass.
    expect(MEMORY_EVAL_SESSION_PROBES.length).toBeGreaterThan(0);
    expect(bodyOf.size).toBeGreaterThan(0);
    for (const probe of MEMORY_EVAL_SESSION_PROBES) {
      expect(probe.gold.length, `${probe.id} has no gold turn`).toBeGreaterThan(0);
      for (const ref of probe.gold) {
        const body = bodyOf.get(ref);
        expect(body, `${probe.id} references unknown source ${ref}`).toBeDefined();
        expect(
          body?.toLowerCase().includes(probe.question.toLowerCase()),
          `${probe.id} is quoted from its own answer`
        ).toBe(false);
      }
    }
  });
});

/* --- the same corpus, under pressure ------------------------------------- *
 *
 * Everything above is measured on fifty-one rows against a pack that holds forty-four. That makes
 * quotas and fusion weights decide something and leaves the three per-channel candidate caps
 * decided nothing: `MEMORY_LEXICAL_CANDIDATES` takes the top 120 rows a GIN probe matched and
 * `MEMORY_FUZZY_SCAN_CANDIDATES` scores the top 600, and on fifty-one rows neither can be reached.
 * A cap that never binds is a selection step nobody has measured - a row cut at the cap is
 * unreachable at any k, exactly like a row no channel admitted - so every number above was taken
 * with two of them switched off.
 *
 * This block seeds four thousand more rows a workspace of the same age would be carrying and takes
 * the same measurements again. The corpus, the probes and the gold sets are identical; the only
 * difference is what the padding does to the ranking.
 *
 * What it says, committed below:
 *
 *   recall       100%   -> 100%     (40/40 either way)
 *   mrr          0.469  -> 0.425
 *   pack tokens  364    -> 758      for the same forty answers
 *   gold share   13%    -> 6%
 *   deepest hit  rank 10 -> rank 28
 *   abstention   3/3    -> 3/3
 *
 * The headline is that recall does not move: nothing the padding contributed displaced an answer
 * out of the pack, and the two caps that finally bind cut rows that were never going to be
 * returned. What moves is the price and the depth. The pack doubles for the same answers, the share
 * of it that answers anything halves, and the worst-ranked answer goes from tenth to twenty-eighth
 * - which is past where an agent reading from the top would have stopped. That is the number this
 * whole block exists to put a floor under, and it is invisible at fifty-one rows.
 *
 * The controls are re-run too, and they separate further rather than less: the random arm falls
 * from 12.5% to 5.0% because arbitrary rows drawn from four thousand answer even less than
 * arbitrary rows drawn from fifty-one. A control that got easier to beat as the corpus grew would
 * have meant the padding was scoring the probes, which is the one way this could have been wrong.
 */
describe('memory retrieval eval under pressure', () => {
  /**
   * The caps, read out of the statement that owns them rather than copied.
   *
   * A literal here would pass forever: raise `MEMORY_FUZZY_SCAN_CANDIDATES` to five thousand and an
   * assertion that the channel matched more than 600 rows still holds while the cap it was standing
   * for stopped binding entirely. Reading them means a rename fails loudly - which is the failure
   * this wants, because a cap that has been renamed is a cap nobody is measuring here any more.
   */
  const caps = (() => {
    const source = readFileSync(new URL('./store/sql/memory.ts', import.meta.url), 'utf8');
    const read = (name: string): number => {
      const match = source.match(new RegExp(`const ${name} = ([\\d_]+);`));
      if (!match)
        throw new Error(
          `${name} is no longer declared in store/sql/memory.ts, so the padded run is no longer ` +
            `measuring the cap it says it measures`
        );
      return Number(match[1]!.replace(/_/g, ''));
    };
    return {
      lexical: read('MEMORY_LEXICAL_CANDIDATES'),
      fuzzyScan: read('MEMORY_FUZZY_SCAN_CANDIDATES')
    };
  })();

  /** Recall does not move under pressure, so this is committed at the same place as the unpadded. */
  const MIN_PADDED_RECALL = 1;
  /** Today's 0.425, down from 0.469 unpadded: the answer sits a little deeper for the same hit. */
  const MIN_PADDED_MRR = 0.41;
  /** Today's 758, against 364 unpadded. The padding is bought entirely in tokens. */
  const MAX_PADDED_PACK_TOKENS = 800;
  /** Today's 28, against 12 unpadded - and 28 is past where a reader stops. */
  const MAX_PADDED_RANK = 30;
  /** Today's 0.050 and 0.003, both further from the ranked arm than they were unpadded. */
  const MAX_PADDED_RANDOM_RECALL = 0.12;
  const MAX_PADDED_RANDOM_MRR = 0.02;
  /** Today's 0.075: unchanged, because a probe that answers itself does not care how big the store is. */
  const MAX_PADDED_EMPTY_RECALL = 0.12;

  const paddingRows = MEMORY_EVAL_PADDING_ITEMS + MEMORY_EVAL_PADDING_SOURCES;

  let database: Database;
  let store: DataStore;
  let seed: MemoryEvalSeed;
  let workspaceId: string;
  let packRun: MemoryEvalReport;

  const key = memoryIndexKey(Buffer.alloc(32, 11));
  const now = new Date('2026-07-31T08:00:00.000Z');

  const run = async (
    options: {
      budgetTokens?: number;
      maxItems?: number;
      quotas?: typeof MEMORY_PACK_QUOTAS;
      pack?: 'ranked' | 'empty' | 'random';
    } = {}
  ): Promise<MemoryEvalReport> =>
    runMemoryRecallEval({ store, workspaceId, key, now, seed, paddingRows, ...options });

  // A second database rather than more rows in the first one: the unpadded numbers above are the
  // comparison, and they have to be taken on a store the padding never touched.
  beforeAll(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    const user = await store.createUser({ username: 'eval-owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
    seed = await seedMemoryEvalCorpus({ store, userId: user.id, workspaceId, key, now });
    await seedMemoryEvalPadding({ store, userId: user.id, workspaceId, key, now });
    packRun = await run();
  }, 300_000);

  afterAll(async () => database.close());

  it('presses the candidate caps that fifty-one rows cannot reach', async () => {
    // The whole premise. If this fails, the padded numbers below are a second measurement of the
    // unpadded system and say nothing the block above did not already say.
    let lexicalItems = 0;
    let lexicalSources = 0;
    let fuzzy = 0;
    let deepest = { lexicalItems: 0, lexicalSources: 0, fuzzyCandidates: 0 };
    for (const probe of MEMORY_EVAL_PROBES) {
      const pressure = await measureMemoryChannelPressure({
        database,
        workspaceId,
        plan: planMemoryQuery(probe.question, key)
      });
      if (pressure.lexicalItems > caps.lexical) lexicalItems += 1;
      if (pressure.lexicalSources > caps.lexical) lexicalSources += 1;
      if (pressure.fuzzyCandidates > caps.fuzzyScan) fuzzy += 1;
      deepest = {
        lexicalItems: Math.max(deepest.lexicalItems, pressure.lexicalItems),
        lexicalSources: Math.max(deepest.lexicalSources, pressure.lexicalSources),
        fuzzyCandidates: Math.max(deepest.fuzzyCandidates, pressure.fuzzyCandidates)
      };
    }
    const report = JSON.stringify({ caps, over: { lexicalItems, lexicalSources, fuzzy }, deepest });
    // Today 20 probes press the item lexical channel past 120, 7 press the source channel past it,
    // and 4 press the fuzzy scan past 600 - the deepest at 1,551, 1,074 and 2,446 rows. Committed
    // as floors well under those, because what matters is that the caps are reached at all.
    expect(lexicalItems, report).toBeGreaterThanOrEqual(15);
    expect(lexicalSources, report).toBeGreaterThanOrEqual(5);
    expect(fuzzy, report).toBeGreaterThanOrEqual(3);
    // The fuzzy channel is the one with no other guard: its GIN probe supplies no selectivity, so
    // without the scan cap this is the number of rows a per-row `unnest` would score per recall.
    expect(deepest.fuzzyCandidates, report).toBeGreaterThan(caps.fuzzyScan * 2);
  }, 300_000);

  it('reports the padded corpus it was actually measured on', () => {
    expect(packRun.pressure).toBe(MEMORY_EVAL_PADDED_PRESSURE(paddingRows));
    // Fifty times what the unpadded run was measured at, which is the point of the whole block.
    expect(packRun.pressure).toBeGreaterThan(MEMORY_EVAL_CORPUS_PRESSURE * 50);
    // `writeCost` stays the corpus's: it is the price of writing the rows the probes ask about, and
    // adding four thousand rows nobody asks about to it would report a slower write path than the
    // one the unpadded run measured, for no change to the write path at all.
    expect(packRun.writeCost.items).toBe(MEMORY_EVAL_ITEMS.length);
    expect(packRun.writeCost.sources).toBe(MEMORY_EVAL_SOURCES.length);
  });

  it('keeps every answer it had, and pays about twice as much for them', () => {
    expect(packRun.recall, formatMemoryEvalReport(packRun)).toBeGreaterThanOrEqual(
      MIN_PADDED_RECALL
    );
    expect(packRun.leaks).toEqual([]);
    expect(packRun.packTokens, formatMemoryEvalReport(packRun)).toBeLessThanOrEqual(
      MAX_PADDED_PACK_TOKENS
    );
    // And it really is more expensive than the unpadded pack, or the two runs are the same run and
    // one of these blocks is measuring the other's corpus.
    expect(packRun.packTokens, formatMemoryEvalReport(packRun)).toBeGreaterThan(MAX_PACK_TOKENS);
  });

  it('ranks the answer deeper, which is the cost that recall alone hides', () => {
    expect(packRun.mrr, formatMemoryEvalReport(packRun)).toBeGreaterThanOrEqual(MIN_PADDED_MRR);
    for (const probe of packRun.probes)
      if (probe.hit && probe.rank !== null)
        expect(probe.rank, `${probe.id} answered at rank ${probe.rank}`).toBeLessThanOrEqual(
          MAX_PADDED_RANK
        );
    // The regression the small corpus could not have caught: the owner's nine facts are still
    // separated by the words of the question and not by four thousand rows of noise.
    const language = packRun.probes.find((entry) => entry.id === 'owner-language');
    expect(language?.missed).toEqual([]);
    expect(language?.rank ?? Infinity).toBeLessThanOrEqual(4);
  });

  it('still answers nothing to a question the store cannot answer', () => {
    // The failure mode padding is most likely to cause, and the one that would be worst: four
    // thousand plausible rows are four thousand near misses, and a pack that starts returning them
    // for "what is the capital city of Peru" costs the owner tokens on every unanswerable question.
    const abstentions = packRun.probes.filter((probe) => probe.type === 'abstention');
    expect(abstentions.length).toBeGreaterThan(0);
    for (const probe of abstentions) {
      expect(probe.hit, `${probe.id} returned ${probe.returned} rows`).toBe(true);
      expect(probe.returned).toBeLessThanOrEqual(ALWAYS_ON_REFS.size);
    }
  });

  it('holds the known gap open at scale too', () => {
    const known = MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss);
    expect(packRun.expectedMisses).toEqual(known.map((probe) => probe.id));
    const byId = new Map(packRun.probes.map((probe) => [probe.id, probe]));
    for (const probe of known)
      expect(
        byId.get(probe.id)?.hit,
        `${probe.id} now hits under pressure - drop its expectedMiss`
      ).toBe(false);
  });

  it('beats an unranked pack by more at four thousand rows than at fifty-one', async () => {
    const empty = await run({ pack: 'empty' });
    const random = await run({ pack: 'random' });
    const answerable = MEMORY_EVAL_PROBES.filter((probe) => probe.gold.length > 0).map(
      (probe) => probe.id
    );
    expect(
      empty.probes.filter((result) => result.hit && answerable.includes(result.id)),
      'a probe that scores with no pack is measuring its own question'
    ).toEqual([]);
    expect(random.recall).toBeLessThan(packRun.recall);
    expect(random.mrr).toBeLessThan(packRun.mrr);
    expect(random.recall).toBeLessThan(MAX_PADDED_RANDOM_RECALL);
    expect(random.mrr).toBeLessThan(MAX_PADDED_RANDOM_MRR);
    expect(empty.recall).toBeLessThan(MAX_PADDED_EMPTY_RECALL);
    // The separation has to widen with the corpus, not narrow: a random arm that improved as rows
    // were added would mean the padding is answering the probes rather than competing with them.
    expect(random.recall).toBeLessThan(MAX_RANDOM_RECALL);
  }, 300_000);

  it('admits every gold row into some channel with the caps binding', async () => {
    // The ceiling run, repeated under pressure, because this is where the caps could actually cost
    // an answer: quotas and the budget are lifted, so anything missing here was cut by a candidate
    // cap or by admission, and the two are the same kind of loss from the pack's point of view.
    const result = await run({
      budgetTokens: 1_000_000,
      maxItems: 200,
      quotas: MEMORY_EVAL_UNBOUNDED_QUOTAS
    });
    expect(result.recall, formatMemoryEvalReport(result)).toBeGreaterThanOrEqual(
      MIN_CANDIDATE_RECALL
    );
    const admitted = new Map(result.probes.map((probe) => [probe.id, probe]));
    for (const probe of MEMORY_EVAL_PROBES.filter((probe) => probe.expectedMiss))
      expect(admitted.get(probe.id)?.found, formatMemoryEvalReport(result)).toEqual([]);
    expect(result.packTokens).toBeGreaterThan(packRun.packTokens);
  }, 300_000);
});

/**
 * The same corpus, with a use history.
 *
 * WHY THIS BLOCK EXISTS. Every number above it was measured on a store where no `mem.item_use` row
 * had ever been written and `consolidateMemory` had never been called, so all fifty-six items
 * carried `salience = 0` - minimum and maximum - and `mem.prior`'s salience factor evaluated to
 * exactly 1.0 for every row in every probe. The usage half of the ranking was unmeasurable by the
 * repository's only retrieval instrument, and it stayed unmeasurable through an audit that moved
 * six of its constants at once - deleting the negative term, multiplying the usage window by a
 * hundred, cutting both positive weights tenfold - with 2,296 tests green.
 *
 * A second corpus rather than usage added to the first, for the same reason the padded block is a
 * second database: the numbers above are the comparison, and a gate re-baselined to accommodate a
 * fixture is not a gate. The A/B between the two blocks is the measurement.
 *
 * The histories are hand-written per row in `MEMORY_EVAL_ITEMS` and were NOT written with these
 * probes in hand - the heaviest history in the corpus belongs to a retired value that must never
 * come back for a present-tense question. So this arm measures the usage prior in its worst case,
 * where a row's history says nothing about whether it answers the question, and the MRR it commits
 * is a floor under that. In production the two are not independent: a `mem.item_use` row is
 * written by this same query answering an earlier turn.
 */
describe('memory retrieval eval with a use history', () => {
  let database: Database;
  let store: DataStore;
  let seed: MemoryEvalSeed;
  let workspaceId: string;
  let packRun: MemoryEvalReport;

  const key = memoryIndexKey(Buffer.alloc(32, 11));
  const now = new Date('2026-07-31T08:00:00.000Z');

  /**
   * Today's numbers on this corpus, committed the way the ones above are.
   *
   * Recall does not move: 100.0%, identical to the arm with no usage at all, and no retired value
   * leaks. MRR does - 0.469 with the salience factor switched off entirely, 0.427 under the
   * `1 + 0.15*ln(1 + greatest(salience,0))` this replaced, 0.395 under the shipped
   * `exp(0.15*asinh(salience))`. The first three were measured on THIS corpus by substituting the
   * body of `mem.prior`, and they are the first numbers in this repository that say what the usage
   * tier is worth. What they say is that on a fixture where usage carries no information about the
   * question, the tier can only cost rank, and costs more the more of the salience range it
   * exposes - which is the argument for leaving 0.15 where it is until somebody measures the other
   * side of it.
   *
   * TODAY IT IS 0.398 AT 363 TOKENS, and the 0.003 is the whole of what stopping the score from
   * crediting an ungraded use is worth on this fixture. That is a small number honestly reported
   * rather than a headline: this corpus is uninformative about usage by construction, so ANY
   * reduction in the salience spread moves MRR back toward the 0.469 of the arm with no usage at
   * all, and this eval cannot tell a repair from a retreat. What it does establish is the
   * direction and the size, and that nothing else moved: recall held at 100.0%, the retired value
   * still does not leak, and the pack lost one token.
   *
   * The measurement that actually decides the change is in `memory-decay.test.ts`, where the
   * feedback loop is run rather than described. Sequenced so the fixture and the score could not
   * be confused with each other: writing the corpus's uncited, unfailed uses as `unknown` instead
   * of `ok` - which is what the production writer does - moved 0.469 / 0.425 / 0.395 to
   * 0.469 / 0.425 / 0.395, not a digit, because `unknown` and `ok` scored identically. The whole
   * of the movement below belongs to the salience recompute.
   */
  const MIN_USAGE_PACK_RECALL = 1;
  const MIN_USAGE_MRR = 0.37;
  const MAX_USAGE_PACK_TOKENS = 450;

  beforeAll(async () => {
    database = createDatabase({ driver: 'pglite', pglitePath: ':memory:' });
    await migrateDatabase(database);
    store = new DataStore(database);
    const user = await store.createUser({ username: 'eval-owner', displayName: 'Owner' });
    const workspace = await store.createWorkspace({
      userId: user.id,
      name: 'computer',
      storageLimitBytes: 10 * 1024 ** 3,
      imageRevision: 'dev',
      region: 'auto',
      wrappedKey: 'wrapped'
    });
    workspaceId = workspace.id;
    seed = await seedMemoryEvalCorpus({
      store,
      userId: user.id,
      workspaceId,
      key,
      now,
      withUsage: true
    });
    packRun = await runMemoryRecallEval({ store, workspaceId, key, now, seed });
  }, 300_000);

  afterAll(async () => database.close());

  it('carries a salience the ranking can see, which is what nothing here did before', async () => {
    const spread = await database.query<{ lo: number; hi: number; nonzero: string; rows: string }>(
      `SELECT MIN(salience) AS lo, MAX(salience) AS hi,
              count(*) FILTER (WHERE salience <> 0) AS nonzero, count(*) AS rows
       FROM mem.item WHERE workspace_id=$1`,
      [workspaceId]
    );
    const { lo, hi, nonzero, rows } = spread.rows[0]!;
    // Both signs present. A corpus that only ever produced positive salience could not show that
    // negative reinforcement reaches the ranking, and one at a single value shows nothing at all.
    expect(Number(lo)).toBeLessThan(0);
    expect(Number(hi)).toBeGreaterThan(0);
    expect(Number(nonzero)).toBe(Number(rows));

    // And the history reached the fold: `shell-retired`'s ten uses are all more than a hundred and
    // eighty days old, so the retention pass moved them to `mem.item_use_fold` and their weight
    // survived the move. Under the DELETE this replaced they would be gone.
    const folded = await database.query<{ item_id: string; uses: number; oks: number }>(
      'SELECT item_id, uses, oks FROM mem.item_use_fold'
    );
    expect(folded.rows).toHaveLength(1);
    expect(folded.rows[0]!.item_id).toBe(seed.ids.get('shell-retired'));
    expect(folded.rows[0]!.uses).toBe(10);
    // And none of the ten was graded. `shell-retired` is the heaviest history in this corpus and
    // it is a retired value that must never come back, so it carries no citations at all - which
    // under the production writer's own rules makes every one of its uses `unknown`. The fold
    // records that, and the score reads it: this is the row whose lead a score blind to the outcome
    // would keep paying for out of nothing but the fact that it had once been packed.
    expect(folded.rows[0]!.oks).toBe(0);

    // THE CORPUS WRITES ALL THREE OUTCOMES, BECAUSE THE PRODUCTION WRITER DOES. A fixture that
    // grades every use that was not cited and did not fail a success never produces `unknown`,
    // and cannot see what the score does with it. If this ever writes only two, the arm below is
    // measuring a store that no turn on this computer can produce.
    const outcomes = await database.query<{ outcome: string; n: string }>(
      `SELECT outcome, count(*)::int AS n FROM mem.item_use WHERE workspace_id=$1
       GROUP BY outcome ORDER BY outcome`,
      [workspaceId]
    );
    expect(outcomes.rows.map((row) => row.outcome)).toEqual(['fail', 'ok', 'unknown']);
    for (const row of outcomes.rows) expect(Number(row.n)).toBeGreaterThan(0);
  }, 300_000);

  it('retrieves and ranks under a usage prior that knows nothing about the questions', () => {
    const report = formatMemoryEvalReport(packRun);
    // Recall and the pack size are unmoved by the tier: it reorders, it does not admit or evict.
    expect(packRun.recall, report).toBeGreaterThanOrEqual(MIN_USAGE_PACK_RECALL);
    expect(packRun.packTokens, report).toBeLessThanOrEqual(MAX_USAGE_PACK_TOKENS);
    expect(packRun.leaks, report).toEqual([]);
    expect(packRun.mrr, report).toBeGreaterThanOrEqual(MIN_USAGE_MRR);
    for (const probe of packRun.probes)
      if (probe.hit && probe.rank !== null)
        expect(probe.rank, `${probe.id} answered at rank ${probe.rank}`).toBeLessThanOrEqual(12);
  });

  it('moves when a salience constant moves, which is the whole point of the arm', async () => {
    // The falsification. Flatten salience to zero and the ranking has to change - if it does not,
    // this block is measuring the same thing as the one above it and the usage tier is invisible.
    const before = packRun.mrr;
    await database.query('UPDATE mem.item SET salience = 0 WHERE workspace_id=$1', [workspaceId]);
    const flattened = await runMemoryRecallEval({ store, workspaceId, key, now, seed });
    expect(flattened.mrr).not.toBe(before);
    expect(flattened.mrr).toBeGreaterThan(before);
    // Restored by the real pass rather than by writing the column back, so the number this block
    // committed is the number the nightly statement produces.
    await store.consolidateMemory(workspaceId, { now });
    const restored = await runMemoryRecallEval({ store, workspaceId, key, now, seed });
    expect(restored.mrr).toBeCloseTo(before, 10);
  }, 300_000);
});
