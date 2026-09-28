import { projectMemorySourceSearchSql } from './sql/memory.js';
import { randomUUID } from 'node:crypto';
import {
  GardenError,
  MEMORY_PACK_BUDGET_TOKENS,
  MEMORY_FUZZY_SIMILARITY_THRESHOLD,
  MEMORY_PACK_DEFAULT_QUOTA,
  MEMORY_PACK_QUOTAS,
  MEMORY_PREDICATES,
  MEMORY_PROCEDURE_MIN_SUCCESS_RATE,
  MEMORY_PROCEDURE_STALE_DAYS,
  MEMORY_SALIENCE_CITE_WEIGHT,
  MEMORY_SALIENCE_FAIL_WEIGHT,
  MEMORY_SALIENCE_USE_WEIGHT,
  MEMORY_USE_AGE_FLOOR_DAYS,
  MEMORY_USE_DECAY_EXPONENT,
  isFunctionalMemoryPredicate,
  isMemoryToken,
  memoryPredicate,
  resolveMemoryContradiction
} from '@garden/core';
import type {
  EncryptedEnvelope,
  MemoryItemIndex,
  MemoryKind,
  MemoryPackQuota,
  MemoryQueryPlan,
  MemoryStatus,
  MemoryTrust
} from '@garden/core';
import type { Database } from '../database.js';
import {
  iso,
  json,
  mapMemoryCandidate,
  mapMemoryFactCandidate,
  mapMemoryItem,
  mapMemoryPack,
  mapMemorySource,
  mapOwnerBlock,
  optionalText
} from './rows.js';
import {
  MEMORY_RECALL_SQL,
  MEMORY_SOURCE_SEARCH_PER_TASK,
  MEMORY_SOURCE_ARCHIVE_SEARCH_SQL,
  MEMORY_SOURCE_SEARCH_SQL,
  MEMORY_SOURCE_WINDOW_SQL,
  OWNER_BLOCK_MAX_BYTES,
  OWNER_BLOCK_READ_SQL,
  OWNER_BLOCK_WRITE_SQL
} from './sql/memory.js';

export { OWNER_BLOCK_MAX_BYTES };

/**
 * The owner's own block, as it is stored: sealed text, its exact plaintext length, and the version
 * a rewrite has to state.
 *
 * `contentBytes` is not a stored column. It is `octet_length` of the decoded ciphertext, which for
 * AES-256-GCM is the plaintext length to the byte - so the number a caller reports against the
 * bound and the number the database refuses on are the same number by construction rather than by
 * two writers agreeing.
 */
export interface OwnerBlockRecord {
  userId: string;
  ciphertext: EncryptedEnvelope;
  contentBytes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The plaintext length of a sealed block, read off the envelope without a key.
 *
 * GCM is a counter mode: the ciphertext is exactly as long as what went in, and the authentication
 * tag lives in its own field beside it. This is the same arithmetic migration 73's CHECK does in
 * SQL, and it is here so the refusal can carry a message before the statement runs.
 */
export const ownerBlockBytes = (envelope: EncryptedEnvelope): number =>
  Buffer.from(envelope.ciphertext, 'base64').byteLength;

/** Guards the one lookup whose ids arrive as model-written text rather than from a prior row. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryCapabilities {
  /** True when pg_trgm is installed. Fuzzy recall does not depend on it; reporting does. */
  readonly trigram: boolean;
}

export interface MemoryItemRecord {
  id: string;
  userId: string;
  workspaceId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  trust: MemoryTrust;
  documentCiphertext: EncryptedEnvelope;
  observedAt: string;
  retiredAt: string | null;
  validFrom: string;
  validTo: string | null;
  subjectKey: string | null;
  predicate: string | null;
  predFunctional: boolean;
  objectKey: string | null;
  episodeId: string | null;
  taskId: string | null;
  lastVerified: string | null;
  okCount: number;
  failCount: number;
  pin: boolean;
  useCount: number;
  citedCount: number;
  negCount: number;
  lastUsedAt: string | null;
  /**
   * Whether the turn that produced this row read somebody else's words, or `null` for a row
   * written before migration 71, where nobody recorded the answer.
   *
   * It exists so that the taint gate outlives the turn it was taken on. Everything the gate used
   * to protect happened inside `recordTurnEpisode`; the verbatim owner text of a tainted turn went
   * into `mem.source` regardless, so a pass reading sources a day later had nothing to consult.
   * Readers test for `false` rather than for `not true`, which is what makes the unknown backlog
   * refused rather than trusted.
   */
  tainted: boolean | null;
  /**
   * The source the taint above came from, or `null` when the turn read nothing from outside and on
   * every row written before migration 74. It names what a reach back into this turn's stored tool
   * results is replaying, which is what the owner's timeline needs in order to say more than
   * "somewhere".
   */
  taintOrigin: string | null;
  salience: number;
  tokensEst: number;
  indexed: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A procedure in the review queue, and why it is there.
 *
 * `unverified` is "nobody has confirmed this in a season" - it may be perfectly good and merely
 * unused. `failing` is "it lost more than it won across its last five uses" - it is broken now, and
 * `recentOkCount` of `recentGradedCount` is the evidence. They are different things to say to an
 * owner deciding whether to keep a remembered command, which is why the queue reports which.
 */
export interface MemoryProcedureReviewRecord extends MemoryItemRecord {
  reason: 'unverified' | 'failing' | 'both';
  recentOkCount: number;
  recentGradedCount: number;
}

export interface MemorySourceRecord {
  sharedForWorkspaceId?: string;
  id: string;
  userId: string;
  workspaceId: string;
  occurredAt: string;
  channel: MemorySourceChannel;
  role: string | null;
  taskId: string | null;
  episodeId: string | null;
  originCiphertext: EncryptedEnvelope | null;
  originKey: string | null;
  bodyCiphertext: EncryptedEnvelope;
  chunkIndex: number;
  chunkOf: string | null;
  tokensEst: number;
  indexed: boolean;
  createdAt: string;
}

export type MemorySourceChannel = 'chat' | 'terminal' | 'file' | 'browser' | 'desktop' | 'tool';

/**
 * One provenance edge from a curated item to the verbatim row behind it, with the row's sealed body
 * so the edge can actually be followed.
 *
 * The span is Postgres's own `int4range` text - `[7,40)` - and it is deliberately not parsed here.
 * A range is a half-open pair of character offsets into the plaintext, and the store never holds
 * the plaintext: cutting it is the key holder's job, and a store that returned an already-cut
 * `text` field would be claiming to have read what it cannot read.
 */
export interface MemoryEvidenceRecord {
  sourceId: string;
  span: string | null;
  occurredAt: string;
  role: string | null;
  channel: MemorySourceChannel;
  taskId: string | null;
  chunkIndex: number;
  bodyCiphertext: EncryptedEnvelope;
}

/** One tool call a memory cited, with the raw result the harness stored for it, sealed. */
export interface MemoryCitedCallRecord {
  toolCallId: string;
  eventId: string;
  /**
   * The conversation the event belongs to, read off the event row rather than off the memory.
   *
   * It is the encryption context the payload was sealed under, so taking it from here is what makes
   * a citation that somehow named an event in another conversation fail to open rather than open
   * that conversation's material under this memory's name.
   */
  taskId: string;
  payloadCiphertext: EncryptedEnvelope;
  occurredAt: string;
}

export type MemoryUseOutcome = 'ok' | 'fail' | 'unknown';

export interface MemoryCandidateRecord {
  sharedForWorkspaceId?: string;
  originWorkspaceId?: string;
  id: string;
  /** `item` rows come from the curated overlay, `source` rows from the verbatim layer. */
  layer: 'item' | 'source';
  kind: MemoryKind;
  trust: MemoryTrust;
  status: MemoryStatus;
  observedAt: string;
  validFrom: string;
  validTo: string | null;
  subjectKey: string | null;
  predicate: string | null;
  tokensEst: number;
  score: number;
  documentCiphertext: EncryptedEnvelope;
}

export interface MemoryPackRecord {
  taskId: string;
  workspaceId: string;
  briefVersion: string | null;
  bodyCiphertext: EncryptedEnvelope;
  sha256: string;
  itemIds: string[];
  tokensEst: number;
  createdAt: string;
}

export interface MemoryLinkRecord {
  srcId: string;
  dstId: string;
  rel: MemoryLinkRelation;
  weight: number;
  createdAt: string;
}

export type MemoryLinkRelation =
  | 'supersedes'
  | 'contradicts'
  | 'supports'
  | 'derived_from'
  | 'about'
  | 'part_of';

/**
 * Two active facts about one subject that the store cannot tell apart on its own.
 *
 * Produced by `listMemoryContradictionCandidates` and consumed by the resolution policy in
 * `@garden/core`, which is deterministic *given a verdict* - so this carries everything the
 * policy needs (trust and observation time) plus the sealed documents, because the only thing that
 * can supply the verdict is something holding the key.
 */
export interface MemoryContradictionPair {
  readonly predicate: string;
  /** True when the registry says this predicate has one value, which settles the verdict by itself. */
  readonly functional: boolean;
  readonly left: MemoryItemRecord;
  readonly right: MemoryItemRecord;
}

/**
 * One carve-out on one rule, as the store holds it: a blind hash of the clause and the sealed
 * clause itself.
 *
 * `key` is `memoryObjectKey` over the clause under the store's own fold, so two spellings of one
 * exception are one row and the store can dedupe what it cannot read. It belongs to the RULE -
 * `(workspace, subject, predicate, object_key)` - and not to the candidate that carried it, which
 * is why it survives the candidate's promotion.
 */
export interface MemoryFactQualification {
  readonly key: string;
  readonly ciphertext: EncryptedEnvelope;
  readonly firstSeen: string;
}

export interface MemoryFactCandidateRecord {
  workspaceId: string;
  subjectKey: string;
  predicate: string;
  /**
   * The rule with its qualification stripped, keyed.
   *
   * This is what corroboration counts, and the stripping is the whole point: a sentence and the
   * same sentence with the owner's exception attached have to reach the same counter, or the bare
   * one collects the sightings and the qualified one dies a singleton. The exception is not lost -
   * it is in `qualifications`, on terms of its own.
   */
  objectKey: string;
  /**
   * Every carve-out anyone has seen on this rule, oldest first, whether or not this candidate's own
   * sighting carried one.
   *
   * Absent rather than empty when the caller did not ask for them: only the promotion path and the
   * owner's queue load them, and a record that has not been asked must not look like a rule with
   * none. Ordered by `first_seen` so composition is deterministic across passes.
   */
  qualifications?: readonly MemoryFactQualification[];
  episodeCount: number;
  firstSeen: string;
  lastSeen: string;
  episodeIds: string[];
  draftCiphertext: EncryptedEnvelope | null;
  /**
   * Which side nominated this sentence: the shipped patterns over the owner's own words, or a
   * model. Sticky towards `proposed` at the upsert, so a sentence a model wrote cannot become the
   * owner's own by being matched once by a regex afterwards.
   *
   * It decides two things and neither is cosmetic. A promotion from `proposed` is minted at
   * `derived` rather than `stated` - the sentence is a machine's wording of what the owner said,
   * not the owner's - and only `proposed` rows are offered to the owner as proposals.
   */
  origin: MemoryFactCandidateOrigin;
  /**
   * When the owner refused this sentence, or null. A refusal is kept rather than deleted because a
   * deleted candidate is proposed again the next night, forever. The draft is dropped at the same
   * moment; the three keys that remain are keyed blind hashes and are all the store needs to
   * refuse it again.
   */
  dismissedAt: string | null;
}

export type MemoryFactCandidateOrigin = 'observed' | 'proposed';

/**
 * One verbatim chunk of one owner turn, carrying the episode it belongs to.
 *
 * Chunks rather than turns because that is how `mem.source` holds them - up to eight rows of six
 * kilobytes per part - and the store cannot join them back into a turn, because it cannot read
 * them. The caller holds the key and does the assembly.
 */
export interface MemoryProposalSourceRow {
  readonly episodeId: string;
  readonly occurredAt: string;
  readonly taskId: string | null;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly bodyCiphertext: EncryptedEnvelope;
}

/**
 * What the key holder has to supply for an observation to become a durable fact: the sealed
 * document and the blind index over it, neither of which the store can produce for itself.
 */
export interface PreparedMemoryFact {
  userId: string;
  documentCiphertext: EncryptedEnvelope;
  /** Its `subjectKey` and `objectKey` must be the candidate's, or the promotion is refused. */
  index: MemoryItemIndex;
  /**
   * The carve-outs the sealed body actually carries, as keys.
   *
   * Recorded on the row so a later candidate can be asked "does the live rule already say this?"
   * against a store that cannot read either sentence. It is not checked against the candidate the
   * way the subject and object are, because it is not an identity - it is a set that grows.
   */
  qualificationKeys?: readonly string[];
  /** Defaults to `derived`: a promoted fact was assembled from episodes, not stated outright. */
  trust?: MemoryTrust;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  taskId?: string | null;
  /**
   * Admits the row to recall with no lexical grip at all, and exempts it from archival. Off unless
   * the caller asks: this is the one flag that puts an entry in front of every later task in the
   * workspace whether or not that task's words reached it.
   */
  pin?: boolean;
}

export interface MemoryFactPromotion {
  candidate: MemoryFactCandidateRecord;
  item: MemoryItemRecord;
  supersededIds: string[];
  /**
   * True when the corroboration landed on a row that already said this, rather than minting a
   * second one. `item` is then the row that was already there and the episodes behind this
   * candidate have been linked to it.
   */
  reattached: boolean;
}

export interface CreateMemoryItemInput {
  userId: string;
  workspaceId: string;
  kind: MemoryKind;
  trust: MemoryTrust;
  documentCiphertext: EncryptedEnvelope;
  /** Keyed blind index built by `buildMemoryItemIndex`; plaintext never reaches the store. */
  index: MemoryItemIndex;
  id?: string;
  status?: MemoryStatus;
  observedAt?: Date | string | null;
  validFrom?: Date | string | null;
  validTo?: Date | string | null;
  predicate?: string | null;
  episodeId?: string | null;
  taskId?: string | null;
  lastVerified?: Date | string | null;
  pin?: boolean;
  salience?: number;
  /**
   * Whether the turn this row came from read somebody else's words. Written on episodes, where a
   * later pass can read it; left unset elsewhere, where there is no later pass and the gate is
   * still taken at the moment of writing.
   */
  tainted?: boolean | null;
  /**
   * Where those words came from, when they came from somewhere. The boolean above says whether a
   * turn read untrusted content and cannot say what it read; a reach back into this turn's stored
   * material has to hand the model, and the owner's timeline, the name of the source it is
   * replaying. Written only where `tainted` is true, and never read on its own: an absent origin
   * on a row that is not known-untainted is treated exactly as `tainted IS NULL` is.
   */
  taintOrigin?: string | null;
  /**
   * The carve-outs this row's sentence carries, keyed. Facts promoted from a candidate only; every
   * other writer leaves it null, which reads as "this row makes no claim about exceptions" rather
   * than "this rule has none".
   */
  qualificationKeys?: readonly string[] | null;
}

export interface RecallMemoryInput {
  workspaceId: string;
  plan: MemoryQueryPlan;
  /** Anchors every decayed score. Pass the task's start instant to freeze a pack for its lifetime. */
  now?: Date | string;
  budgetTokens?: number;
  maxItems?: number;
  kinds?: readonly MemoryKind[];
  scope?: 'default' | 'archive';
  asOf?: Date | string | null;
  includeSuperseded?: boolean;
  quotas?: readonly MemoryPackQuota[];
  procedureStaleDays?: number;
  procedureMinSuccessRate?: number;
  /** Minimum keyed-trigram Jaccard for the fuzzy channel; defaults to pg_trgm's own threshold. */
  fuzzyThreshold?: number;
  /**
   * Rows the caller already has in context. Excluded before any channel spends a slot on them, so a
   * mid-task recall returns what the frozen pack did not, rather than a paraphrase of it.
   */
  excludeIds?: readonly string[];
  /**
   * `stable` orders by (kind, id) so the same rows always render to the same pack bytes, which is
   * what the prompt cache needs. `relevance` orders by fused score, for a recall the agent asked
   * for mid-task and nothing is caching.
   */
  order?: 'stable' | 'relevance';
}

export interface ProjectMemoryScope {
  userId: string;
  projectId: string;
}

export interface SearchMemorySourcesInput {
  project?: ProjectMemoryScope;
  workspaceId: string;
  /** Built by `planMemoryQuery`, exactly as for item recall: same tokenizer, same key. */
  plan: MemoryQueryPlan;
  /** Restricts the search to one task's transcript. */
  taskId?: string | null;
  since?: Date | string | null;
  until?: Date | string | null;
  limit?: number;
  /**
   * Most rows any one conversation may contribute. Defaults to `MEMORY_SOURCE_SEARCH_PER_TASK`;
   * a search already restricted to one task raises it, because there is nothing to crowd out.
   */
  perTask?: number;
  /**
   * Which tier to search. `indexed` is every row the nightly pass has not yet archived and is the
   * default; `archived` is only the rows past the horizon, searched by recomputing their vector
   * from the tokens the pass now keeps.
   *
   * Two calls rather than one union, because they are two different costs and the caller should
   * have to decide to pay the second: the first is a GIN probe, the second is a scan. @see
   * MEMORY_SOURCE_ARCHIVE_SEARCH_SQL.
   */
  reach?: 'indexed' | 'archived';
}

export interface MemorySourceHit extends MemorySourceRecord {
  score: number;
}

export interface MemoryConsolidationReport {
  salienceUpdated: number;
  itemsArchived: number;
  sourcesUnindexed: number;
  /**
   * Rows that left `mem.item_use` this pass - folded into `mem.item_use_fold`, not discarded. The
   * name is kept because the bound it reports is the same one: how much of the per-use table the
   * retention horizon took out. What those rows are worth to the ranking survives them.
   */
  usesPruned: number;
  candidatesPruned: number;
  packsPruned: number;
  staleProcedureIds: string[];
  /** True when this pass also did the periodic full rebuild of the BM25 corpus statistics. */
  corpusStatsRebuilt: boolean;
  /**
   * What the contradiction pass did, split by outcome because they mean different things to the
   * owner: a dispute is a question waiting in the review queue, a supersession is an answer this
   * pass was entitled to give on its own.
   */
  factsDisputed: number;
  factsSuperseded: number;
  factsRetracted: number;
}

/**
 * The tiered agent memory: the `mem` schema and every statement that reads or writes it.
 *
 * Three layers in one place because they only make sense together - `mem.source` holds the words as
 * they were typed, `mem.item` holds what was curated out of them, and `mem.pack` holds the bytes a
 * task actually sent to the model. Recall reads all three; consolidation demotes across all three;
 * and `forgetMemoryItem` is the one statement that has to reach every one of them, which is exactly
 * why it belongs beside them rather than in a route.
 */
export class MemoryStore {
  constructor(private readonly database: Database) {}

  /** Detected once per process: extension availability cannot change under a running server. */
  #memoryCapabilities: Promise<MemoryCapabilities> | null = null;

  private async invalidatePacks(database: Database, itemIds: readonly string[]): Promise<void> {
    if (itemIds.length === 0) return;
    // Shared items can also appear in child-project packs.
    await database.query('DELETE FROM mem.pack WHERE item_ids && $1::uuid[]', [[...itemIds]]);
  }

  async #sharedWorkspace(workspaceId: string): Promise<string | null> {
    const row = (
      await this.database.query(
        `SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$1 AND p.parent_workspace_id IS NULL`,
        [workspaceId]
      )
    ).rows[0];
    return row ? String(row.id) : null;
  }

  async memoryCapabilities(): Promise<MemoryCapabilities> {
    this.#memoryCapabilities ??= this.database
      .query<{
        extname: string;
      }>(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`)
      .then((result) => ({ trigram: result.rows.length > 0 }));
    return this.#memoryCapabilities;
  }

  /**
   * Reconciles the database copy of the predicate registry with the vetted in-repo one. The
   * registry is deliberately not extensible at runtime, so this only ever writes what ships.
   *
   * Each registry row is followed by a backfill of `mem.item.pred_functional`, because that column
   * is a cache of `cardinality = 'one'` that only ever gets filled at write time: `mem.index_row()`
   * computes it, and its trigger fires on `mem.item`, not on `mem.predicate`. Nothing else refreshes
   * it, and it is the sole predicate of the `mem_fact_current_one` unique index - the one guarantee
   * that a functional predicate has one current value.
   *
   * So a release that changes a cardinality used to update the registry and leave every stored row
   * carrying the old answer. `many` -> `one` left the unique index covering nothing it should have
   * covered, and two current values for the same subject coexisting indefinitely with no error
   * anywhere. `one` -> `many` was worse: the stale `TRUE` kept the index covering rows it no longer
   * governed, so a legitimate second value was refused by a constraint violation the agent reported
   * to the owner as a failed memory write.
   *
   * Two things to know before relying on this. Nothing calls it on a live box: the eval harness and
   * the tests do, while `apps/api/src/server.ts` and `apps/worker/src/index.ts` both stop at
   * `migrateDatabase`. And the damage it repairs is narrower than it looks, because the registry's
   * only production writer is `#recordMemoryFact`, which upserts the definition it is about to use
   * before writing - so a fact minted after a cardinality change always carries the new answer, and
   * the retirement that enforces `one` never reads the flag. What is left is the rows written
   * *before* the change, which keep the old answer and stay outside or inside `mem_fact_current_one`
   * accordingly until this runs.
   */
  async syncMemoryPredicates(): Promise<number> {
    let written = 0;
    for (const predicate of MEMORY_PREDICATES) {
      const result = await this.database.query(
        `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE
           SET cardinality=EXCLUDED.cardinality, is_temporal=EXCLUDED.is_temporal,
               description=EXCLUDED.description`,
        [predicate.name, predicate.cardinality, predicate.isTemporal, predicate.description]
      );
      written += result.rowCount;
      await this.#backfillPredicateFunctional(
        this.database,
        predicate.name,
        predicate.cardinality === 'one'
      );
    }
    return written;
  }

  /**
   * Re-materialises `pred_functional` for one predicate after its cardinality moved.
   *
   * The direction matters, and only one of the two can fail. Clearing the flag can only remove rows
   * from `mem_fact_current_one`, so it is a plain UPDATE. Setting it *adds* rows to a unique index,
   * and the rows being added are exactly the ones written while the predicate still permitted many
   * values - so a subject that legitimately accumulated three current values under `many` would
   * abort the whole statement the moment the registry said `one`.
   *
   * That abort would land on an unattended upgrade, so it is designed out rather than caught: a row
   * is only promoted when nothing else already occupies its slot in the index. A subject that really
   * does hold several current values keeps them, keeps them retrievable, and stays outside the
   * unique index until the contradiction is resolved the ordinary way - by one of them being
   * superseded. Half a table converted is the correct outcome here; a migration that refuses to
   * finish is not.
   *
   * The occupancy test is a window rather than the correlated NOT EXISTS it reads as, and that is
   * not a style choice. `mem.item.predicate` has no index of its own, so asking "does anything else
   * hold this row's slot?" once per candidate row is one sequential scan per candidate: measured at
   * 20,000 facts under a predicate that had just narrowed, the correlated form took **65 s** and the
   * window form takes **0.4 s**. Sixty-five seconds inside an unattended upgrade is how a box comes
   * back from a 3am restart with its memory half converted and nobody watching.
   *
   * `PARTITION BY workspace_id, subject_key` is the index's key less the predicate, which the WHERE
   * has already fixed. subject_key is nullable in general but never on a row this can promote: the
   * table's own CHECK requires a fact to carry one, and only facts are governed.
   */
  async #backfillPredicateFunctional(
    database: Database,
    name: string,
    functional: boolean
  ): Promise<void> {
    if (!functional) {
      await database.query(
        `UPDATE mem.item SET pred_functional = FALSE
         WHERE predicate = $1 AND pred_functional`,
        [name]
      );
      return;
    }
    await database.query(
      `WITH slots AS (
         SELECT id, pred_functional,
                (kind = 'fact' AND status = 'active' AND valid_to IS NULL) AS governed,
                count(*) FILTER (WHERE kind = 'fact' AND status = 'active' AND valid_to IS NULL)
                  OVER (PARTITION BY workspace_id, subject_key) AS in_slot
         FROM mem.item WHERE predicate = $1
       )
       UPDATE mem.item i SET pred_functional = TRUE
       FROM slots s
       WHERE s.id = i.id AND NOT s.pred_functional
         AND (NOT s.governed OR s.in_slot <= 1)`,
      [name]
    );
  }

  async createMemorySource(input: {
    userId: string;
    workspaceId: string;
    channel: MemorySourceChannel;
    bodyCiphertext: EncryptedEnvelope;
    bodyTokens: string;
    tokensEst: number;
    indexed?: boolean;
    role?: string | null;
    taskId?: string | null;
    episodeId?: string | null;
    /** Sealed provenance: paths, URLs, cwd, exit codes. Never written in the clear. */
    originCiphertext?: EncryptedEnvelope | null;
    /** Keyed hash of the locator, from `memoryOriginKey`; the only origin column SQL can match. */
    originKey?: string | null;
    chunkIndex?: number;
    chunkOf?: string | null;
    occurredAt?: Date | string;
    /**
     * Every other memory write takes a caller-supplied id and this one minted its own, which made
     * a corpus impossible to reproduce: two rows the ranking cannot separate are ordered by id, so
     * a random one decides which of them the pack carries and the same store answers the same
     * question differently on a second run.
     */
    id?: string;
  }): Promise<MemorySourceRecord> {
    const result = await this.database.query(
      `INSERT INTO mem.source(
         id,user_id,workspace_id,occurred_at,channel,role,task_id,episode_id,origin_ciphertext,
         origin_key,body_ciphertext,chunk_ix,chunk_of,tokens_est,indexed,body_tokens
       ) VALUES ($1,$2,$3,COALESCE($4,NOW()),$5,$6,$7,$8,COALESCE($9::jsonb,'{}'::jsonb),$10,
                 $11::jsonb,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.userId,
        input.workspaceId,
        input.occurredAt ?? null,
        input.channel,
        input.role ?? null,
        input.taskId ?? null,
        input.episodeId ?? null,
        input.originCiphertext ? JSON.stringify(input.originCiphertext) : null,
        input.originKey ?? null,
        JSON.stringify(input.bodyCiphertext),
        input.chunkIndex ?? 0,
        input.chunkOf ?? null,
        input.tokensEst,
        input.indexed ?? true,
        input.indexed === false ? '' : input.bodyTokens
      ]
    );
    return mapMemorySource(result.rows[0]!);
  }

  /**
   * Reaches verbatim rows by where they came from. Compaction takes old sources out of the lexical
   * index but never deletes them, so this is the path that still finds them.
   */
  async listMemorySourcesByOrigin(
    workspaceId: string,
    originKey: string,
    limit = 50
  ): Promise<MemorySourceRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.source WHERE workspace_id=$1 AND origin_key=$2
       ORDER BY occurred_at DESC, id LIMIT $3`,
      [workspaceId, originKey, limit]
    );
    return result.rows.map(mapMemorySource);
  }

  /**
   * How alike two entries have to be before the second one is not written.
   *
   * Measured over the *keyed body lexemes*, which is a set of stemmed content words with the stop
   * words already removed by the same tokenizer the index uses - so 0.9 is nine tenths of the
   * substantive words in common, not nine tenths of the English. Two genuinely different facts
   * about one subject do not reach it; two paraphrases of one preference do, which is exactly the
   * pair §4.7 #112 names. Deliberately blunt: no entropy gate, no model call, and nothing that
   * needs pg_trgm - the cheapest tier that changes the outcome, run on the one path that had no
   * duplicate suppression at all.
   */
  static readonly nearDuplicateJaccard = 0.9;

  /**
   * How many carve-outs one rule may accumulate.
   *
   * The only spelling of this bound. It lives beside the statement that enforces it rather than in
   * the worker that supplies the clauses, because a caller-supplied maximum is a second policy the
   * store cannot see - and this store has paid for one of those already, in the corroboration gate
   * whose two halves are defaults here for exactly that reason.
   *
   * Four, and the number is measured rather than round: over the owner's 648 typed turns no rule
   * core accumulates more than two distinct qualifications, and the 200-character bound on a
   * standing order refuses a fifth long before this does - the shortest carve-out in that corpus is
   * 24 characters, so five of them behind a 16-character core is already past 200. It exists at all
   * because this is a table and composition is not what stops it growing: a rule whose clauses no
   * longer compose keeps every row it has, so without a bound here a proposer restating one rule
   * nightly with a fresh clause grows a row set nothing will ever read.
   */
  static readonly maxQualifications = 4;

  /**
   * The fewest distinct body lexemes an entry must have before similarity means anything.
   *
   * Under this, Jaccard is measuring a coincidence. "Ships on Friday" and "Ships on Monday" share
   * two of three tokens and are opposite facts; the threshold above would refuse the second of
   * them and lose the correction, which is the worst outcome this whole mechanism can produce.
   * Short entries are written, and the pack's own exact `dedupe_key` collapse still catches the
   * case where they are identical.
   */
  static readonly nearDuplicateMinTokens = 8;

  /**
   * How many recent siblings one write compares itself against.
   *
   * A bound, not a sample: `mem_item_kind_idx` is `(workspace_id, kind, observed_at DESC) WHERE
   * status='active'`, so this reads a fixed prefix of one index whatever the workspace has
   * accumulated. Unbounded, a write into a corpus of twenty thousand procedures would compute
   * twenty thousand set intersections on the finishing path of a turn the owner is waiting on -
   * and a duplicate that has to travel past two hundred more recent entries of the same kind and
   * subject to find its twin is not the case this exists for.
   */
  static readonly nearDuplicateScan = 200;

  /**
   * Writes an entry, unless this workspace already remembers it.
   *
   * The tiered store had no duplicate suppression on the write path at all: two paraphrases of one
   * preference produced two rows, two slots in the recall budget and two lines in the block at the
   * top of every later window, and the only collapse anywhere was `DISTINCT ON (dedupe_key)` at
   * recall time, which needs the bytes to be identical. So the corpus grew a copy per turn of
   * everything the agent kept rediscovering, and the pack spent its budget saying one thing twice.
   *
   * Facts written through `recordMemoryFact` deliberately do not come this way: a second current
   * value of a functional predicate is a *correction*, and it is already resolved there,
   * bitemporally and with a `supersedes` link. Collapsing it into the row it corrects would delete
   * the correction. Episodes are exempt for the opposite reason - they are the audit trail, one
   * per turn, and two similar turns really did both happen.
   *
   * The existing row is returned rather than a null, so a caller cannot tell a suppressed write
   * from a fresh one and cannot end up holding an id that is not in the table.
   */
  async createMemoryItem(input: CreateMemoryItemInput): Promise<MemoryItemRecord> {
    const existing = await this.#nearDuplicateMemoryItem(input);
    if (existing) return existing;
    return this.#insertMemoryItem(this.database, input);
  }

  async #nearDuplicateMemoryItem(input: CreateMemoryItemInput): Promise<MemoryItemRecord | null> {
    if (input.kind === 'episode' || input.status === 'retracted') return null;
    // An unindexed body carries no tokens to compare, which is the point of the flag: whatever
    // defeated the tokenizer would defeat this too, and a similarity of nothing to nothing is 1.
    if (!input.index.indexed) return null;
    const tokens = [...new Set(input.index.bodyTokens.split(' ').filter(Boolean))];
    // The same floor the query applies to the stored side, applied here to save the round trip.
    // It is deliberately not a second guard: with both sides tested in SQL this early return can
    // only ever refuse work the query would have refused anyway, and writing it down as belt and
    // braces would be the sort of duplicated policy this repository has twice paid for.
    if (tokens.length < MemoryStore.nearDuplicateMinTokens) return null;
    const result = await this.database.query(
      // The first CTE is a fixed prefix of `mem_item_kind_idx` and nothing else, deliberately:
      // moving the subject or validity filter above the LIMIT would make Postgres scan until it
      // had found two hundred *matching* rows, which on a corpus where nothing matches is the
      // whole table on every write - the unbounded scan this bound exists to prevent, wearing the
      // bound's clothes.
      `WITH recent AS (
         SELECT i.* FROM mem.item i
         WHERE i.workspace_id=$1 AND i.kind=$2::mem.kind AND i.status='active'
         ORDER BY i.observed_at DESC, i.id
         LIMIT $5::int
       ),
       siblings AS (
         SELECT * FROM recent
         WHERE valid_to IS NULL AND subject_key IS NOT DISTINCT FROM $3::text
       )
       SELECT r.* FROM siblings r
       CROSS JOIN LATERAL (
         SELECT ARRAY(
           SELECT DISTINCT token FROM unnest(string_to_array(r.body_tokens,' ')) AS token
           WHERE token <> ''
         ) AS lexemes
       ) mine
       CROSS JOIN LATERAL (
         SELECT cardinality(
           ARRAY(SELECT unnest(mine.lexemes) INTERSECT SELECT unnest($4::text[]))
         ) AS shared
       ) overlap
       WHERE cardinality(mine.lexemes) >= $6::int
         AND overlap.shared::float8 / NULLIF(
               cardinality(mine.lexemes) + cardinality($4::text[]) - overlap.shared, 0
             ) >= $7::float8
       ORDER BY r.observed_at DESC, r.id
       LIMIT 1`,
      [
        input.workspaceId,
        input.kind,
        input.index.subjectKey,
        tokens,
        MemoryStore.nearDuplicateScan,
        MemoryStore.nearDuplicateMinTokens,
        MemoryStore.nearDuplicateJaccard
      ]
    );
    return result.rows[0] ? mapMemoryItem(result.rows[0]) : null;
  }

  async #insertMemoryItem(
    database: Database,
    input: CreateMemoryItemInput
  ): Promise<MemoryItemRecord> {
    const result = await database.query(
      `INSERT INTO mem.item(
         id,user_id,workspace_id,kind,status,trust,document_ciphertext,title_tokens,tag_tokens,
         alias_tokens,body_tokens,tags_hashed,trigrams,dedupe_key,observed_at,valid_from,valid_to,
         subject_key,predicate,object_key,episode_id,task_id,last_verified,pin,salience,
         tokens_est,indexed,tainted,qualification_keys,taint_origin
       ) VALUES (
         $1,$2,$3,$4::mem.kind,COALESCE($5::mem.status,'active'),$6::mem.trust,$7::jsonb,$8,$9,
         $27,$10,$11::text[],$12::text[],$13,COALESCE($14,NOW()),COALESCE($15,NOW()),$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$28::boolean,$29::text[],$30
       ) RETURNING *`,
      [
        input.id ?? randomUUID(),
        input.userId,
        input.workspaceId,
        input.kind,
        input.status ?? null,
        input.trust,
        JSON.stringify(input.documentCiphertext),
        input.index.titleTokens,
        input.index.tagTokens,
        input.index.bodyTokens,
        input.index.tagsHashed,
        input.index.trigrams,
        input.index.dedupeKey,
        input.observedAt ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.index.subjectKey,
        input.predicate ?? null,
        input.index.objectKey,
        input.episodeId ?? null,
        input.taskId ?? null,
        input.lastVerified ?? null,
        input.pin ?? false,
        input.salience ?? 0,
        input.index.tokensEst,
        input.index.indexed,
        input.index.aliasTokens,
        input.tainted ?? null,
        input.qualificationKeys ? [...input.qualificationKeys] : null,
        // Only ever beside a true `tainted`. Written null otherwise rather than left to a caller's
        // default, so a row can never claim an origin for words nobody said came from outside.
        input.tainted === true ? (input.taintOrigin ?? null) : null
      ]
    );
    return mapMemoryItem(result.rows[0]!);
  }

  /**
   * Mints a fact and applies deterministic supersession: a second current value for a functional
   * predicate retires the first one, bitemporally and with a `supersedes` link, rather than being
   * deleted. That keeps "what did I use before?" answerable and keeps the audit trail behind every
   * brief line intact - and it costs no model call at all.
   */
  async recordMemoryFact(
    input: Omit<CreateMemoryItemInput, 'kind'> & { predicate: string }
  ): Promise<{ item: MemoryItemRecord; supersededIds: string[] }> {
    return this.database.transaction(async (transaction) =>
      this.#recordMemoryFact(transaction, input)
    );
  }

  async #recordMemoryFact(
    transaction: Database,
    input: Omit<CreateMemoryItemInput, 'kind'> & { predicate: string }
  ): Promise<{ item: MemoryItemRecord; supersededIds: string[] }> {
    const definition = memoryPredicate(input.predicate);
    if (!definition)
      throw new GardenError(
        'memory_predicate_unknown',
        `Unknown memory predicate "${input.predicate}"`
      );
    if (!input.index.subjectKey)
      throw new GardenError('memory_fact_subject_missing', 'A fact needs a subject');

    /*
     * The shipped definition, pushed into the registry before anything is written against it.
     *
     * This upsert is load-bearing in a way its own line does not show, so it is written down here:
     * it is the reason a release that changes a cardinality cannot break a fact write, and the
     * reason `mem.item.pred_functional` going stale is a dormant inconsistency rather than a failed
     * memory. The row inserted below has its flag computed by `mem.index_row()` from `mem.predicate`
     * as it stands *after* this statement, so a new fact always carries the current answer whatever
     * the rows beside it are still claiming - and the retirement below never consults the flag at
     * all. `syncMemoryPredicates` is what reconciles the rows already stored; nothing calls it at
     * boot, and this is why that is a debt rather than an outage.
     */
    await transaction.query(
      `INSERT INTO mem.predicate(name,cardinality,is_temporal,description)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET cardinality=EXCLUDED.cardinality, is_temporal=EXCLUDED.is_temporal,
             description=EXCLUDED.description`,
      [definition.name, definition.cardinality, definition.isTemporal, definition.description]
    );
    const supersededIds: string[] = [];
    // Asked of the registry by name rather than off the definition in hand, so that "what makes a
    // predicate functional" has exactly one spelling. `definition` came from the same registry a
    // few lines up, so the answer cannot differ; what changes is that the deterministic half of
    // contradiction resolution and the predicate helper `@garden/core` exports are now the same
    // test, and a future edit to one of them cannot leave the other behind.
    if (isFunctionalMemoryPredicate(input.predicate)) {
      const retired = await transaction.query<{ id: string }>(
        `UPDATE mem.item SET status='superseded', valid_to=COALESCE($4,NOW()), retired_at=NOW(),
                             updated_at=NOW()
         WHERE workspace_id=$1 AND kind='fact' AND status='active' AND valid_to IS NULL
           AND subject_key=$2 AND predicate=$3
         RETURNING id`,
        [input.workspaceId, input.index.subjectKey, input.predicate, input.validFrom ?? null]
      );
      supersededIds.push(...retired.rows.map((row) => row.id));
    }
    await this.invalidatePacks(transaction, supersededIds);
    const item = await this.#insertMemoryItem(transaction, { ...input, kind: 'fact' });
    for (const supersededId of supersededIds)
      await transaction.query(
        `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'supersedes')
         ON CONFLICT DO NOTHING`,
        [item.id, supersededId]
      );
    return { item, supersededIds };
  }

  /**
   * Both sides of what the harness watched an acceptance command do, written in one statement.
   *
   * A dead end is a procedure the harness saw fail, and the thing that refutes it is the same
   * command later observed passing - so the write that would record a pass is the write that has to
   * retire the caution, or the caution outlives the problem and starts arguing against work that
   * would now succeed. Doing it here rather than in two calls is what makes that true even when the
   * turn crashes between them: a pass never leaves a stale dead end standing, because there is no
   * moment at which one has been recorded and the other has not.
   *
   * `passed` wins inside the turn as well as across turns. A command can reach both lists at once -
   * two checks naming the same command, one answered by a run garden already watched succeed and
   * one it ran again - and the pass is the later evidence, so nothing is written for it.
   *
   * The subject is the command alone, exactly as a passing run keys it, so a command that fails in
   * one directory and passes in another retires the caution about the first. That is the deliberate
   * direction of the error: forgetting a warning costs a re-run, and keeping a wrong one costs the
   * approach.
   */
  async recordMemoryDeadEnds(input: {
    workspaceId: string;
    /** Keyed `MEMORY_DEAD_END_TAG`; the only handle this store has on rows it cannot read. */
    markerTag: string;
    /** Keyed subjects of the commands the harness watched pass on this turn. */
    passed?: readonly string[];
    /** One per command it watched fail, already built and encrypted by the caller. */
    failed?: readonly Omit<CreateMemoryItemInput, 'kind'>[];
    at?: Date | string | null;
  }): Promise<{ recorded: string[]; retired: string[] }> {
    const passed = [...new Set(input.passed ?? [])];
    const failed = (input.failed ?? []).filter(
      (item) => item.index.subjectKey && !passed.includes(item.index.subjectKey)
    );
    if (passed.length === 0 && failed.length === 0) return { recorded: [], retired: [] };
    return this.database.transaction(async (transaction) => {
      const retired: string[] = [];
      if (passed.length > 0) {
        // Superseded rather than deleted, for the same reason a retired fact is: "what was wrong
        // with this last month" stays answerable, and only `status='active'` reaches recall.
        const result = await transaction.query<{ id: string }>(
          `UPDATE mem.item SET status='superseded', valid_to=COALESCE($4::timestamptz,NOW()),
                               retired_at=NOW(), updated_at=NOW()
           WHERE workspace_id=$1 AND kind='procedure' AND status='active'
             AND tags_hashed @> ARRAY[$2::text] AND subject_key = ANY($3::text[])
           RETURNING id`,
          [input.workspaceId, input.markerTag, passed, input.at ?? null]
        );
        retired.push(...result.rows.map((row) => row.id));
      }
      await this.invalidatePacks(transaction, retired);
      const recorded: string[] = [];
      for (const item of failed) {
        const written = await this.#insertMemoryItem(transaction, { ...item, kind: 'procedure' });
        recorded.push(written.id);
      }
      return { recorded, retired };
    });
  }

  async getMemoryItem(workspaceId: string, id: string): Promise<MemoryItemRecord | null> {
    const result = await this.database.query(
      `SELECT * FROM mem.item WHERE id=$2 AND workspace_id IN ($1,(SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$1))`,
      [workspaceId, id]
    );
    return result.rows[0] ? mapMemoryItem(result.rows[0]) : null;
  }

  /** Owner browsing is deliberately separate from project-agent recall. */
  async listOwnerMemoryItems(
    userId: string,
    workspaceId: string,
    options: {
      scope?: string;
      kind?: MemoryKind;
      status?: MemoryStatus;
      lexemes?: readonly string[];
      cursor?: { at: string; id: string };
      limit?: number;
    } = {}
  ): Promise<{ items: (MemoryItemRecord & { projectId: string | null })[]; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 40));
    const result = await this.database.query(
      `SELECT i.*, p.id AS project_id FROM mem.item i
       JOIN workspaces w ON w.id=i.workspace_id AND w.user_id=$1
       LEFT JOIN mem.item episode ON episode.id=i.episode_id
       LEFT JOIN tasks t ON t.id=COALESCE(i.task_id,episode.task_id) AND t.user_id=$1
       LEFT JOIN projects p ON p.id=t.project_id AND p.user_id=$1
       WHERE i.user_id=$1 AND (w.id=$2 OR w.parent_workspace_id=$2)
         AND ($3::uuid IS NULL OR w.id=$3)
         AND ($4::text IS NULL OR i.kind::text=$4)
         AND ($5::text IS NULL OR i.status::text=$5)
         AND ($6::text[] IS NULL OR i.tsv @@ to_tsquery('simple',array_to_string($6::text[],' | ')))
         AND ($7::timestamptz IS NULL OR i.observed_at<$7 OR (i.observed_at=$7 AND i.id>$8::uuid))
       ORDER BY i.observed_at DESC,i.id LIMIT $9`,
      [
        userId,
        workspaceId,
        options.scope ?? null,
        options.kind ?? null,
        options.status ?? null,
        options.lexemes ? options.lexemes.filter(isMemoryToken) : null,
        options.cursor?.at ?? null,
        options.cursor?.id ?? null,
        limit + 1
      ]
    );
    return {
      items: result.rows
        .slice(0, limit)
        .map((row) => ({ ...mapMemoryItem(row), projectId: optionalText(row.project_id) })),
      hasMore: result.rows.length > limit
    };
  }

  async listMemoryItems(
    workspaceId: string,
    filter: { kind?: MemoryKind; status?: MemoryStatus; limit?: number } = {}
  ): Promise<MemoryItemRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.item
       WHERE workspace_id IN ($1,(SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$1))
         AND ($2::text IS NULL OR kind::text=$2)
         AND ($3::text IS NULL OR status::text=$3)
       ORDER BY observed_at DESC, id
       LIMIT $4`,
      [workspaceId, filter.kind ?? null, filter.status ?? null, filter.limit ?? 200]
    );
    return result.rows.map(mapMemoryItem);
  }

  async linkMemoryItems(input: {
    srcId: string;
    dstId: string;
    rel: MemoryLinkRelation;
    weight?: number;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO mem.link(src_id,dst_id,rel,weight) VALUES ($1,$2,$3,$4)
       ON CONFLICT (src_id,dst_id,rel) DO UPDATE SET weight=EXCLUDED.weight`,
      [input.srcId, input.dstId, input.rel, input.weight ?? 1]
    );
  }

  async listMemoryLinks(itemId: string): Promise<MemoryLinkRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.link WHERE src_id=$1 OR dst_id=$1 ORDER BY rel, src_id, dst_id`,
      [itemId]
    );
    return result.rows.map((row) => ({
      srcId: String(row.src_id),
      dstId: String(row.dst_id),
      rel: String(row.rel) as MemoryLinkRelation,
      weight: Number(row.weight),
      createdAt: iso(row.created_at)
    }));
  }

  /** Provenance: every curated item cites the verbatim rows it was extracted from. */
  async attachMemoryEvidence(
    itemId: string,
    sources: readonly { sourceId: string; span?: [number, number] | null }[]
  ): Promise<number> {
    // All of an item's provenance or none of it. A curated item is already visible to recall by
    // the time this runs, so a half-written citation list is an item the owner can be shown that
    // claims fewer sources than it was actually extracted from - and nothing later notices, because
    // there is no record anywhere of how many there should have been.
    return this.database.transaction(async (transaction) => {
      let written = 0;
      for (const source of sources) {
        const result = await transaction.query(
          `INSERT INTO mem.evidence(item_id,source_id,span)
           VALUES ($1,$2,CASE WHEN $3::int IS NULL THEN NULL ELSE int4range($3::int,$4::int) END)
           ON CONFLICT (item_id,source_id) DO UPDATE SET span=EXCLUDED.span`,
          [itemId, source.sourceId, source.span?.[0] ?? null, source.span?.[1] ?? null]
        );
        written += result.rowCount;
      }
      return written;
    });
  }

  /**
   * The words, not only the pointer.
   *
   * This selected `source_id`, `span` and `occurred_at` and had no caller anywhere outside the
   * store's own delegate - which is the whole defect it was: garden can name the exact character
   * range of the exact stored turn that justifies a remembered fact, and handed back a reference
   * nothing could dereference. `body_ciphertext` is what makes the edge readable, and it comes back
   * sealed like every other body in this tier: the store cannot open it, and the span is returned
   * beside it so the caller cuts the range the edge actually vouches for rather than the chunk it
   * happens to sit in.
   *
   * Bounded in rows here and in characters at the caller, because the two bounds refuse different
   * things. `recordTurnEpisode` attaches at most `2 x MEMORY_MAX_SOURCE_CHUNKS` rows to one
   * episode, so the default is that number and a caller asking for more gets what exists; the
   * characters are the caller's because only the caller knows what it is about to put in a window.
   *
   * Ordered by chunk within an instant, so the parts of one turn come back in reading order. The
   * previous ordering was by source id inside `occurred_at`, which for a turn chunked into eight
   * parts written in the same transaction is a random permutation of the owner's own sentence.
   */
  async listMemoryEvidence(itemId: string, limit = 16): Promise<MemoryEvidenceRecord[]> {
    const result = await this.database.query(
      `SELECT e.source_id, e.span::text AS span, s.occurred_at, s.role, s.channel, s.task_id,
              s.chunk_ix, s.body_ciphertext
       FROM mem.evidence e JOIN mem.source s ON s.id=e.source_id
       WHERE e.item_id=$1
       ORDER BY s.occurred_at, s.chunk_ix, e.source_id
       LIMIT $2`,
      [itemId, Math.max(1, Math.trunc(limit))]
    );
    return result.rows.map((row) => ({
      sourceId: String(row.source_id),
      span: optionalText(row.span),
      occurredAt: iso(row.occurred_at),
      role: optionalText(row.role),
      channel: String(row.channel) as MemorySourceChannel,
      taskId: optionalText(row.task_id),
      chunkIndex: Number(row.chunk_ix),
      bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext)
    }));
  }

  /**
   * The other half of an item's provenance: the tool calls a `finish` cited to justify it.
   *
   * `mem.evidence` reaches the verbatim tier, which is the owner's request and the agent's summary
   * and under one per cent of what a trajectory is made of. This reaches the tier that is most of
   * it - the raw tool results `recordToolResult` already stores untruncated in `task_events` - and
   * it reaches exactly the calls the completion contract named, never the rows that exist.
   *
   * Nothing is copied. The event id is a foreign key, so a citation cannot outlive the result it
   * points at, and both go when the conversation does.
   */
  async attachMemoryCitedCalls(
    itemId: string,
    calls: readonly { toolCallId: string; eventId: string }[]
  ): Promise<number> {
    if (calls.length === 0) return 0;
    return this.database.transaction(async (transaction) => {
      let written = 0;
      for (const call of calls) {
        const result = await transaction.query(
          `INSERT INTO mem.cited_call(item_id,tool_call_id,event_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (item_id,tool_call_id) DO UPDATE SET event_id=EXCLUDED.event_id`,
          [itemId, call.toolCallId, call.eventId]
        );
        written += result.rowCount;
      }
      return written;
    });
  }

  /**
   * What one memory cited, with the stored result behind it, sealed.
   *
   * `e.kind = 'tool_result'` is the refusal written where it cannot be forgotten. The citation
   * table can only ever be written with the id of an event the harness recorded for a tool call,
   * and this clause means that even a row filed against some other kind of event - a warning, an
   * approval card, the owner's own message - answers nothing. The reach reads what was cited, and
   * of that only what a tool returned.
   */
  async listMemoryCitedCalls(itemId: string, limit = 8): Promise<MemoryCitedCallRecord[]> {
    const result = await this.database.query(
      `SELECT c.tool_call_id, c.event_id, e.task_id, e.payload_ciphertext, e.created_at
       FROM mem.cited_call c JOIN task_events e ON e.id = c.event_id
       WHERE c.item_id = $1 AND e.kind = 'tool_result' AND e.payload_ciphertext IS NOT NULL
       ORDER BY e.sequence
       LIMIT $2`,
      [itemId, Math.max(1, Math.trunc(limit))]
    );
    return result.rows.map((row) => ({
      toolCallId: String(row.tool_call_id),
      eventId: String(row.event_id),
      taskId: String(row.task_id),
      payloadCiphertext: json<EncryptedEnvelope>(row.payload_ciphertext),
      occurredAt: iso(row.created_at)
    }));
  }

  /**
   * Below-threshold observations wait here instead of entering mem.item. Requiring two independent
   * episodes at least a day apart is the single most effective anti-bloat rule in the design:
   * minting a fact per message pair is what makes a store unusable after a year.
   *
   * The day is the half that cannot be bought. A count of sightings can be: the owner pasting
   * somebody else's document into two conversations is two sightings, five minutes apart, and it
   * is ordinary behaviour rather than an attack anybody has to mount. Measured end to end, one
   * bare paste of a vendor `CONTRIBUTING.md` into two threads five minutes apart puts five of
   * somebody else's rules into `mem.item`, active and pinned, if nothing asks for elapsed time.
   * That is why no property of WHO said it - however carefully written where the candidate is
   * written - substitutes for the twenty-four hours here.
   */
  async observeMemoryFactCandidate(input: {
    workspaceId: string;
    subjectKey: string;
    predicate: string;
    objectKey: string;
    episodeId: string;
    observedAt?: Date | string;
    draftCiphertext?: EncryptedEnvelope | null;
    /** Who nominated it. Defaults to the shipped patterns over the owner's own sentence. */
    origin?: MemoryFactCandidateOrigin;
    /**
     * The carve-outs this sighting carried, if any. Written beside the candidate rather than into
     * it, and on terms of their own: one sighting is enough for an exception where a rule needs
     * two, so they are accumulated rather than counted.
     */
    qualifications?: readonly { key: string; ciphertext: EncryptedEnvelope }[];
  }): Promise<MemoryFactCandidateRecord> {
    const result = await this.database.query(
      `INSERT INTO mem.fact_candidate(
         workspace_id,subject_key,predicate,object_key,n_episodes,first_seen,last_seen,
         episode_ids,draft_ciphertext,origin
       ) VALUES ($1,$2,$3,$4,1,COALESCE($6,NOW()),COALESCE($6,NOW()),ARRAY[$5::uuid],$7::jsonb,$8)
       ON CONFLICT (workspace_id,subject_key,predicate,object_key) DO UPDATE SET
         n_episodes = mem.fact_candidate.n_episodes
           + CASE WHEN $5::uuid = ANY(mem.fact_candidate.episode_ids) THEN 0 ELSE 1 END,
         episode_ids = CASE WHEN $5::uuid = ANY(mem.fact_candidate.episode_ids)
           THEN mem.fact_candidate.episode_ids
           ELSE (mem.fact_candidate.episode_ids || ARRAY[$5::uuid])[1:32] END,
         first_seen = LEAST(mem.fact_candidate.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(mem.fact_candidate.last_seen, EXCLUDED.last_seen),
         draft_ciphertext = COALESCE(EXCLUDED.draft_ciphertext, mem.fact_candidate.draft_ciphertext),
         -- One-way. A sentence a model wrote stays marked as a model's, however many times a
         -- pattern matches it afterwards, because the trust a promotion is minted at and the
         -- queue the owner reads both key off this column.
         origin = CASE WHEN EXCLUDED.origin = 'proposed' THEN 'proposed'
                       ELSE mem.fact_candidate.origin END
       -- The owner's refusal, enforced where the row is written rather than where it is read.
       -- Without it a dismissed sentence is re-observed tonight, re-proposed tomorrow, and the
       -- dismissal is a button that clears the screen for one day.
       WHERE mem.fact_candidate.dismissed_at IS NULL
       RETURNING *`,
      [
        input.workspaceId,
        input.subjectKey,
        input.predicate,
        input.objectKey,
        input.episodeId,
        input.observedAt ?? null,
        input.draftCiphertext ? JSON.stringify(input.draftCiphertext) : null,
        input.origin ?? 'observed'
      ]
    );
    /*
     * The carve-outs, on their own terms.
     *
     * Insert-only, so the set a rule carries can only grow - that monotonicity is what makes the
     * safety property hold after the first promotion as well as at it, and it is structural rather
     * than asserted: there is no statement anywhere that removes one of these except the owner's
     * own dismissal and the workspace cascade.
     *
     * Not a read-modify-write on the candidate's draft, which is the shape this obviously wants to
     * be. Two turns finishing in the same second would each read the draft, union their own clause
     * into it, and write back - and the later write would drop the earlier one's carve-out. A row
     * per clause keyed on a blind hash of the clause is idempotent by construction and needs no
     * transaction at all.
     *
     * The bound and the owner's refusal are both taken in the statement rather than around it. A
     * count read first and enforced afterwards is two statements a concurrent turn fits between,
     * and `dismissed_at` tested in TypeScript would let the clauses of a sentence the owner has
     * refused accumulate beside the refusal.
     */
    const qualifications = (input.qualifications ?? []).slice(0, MemoryStore.maxQualifications);
    for (const qualification of qualifications)
      await this.database.query(
        `INSERT INTO mem.fact_qualification(
           workspace_id,subject_key,predicate,object_key,qualification_key,ciphertext,first_seen
         )
         SELECT $1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::timestamptz,NOW())
         WHERE (
                 SELECT count(*) FROM mem.fact_qualification q
                 WHERE q.workspace_id=$1 AND q.subject_key=$2 AND q.predicate=$3
                   AND q.object_key=$4
               ) < $8::int
           AND NOT EXISTS (
                 SELECT 1 FROM mem.fact_candidate c
                 WHERE c.workspace_id=$1 AND c.subject_key=$2 AND c.predicate=$3
                   AND c.object_key=$4 AND c.dismissed_at IS NOT NULL
               )
         ON CONFLICT DO NOTHING`,
        [
          input.workspaceId,
          input.subjectKey,
          input.predicate,
          input.objectKey,
          qualification.key,
          JSON.stringify(qualification.ciphertext),
          input.observedAt ?? null,
          MemoryStore.maxQualifications
        ]
      );
    // A conflicting row the WHERE above refused updates nothing and returns nothing. The row is
    // still there and the caller is owed the truth about it - it comes back untouched, carrying
    // `dismissedAt`, so a caller counting what it managed to nominate can see that this one it
    // did not.
    if (result.rows[0]) return mapMemoryFactCandidate(result.rows[0]);
    const standing = await this.database.query(
      `SELECT * FROM mem.fact_candidate
       WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
      [input.workspaceId, input.subjectKey, input.predicate, input.objectKey]
    );
    if (!standing.rows[0])
      throw new GardenError(
        'memory_candidate_missing',
        'A fact candidate could not be observed or read back'
      );
    return mapMemoryFactCandidate(standing.rows[0]);
  }

  /**
   * "Do not remember this", said about a sentence that is not yet a memory.
   *
   * The refusal is durable and it is deliberately not a delete: `mem.fact_candidate` is keyed on
   * three blind hashes, so keeping the row keeps exactly enough to refuse the same sentence again
   * and nothing that can be read. A delete would clear the screen for one night and the proposer
   * would nominate it again on the next pass, which is the failure this whole column exists to
   * prevent - and the same failure `promoteMemoryFactCandidates` already refuses one tier up, where
   * a retracted fact is dropped rather than re-minted two sightings later.
   *
   * Per sentence, with the same limit the retraction path has: the keys fold case, NFKC and runs of
   * whitespace and nothing else, so a paraphrase is a different row and can be proposed again. That
   * is the whole of what a store which cannot read the body can promise.
   */
  async dismissMemoryFactCandidate(
    workspaceId: string,
    subjectKey: string,
    predicate: string,
    objectKey: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE mem.fact_candidate
       SET dismissed_at = NOW(), draft_ciphertext = NULL
       WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4
         AND dismissed_at IS NULL`,
      [workspaceId, subjectKey, predicate, objectKey]
    );
    // The carve-outs go with the draft and for the same reason. They are the owner's words about a
    // rule the owner has just refused, and the three keys are the whole of what a refusal needs to
    // be enforceable. Keeping them would leave clauses of a sentence nobody may store.
    if (result.rowCount === 1)
      await this.#dropQualifications(workspaceId, subjectKey, predicate, objectKey);
    return result.rowCount === 1;
  }

  /** Every carve-out on one rule, dropped together. Never called by promotion, which keeps them. */
  async #dropQualifications(
    workspaceId: string,
    subjectKey: string,
    predicate: string,
    objectKey: string
  ): Promise<void> {
    await this.database.query(
      `DELETE FROM mem.fact_qualification
       WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
      [workspaceId, subjectKey, predicate, objectKey]
    );
  }

  /**
   * What a model has nominated and the owner has not yet refused, newest and best-corroborated
   * first.
   *
   * `origin='proposed'` and not every candidate, and the reason is measured rather than tidy: over
   * this machine's own 646 owner-typed turns the shipped patterns produce 35 distinct candidates of
   * which one ever promotes. A queue where the row the owner has to judge is one in thirty-six is a
   * queue nobody reads. These are the rows a model wrote, they are bounded at three a night and
   * twenty outstanding, and they are the only ones the owner has never had a chance to refuse.
   */
  async listMemoryFactProposals(
    workspaceId: string,
    limit = 50
  ): Promise<MemoryFactCandidateRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM mem.fact_candidate
       WHERE workspace_id=$1 AND origin='proposed' AND dismissed_at IS NULL
       ORDER BY n_episodes DESC, last_seen DESC, subject_key, predicate, object_key
       LIMIT $2`,
      [workspaceId, Math.max(1, Math.trunc(limit))]
    );
    return result.rows.map(mapMemoryFactCandidate);
  }

  /** How many proposals are outstanding, which is what the standing bound is enforced against. */
  async countMemoryFactProposals(workspaceId: string): Promise<number> {
    const result = await this.database.query<{ open: string }>(
      `SELECT count(*) AS open FROM mem.fact_candidate
       WHERE workspace_id=$1 AND origin='proposed' AND dismissed_at IS NULL`,
      [workspaceId]
    );
    return Number(result.rows[0]?.open ?? 0);
  }

  /**
   * The once-a-day claim on the one model call memory makes, taken in the database rather than in a
   * worker's memory.
   *
   * `consolidateMemory` is scheduled from a `Map` held by the worker, and for consolidation that is
   * correct: the pass is idempotent maintenance and running it twice costs a few statements. The
   * proposer is not that. It is a request to a provider that the owner pays for, and a cadence that
   * lives in a process is reset by every restart - a worker crash-looping every twenty minutes
   * would make the nightly call every twenty minutes, and nothing anywhere would say so.
   *
   * One UPDATE, so the claim and the test are the same statement and two workers finishing turns in
   * the same second cannot both win it. It returns the PREVIOUS value from a self-join, because
   * `RETURNING` on an UPDATE yields the new row - and the previous value is the whole point: it is
   * the far end of the window the caller is about to read, so a run that happens thirty hours after
   * the last one reads thirty hours rather than twenty-four and nothing falls between two passes.
   *
   * A first claim returns `previous: null`, which is not a window and must not be treated as one.
   * There is no last run to read forward from, so the honest answer is to take the clock and read
   * nothing - a fresh installation pays for no call at all on its first finished turn.
   *
   * It lives on the memory store and writes a `workspaces` column, which is the same shape as
   * `consolidateMemory` reaching into `tasks` to drop the bundles of settled conversations: the
   * table is not the subject, the pass is.
   */
  async claimMemoryProposalRun(
    workspaceId: string,
    options: { now?: Date | string; minGapHours?: number } = {}
  ): Promise<{ claimed: boolean; previous: string | null }> {
    const result = await this.database.query<{ previous: unknown }>(
      `UPDATE workspaces w
       SET memory_proposed_at = COALESCE($2::timestamptz, NOW())
       FROM workspaces before
       WHERE w.id = $1 AND before.id = w.id
         AND (before.memory_proposed_at IS NULL
              OR before.memory_proposed_at
                 <= COALESCE($2::timestamptz, NOW()) - make_interval(hours => $3::int))
       RETURNING before.memory_proposed_at AS previous`,
      [workspaceId, options.now ?? null, Math.max(1, Math.trunc(options.minGapHours ?? 24))]
    );
    if (result.rows.length === 0) return { claimed: false, previous: null };
    const previous = result.rows[0]?.previous;
    return { claimed: true, previous: previous ? iso(previous) : null };
  }

  /**
   * Yesterday's turns, as the owner's own verbatim words, for a pass that runs once a day.
   *
   * Three filters and every one of them is load-bearing.
   *
   * `i.tainted = FALSE` and not `NOT i.tainted`: an episode written before migration 71 has NULL
   * here and nobody recorded whether that turn read somebody else's words, so it is refused. This
   * is the taint gate given a second life - it used to exist only inside the worker, on the turn
   * itself, and the verbatim text of a tainted turn went into `mem.source` anyway.
   *
   * `s.role = 'owner'` and not every source on the episode. The other role is the agent's own
   * summary of its work, and it is the laundering route: a turn that read a hostile page and
   * summarised it is a turn whose SUMMARY would carry the page's instructions into a pass that
   * proposes what this computer should believe. The episode's own body is not read here either,
   * for the same reason - it renders that summary into its `Result:` line.
   *
   * `s.chunk_ix` in the ordering, because the owner's turn is stored as up to eight chunks and
   * reading them out of order would hand a proposer a shuffled sentence.
   */
  async listMemoryProposalSources(
    workspaceId: string,
    input: { since: Date | string; limit?: number }
  ): Promise<MemoryProposalSourceRow[]> {
    const result = await this.database.query(
      `SELECT i.id AS episode_id, i.observed_at, i.task_id, s.id AS source_id,
              s.chunk_ix, s.body_ciphertext
       FROM mem.source s
       JOIN mem.item i ON i.id = s.episode_id AND i.workspace_id = s.workspace_id
       WHERE s.workspace_id = $1
         AND i.kind = 'episode'
         AND i.tainted = FALSE
         AND s.role = 'owner'
         AND i.observed_at >= $2::timestamptz
       ORDER BY i.observed_at, i.id, s.chunk_ix
       LIMIT $3`,
      [workspaceId, input.since, Math.max(1, Math.trunc(input.limit ?? 256))]
    );
    return result.rows.map((row) => ({
      episodeId: String(row.episode_id),
      occurredAt: iso(row.observed_at),
      taskId: optionalText(row.task_id),
      sourceId: String(row.source_id),
      chunkIndex: Number(row.chunk_ix),
      bodyCiphertext: json<EncryptedEnvelope>(row.body_ciphertext)
    }));
  }

  /**
   * What the corroboration gate admits, and why both halves of it are still here.
   *
   * Two sightings stops a single sentence - a paste, a quote, a fragment the observer mangled -
   * from becoming a rule the model obeys. The day stops two of them from being the same act. They
   * do different work and neither covers for the other, which is the finding that put this query
   * back the way it was after a pass that waived the day for a rule the owner had said in two
   * conversations of their own.
   *
   * The waiver was measured on this machine's transcripts and it worked: on 389 owner-typed turns
   * here it admitted exactly one row, `Remember, this will primarily be an app experience on
   * desktop and mobile...`, said four times in four conversations six minutes apart, and no
   * corrupt one. What the measurement could not see is that pasting the same document into two
   * conversations is not an attack anybody has to mount - it is what a person does when they open
   * a fresh thread on the same topic. Driven end to end, one bare paste of a vendor
   * `CONTRIBUTING.md` into two threads five minutes apart put five of somebody else's rules into
   * `mem.item`, active and pinned, inside four ordinary turns. `docs/design/memory/GATE.md` §3.2
   * had already priced that attack at exactly "the owner pastes one document twice", and two
   * conversations IS twice.
   *
   * So the day is not a proxy for anything and cannot be swapped for a better proxy. It is the one
   * requirement a paste cannot satisfy by being pasted again, and the cost of keeping it is one
   * rule the owner can state again tomorrow.
   */
  async listPromotableMemoryFactCandidates(
    workspaceId: string,
    options: { minEpisodes?: number; minGapHours?: number; limit?: number } = {}
  ): Promise<MemoryFactCandidateRecord[]> {
    const result = await this.database.query(
      // `dismissed_at IS NULL` is the third clause and it is not part of the corroboration gate:
      // the two above are what a sentence has to earn, this is the owner having already said no.
      // It sits here as well as at the write point because the two guard different moments - the
      // write refuses a dismissed sentence being re-observed, this refuses one that was dismissed
      // after it had already accumulated its sightings.
      `SELECT * FROM mem.fact_candidate
       WHERE workspace_id=$1 AND n_episodes >= $2
         AND last_seen - first_seen >= make_interval(hours => $3::int)
         AND dismissed_at IS NULL
       ORDER BY n_episodes DESC, last_seen DESC, subject_key, predicate, object_key
       LIMIT $4`,
      [
        workspaceId,
        options.minEpisodes ?? 2,
        Math.trunc(options.minGapHours ?? 24),
        options.limit ?? 50
      ]
    );
    return this.#withQualifications(workspaceId, result.rows.map(mapMemoryFactCandidate));
  }

  /**
   * Every carve-out on every rule in a batch, in one statement.
   *
   * One query and not one per candidate: this runs at the end of every finished turn, behind a
   * `LIMIT 50`, and fifty round trips to answer "does this rule have an exception" on a corpus
   * where almost none do is the shape of cost that gets noticed a year later. The object key is
   * unique enough to filter on and the triple is matched in memory, which is where the store can
   * afford to be exact.
   *
   * A candidate with no carve-out gets `[]` and not `undefined`: it has been asked, and the answer
   * is none. That distinction is what `MemoryFactCandidateRecord.qualifications` is optional for.
   */
  async #withQualifications(
    workspaceId: string,
    candidates: MemoryFactCandidateRecord[]
  ): Promise<MemoryFactCandidateRecord[]> {
    if (candidates.length === 0) return candidates;
    const result = await this.database.query(
      `SELECT subject_key, predicate, object_key, qualification_key, ciphertext, first_seen
       FROM mem.fact_qualification
       WHERE workspace_id=$1 AND object_key = ANY($2::text[])
       ORDER BY first_seen, qualification_key`,
      [workspaceId, candidates.map((candidate) => candidate.objectKey)]
    );
    const byRule = new Map<string, MemoryFactQualification[]>();
    for (const row of result.rows) {
      const rule = [String(row.subject_key), String(row.predicate), String(row.object_key)].join(
        '\0'
      );
      const held = byRule.get(rule) ?? [];
      held.push({
        key: String(row.qualification_key),
        ciphertext: json<EncryptedEnvelope>(row.ciphertext),
        firstSeen: iso(row.first_seen)
      });
      byRule.set(rule, held);
    }
    return candidates.map((candidate) => ({
      ...candidate,
      qualifications:
        byRule.get([candidate.subjectKey, candidate.predicate, candidate.objectKey].join('\0')) ??
        []
    }));
  }

  async deleteMemoryFactCandidate(
    workspaceId: string,
    subjectKey: string,
    predicate: string,
    objectKey: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM mem.fact_candidate
       WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
      [workspaceId, subjectKey, predicate, objectKey]
    );
    // Abandoning the nomination abandons its carve-outs. This is the path for a rule whose
    // predicate has left the registry and for one the owner retracted - in both the rule is not
    // going to be stored, and clauses of a sentence nothing will ever compose are dead rows.
    // Promotion does NOT come through here: it deletes the candidate with its own statement,
    // precisely so the accumulator outlives the nomination that filled it.
    await this.#dropQualifications(workspaceId, subjectKey, predicate, objectKey);
    return result.rowCount === 1;
  }

  /**
   * The other half of the observation gate: candidates that have now cleared it become facts and
   * stop being candidates. Only the key holder can seal a document or build a blind index, so it
   * supplies both through `prepare`; everything that has to happen together - supersession, the
   * `derived_from` links back to the episodes that vouched for the fact, and the removal of the
   * candidate row - happens in one transaction per candidate, so a crash cannot leave a promoted
   * fact whose candidate would be promoted again on the next pass.
   *
   * `prepare` returning null leaves the candidate exactly where it is. That is the right answer
   * when the caller cannot open the draft, and it is why nothing here is ever destructive on its
   * own: a candidate only disappears once it has become something.
   *
   * Two things this does NOT do, both of which it used to.
   *
   * It does not mint a second row for a sentence the workspace already holds. Promotion deletes
   * the candidate, and `standing_order` is `cardinality: 'many'`, so the supersession in
   * `#recordMemoryFact` never fires on one: an owner restating a rule they had already had
   * promoted re-accumulated a candidate and minted an identical, active, pinned row beside the
   * first. The pack caps facts at four per subject, so duplicates do not merely waste bytes - the
   * same rule takes two of the four slots every later turn in that workspace sees. The
   * corroboration now lands on the row that is already there, as evidence.
   *
   * And it does not bring back a row the owner retracted. Retraction is the owner saying "stop
   * believing this", and a promotion pass that re-mints it two sightings later is the machine
   * overruling them - the one failure this tier cannot be allowed, because a stored rule is
   * obeyed. The candidate is dropped rather than held, so the answer does not change on the next
   * turn either. `DELETE /memory-items/:id` removes the row and every trace of it, and is
   * therefore the route back for an owner who changes their mind: a rule they deleted can be
   * learned again, a rule they retracted stays refused.
   *
   * Refused per SENTENCE, and the difference matters enough to say here rather than let a reader
   * assume otherwise. The row is found by `(subject_key, predicate, object_key)`, and the object
   * key is a blind index over `normalizeMemoryTerm`, which folds case, NFKC and runs of
   * whitespace and nothing else. `...on a Friday afternoon!` and `...on a Friday afternoon..`
   * are different keys and are re-minted, as is any paraphrase. The store cannot read the body,
   * so this is the whole of what it can promise: the exact sentence the owner retracted does not
   * come back on its own.
   */
  async promoteMemoryFactCandidates(
    workspaceId: string,
    prepare: (
      candidate: MemoryFactCandidateRecord
    ) => Promise<PreparedMemoryFact | null> | PreparedMemoryFact | null,
    options: {
      minEpisodes?: number;
      minGapHours?: number;
      limit?: number;
    } = {}
  ): Promise<MemoryFactPromotion[]> {
    const candidates = await this.listPromotableMemoryFactCandidates(workspaceId, options);
    const promoted: MemoryFactPromotion[] = [];
    for (const candidate of candidates) {
      // A predicate that has left the vetted in-repo registry can never become a fact, so its
      // candidates are not held for a review that will never come.
      if (!memoryPredicate(candidate.predicate)) {
        await this.deleteMemoryFactCandidate(
          workspaceId,
          candidate.subjectKey,
          candidate.predicate,
          candidate.objectKey
        );
        continue;
      }
      const standing = await this.#storedMemoryFact(workspaceId, candidate);
      if (standing?.status === 'retracted') {
        await this.deleteMemoryFactCandidate(
          workspaceId,
          candidate.subjectKey,
          candidate.predicate,
          candidate.objectKey
        );
        continue;
      }
      /*
       * The live row says this rule already - but does it say the exception?
       *
       * Reattaching is right when it does, and it is the wrong answer when the rule promoted in
       * June and the owner stated its carve-out in August: the corroboration would land on a row
       * that still reads as the bare rule, and the exception would sit in an accumulator nothing
       * ever composes. That is the same defect this whole change exists to remove, one tier along
       * and after the fact.
       *
       * The test is a set containment over blind keys, which is the whole of what a store that
       * cannot read either sentence is able to do. The accumulator is insert-only and survives
       * promotion, so a row minted from it can only ever have been minted from a subset of what is
       * there now - which makes the direction of this comparison structural: the new row carries
       * every key the old one had and at least one more. **A rule's carve-outs never shrink.**
       */
      const carriesEveryQualification =
        !standing ||
        (candidate.qualifications ?? []).every((qualification) =>
          standing.qualificationKeys.includes(qualification.key)
        );
      if (standing && carriesEveryQualification) {
        const item = await this.database.transaction(async (transaction) => {
          await this.#linkPromotionEpisodes(transaction, workspaceId, standing.id, candidate);
          await transaction.query(
            `DELETE FROM mem.fact_candidate
             WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
            [workspaceId, candidate.subjectKey, candidate.predicate, candidate.objectKey]
          );
          const row = await transaction.query(`SELECT * FROM mem.item WHERE id=$1`, [standing.id]);
          return mapMemoryItem(row.rows[0]!);
        });
        promoted.push({ candidate, item, supersededIds: [], reattached: true });
        continue;
      }
      const prepared = await prepare(candidate);
      if (!prepared) continue;
      // The fact that gets minted has to be the one that was actually observed twice; the keyed
      // subject and object are the only handles the store has on that identity.
      if (
        prepared.index.subjectKey !== candidate.subjectKey ||
        prepared.index.objectKey !== candidate.objectKey
      )
        throw new GardenError(
          'memory_promotion_mismatch',
          'A promoted fact must carry the subject and object of the candidate it came from'
        );
      const result = await this.database.transaction(async (transaction) => {
        const recorded = await this.#recordMemoryFact(transaction, {
          userId: prepared.userId,
          workspaceId,
          trust: prepared.trust ?? 'derived',
          documentCiphertext: prepared.documentCiphertext,
          index: prepared.index,
          predicate: candidate.predicate,
          observedAt: prepared.observedAt ?? candidate.lastSeen,
          validFrom: prepared.validFrom ?? candidate.lastSeen,
          taskId: prepared.taskId ?? null,
          episodeId: candidate.episodeIds.at(-1) ?? null,
          pin: prepared.pin ?? false,
          qualificationKeys: prepared.qualificationKeys ?? null
        });
        await this.#linkPromotionEpisodes(transaction, workspaceId, recorded.item.id, candidate);
        /*
         * The thinner row retires in the same transaction that mints the fuller one.
         *
         * `standing_order` is `cardinality: 'many'`, so `#recordMemoryFact`'s own supersession
         * never fires on one and both rows would otherwise stay active - the same rule twice,
         * spending two of the four slots the pack gives a subject, one of them saying less than the
         * other. Superseded rather than deleted, like every other retirement in this table: the row
         * stays answerable and leaves recall.
         */
        if (standing) {
          await transaction.query(
            `UPDATE mem.item SET status='superseded', valid_to=COALESCE($2::timestamptz,NOW()),
                                 retired_at=NOW(), updated_at=NOW()
             WHERE id=$1 AND status='active'`,
            [standing.id, prepared.validFrom ?? candidate.lastSeen]
          );
          await transaction.query(
            `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'supersedes')
             ON CONFLICT DO NOTHING`,
            [recorded.item.id, standing.id]
          );
          recorded.supersededIds.push(standing.id);
        }
        await transaction.query(
          `DELETE FROM mem.fact_candidate
           WHERE workspace_id=$1 AND subject_key=$2 AND predicate=$3 AND object_key=$4`,
          [workspaceId, candidate.subjectKey, candidate.predicate, candidate.objectKey]
        );
        return recorded;
      });
      promoted.push({
        candidate,
        item: result.item,
        supersededIds: result.supersededIds,
        reattached: false
      });
    }
    return promoted;
  }

  /**
   * The live row this candidate would be a second copy of, if there is one.
   *
   * Keyed identity and not the sealed body: the store cannot read either, and the blind index is
   * what promotion already refuses a mismatch on. `archived` and `superseded` are deliberately not
   * here - an archived row is out of recall and a superseded one is a value that stopped being
   * true, and refusing to re-learn either would mean the owner could never move back to a city
   * they had left.
   */
  async #storedMemoryFact(
    workspaceId: string,
    candidate: MemoryFactCandidateRecord
  ): Promise<{ id: string; status: string; qualificationKeys: string[] } | null> {
    const result = await this.database.query<{
      id: string;
      status: string;
      qualification_keys: string[] | null;
    }>(
      // `COALESCE(...,'{}')` and not a null check at the caller: a row minted before this column
      // existed makes no claim about exceptions, and the only safe reading of no claim is that it
      // carries none - so a candidate with a carve-out mints the fuller row rather than reattaching
      // to a row that may or may not already say it.
      `SELECT id, status::text AS status, COALESCE(qualification_keys,'{}') AS qualification_keys
       FROM mem.item
       WHERE workspace_id=$1 AND kind='fact' AND subject_key=$2 AND predicate=$3 AND object_key=$4
         AND status IN ('active','retracted')
       ORDER BY (status = 'retracted') DESC, observed_at DESC, id
       LIMIT 1`,
      [workspaceId, candidate.subjectKey, candidate.predicate, candidate.objectKey]
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, status: row.status, qualificationKeys: row.qualification_keys ?? [] }
      : null;
  }

  /** The episodes that vouched for a fact, whether it was just minted or was already there. */
  async #linkPromotionEpisodes(
    transaction: Database,
    workspaceId: string,
    itemId: string,
    candidate: MemoryFactCandidateRecord
  ): Promise<void> {
    for (const episodeId of candidate.episodeIds)
      await transaction.query(
        `INSERT INTO mem.link(src_id,dst_id,rel)
         SELECT $1,$2,'derived_from' FROM mem.item WHERE id=$2 AND workspace_id=$3
         ON CONFLICT DO NOTHING`,
        [itemId, episodeId, workspaceId]
      );
  }

  /**
   * Two things the owner stated that genuinely conflict are never auto-resolved: both go to
   * `disputed`, neither is retrieved by default, and the pair surfaces in the review queue.
   */
  async markMemoryFactsDisputed(workspaceId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    // The status and the contradiction links are one statement of the same fact - these two
    // disagree, here is which two. Half of it is worse than none: items marked disputed with no
    // links leave the review queue unable to say what they conflict with, and links with no status
    // change leave both values live and retrievable while the graph says they contradict.
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE mem.item SET status='disputed', updated_at=NOW()
         WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND status='active' RETURNING id`,
        [workspaceId, [...ids]]
      );
      const changed = result.rows.map((row) => String(row.id));
      await this.invalidatePacks(transaction, changed);
      for (const [index, left] of changed.entries())
        for (const right of changed.slice(index + 1))
          await transaction.query(
            `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'contradicts')
             ON CONFLICT DO NOTHING`,
            [left, right]
          );
      return result.rowCount;
    });
  }

  /**
   * Candidate pairs for the contradiction pass: two active facts that state different values of one
   * predicate about one subject, at the same time.
   *
   * The reachable case is named in this file already, twelve hundred lines up.
   * `#backfillPredicateFunctional` explains that when a release narrows a predicate from `many` to
   * `one`, a subject that legitimately accumulated several current values *keeps them*, stays
   * outside `mem_fact_current_one`, and waits "until the contradiction is resolved the ordinary way
   * - by one of them being superseded". Nothing in the product had ever done that, so the wait was
   * permanent: two current answers to a question the registry says has one, both retrievable, both
   * ranked into the block at the top of the window, for as long as the workspace existed. That is
   * the state this reads, and the reason `functional` is asked of `mem.predicate` rather than of
   * `mem.item.pred_functional` - the flag is precisely what those rows do not have.
   *
   * Pairs already joined by a `contradicts`, `supersedes` or `supports` link are excluded: those
   * have been answered, and re-answering them every night is how a nightly pass becomes a standing
   * bill. `l.id < r.id` makes each pair appear once, in one orientation.
   */
  async listMemoryContradictionCandidates(
    workspaceId: string,
    options: { limit?: number; onlyFunctional?: boolean } = {}
  ): Promise<MemoryContradictionPair[]> {
    const result = await this.database.query<{
      left_id: string;
      right_id: string;
      predicate: string;
      functional: boolean;
    }>(
      `SELECT l.id AS left_id, r.id AS right_id, l.predicate AS predicate,
              (p.cardinality = 'one') AS functional
       FROM mem.item l
       JOIN mem.item r
         ON r.workspace_id = l.workspace_id
        AND r.subject_key = l.subject_key
        AND r.predicate = l.predicate
        AND r.kind = 'fact' AND r.status = 'active' AND r.valid_to IS NULL
        AND r.object_key IS DISTINCT FROM l.object_key
        AND l.id < r.id
       JOIN mem.predicate p ON p.name = l.predicate
       WHERE l.workspace_id = $1 AND l.kind = 'fact' AND l.status = 'active'
         AND l.valid_to IS NULL AND l.subject_key IS NOT NULL AND l.predicate IS NOT NULL
         AND (NOT $3::boolean OR p.cardinality = 'one')
         AND NOT EXISTS (
           SELECT 1 FROM mem.link k
           WHERE k.rel IN ('contradicts','supersedes','supports')
             AND ((k.src_id = l.id AND k.dst_id = r.id) OR (k.src_id = r.id AND k.dst_id = l.id))
         )
       ORDER BY l.observed_at DESC, l.id, r.id
       LIMIT $2::int`,
      [workspaceId, Math.trunc(options.limit ?? 20), options.onlyFunctional === true]
    );
    if (result.rows.length === 0) return [];
    const items = new Map(
      (
        await this.getMemoryItems(
          workspaceId,
          result.rows.flatMap((row) => [row.left_id, row.right_id])
        )
      ).map((item) => [item.id, item])
    );
    return result.rows.flatMap((row) => {
      const left = items.get(row.left_id);
      const right = items.get(row.right_id);
      if (!left || !right) return [];
      return [{ predicate: row.predicate, functional: row.functional === true, left, right }];
    });
  }

  /**
   * Retires one of two conflicting facts in favour of the other, with the link that says why.
   *
   * The same statement `#recordMemoryFact` makes when a functional predicate gets a new current
   * value, reached from the other direction: there the winner is arriving, here the winner is
   * already stored and something else has decided between them. One transaction, because a
   * superseded row with no `supersedes` link is a value that vanished for no recorded reason, and
   * the link without the status leaves both values live while the graph says one replaced the
   * other.
   */
  async supersedeMemoryItem(input: {
    workspaceId: string;
    winnerId: string;
    loserId: string;
    at?: Date | string;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const retired = await transaction.query(
        `UPDATE mem.item SET status='superseded', valid_to=COALESCE(valid_to,COALESCE($3,NOW())),
                             retired_at=NOW(), updated_at=NOW()
         WHERE workspace_id=$1 AND id=$2 AND status='active'`,
        [input.workspaceId, input.loserId, input.at ?? null]
      );
      if (retired.rowCount !== 1) return false;
      await this.invalidatePacks(transaction, [input.loserId]);
      await transaction.query(
        `INSERT INTO mem.link(src_id,dst_id,rel) VALUES ($1,$2,'supersedes')
         ON CONFLICT DO NOTHING`,
        [input.winnerId, input.loserId]
      );
      return true;
    });
  }

  /**
   * Retraction is a status change, and `neg_count` is not negative reinforcement.
   *
   * The counter is incremented in the same statement that sets `status='retracted'`, and no
   * admission predicate in `sql/memory.ts` admits `retracted` - so `neg_count > 0` has always
   * implied the row is unreachable, and every row recall could return had `neg_count = 0`
   * identically. The salience formula's `- 0.30 * (neg_count / use_count)` was therefore a weight
   * on a term that had never once been nonzero for a retrievable row, and the row that failed ten
   * of ten uses scored the HIGHEST salience in its workspace. Negative reinforcement now lives
   * where the evidence is - `mem.item_use.outcome='fail'`, written by `recordMemoryUse` below at
   * the production call site - and is weighted by `MEMORY_SALIENCE_FAIL_WEIGHT`.
   *
   * The column stays because the retraction record stays, and it is read by nothing: the `UPDATE`
   * refuses a row that is already retracted, so it is a boolean spelled as a counter and
   * `status='retracted'` says the same thing. It is not a place to add a signal to.
   */
  async retractMemoryItem(workspaceId: string, id: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE mem.item SET status='retracted', retired_at=NOW(), valid_to=COALESCE(valid_to,NOW()),
                             neg_count=neg_count+1, updated_at=NOW()
         WHERE workspace_id=$1 AND id=$2 AND status <> 'retracted'`,
        [workspaceId, id]
      );
      if (result.rowCount !== 1) return false;
      await this.invalidatePacks(transaction, [id]);
      return true;
    });
  }

  /** Records the outcome of injecting an item so salience and procedure health stay honest. */
  async recordMemoryUse(input: {
    workspaceId: string;
    itemIds: readonly string[];
    taskId?: string | null;
    cited?: boolean;
    outcome?: MemoryUseOutcome;
    usedAt?: Date | string;
  }): Promise<number> {
    if (input.itemIds.length === 0) return 0;
    const workspaceId = input.workspaceId;
    const itemIds = [...input.itemIds];
    const usedAt = input.usedAt ?? null;
    const cited = input.cited ?? false;
    const outcome = input.outcome ?? 'unknown';
    // One event written down twice, so it is written down once. Procedure health counts the
    // item_use rows and salience is recomputed from the counters on the item, and nothing ever
    // derives either from the other - so a crash between these two statements left the two views
    // of the same use disagreeing for as long as the item existed.
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO mem.item_use(id,item_id,workspace_id,task_id,used_at,cited,outcome)
         SELECT gen_random_uuid(), i.id, $1::uuid, $3::uuid, COALESCE($4::timestamptz,NOW()),
                $5::boolean, $6::text
         FROM mem.item i WHERE i.id = ANY($2::uuid[]) AND i.workspace_id=$1::uuid`,
        [workspaceId, itemIds, input.taskId ?? null, usedAt, cited, outcome]
      );
      const updated = await transaction.query(
        `UPDATE mem.item SET
           use_count=use_count+1,
           last_used_at=COALESCE($3::timestamptz,NOW()),
           cited_count=cited_count + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
           ok_count=ok_count + CASE WHEN $5::text='ok' THEN 1 ELSE 0 END,
           fail_count=fail_count + CASE WHEN $5::text='fail' THEN 1 ELSE 0 END,
           updated_at=NOW()
         WHERE id = ANY($2::uuid[]) AND workspace_id=$1::uuid`,
        [workspaceId, itemIds, usedAt, cited, outcome]
      );
      return updated.rowCount;
    });
  }

  async verifyMemoryProcedure(
    workspaceId: string,
    id: string,
    verifiedAt?: Date | string
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE mem.item SET last_verified=COALESCE($3,NOW()), updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND kind='procedure'`,
      [workspaceId, id, verifiedAt ?? null]
    );
    return result.rowCount === 1;
  }

  /**
   * The review queue. A procedure that stops being injected is never deleted for the owner: it is
   * listed here as "verify or delete", because silently dropping it destroys the audit trail.
   *
   * Two questions decide membership and they mean opposite things to whoever is reading: a
   * procedure nobody has confirmed in a season may be perfectly good and merely unused, while one
   * that failed three of its last five uses is broken now. The statement has always computed both
   * and returned neither, and the only caller kept the ids - so the queue three documents promise
   * could be listed but not explained. `reason` and the two recent counters are the rest of that
   * answer, and they cost nothing: the LATERAL already produces them.
   */
  async listStaleMemoryProcedures(
    workspaceId: string,
    options: { now?: Date | string; staleDays?: number; minSuccessRate?: number } = {}
  ): Promise<MemoryProcedureReviewRecord[]> {
    const result = await this.database.query(
      `SELECT i.*,
         COALESCE(health.ok_recent,0)::int AS ok_recent,
         COALESCE(health.graded_recent,0)::int AS graded_recent,
         (COALESCE(i.last_verified, i.observed_at)
            <= COALESCE($2::timestamptz, NOW()) - make_interval(days => $3::int)) AS unverified,
         (health.graded_recent > 0
          AND health.ok_recent / health.graded_recent < $4::float8) AS failing
       FROM mem.item i
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE r.outcome='ok')::float8 AS ok_recent,
                count(*) FILTER (WHERE r.outcome<>'unknown')::float8 AS graded_recent
         FROM (SELECT u.outcome FROM mem.item_use u WHERE u.item_id=i.id
               ORDER BY u.used_at DESC, u.id LIMIT 5) r
       ) health ON TRUE
       WHERE i.workspace_id=$1 AND i.kind='procedure' AND i.status='active'
         AND (COALESCE(i.last_verified, i.observed_at)
                <= COALESCE($2::timestamptz, NOW()) - make_interval(days => $3::int)
              OR (health.graded_recent > 0
                  AND health.ok_recent / health.graded_recent < $4::float8))
       ORDER BY i.observed_at, i.id`,
      [
        workspaceId,
        options.now ?? null,
        Math.trunc(options.staleDays ?? MEMORY_PROCEDURE_STALE_DAYS),
        options.minSuccessRate ?? MEMORY_PROCEDURE_MIN_SUCCESS_RATE
      ]
    );
    return result.rows.map((row) => {
      const unverified = row.unverified === true;
      const failing = row.failing === true;
      return {
        ...mapMemoryItem(row),
        reason: unverified && failing ? 'both' : failing ? 'failing' : 'unverified',
        recentOkCount: Number(row.ok_recent),
        recentGradedCount: Number(row.graded_recent)
      };
    });
  }

  /**
   * The other half of the queue: two things the owner said that contradict each other.
   *
   * `markMemoryFactsDisputed` writes the status and the `contradicts` links as one statement of one
   * fact, and the status alone cannot be shown to anybody - "this is disputed" with no answer to
   * "with what" is not a thing a person can act on. Both sides come back in one read rather than
   * through `listMemoryLinks` per row, because a review surface that issues a query per item is the
   * shape the sidebar spent a release paying for.
   *
   * Ordered oldest first, like the procedure queue, so the pair that has been unresolved longest is
   * the one at the top.
   */
  async listDisputedMemoryItems(
    workspaceId: string,
    limit = 200
  ): Promise<Array<MemoryItemRecord & { contradicts: string[] }>> {
    const result = await this.database.query(
      `SELECT i.*, COALESCE(against.ids, ARRAY[]::uuid[]) AS contradicts
       FROM mem.item i
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(DISTINCT other ORDER BY other) AS ids
         FROM (
           SELECT l.dst_id AS other FROM mem.link l
             WHERE l.src_id=i.id AND l.rel='contradicts'
           UNION
           SELECT l.src_id AS other FROM mem.link l
             WHERE l.dst_id=i.id AND l.rel='contradicts'
         ) sides
       ) against ON TRUE
       WHERE i.workspace_id=$1 AND i.status='disputed'
       ORDER BY i.observed_at, i.id
       LIMIT $2`,
      [workspaceId, Math.max(1, Math.min(Math.trunc(limit), 500))]
    );
    return result.rows.map((row) => ({
      ...mapMemoryItem(row),
      contradicts: ((row.contradicts as string[] | null) ?? []).map(String)
    }));
  }

  /**
   * The fused ranking query. Returns an already-budgeted set in deterministic (kind, id) order, so
   * two calls anchored at the same `now` produce byte-identical packs.
   */
  async recallMemoryCandidates(input: RecallMemoryInput): Promise<MemoryCandidateRecord[]> {
    // The tsquery is assembled inside SQL from this array. Tokens come from the blind index and
    // are alphabetic by construction; anything else could only be a caller bug, and could not
    // match a stored token anyway, so it is dropped rather than allowed to reach the parser.
    const result = await this.database.query(MEMORY_RECALL_SQL, [
      input.workspaceId,
      input.plan.lexemes.filter(isMemoryToken),
      [...input.plan.trigrams],
      [...input.plan.entityKeys],
      [...input.plan.tagTokens],
      input.now ?? new Date(),
      input.plan.temporalIntent,
      // Pinned false rather than removed. No writer on this computer produces an `inferred` row and
      // no caller can ask for one any more, so the clause this feeds is now a guard against a
      // legacy row rather than a switch - and leaving the parameter in place keeps the other
      // twenty-two positions where the query already expects them.
      false,
      input.includeSuperseded ?? false,
      Math.trunc(input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS),
      JSON.stringify(input.quotas ?? MEMORY_PACK_QUOTAS),
      input.asOf ?? null,
      input.kinds ? [...input.kinds] : null,
      input.scope ?? 'default',
      Math.trunc(input.maxItems ?? 60),
      Math.trunc(input.procedureStaleDays ?? MEMORY_PROCEDURE_STALE_DAYS),
      input.procedureMinSuccessRate ?? MEMORY_PROCEDURE_MIN_SUCCESS_RATE,
      input.fuzzyThreshold ?? MEMORY_FUZZY_SIMILARITY_THRESHOLD,
      input.order === 'relevance',
      MEMORY_PACK_DEFAULT_QUOTA.share,
      Math.trunc(MEMORY_PACK_DEFAULT_QUOTA.cap),
      Math.trunc(MEMORY_PACK_DEFAULT_QUOTA.perSubject),
      // Ids reach the store from a model-authored tool call by way of the pack, so anything that is
      // not a UUID is dropped here rather than reaching PostgreSQL as a cast error.
      [...new Set((input.excludeIds ?? []).filter((id) => UUID_PATTERN.test(id)))]
    ]);
    const own = result.rows.map(mapMemoryCandidate);
    const shared = await this.#sharedWorkspace(input.workspaceId);
    if (!shared) return own;
    const inherited = (await this.recallMemoryCandidates({ ...input, workspaceId: shared })).map(
      (candidate) => ({
        ...candidate,
        sharedForWorkspaceId: input.workspaceId,
        originWorkspaceId: shared
      })
    );
    let tokens = 0;
    return [...own, ...inherited]
      .filter((candidate) => {
        tokens += candidate.tokensEst;
        return tokens <= (input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS);
      })
      .slice(0, input.maxItems ?? 60);
  }

  /**
   * BM25 over the verbatim layer alone: past conversations, terminal output and tool results, in
   * the same keyed index the curated overlay uses. Bodies come back sealed; only the key holder
   * ever sees what matched.
   */
  async searchMemorySources(input: SearchMemorySourcesInput): Promise<MemorySourceHit[]> {
    const lexemes = input.plan.lexemes.filter(isMemoryToken);
    if (lexemes.length === 0) return [];
    const limit = Math.trunc(input.limit ?? 20);
    const result = await this.database.query(
      input.project
        ? projectMemorySourceSearchSql(input.reach ?? 'indexed')
        : input.reach === 'archived'
          ? MEMORY_SOURCE_ARCHIVE_SEARCH_SQL
          : MEMORY_SOURCE_SEARCH_SQL,
      [
        input.workspaceId,
        lexemes,
        input.taskId ?? null,
        input.since ?? null,
        input.until ?? null,
        limit,
        // Inside a single conversation there is no second thread to make room for, so the cap
        // would only throw away rows the caller asked for by name.
        Math.max(
          1,
          Math.trunc(input.perTask ?? (input.taskId ? limit : MEMORY_SOURCE_SEARCH_PER_TASK))
        ),
        ...(input.project ? [input.project.userId, input.project.projectId] : [])
      ]
    );
    const own = result.rows.map((row) => ({ ...mapMemorySource(row), score: Number(row.score) }));
    if (input.project)
      return own.map((source) =>
        source.workspaceId === input.workspaceId
          ? source
          : { ...source, sharedForWorkspaceId: input.workspaceId }
      );
    const shared = await this.#sharedWorkspace(input.workspaceId);
    if (!shared) return own;
    const inherited = (await this.searchMemorySources({ ...input, workspaceId: shared })).map(
      (source) => ({ ...source, sharedForWorkspaceId: input.workspaceId })
    );
    return [...own, ...inherited].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * How far back the verbatim layer actually reaches, in each of the two tiers separately.
   *
   * A search that returns nothing has two completely different meanings - the owner never discussed
   * it, or it happened before this workspace started recording - and an agent that cannot tell them
   * apart will state the first one as fact. Capture began when the memory schema did, so on a
   * computer that has been in use longer than that there is a real horizon, and it is a number
   * rather than a guess.
   *
   * `archived` is the second half of that same argument and it exists because the horizon is no
   * longer where the record stops. Past the archive age a row leaves the fast index and keeps its
   * tokens, so "nothing in the indexed tier" and "nothing recorded" are now a THIRD pair of
   * meanings an agent could confuse - and the honest answer to a search that found nothing is not
   * only how far back the record goes but how much of it the first pass could not see. Counted in
   * one statement over one scan rather than two queries, because it is asked on the path where the
   * agent is about to tell the owner something about their own history from an absence.
   */
  async memorySourceCoverage(
    workspaceId: string,
    project?: ProjectMemoryScope
  ): Promise<{
    turns: number;
    conversations: number;
    earliest: string | null;
    /** Rows past the archive horizon: out of the fast index, still searchable one step further. */
    archived: { turns: number; earliest: string | null };
  }> {
    const result = await this.database.query<{
      turns: string;
      conversations: string;
      earliest: unknown;
      archived_turns: string;
      archived_earliest: unknown;
    }>(
      `SELECT count(*) AS turns, count(DISTINCT task_id) AS conversations,
              min(occurred_at) AS earliest,
              count(*) FILTER (WHERE NOT indexed AND body_tokens <> '') AS archived_turns,
              min(occurred_at) FILTER (WHERE NOT indexed AND body_tokens <> '')
                AS archived_earliest
       FROM mem.source WHERE ${project ? 'user_id=$2 AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=mem.source.task_id AND t.user_id=$2 AND t.project_id=$3) AND $1::uuid IS NOT NULL' : 'workspace_id IN ($1,(SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$1))'}`,
      [workspaceId, ...(project ? [project.userId, project.projectId] : [])]
    );
    const row = result.rows[0];
    return {
      turns: Number(row?.turns ?? 0),
      conversations: Number(row?.conversations ?? 0),
      earliest: row?.earliest ? iso(row.earliest) : null,
      archived: {
        turns: Number(row?.archived_turns ?? 0),
        earliest: row?.archived_earliest ? iso(row.archived_earliest) : null
      }
    };
  }

  /**
   * The verbatim rows around one hit, in the order they happened. `before` and `after` are counts
   * of rows, not bytes: a caller that wants more context asks for more rows.
   */
  async listMemorySourceWindow(
    workspaceId: string,
    sourceId: string,
    window: { before?: number; after?: number; project?: ProjectMemoryScope } = {}
  ): Promise<MemorySourceRecord[]> {
    if (window.project) {
      const origin = await this.database.query(
        `SELECT s.workspace_id FROM mem.source s JOIN tasks t ON t.id=s.task_id
        WHERE s.id=$1 AND s.user_id=$2 AND t.user_id=$2 AND t.project_id=$3`,
        [sourceId, window.project.userId, window.project.projectId]
      );
      if (!origin.rows.length) return [];
      const scope = String(origin.rows[0]!.workspace_id);
      const result = await this.database.query(MEMORY_SOURCE_WINDOW_SQL, [
        scope,
        sourceId,
        Math.max(0, Math.trunc(window.before ?? 2)),
        Math.max(0, Math.trunc(window.after ?? 2))
      ]);
      return result.rows.map((row) => ({
        ...mapMemorySource(row),
        sharedForWorkspaceId: workspaceId
      }));
    }
    const result = await this.database.query(MEMORY_SOURCE_WINDOW_SQL, [
      workspaceId,
      sourceId,
      Math.max(0, Math.trunc(window.before ?? 2)),
      Math.max(0, Math.trunc(window.after ?? 2))
    ]);
    if (result.rows.length) return result.rows.map(mapMemorySource);
    const shared = await this.#sharedWorkspace(workspaceId);
    return shared
      ? (await this.listMemorySourceWindow(shared, sourceId, window)).map((source) => ({
          ...source,
          sharedForWorkspaceId: workspaceId
        }))
      : [];
  }

  /**
   * Dereferences the ids a memory pack printed. Ids reach the agent as opaque text, so anything
   * that is not a UUID is discarded here rather than reaching PostgreSQL as a cast error - a model
   * quoting an id back imprecisely must get an empty result, never a failed turn.
   */
  async getMemoryItems(workspaceId: string, ids: readonly string[]): Promise<MemoryItemRecord[]> {
    const wanted = [...new Set(ids.filter((id) => UUID_PATTERN.test(id)))];
    if (wanted.length === 0) return [];
    const result = await this.database.query(
      `SELECT * FROM mem.item WHERE workspace_id IN ($1,(SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$1)) AND id = ANY($2::uuid[]) ORDER BY kind, id`,
      [workspaceId, wanted]
    );
    return result.rows.map(mapMemoryItem);
  }

  async getMemoryPack(taskId: string, validAt?: Date | string): Promise<MemoryPackRecord | null> {
    await this.database.query(
      `DELETE FROM mem.pack p WHERE p.task_id=$1 AND EXISTS (
         SELECT 1 FROM mem.item i WHERE i.id=ANY(p.item_ids)
         AND (i.status <> 'active' OR ($2::timestamptz IS NOT NULL AND
           (i.valid_from>$2 OR i.valid_to<=$2))))`,
      [taskId, validAt ?? null]
    );
    const result = await this.database.query('SELECT * FROM mem.pack WHERE task_id=$1', [taskId]);
    return result.rows[0] ? mapMemoryPack(result.rows[0]) : null;
  }

  /**
   * First writer wins. A worker that restarts mid-task re-reads the bytes it already emitted
   * instead of re-ranking against a newer clock, which is what keeps the cached prefix alive.
   */
  async saveMemoryPack(input: {
    taskId: string;
    workspaceId: string;
    bodyCiphertext: EncryptedEnvelope;
    sha256: string;
    itemIds: readonly string[];
    tokensEst: number;
    briefVersion?: string | null;
  }): Promise<MemoryPackRecord> {
    return this.database.transaction(async (transaction) => {
      // Lock evidence until the pack is stored so a concurrent correction invalidates the
      // finished pack rather than racing between ranking and insertion.
      const ids = [...new Set(input.itemIds)];
      const items = await transaction.query(
        `SELECT id,status FROM mem.item WHERE id=ANY($1::uuid[])
         AND workspace_id IN ($2,(SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$2))
         ORDER BY id FOR SHARE`,
        [ids, input.workspaceId]
      );
      const sources = await transaction.query(
        `SELECT id FROM mem.source WHERE id=ANY($1::uuid[])
         AND workspace_id IN ($2,(SELECT p.id FROM workspaces w JOIN workspaces p ON p.id=w.parent_workspace_id AND p.user_id=w.user_id WHERE w.id=$2))
         ORDER BY id FOR SHARE`,
        [ids, input.workspaceId]
      );
      if (
        items.rows.some((row) => row.status !== 'active') ||
        items.rows.length + sources.rows.length !== ids.length
      )
        throw new GardenError(
          'memory_evidence_changed',
          'Memory changed during recall; retry retrieval'
        );
      const inserted = await transaction.query(
        `INSERT INTO mem.pack(
           task_id,workspace_id,brief_version,body_ciphertext,sha256,item_ids,tokens_est
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7)
         ON CONFLICT (task_id) DO UPDATE SET
           brief_version=EXCLUDED.brief_version,body_ciphertext=EXCLUDED.body_ciphertext,
           sha256=EXCLUDED.sha256,item_ids=EXCLUDED.item_ids,tokens_est=EXCLUDED.tokens_est,
           created_at=NOW()
         WHERE mem.pack.brief_version IS DISTINCT FROM EXCLUDED.brief_version
         RETURNING *`,
        [
          input.taskId,
          input.workspaceId,
          input.briefVersion ?? null,
          JSON.stringify(input.bodyCiphertext),
          input.sha256,
          ids,
          input.tokensEst
        ]
      );
      if (inserted.rows[0]) return mapMemoryPack(inserted.rows[0]);
      const existing = await transaction.query('SELECT * FROM mem.pack WHERE task_id=$1', [
        input.taskId
      ]);
      if (!existing.rows[0])
        throw new GardenError('memory_pack_missing', 'Memory pack could not be stored');
      return mapMemoryPack(existing.rows[0]);
    });
  }

  /*
   * There is no `deleteMemoryPack(taskId)`. There was, and it had no caller anywhere - not
   * production, not a test, not an eval - while being the simplest signature of the three ways a
   * bundle can be removed, which is the one somebody reaches for.
   *
   * The two that run are the two that are safe, and both are scoped to a workspace rather than to a
   * task: `consolidateMemory` drops the bundles of settled conversations, and `forgetMemoryItem`
   * drops every bundle that quoted a row the owner just deleted. Deleting a live task's bundle on
   * its own has no meaning that is not a bug - the task rebuilds it on its next turn and pays a
   * cache miss for nothing - so the way to remove one is to remove what it was built from.
   */

  /**
   * The nightly pass. Salience is recomputed from raw counters rather than stored decayed, old
   * material is demoted rather than deleted, and every table that could grow without bound is
   * trimmed. Nothing here calls a model: the expensive residue is the caller's business.
   */
  async consolidateMemory(
    workspaceId: string,
    options: {
      now?: Date | string;
      archiveAfterDays?: number;
      useRetentionDays?: number;
      candidateRetentionDays?: number;
      statsRebuildDays?: number;
    } = {}
  ): Promise<MemoryConsolidationReport> {
    const now = options.now ?? null;
    const archiveAfterDays = Math.trunc(options.archiveAfterDays ?? 730);
    const useRetentionDays = Math.trunc(options.useRetentionDays ?? 180);
    const candidateRetentionDays = Math.trunc(options.candidateRetentionDays ?? 180);
    const statsRebuildDays = Math.trunc(options.statsRebuildDays ?? 30);

    /*
     * Salience: three power-law activations over the row's own use history, z-scored.
     *
     * `B = ln(1 + SUM_j max(age_days, floor)^-d)` per signal, exactly the ACT-R base-level
     * activation `MEMORY_USE_DECAY_EXPONENT` documents, plus the closed-form contribution of
     * whatever the retention fold has already taken out of `mem.item_use` (below). `s_use` and
     * `s_fail` are the two graded outcomes and `s_cite` is the subset the model reached for - so
     * all three are the same construction on the same clock, which is what makes their weights
     * comparable to each other.
     *
     * AN UNGRADED USE IS NOT A SUCCESS, AND `s_use` USED TO SAY IT WAS. The filter here read
     * `outcome <> 'fail'`, which is every outcome the harness did not watch fail - and that
     * includes `unknown`, which is the outcome nobody watched at all. Both of this score's
     * production writers emit it: `recallMemory` writes `unknown` for every row it merely
     * RETURNED, and `recordMemoryPackOutcome` writes `unknown` for every packed entry the
     * finished turn never touched, its comment saying in as many words that such an entry must be
     * left "ungraded, both directions". It was not: under `<> 'fail'` a history of ten ungraded
     * uses and a history of ten graded ones are the same activation to the last bit, so no ranking
     * downstream of this could tell a use the model cited from a row the ranker had handed itself.
     * @see the `an ungraded use` cases in `memory-decay.test.ts`, which compute both filters over
     * the same rows.
     *
     * So the ranking was reading its own output as evidence. A row the ranker returned got a use
     * worth exactly as much as one the model cited, which made it likelier to be returned, which
     * bought it another. `MEMORY_USE_DECAY_EXPONENT` records what that cost when it was first
     * noticed: two rows alike in everything, the one an `ORDER BY score DESC, id` tie-break
     * happened to put first held 70 uses against 10 sixty turns later, on nothing but a UUID. That
     * is a rich-get-richer sort on a coin flip, and it is why the owner's "usage-weighted
     * retrieval WITH positive and negative reinforcement" could not be built on the old filter:
     * the loop drowns the reinforcement.
     *
     * ZERO, NOT A DISCOUNT, and the reason is that a discount does not work. A uniform weight `w`
     * on ungraded uses scales the activation the loop manufactures by `w`, and salience is a
     * z-score against the workspace's own moments - so for two rows whose only difference IS that
     * activation, `w` largely divides back out and the pair still separates, for every `w > 0`,
     * just further down the decimals. Only `w = 0` breaks the path, because only `w = 0` makes the
     * ranker's own selection carry no evidence at all. Measured the other way round, on the loop
     * itself: thirty rounds, thirty ungraded uses against nought, and the pair ends where the text
     * put it - while the same thirty rounds graded `ok`, which is exactly what the old filter
     * scored them as, leave the leader a whole salience ahead.
     *
     * `mem.item_use` still gets the row; `use_count`, `last_used_at`, procedure health and the
     * audit trail are all unaffected. What changes is that being chosen is no longer a reason to
     * be chosen again.
     *
     * IT IS ALSO WHAT THE OTHER READER OF THIS COLUMN ALREADY DID. `listStaleMemoryProcedures`
     * counts `graded_recent` as `outcome <> 'unknown'` and has since it was written, so the
     * procedure-health tier and the salience tier disagreed about what `unknown` meant, and the
     * health tier was right.
     *
     * WHAT IT COSTS, TRACED THROUGH THE WRITER RATHER THAN ARGUED. `s_use` is now the uses graded
     * `ok`, and the only production writer of `ok` is the attributable path of
     * `recordMemoryPackOutcome`, which grades an entry only if it was cited. Run against a real
     * store, that writer produces exactly two shapes of row: `cited=true, outcome='ok'` for what
     * the turn used, and `cited=false, outcome='unknown'` for the rest. So on that path
     * `FILTER (WHERE u.outcome = 'ok')` and `FILTER (WHERE u.cited)` select THE SAME ROWS, `s_use`
     * and `s_cite` are one number, and the two positive terms of this formula are one signal
     * carried at 0.5 + 0.2 rather than two signals compared.
     *
     * The one thing left that separates them is the unattributable path - a pack whose data key
     * will not open, or a turn with nothing to attribute against - which grades the whole pack
     * with no citation at all. `fail` does NOT separate them, because nothing writes it: the only
     * caller of `recordMemoryPackOutcome` in the product, `apps/worker/src/memory-capture.ts`,
     * passes the literal `outcome: 'ok'` and only when the turn was not interrupted, so no turn on
     * this box has ever written `outcome='fail'` and `s_fail` is empty in production. That was
     * already true before this change and it is not this statement's to repair, but it is what
     * makes the overlap above total rather than partial.
     *
     * `MEMORY_SALIENCE_USE_WEIGHT` and `MEMORY_SALIENCE_CITE_WEIGHT` were chosen against a
     * measured r = 0.9344 between two signals that were then distinct. On the ordinary path they
     * now weigh one signal twice, and whoever next reads their ratio needs that first. The
     * decision - collapse the two weights, or wire the grade in `memory-capture.ts` so a turn that
     * failed marks down what it cited - belongs with `packages/core/src/memory.ts`, where both
     * constants live and where neither this file nor this lane can reach.
     *
     * THE `+ 1` IS NOT A FUDGE. `SUM` is zero for a row that has never been used and `ln 0` has no
     * value to rank, so one pseudo-use is added at the unit of the clock - one day, where
     * `t^-d = 1` for any `d`. A never-used row therefore scores exactly 0 and every row with any
     * history at all scores strictly above it: one use ten years ago is worth `ln(1.0166)`, which
     * is small and is not zero. That is "further away, never gone" as an identity rather than as a
     * floor constant, and it is what the previous `INTERVAL '90 days'` could not express.
     *
     * The z-score against the workspace's own moments is unchanged and is what stops a busy
     * project inflating everything: a round that uses every row raises the mean by as much as it
     * raises each row. It is also most of the answer to whether the clock should run on calendar
     * days or on the owner's working days. Rescaling every age by a constant `c` multiplies every
     * SUM by the same `c^-d`, which is an additive `-d ln c` on every `ln SUM` and which a z-score
     * removes exactly; only the NON-uniform part of a working-day clock could change a ranking,
     * and that part is measured on one owner whose duty cycle is 0.362 over 138 days. Calendar
     * days, therefore, and no second table to maintain.
     *
     * "Did this match the last query" is still deliberately not an input: it is the signal that
     * over-weights recency, and recency already has its own factor in `mem.prior`.
     */
    const salience = await this.database.query(
      `WITH clock AS (SELECT COALESCE($2::timestamptz,NOW()) AS t_now),
       live AS (
         SELECT i.id, i.pin,
                COALESCE(SUM(power(GREATEST(
                  EXTRACT(EPOCH FROM c.t_now - u.used_at)::float8/86400.0, $3::float8), -$4::float8))
                  FILTER (WHERE u.outcome = 'ok'), 0) AS s_use,
                COALESCE(SUM(power(GREATEST(
                  EXTRACT(EPOCH FROM c.t_now - u.used_at)::float8/86400.0, $3::float8), -$4::float8))
                  FILTER (WHERE u.cited), 0) AS s_cite,
                COALESCE(SUM(power(GREATEST(
                  EXTRACT(EPOCH FROM c.t_now - u.used_at)::float8/86400.0, $3::float8), -$4::float8))
                  FILTER (WHERE u.outcome='fail'), 0) AS s_fail
         FROM mem.item i
         CROSS JOIN clock c
         LEFT JOIN mem.item_use u ON u.item_id=i.id
         WHERE i.workspace_id=$1
         GROUP BY i.id, i.pin
       ),
       usage AS (
         SELECT l.id, l.pin,
                -- f.oks, not f.uses - f.fails: the fold's ungraded tail is excluded here for the
                -- same reason the live half excludes it, and migration 78 is what gave the fold a
                -- column able to say which of its uses were graded.
                ln(1 + l.s_use  + COALESCE(f.oks * f.unit, 0)) AS b_use,
                ln(1 + l.s_cite + COALESCE(f.cites * f.unit, 0)) AS b_cite,
                ln(1 + l.s_fail + COALESCE(f.fails * f.unit, 0)) AS b_fail
         FROM live l
         CROSS JOIN clock c
         LEFT JOIN LATERAL (
           -- The folded tail, evaluated from its span. One use somewhere in [a,b] is worth the
           -- mean of t^-d over that span; n uses are worth n times it. Exact for a block whose
           -- uses are uniform in their own window, and exact in the limit b -> a, which is the
           -- branch below. Both ages are floored, so a clock behind the fold cannot diverge.
           SELECT g.oks, g.cites, g.fails,
                  CASE WHEN g.last_at > g.first_at THEN
                    (power(GREATEST(EXTRACT(EPOCH FROM c.t_now - g.first_at)::float8/86400.0,
                                    $3::float8), 1 - $4::float8)
                     - power(GREATEST(EXTRACT(EPOCH FROM c.t_now - g.last_at)::float8/86400.0,
                                      $3::float8), 1 - $4::float8))
                    / ((1 - $4::float8)
                       * EXTRACT(EPOCH FROM g.last_at - g.first_at)::float8/86400.0)
                  ELSE
                    power(GREATEST(EXTRACT(EPOCH FROM c.t_now - g.last_at)::float8/86400.0,
                                   $3::float8), -$4::float8)
                  END AS unit
           FROM mem.item_use_fold g WHERE g.item_id = l.id
         ) f ON TRUE
       ),
       moments AS (
         SELECT AVG(b_use) AS mu, COALESCE(STDDEV_POP(b_use),0) AS su,
                AVG(b_cite) AS mc, COALESCE(STDDEV_POP(b_cite),0) AS sc,
                AVG(b_fail) AS mf, COALESCE(STDDEV_POP(b_fail),0) AS sf
         FROM usage
       )
       UPDATE mem.item SET salience =
           $5::float8 * COALESCE((g.b_use  - m.mu) / NULLIF(m.su,0), 0)
         + $6::float8 * COALESCE((g.b_cite - m.mc) / NULLIF(m.sc,0), 0)
         - $7::float8 * COALESCE((g.b_fail - m.mf) / NULLIF(m.sf,0), 0)
         + CASE WHEN g.pin THEN 1.0 ELSE 0.0 END,
         updated_at=NOW()
       FROM usage g, moments m
       WHERE mem.item.id = g.id`,
      [
        workspaceId,
        now,
        MEMORY_USE_AGE_FLOOR_DAYS,
        MEMORY_USE_DECAY_EXPONENT,
        MEMORY_SALIENCE_USE_WEIGHT,
        MEMORY_SALIENCE_CITE_WEIGHT,
        MEMORY_SALIENCE_FAIL_WEIGHT
      ]
    );
    // An episode lends part of its salience to what was extracted from it, so a fact from a
    // heavily used episode outranks an equally unused fact from a forgotten one.
    await this.database.query(
      `UPDATE mem.item SET salience = mem.item.salience + 0.20 * GREATEST(e.salience, 0)
       FROM mem.item e
       WHERE mem.item.workspace_id=$1 AND mem.item.episode_id = e.id AND e.kind='episode'`,
      [workspaceId]
    );

    // Compaction never deletes anything: items are demoted to 'archived' and sources merely leave
    // the lexical index, keeping every byte they were written with. An item that is pinned, or that
    // something still links to, is exempt; the source tier's own exemption is gone and the
    // paragraph on the statement below says why.
    const archived = await this.database.query(
      `UPDATE mem.item SET status='archived', updated_at=NOW()
       WHERE workspace_id=$1 AND status='active' AND NOT pin
         AND observed_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         AND NOT EXISTS (SELECT 1 FROM mem.link l WHERE l.dst_id=mem.item.id)`,
      [workspaceId, now, archiveAfterDays]
    );
    /*
     * THE ARCHIVE HORIZON, AND THE ONE COLUMN IT MUST NOT TOUCH.
     *
     * This statement read `SET indexed=FALSE, body_tokens=''`, and the comment above it said
     * compaction never deletes verbatim text. Both halves of that were true and together they
     * were still the one place the owner's rule - no memory is ever totally gone, only further
     * away or more steps to get to - was broken. `body_ciphertext` did survive, so the words were
     * on the disk; `body_tokens` did not, and it is the ONLY searchable representation this
     * database has of them. The tokens are keyed HMACs of the lexemes, computed in the worker
     * against a key the server does not hold, so a server-side reindex is not merely unimplemented
     * here - it is impossible from anything the erasing statement left behind. Nothing in the tree
     * rebuilds them from the ciphertext either. A conversation straddling the horizon stayed
     * reachable in two steps through a surviving neighbour; one entirely older than two years had
     * no route in from any query at all.
     *
     * So the pass now flips one boolean and erases nothing. What that costs and what it buys are
     * both exact:
     *
     *   - The row still leaves the fast index. `mem_source_tsv_gin` is partial - `WHERE indexed` -
     *     so `indexed=FALSE` removes it from the GIN structure, which is the expensive half and
     *     the half this pass exists for.
     *   - What stays is everything else the row was written with: the sealed body, the keyed
     *     `body_tokens`, and - since migration 76 - the `tsv` those tokens make, which costs no
     *     index bytes at all while the flag is false. `MEMORY_SOURCE_ARCHIVE_SEARCH_SQL` then
     *     matches it with the same `@@` off a scan. That is the extra step: the ordinary search
     *     never sees these rows, and a search that finds nothing reaches them by scanning rather
     *     than by probing. @see searchMemorySessions, which takes that second step for the agent
     *     so a two-year-old conversation is answered rather than merely reachable in principle.
     *
     * IT DOES NOT RESURRECT A ROW THAT WAS NEVER INDEXED. `createMemorySource` still writes `''`
     * for `body_tokens` when the caller says `indexed: false`, and that is a different decision
     * about a different row - a body with nothing to index, or one the taint gate refuses to make
     * searchable. This statement only ever moves rows that WERE indexed, so it can never put
     * tokens on a row the write path decided must not have them.
     *
     * Irreversible deletion is still available and is still the owner's: `forgetMemoryItem` and
     * the task-deletion cascade both remove rows outright. What is gone is a timer that did it.
     *
     * ── AND THE CITATION EXEMPTION GOES WITH THE ERASURE, BECAUSE IT WAS THE ERASURE'S GUARD ────
     *
     * This statement also carried `AND NOT EXISTS (SELECT 1 FROM mem.evidence e WHERE
     * e.source_id=mem.source.id)`, described as "anything cited by a live item is exempt". Measured
     * against the only production writer of `mem.source`, that clause did not narrow the pass - it
     * switched it off. `recordTurnEpisode` writes every chunk of the owner's request and the
     * agent's summary and then calls `attachMemoryEvidence(episodeId, ...)` over EVERY id it just
     * wrote, in the same function, unconditionally. So every row this pass could ever see was
     * cited, `sourcesUnindexed` was structurally zero on this box, and the verbatim index was
     * bounded by nothing at all. The erasure above was therefore a landmine rather than a live
     * loss - and the tier below it was a route no production row could reach.
     *
     * The exemption existed for one reason and it was the erasure. A cited row whose tokens were
     * destroyed would leave a curated fact pointing at provenance that could never be found again,
     * which is exactly what it was written to prevent. With the tokens kept there is nothing left
     * to protect: `listMemoryEvidence` reads `body_ciphertext` and `memoryReach` dereferences by
     * id, and neither has ever looked at `indexed`. An archived row's citation dereferences to the
     * same bytes it always did.
     *
     * What the clause's removal actually changes is the one thing the horizon is FOR: the fast
     * index now holds a two-year window rather than everything ever said. That is a tiering, not a
     * deletion - hot rows in the partial GIN index, cold rows one scan away with their tokens
     * intact - and it is the first version of this pass that both bounds the index and keeps every
     * word reachable. Measured on the owner's real corpus - 1,006 turns, 2,394 rows, 138 days -
     * keeping everything rather than erasing it costs 10.20 MiB, which is 27 MiB a year at that
     * rate and 0.034% of this box's free disk over ten; tiering hands back the 3.47 MiB of GIN
     * index those rows were holding. @see docs/design/prime/CLOSE.md.
     *
     * One approximation it introduces, stated rather than discovered: `rebuildMemoryCorpusStats`
     * counts only indexed rows, so a cold-tier search scores with the hot corpus's document
     * frequencies and average length. It affects ranking WITHIN the cold tier only - the tier is
     * reached only when the hot one answered nothing - and a shared normalisation constant moves
     * every cold row together. A term that survives only in cold rows gets no `mem.lexeme_df` entry
     * and therefore maximum IDF, which is the right way round for a rare term.
     */
    const unindexed = await this.database.query(
      `UPDATE mem.source SET indexed=FALSE
       WHERE workspace_id=$1 AND indexed
         AND occurred_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, archiveAfterDays]
    );

    /*
     * The use history past the retention horizon is FOLDED, not forgotten.
     *
     * This statement used to be `DELETE FROM mem.item_use ... WHERE used_at < horizon`, and while
     * the score above it was a count inside a 90-day window that cost nothing: the rows it dropped
     * had already scored zero for ninety days. A sum over every prior use cannot be taken against
     * a table that forgets, so deleting the window and leaving this alone would have moved the
     * cliff from day 90 to day 180 rather than removing it.
     *
     * What leaves the table arrives in `mem.item_use_fold` as a count and a span, from which the
     * block's activation is recovered in closed form by the LATERAL above. The bound the delete
     * existed for is kept - one row per item, however long the history - and it is now a bound on
     * storage rather than on memory.
     *
     * ONE STATEMENT, not two in a transaction. Both halves read the same snapshot, so the INSERT
     * sees exactly the rows the DELETE removes; a crash between an INSERT and a DELETE would have
     * double-counted a block forever, and between a DELETE and an INSERT would have lost it. A
     * data-modifying CTE is executed to completion whether or not the primary query reads it.
     *
     * `LEAST`/`GREATEST` on the span rather than assignment: a later night folds a newer block
     * onto an older one, and the union's span is the union of the spans.
     */
    const uses = await this.database.query(
      `WITH stale AS (
         SELECT u.item_id,
                count(*)::int AS uses,
                count(*) FILTER (WHERE u.outcome='ok')::int AS oks,
                count(*) FILTER (WHERE u.cited)::int AS cites,
                count(*) FILTER (WHERE u.outcome='fail')::int AS fails,
                min(u.used_at) AS first_at, max(u.used_at) AS last_at
         FROM mem.item_use u
         WHERE u.workspace_id=$1
           AND u.used_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         GROUP BY u.item_id
       ),
       folded AS (
         INSERT INTO mem.item_use_fold(item_id,uses,oks,cites,fails,first_at,last_at)
         SELECT item_id,uses,oks,cites,fails,first_at,last_at FROM stale
         ON CONFLICT (item_id) DO UPDATE SET
           uses  = mem.item_use_fold.uses  + EXCLUDED.uses,
           oks   = mem.item_use_fold.oks   + EXCLUDED.oks,
           cites = mem.item_use_fold.cites + EXCLUDED.cites,
           fails = mem.item_use_fold.fails + EXCLUDED.fails,
           first_at = LEAST(mem.item_use_fold.first_at, EXCLUDED.first_at),
           last_at  = GREATEST(mem.item_use_fold.last_at, EXCLUDED.last_at)
         RETURNING item_id
       )
       DELETE FROM mem.item_use
       WHERE workspace_id=$1
         AND used_at < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, useRetentionDays]
    );
    // A dismissed candidate is exempt, and permanently. Ageing one out would delete the only
    // record of the owner's refusal, and the sentence would be proposed again on the first night
    // after the horizon - which is the same defect as re-minting a retracted fact, on the tier
    // below it. What survives is three blind hashes and a timestamp, written only by the owner
    // pressing a button, so the exemption cannot grow faster than they refuse things.
    const candidates = await this.database.query(
      `DELETE FROM mem.fact_candidate
       WHERE workspace_id=$1 AND dismissed_at IS NULL
         AND last_seen < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)`,
      [workspaceId, now, candidateRetentionDays]
    );
    /*
     * Carve-outs whose rule is neither nominated nor stored any more.
     *
     * Not aged out on their own clock, and the two NOT EXISTS clauses are why. A carve-out on a
     * rule that is still a candidate is waiting for the rule's second sighting, and a carve-out on
     * a rule that has already promoted is what a later restatement is compared against - deleting
     * either would put the accumulator back to where a rule stated in June cannot pick up the
     * exception stated in August, which is the failure the table exists to remove. What is left
     * after both is a clause belonging to nothing, and it goes on the candidate's own horizon.
     *
     * `status IN ('active','retracted')` matches `#storedMemoryFact` exactly: those are the two
     * statuses a promotion consults, so those are the two that can still need the set.
     */
    await this.database.query(
      `DELETE FROM mem.fact_qualification q
       WHERE q.workspace_id=$1
         AND q.first_seen < COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
         AND NOT EXISTS (
               SELECT 1 FROM mem.fact_candidate c
               WHERE c.workspace_id=q.workspace_id AND c.subject_key=q.subject_key
                 AND c.predicate=q.predicate AND c.object_key=q.object_key
             )
         AND NOT EXISTS (
               SELECT 1 FROM mem.item i
               WHERE i.workspace_id=q.workspace_id AND i.kind='fact'
                 AND i.subject_key=q.subject_key AND i.predicate=q.predicate
                 AND i.object_key=q.object_key AND i.status IN ('active','retracted')
             )`,
      [workspaceId, now, candidateRetentionDays]
    );
    const packs = await this.database.query(
      `DELETE FROM mem.pack WHERE workspace_id=$1 AND task_id IN (
         SELECT t.id FROM tasks t
         WHERE t.id=mem.pack.task_id AND t.status IN ('completed','failed','cancelled')
       )`,
      [workspaceId]
    );

    // The AFTER INSERT trigger keeps document frequency fresh but never subtracts, so archived
    // items and unindexed sources leave their lexemes counted forever and IDF drifts low. The full
    // rebuild is too expensive to run nightly, so this pass is where its own cadence is kept -
    // there is no other timer in the product that knows a workspace has memory in it.
    const drifted = await this.database.query<{ stale: boolean }>(
      `SELECT refreshed_at <= COALESCE($2::timestamptz,NOW()) - make_interval(days => $3::int)
                AS stale
       FROM mem.corpus_stats WHERE workspace_id=$1`,
      [workspaceId, now, statsRebuildDays]
    );
    const corpusStatsRebuilt = drifted.rows[0]?.stale === true;
    if (corpusStatsRebuilt) await this.rebuildMemoryCorpusStats(workspaceId);

    const contradictions = await this.#resolveFunctionalContradictions(workspaceId, now);

    const stale = await this.listStaleMemoryProcedures(
      workspaceId,
      options.now ? { now: options.now } : {}
    );
    return {
      salienceUpdated: salience.rowCount,
      itemsArchived: archived.rowCount,
      sourcesUnindexed: unindexed.rowCount,
      usesPruned: uses.rowCount,
      candidatesPruned: candidates.rowCount,
      packsPruned: packs.rowCount,
      staleProcedureIds: stale.map((item) => item.id),
      corpusStatsRebuilt,
      ...contradictions
    };
  }

  /** How many pairs one pass will settle. Bounded like everything else consolidation does. */
  static readonly contradictionPassPairs = 20;

  /**
   * The nightly half of §4.3 that had never been built, reduced to the part that needs no model.
   *
   * `resolveMemoryContradiction` in `@garden/core` is the resolution table - deterministic given a
   * verdict, so the only thing anyone ever has to supply is the verdict - and it had no production
   * caller at all: real code, with a real reader, that nothing in the product could reach. The
   * missing piece was never the table. It was an answer to "do these two disagree", and for one
   * class of pair the registry has already answered: a predicate declared `cardinality: 'one'` says
   * two different current values of it about one subject are a contradiction, by definition, with
   * nothing left to interpret. `#backfillPredicateFunctional` is the place those pairs come from
   * and its own comment is what promises they will be resolved this way.
   *
   * What is still absent, and is not smuggled in here: a verdict over pairs under a `many`
   * predicate, where "do these disagree" is a question about meaning and wants a model. That pass
   * would call this same table with a verdict it had bought, which is why the table takes one.
   *
   * Runs inside consolidation rather than beside it because consolidation *is* the nightly pass -
   * once a day per workspace, bounded, keyed off the only timer in the product that knows a
   * workspace has memory in it - and because a second cadence is a second thing to get wrong.
   */
  async #resolveFunctionalContradictions(
    workspaceId: string,
    now: Date | string | null
  ): Promise<{ factsDisputed: number; factsSuperseded: number; factsRetracted: number }> {
    const pairs = await this.listMemoryContradictionCandidates(workspaceId, {
      onlyFunctional: true,
      limit: MemoryStore.contradictionPassPairs
    });
    let factsDisputed = 0;
    let factsSuperseded = 0;
    let factsRetracted = 0;
    for (const pair of pairs) {
      const action = resolveMemoryContradiction(
        { id: pair.left.id, trust: pair.left.trust, observedAt: pair.left.observedAt },
        { id: pair.right.id, trust: pair.right.trust, observedAt: pair.right.observedAt },
        // The registry's own statement about the predicate, not a guess about the sentences. This
        // is the only verdict reachable without the workspace key, and consolidation runs without
        // it by design: nothing in this class may need to read what a memory says.
        'contradict'
      );
      if (action.action === 'dispute') {
        factsDisputed += await this.markMemoryFactsDisputed(workspaceId, action.ids);
        continue;
      }
      if (action.action === 'retract') {
        if (await this.retractMemoryItem(workspaceId, action.loserId)) factsRetracted += 1;
        // The link the retraction does not write. Without it the pair is answered in `mem.item` and
        // unanswered in `mem.link`, and the next pass would offer it again.
        await this.linkMemoryItems({
          srcId: action.winnerId,
          dstId: action.loserId,
          rel: 'supersedes'
        });
        continue;
      }
      if (action.action === 'supersede') {
        const applied = await this.supersedeMemoryItem({
          workspaceId,
          winnerId: action.winnerId,
          loserId: action.loserId,
          ...(now ? { at: now } : {})
        });
        if (applied) factsSuperseded += 1;
      }
    }
    return { factsDisputed, factsSuperseded, factsRetracted };
  }

  /**
   * Monthly full rebuild of the corpus statistics. Doing this nightly would be a sequential scan
   * plus a hash aggregate over every lexeme; the AFTER INSERT trigger keeps df fresh in between.
   *
   * Single-occurrence lexemes are kept. Discarding them saved a fraction of a table that the
   * insert trigger repopulates anyway - the trigger writes df=1 for every lexeme of every row it
   * indexes - and it cost the one distinction retrieval most needs: a term in exactly one document
   * is the most discriminative term there is, and a term in no document cannot match at all. With
   * the df=1 rows dropped those two cases were indistinguishable, so the query planner had to treat
   * the rarest terms as if they were unknown.
   */
  async rebuildMemoryCorpusStats(workspaceId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query('DELETE FROM mem.lexeme_df WHERE workspace_id=$1', [workspaceId]);
      await transaction.query(
        // Guarded like every sibling upsert in this file, and for a reason this one has of its own:
        // the AFTER INSERT trigger on a memory write puts a df=1 row into this very table, so a
        // single episode the agent records between the DELETE above and this INSERT re-creates a
        // key the count is about to claim. Unguarded that was a unique violation that took the
        // whole transaction with it, leaving the workspace with no document frequencies at all
        // until the next monthly run - every term's df defaulting to 1, IDF uniform, and recall
        // ranking silently flat for a month with nothing anywhere reporting it.
        `INSERT INTO mem.lexeme_df(workspace_id, lexeme, df)
         SELECT $1, u.lexeme, count(*) FROM (
           SELECT tsv FROM mem.item WHERE workspace_id=$1 AND tsv IS NOT NULL
           UNION ALL
           SELECT tsv FROM mem.source WHERE workspace_id=$1 AND indexed AND tsv IS NOT NULL
         ) d CROSS JOIN LATERAL unnest(d.tsv) u
         GROUP BY u.lexeme
         ON CONFLICT (workspace_id, lexeme) DO UPDATE SET df = EXCLUDED.df`,
        [workspaceId]
      );
      await transaction.query(
        `INSERT INTO mem.corpus_stats(workspace_id,n_docs,sum_len,refreshed_at)
         SELECT $1, count(*), COALESCE(SUM(tsv_len),0), NOW() FROM (
           SELECT tsv_len FROM mem.item WHERE workspace_id=$1 AND tsv IS NOT NULL
           UNION ALL
           SELECT tsv_len FROM mem.source WHERE workspace_id=$1 AND indexed AND tsv IS NOT NULL
         ) d
         ON CONFLICT (workspace_id) DO UPDATE
           SET n_docs=EXCLUDED.n_docs, sum_len=EXCLUDED.sum_len, refreshed_at=EXCLUDED.refreshed_at`,
        [workspaceId]
      );
    });
  }

  /**
   * Removal, not retirement.
   *
   * `retractMemoryItem` above sets a status: the row stops being recalled and every word of it
   * stays on disk. That is the right answer when the agent decides something has stopped being
   * true, and the wrong one when an owner says to forget it, because an owner told a line is gone
   * has to be right. The verbatim chunks go with it - `mem.source` holds the request as typed, and
   * reaches its episode by a link that is set to null rather than followed on delete, so removing
   * the episode alone would leave those words on disk with nothing left pointing at them.
   *
   * The bundle is the statement that decides whether any of this is true from where the agent is
   * standing. A task assembles its memory once, seals the rendered text into `mem.pack`, and re-uses
   * those exact bytes on every later turn without reading the rows again - that is what keeps the
   * cached prompt prefix alive. Deleting the rows and leaving the bundle would mean a conversation
   * that is merely parked, and can be parked for weeks, goes on reciting the line the owner just
   * deleted. So every bundle that quoted this row or its chunks goes too, and those tasks pay one
   * rebuild on their next turn.
   *
   * It lived in the delete route until Wave 7.3, which is why it had no test: six statements that
   * have to agree about what "gone" means, reachable only through HTTP. They are store statements,
   * they are the counterpart of `retractMemoryItem` beside them, and `store.test.ts` now asserts
   * all four copies are reached.
   */
  forgetMemoryItem(workspaceId: string, itemId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const owned = await transaction.query(
        'SELECT id FROM mem.item WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, itemId]
      );
      if (owned.rowCount === 0) return false;
      const chunks = await transaction.query<{ id: string }>(
        'DELETE FROM mem.source WHERE workspace_id=$1 AND episode_id=$2 RETURNING id',
        [workspaceId, itemId]
      );
      /*
       * The half of this statement that is load-bearing is `dst_id`, and nothing but this comment
       * says so. `mem.link.src_id` REFERENCES `mem.item(id) ON DELETE CASCADE`; `dst_id` is
       * `UUID NOT NULL` and references nothing at all. So the `src_id` arm is belt-and-braces over a
       * cascade the database already performs, and the `dst_id` arm is the only thing standing
       * between a deleted row and a `supersedes` edge that still points at it by id.
       *
       * The same asymmetry is why `mem.evidence`, `mem.item_use` and `mem.item_use_fold` need no
       * statement here: all three carry a real cascading foreign key to `mem.item`, so the row's
       * evidence, its live uses and the folded tail of them go with it untouched - which is what
       * makes "forget" still true of a history the retention pass has already compacted. A future
       * migration that ADDS the missing `dst_id` foreign key
       * makes this whole statement redundant and no test will notice, because a redundant DELETE
       * and a necessary one look identical from the outside - the row is gone either way.
       */
      await transaction.query('DELETE FROM mem.link WHERE src_id=$1 OR dst_id=$1', [itemId]);
      // A bundle cites verbatim chunks by their own id alongside the items, so both go into the
      // overlap test: matching on the item alone would leave the owner's own words quoted.
      await transaction.query('DELETE FROM mem.pack WHERE item_ids && $1::uuid[]', [
        [itemId, ...chunks.rows.map((chunk) => chunk.id)]
      ]);
      /*
       * And the turn stops vouching for anything it was about to prove. A drafted fact waits in
       * `mem.fact_candidate` until two separate turns have observed it, holding a sealed draft and
       * the ids of the turns that vouched for it. Nothing reads that table on recall, so it is not
       * the lie the bundle above was - but leaving this turn's vote in it means a line the owner
       * deleted can still be half of what makes garden believe something later, from a record they
       * were told was gone. A draft with no turn left behind it is not a draft.
       *
       * Two statements, in this order, and the order is the whole of it. The sole-witness drafts go
       * first; only then does every surviving draft lose this turn's vote.
       *
       * It used to be the other way round - one UPDATE flooring the counter with
       * `GREATEST(n_episodes - 1, 1)`, then a DELETE sweeping whatever it had emptied - and the
       * floor was not a safety net but a workaround for the column's own `CHECK (n_episodes > 0)`.
       * Between the two statements a draft whose only witness had just been deleted sat at
       * `n_episodes = 1` with an EMPTY `episode_ids`, which is a fact this box believes two turns
       * observed and can name neither. Nothing but the adjacency of the two lines kept that state
       * from being read, and `listPromotableMemoryFactCandidates(minEpisodes: 1)` reads exactly it.
       *
       * Written this way the intermediate state cannot exist, the counter is decremented honestly
       * rather than floored, and the CHECK stops being something to work around and becomes the
       * guard: delete the first statement and the second one violates it, so the transaction fails
       * loudly instead of promoting a fact no surviving turn ever observed.
       *
       * `array_remove` rather than a cardinality test on the raw column, because it strips every
       * occurrence - a draft that somehow listed the same episode twice is still sole-witness.
       * `n_episodes` is not re-derived from the array: `observeMemoryFactCandidate` caps the array
       * at 32 ids while the counter keeps climbing, so on a well-observed draft they legitimately
       * disagree and `cardinality()` would silently reset the count to 31.
       */
      await transaction.query(
        `DELETE FROM mem.fact_candidate
          WHERE workspace_id=$1 AND $2::uuid = ANY(episode_ids)
            AND cardinality(array_remove(episode_ids, $2::uuid)) = 0`,
        [workspaceId, itemId]
      );
      await transaction.query(
        `UPDATE mem.fact_candidate
            SET episode_ids = array_remove(episode_ids, $2::uuid),
                n_episodes = n_episodes - 1
          WHERE workspace_id=$1 AND $2::uuid = ANY(episode_ids)`,
        [workspaceId, itemId]
      );
      /*
       * And the carve-outs on the rule this row IS, if it is one.
       *
       * `mem.fact_qualification` is deliberately outlived by nothing else - it survives promotion so
       * that a rule stated in June can pick up the exception stated in August - which makes it the
       * one table where "delete removes every trace" needs a statement of its own. Without this,
       * deleting a standing order leaves its clauses behind, and the sentence the owner deleted
       * would come back qualified the next time they said the rule. That is the safe direction and
       * it is still not what the route promises.
       *
       * Before the item is deleted, because the keys have to be read off it. Only for a fact, and
       * only for one that has all three keys: the qualification table is keyed on the triple, and a
       * row with a null object key belongs to no rule.
       */
      await transaction.query(
        `DELETE FROM mem.fact_qualification q
         USING mem.item i
         WHERE i.id=$2 AND i.workspace_id=$1 AND i.kind='fact'
           AND q.workspace_id=i.workspace_id AND q.subject_key=i.subject_key
           AND q.predicate=i.predicate AND q.object_key=i.object_key`,
        [workspaceId, itemId]
      );
      const removed = await transaction.query(
        'DELETE FROM mem.item WHERE workspace_id=$1 AND id=$2',
        [workspaceId, itemId]
      );
      return removed.rowCount === 1;
    });
  }

  /**
   * The owner block: one text per person, and the only memory surface nothing ranks.
   *
   * Every other tier here answers "what is relevant to this request". This one answers a question
   * no request names - who the owner is and how they want to be worked with - which is exactly why
   * retrieval cannot serve it and why it is read whole, on every request, or not at all.
   *
   * There is no `workspaceId` and no `taskId` in this signature, and their absence is the gate
   * rather than an omission. `createWorkspaceMemory` narrows its `target` for the same reason; here
   * the two parameters a running turn always has are declared `never`, so the one production caller
   * inside a turn - `apps/worker/src/tools/knowledge.ts` - cannot even name them without a compile
   * error, and the runtime throw below holds for a JavaScript caller or an `as` cast that gets past
   * the type. The agent has no verb for this table at all: the worker's window READS it and nothing
   * in the worker writes it.
   *
   * @see OWNER_BLOCK_WRITE_SQL for the concurrency arm and for why a refused write changes nothing.
   */
  async readOwnerBlock(userId: string): Promise<OwnerBlockRecord | null> {
    const result = await this.database.query(OWNER_BLOCK_READ_SQL, [userId]);
    return result.rows[0] ? mapOwnerBlock(result.rows[0]) : null;
  }

  /**
   * Writes the whole block, or refuses and leaves the stored bytes untouched.
   *
   * Two independent bounds on one number, and they are not redundant. This one reads the sealed
   * bytes it was handed and refuses past `OWNER_BLOCK_MAX_BYTES` with a message naming what is
   * full, because a caller deserves to be told which surface refused it. The CHECK in migration 73
   * is the one that cannot be talked out of it: it measures the same bytes in the database, so a
   * caller that computed the length wrong, or lied about it, is refused there.
   *
   * `expectedVersion` is the version the caller read. Zero means "there was no block". A stale
   * version matches no row and returns null, which the caller reports as a conflict - two settings
   * tabs cannot silently overwrite one another on the one surface whose every word the owner chose.
   */
  async writeOwnerBlock(input: {
    userId: string;
    ciphertext: EncryptedEnvelope;
    expectedVersion: number;
    /** A turn always has these. This method cannot be told them, which is what keeps turns out. */
    workspaceId?: never;
    taskId?: never;
  }): Promise<OwnerBlockRecord | null> {
    if (input.workspaceId !== undefined || input.taskId !== undefined)
      throw new GardenError(
        'owner_block_refused',
        'The owner block is written by the owner in Settings, not from inside a task.'
      );
    const bytes = ownerBlockBytes(input.ciphertext);
    if (bytes > OWNER_BLOCK_MAX_BYTES)
      throw new GardenError(
        'owner_block_full',
        `Your block holds ${OWNER_BLOCK_MAX_BYTES} bytes and this is ${bytes}. Shorten it; nothing here is dropped to make room.`
      );
    const result = await this.database.query(OWNER_BLOCK_WRITE_SQL, [
      input.userId,
      JSON.stringify(input.ciphertext),
      input.expectedVersion
    ]);
    return result.rows[0] ? mapOwnerBlock(result.rows[0]) : null;
  }
}
