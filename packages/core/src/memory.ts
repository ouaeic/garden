import { runtimeValue, runtimeObservations } from './runtime-observations.js';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { GardenError } from './errors.js';

export interface MemoryDocument {
  content: string;
  validFrom?: string;
  validUntil?: string;
  source?: 'owner' | 'agent';
  sourceTaskId?: string;
  previousUpdatedAt?: string;
}

export interface RecallableMemory {
  id: string;
  target: 'workspace' | 'user';
  content: string;
  updatedAt: string;
}

/**
 * Closed-class English function words: articles, pronouns, auxiliaries, and the interrogatives a
 * question is framed with. Fixed once, and deliberately not a tuning surface - every word here is
 * one that cannot distinguish two entries in this store, whatever the store is about.
 *
 * The interrogatives matter more than they look. Admission to the lexical channel is binary: a row
 * sharing one lexeme with the query is a candidate. So "remind me what the neighbour said about her
 * boat" - a question this computer has no answer to at all - pulled in an unrelated episode on the
 * strength of the word "about", and at scale that is how a pack of near misses quietly costs six
 * thousand tokens. Words nothing can be told apart by are dropped from the index and the query
 * alike, so the two surfaces stay symmetric.
 *
 * Words that read as function words but carry meaning on an agent computer are deliberately absent:
 * "down", "up", "out", "over", "no" and "not" all change what a sentence about a service means.
 */
const memoryStopWords = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'more',
  'most',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
]);

const memoryTerms = (value: string): Set<string> =>
  new Set(
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{1,}/gu)
      ?.filter((term) => !memoryStopWords.has(term)) ?? []
  );

/**
 * Selects compact reviewed context without an embedding model or remote index.
 * User-level preferences receive a small durable boost; lexical relevance and
 * recency decide which workspace facts enter a bounded prompt.
 */
export const recallMemories = (
  entries: readonly RecallableMemory[],
  query: string,
  options: { maxItems?: number; maxCharacters?: number; now?: Date } = {}
): RecallableMemory[] => {
  const queryNormalized = query.normalize('NFKC').trim().toLocaleLowerCase('en');
  const queryTerms = memoryTerms(queryNormalized);
  const now = (options.now ?? new Date()).getTime();
  const ranked = entries
    .map((entry) => {
      const contentNormalized = entry.content.normalize('NFKC').toLocaleLowerCase('en');
      const contentTerms = memoryTerms(contentNormalized);
      const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
      const coverage = queryTerms.size ? overlap / queryTerms.size : 0;
      const ageDays = Math.max(0, now - new Date(entry.updatedAt).getTime()) / 86_400_000;
      const recency = Number.isFinite(ageDays) ? 1 / (1 + ageDays / 90) : 0;
      const exact = queryNormalized.length >= 4 && contentNormalized.includes(queryNormalized);
      return {
        entry,
        score:
          (exact ? 12 : 0) +
          overlap * 2.5 +
          coverage * 4 +
          recency +
          (entry.target === 'user' ? 1.5 : 0)
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        new Date(right.entry.updatedAt).getTime() - new Date(left.entry.updatedAt).getTime() ||
        left.entry.id.localeCompare(right.entry.id)
    );
  const selected: RecallableMemory[] = [];
  let characters = 0;
  for (const candidate of ranked) {
    if (selected.length >= (options.maxItems ?? 32)) break;
    if (characters + candidate.entry.content.length > (options.maxCharacters ?? 16_000)) continue;
    selected.push(candidate.entry);
    characters += candidate.entry.content.length;
  }
  return selected;
};

const instant = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
};

export type MemoryTemporalStatus = 'active' | 'upcoming' | 'expired';

export const memoryTemporalStatus = (
  document: MemoryDocument,
  now = new Date()
): MemoryTemporalStatus => {
  const cursor = now.getTime();
  const validFrom = instant(document.validFrom);
  const validUntil = instant(document.validUntil);
  if (validFrom !== undefined && validFrom > cursor) return 'upcoming';
  if (validUntil !== undefined && validUntil <= cursor) return 'expired';
  return 'active';
};

export const assertMemoryValidity = (document: MemoryDocument): void => {
  const validFrom = instant(document.validFrom);
  const validUntil = instant(document.validUntil);
  if (document.validFrom && validFrom === undefined)
    throw new GardenError('memory_validity_invalid', 'Memory start time is invalid');
  if (document.validUntil && validUntil === undefined)
    throw new GardenError('memory_validity_invalid', 'Memory expiry time is invalid');
  if (validFrom !== undefined && validUntil !== undefined && validUntil <= validFrom)
    throw new GardenError(
      'memory_validity_invalid',
      'Memory expiry must be later than its start time'
    );
};

/* ------------------------------------------------------------------------ *
 * Tiered memory: kinds, trust tiers and lifecycle
 * ------------------------------------------------------------------------ */

/** Verbatim `source` rows are never replaced by the curated overlay, only cited by it. */
export type MemoryKind = 'source' | 'episode' | 'fact' | 'procedure';

/**
 * Provenance tier. `stated` is something the owner said or a tool verified; `derived` was inferred
 * mechanically from repeated independent observation.
 *
 * There is no tier for the agent's own conclusions, and that is the invariant rather than an
 * omission: every writer on this computer is mechanical, and the `memory` tool refuses uncertain
 * inference outright. A third tier was declared here for a while and offered to the model as a
 * recall filter it could switch on; nothing ever wrote a row into it, so the parameter described a
 * capability the model did not have and could never have used.
 */
export type MemoryTrust = 'stated' | 'derived';

/**
 * The five states a remembered row can be in. All five are written or read on a live path, and this
 * list says where, because two of them were once proposed for deletion as unreachable members:
 *
 * - `active` - the column default; everything recall returns by default.
 * - `superseded` - written by `recordMemoryFact` when a functional predicate gets a second current
 *   value. This is the deterministic half of contradiction resolution and needs no model call.
 * - `disputed` - written by `markMemoryFactsDisputed`, read by `listDisputedMemoryItems`, and
 *   served to the owner by `GET /v1/workspaces/:id/memory-review`. It means "two things you said
 *   conflict, and neither is being recalled until you say which".
 * - `archived` - reached by recall's `scope: 'archive'`, which is the only way to read past it.
 * - `retracted` - written by `retractMemoryItem` behind
 *   `POST /v1/workspaces/:id/memory-items/:id/retract`. It is deliberately not deletion: the row
 *   stops being recalled and the audit trail survives, which is the difference between "stop
 *   believing this" and `DELETE`.
 *
 * The gap that used to be worth writing down here - the `disputed` *writer* having no production
 * caller, so the review queue could clear a dispute nothing was able to raise - is closed:
 * `consolidateMemory`'s contradiction pass raises one whenever a subject holds two current values
 * of a predicate the registry declares one-valued. What remains open is narrower and is recorded on
 * `resolveMemoryContradiction` below: no pass yet buys a verdict for pairs under a `many` predicate.
 */
export type MemoryStatus = 'active' | 'superseded' | 'disputed' | 'archived' | 'retracted';

export const MEMORY_KINDS: readonly MemoryKind[] = ['source', 'episode', 'fact', 'procedure'];

/**
 * Vetted in-repo predicate registry. `cardinality: 'one'` is the whole deterministic contradiction
 * engine: a second current value for a functional predicate retires the first one without a model
 * call. It is deliberately not extensible at runtime.
 */
export interface MemoryPredicateDefinition {
  readonly name: string;
  readonly cardinality: 'one' | 'many';
  readonly isTemporal: boolean;
  readonly description: string;
}

export const MEMORY_PREDICATES: readonly MemoryPredicateDefinition[] = [
  {
    name: 'default_shell',
    cardinality: 'one',
    isTemporal: true,
    description: 'The interactive shell the owner uses on this computer.'
  },
  {
    name: 'lives_in',
    cardinality: 'one',
    isTemporal: true,
    description: 'Where the subject is currently located.'
  },
  {
    name: 'current_employer',
    cardinality: 'one',
    isTemporal: true,
    description: 'Who the subject currently works for.'
  },
  {
    name: 'project_status',
    cardinality: 'one',
    isTemporal: true,
    description: 'The current state of a project the owner is running.'
  },
  {
    name: 'runs_on',
    cardinality: 'one',
    isTemporal: true,
    description: 'The host, port or environment a service currently runs on.'
  },
  {
    name: 'uses_tool',
    cardinality: 'one',
    isTemporal: true,
    description: 'The tool currently chosen for a named job.'
  },
  {
    name: 'prefers',
    cardinality: 'many',
    isTemporal: true,
    description: 'A stated preference of the owner.'
  },
  {
    name: 'knows_language',
    cardinality: 'many',
    isTemporal: false,
    description: 'A language the subject can work in.'
  },
  {
    name: 'located_at',
    cardinality: 'many',
    isTemporal: true,
    description: 'A path or URL where something the owner cares about lives.'
  },
  {
    name: 'related_to',
    cardinality: 'many',
    isTemporal: false,
    description: 'An untyped association between two entities.'
  },
  /*
   * The one predicate that is not a state of the world.
   *
   * Every entry above it describes something that is true - where the owner lives, what a service
   * listens on, which tool they reach for. Measured over 3,950 real typed turns, that registry
   * minted one durable fact, and the thing the owner actually says over and over is none of these
   * shapes: it is a rule for the machine. "Never run git stash." "Never hardcode the main body
   * colour." Those have no predicate to go into, so a regex could not have helped; the shape had
   * nowhere to land.
   *
   * `many` because an owner has more than one rule and two of them do not contradict; temporal
   * because a rule can be withdrawn, which is what `retractMemoryItem` is for. The object is the
   * owner's own sentence, unedited, which is why nothing here needs a model to read it.
   */
  {
    name: 'standing_order',
    cardinality: 'many',
    isTemporal: true,
    description: 'A rule the owner stated for how this computer must behave, in their own words.'
  }
];

const predicateIndex = new Map(MEMORY_PREDICATES.map((entry) => [entry.name, entry]));

export const memoryPredicate = (name: string): MemoryPredicateDefinition | undefined =>
  predicateIndex.get(name);

export const isFunctionalMemoryPredicate = (name: string): boolean =>
  predicateIndex.get(name)?.cardinality === 'one';

/* ------------------------------------------------------------------------ *
 * Keyed blind index
 *
 * Memory bodies are stored encrypted, exactly like task titles and prompts, so PostgreSQL cannot
 * run `to_tsvector` over the plaintext. Instead the tokenizer runs here and every lexeme is
 * replaced by a keyed HMAC token before it reaches the database. The resulting tsvector keeps
 * positions and field weights, so `@@`, `ts_rank_cd` and the BM25 function all behave normally
 * over a token space the database can match but not read back.
 * ------------------------------------------------------------------------ */

const TOKEN_ALPHABET = 'abcdefghijklmnop';
const LEXEME_TOKEN_CHARS = 16;
const TRIGRAM_TOKEN_CHARS = 12;
const KEY_TOKEN_CHARS = 32;

/** Positions above 16383 are dropped by tsvector, so indexing beyond this buys nothing. */
const MAX_INDEXED_TOKENS = 4_000;
/** Rows larger than this are stored but never indexed; see `poisonsLexicalIndex`. */
const MAX_INDEXED_BYTES = 64_000;
const MIN_PRINTABLE_WORD_RATIO = 0.5;
/** Longer than any real path, flag or hostname: a run this long is a payload, not a word. */
const MAX_WORD_CHARS = 48;
/** Below this the ratio is noise - a one-line note is not a blob however it is punctuated. */
const MIN_RATIO_SAMPLE_CHARS = 256;
/** The alias surface is a naming surface, not a document; a row needing more than this is a blob. */
const MAX_ALIAS_TOKENS = 256;

const encodeToken = (digest: Buffer, chars: number): string => {
  let out = '';
  for (let index = 0; index < chars; index += 1) {
    const byte = digest[index >> 1] ?? 0;
    out += TOKEN_ALPHABET[index % 2 === 0 ? byte >> 4 : byte & 0x0f];
  }
  return out;
};

/**
 * Derives the index key from the workspace data key. Separating them means a leaked index key
 * cannot decrypt anything, and rotating the search surface never touches stored ciphertext.
 */
export const memoryIndexKey = (dataKey: Uint8Array): Buffer =>
  Buffer.from(hkdfSync('sha256', dataKey, new Uint8Array(0), 'garden-memory-index-v1', 32));

/**
 * The key a fact about the OWNER is sealed under, and the reason the owner tier can leave a
 * workspace at all.
 *
 * Every other secret on this box is sealed under a workspace data key: `generateDataKey()` at
 * `createWorkspace`, wrapped as `workspace-key:${workspaceId}`, and unwrapped from
 * `workspace_keys` - a table whose rows are `ON DELETE CASCADE` from `workspaces`. That is the
 * correct scope for a fact about a project and the wrong scope for a fact about a person, and it
 * is the whole of why `workspace_memories.target = 'user'` has never meant what its label says:
 * a row sealed under workspace A's key is unreadable in B, and deleting A destroys it outright.
 * Widening the SQL alone would have returned rows that then failed to decrypt.
 *
 * This is derived rather than stored, which is the same choice `memoryIndexKey` above makes and
 * for the same reason: a subordinate key with no row of its own has no wrap to get out of step,
 * no `ON DELETE` to reason about, and no second rotation story. Deleting a workspace cannot reach
 * it, because it was never in `workspace_keys`. The user id is the salt, so two accounts on one
 * box derive different keys from the same master and neither can open the other's rows even with
 * full database access.
 *
 * What it deliberately does NOT do is survive a reinstall. The master key is minted once by the
 * installer and `service-keys.ts` is blunt about the consequence - a key that did not encrypt this
 * database cannot read it back. So the owner tier outlives a workspace and does not outlive the
 * box, and the honest place to say so is here rather than in a label the owner reads.
 */
export const userMemoryKey = (masterKey: Uint8Array, userId: string): Buffer =>
  Buffer.from(
    hkdfSync('sha256', masterKey, Buffer.from(userId, 'utf8'), 'garden-user-memory-v1', 32)
  );

/**
 * The context an owner-tier row is bound to.
 *
 * Its own domain rather than a reused `workspace-memory:` string, because the GCM tag proves the
 * ciphertext and the AAD were made together and not that the AAD is the one this caller meant -
 * the standing warning on `inferenceCredentialAad`. A workspace row and an owner row must never be
 * substitutable for one another even by a caller holding both keys.
 */
export const userMemoryAad = (userId: string): string => `user-memory:${userId}`;

/**
 * The context the owner's block is bound to, and it is not the one above.
 *
 * The rule stated over `userMemoryAad` is that two surfaces must never be substitutable even by a
 * caller holding both keys, and it kept that against a workspace row - whose context names a
 * workspace - while failing against the one row class that shares this key. Both surfaces are about
 * the same person, so a context naming only the person is satisfied by both: an owner-tier memory
 * row's envelope was byte-for-byte a legal owner block, and copying the JSONB across needed no key
 * at all. The consequence is what makes it worth its own string - the block has no `status` and no
 * expiry by design, so a ranked row the owner had let lapse would come back unranked, resident and
 * permanent.
 *
 * Named for the surface rather than for the person, which is the property the other one is missing.
 * Migration 73's `owner_blocks_context_ck` is the same equality written where a caller that bypasses
 * this module still meets it.
 */
export const ownerBlockAad = (userId: string): string => `owner-block:${userId}`;

/**
 * How many facts about the owner this box will hold, and the measurement the number comes from.
 *
 * 505 owner-typed turns across ten projects and four and a half months were read end to end. The
 * dispositions that recur in more than one project - the ones that would still be true in a
 * project not yet started - come to eight by probe and fewer on reading: one is overwhelming
 * (thirty-four sentences in eight of the ten projects), three more clear three projects, and one
 * collapses entirely once the sentences are read rather than counted. Nothing in that corpus asks
 * to be remembered about the person even once.
 *
 * So the honest content of this tier is single figures, and sixteen is double the widest defensible
 * reading of it. A bound set at what the evidence supports rather than at what the column could
 * hold is what keeps the tier legible: sixteen rows inside 6,000 characters is a screen the owner
 * can read in one sitting, and a tier nobody reads is a tier nobody notices a wrong row in.
 *
 * At the bound the write is refused and the owner is told what is full. Nothing is evicted. The
 * workspace tier can afford an eviction policy because its rows die with the computer anyway; a
 * fact about a person that quietly disappeared to make room would be a thing the owner told this
 * machine once and can never find out it forgot.
 */
export const OWNER_MEMORY_MAX_ROWS = 16;

/** The owner tier's character budget, unchanged - it is what already forced one screen. */
export const OWNER_MEMORY_MAX_CHARS = 6_000;

/** The workspace tier's character budget. Wider, because those rows die with the computer. */
export const WORKSPACE_MEMORY_MAX_CHARS = 12_000;

const keyedToken = (domain: string, value: string, key: Uint8Array, chars: number): string => {
  const read = () =>
    encodeToken(createHmac('sha256', key).update(`${domain} ${value}`).digest(), chars);
  if (!runtimeObservations()) return read();
  return runtimeValue(
    `memory.token:${createHash('sha256')
      .update(JSON.stringify([domain, value, chars]))
      .digest('hex')}`,
    read
  );
};

/**
 * Every index token is drawn from a 16-letter alphabet with no digits and no punctuation. That is
 * what lets the recall query assemble a tsquery out of a bound text[] without a lexeme ever being
 * read as an `&`, `|` or `!` operator, and it is why `to_tsvector('simple', ...)` returns the
 * tokens unchanged instead of splitting or stemming them.
 */
export const isMemoryToken = (value: string): boolean => /^[a-p]+$/.test(value);

/* --- tokenizer ---------------------------------------------------------- */

// Paths, flags, hostnames, versions and SHAs are the substance of an agent computer's memory, so
// the tokenizer keeps them whole instead of letting a stemmer shred them.
const LEXEME_PATTERN =
  /--?[\p{L}\p{N}][\p{L}\p{N}_-]*|\/[\p{L}\p{N}][\p{L}\p{N}_./-]*|[\p{L}\p{N}][\p{L}\p{N}_.:@/+-]*/gu;
const PLAIN_WORD = /^[\p{L}]+$/u;
const TRAILING_PUNCTUATION = /[._:@/+-]+$/;

/** Identifiers keep their exact form; only ordinary prose words are suffix-normalized. */
const stemPlainWord = (word: string): string => {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('sses')) return word.slice(0, -2);
  if (
    word.length > 3 &&
    word.endsWith('s') &&
    !word.endsWith('ss') &&
    !word.endsWith('us') &&
    !word.endsWith('is')
  )
    return word.slice(0, -1);
  const undouble = (value: string): string =>
    value.length > 3 && value.at(-1) === value.at(-2) && !'aeiou'.includes(value.at(-1) ?? '')
      ? value.slice(0, -1)
      : value;
  if (word.endsWith('ing') && word.length - 3 >= 4) return undouble(word.slice(0, -3));
  if (word.endsWith('ed') && word.length - 2 >= 4) return undouble(word.slice(0, -2));
  return word;
};

/**
 * Splits text into ordered lexemes. Order matters: positions in the stored tsvector are what makes
 * `ts_rank_cd` cover-density reranking possible, so this must never be turned into a set.
 */
export const memoryLexemes = (value: string): string[] => {
  const matches = value.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? [];
  const lexemes: string[] = [];
  for (const raw of matches) {
    const token = raw.replace(TRAILING_PUNCTUATION, '');
    if (!token) continue;
    if (PLAIN_WORD.test(token)) {
      if (token.length < 2 || memoryStopWords.has(token)) continue;
      lexemes.push(stemPlainWord(token));
      continue;
    }
    lexemes.push(token);
  }
  return lexemes;
};

/**
 * Ordered lexemes with the offset each one was found at.
 *
 * `memoryLexemes` throws positions away because the index only needs the sequence. An excerpt needs
 * to point at a place in the original text, and it has to do it through the same stemmer the index
 * used - otherwise a hit found by "restarted" is highlighted nowhere, because the body says
 * "restart".
 */
const locatedLexemes = (value: string): { readonly lexeme: string; readonly at: number }[] => {
  const located: { lexeme: string; at: number }[] = [];
  for (const match of value.matchAll(LEXEME_PATTERN)) {
    const raw = match[0].toLocaleLowerCase('en').replace(TRAILING_PUNCTUATION, '');
    if (!raw) continue;
    if (PLAIN_WORD.test(raw)) {
      if (raw.length < 2 || memoryStopWords.has(raw)) continue;
      located.push({ lexeme: stemPlainWord(raw), at: match.index });
      continue;
    }
    located.push({ lexeme: raw, at: match.index });
  }
  return located;
};

/** Identifier-shaped terms are what the fuzzy channel exists for; prose words only add noise. */
export const memoryIdentifiers = (value: string): string[] => {
  const seen = new Set<string>();
  for (const raw of value.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? []) {
    const token = raw.replace(TRAILING_PUNCTUATION, '');
    if (token.length < 3 || PLAIN_WORD.test(token)) continue;
    seen.add(token);
  }
  return [...seen].sort();
};

/** A part shorter than this is a fragment, not a word someone would search by. */
const MIN_ALIAS_CHARS = 3;
const ALIAS_BOUNDARY = /[^\p{L}\p{N}]+/gu;
const CAMEL_BOUNDARY = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const HAS_LETTER = /\p{L}/u;

/**
 * The component words of a compound term.
 *
 * The tokenizer deliberately keeps `garden-relay`, `imap_idle_notify_interval` and
 * `/srv/garden/var/log` whole, because that is what makes them findable by their exact name. The
 * cost is that they share no lexeme with the words a person actually asks by - nobody types
 * `garden-relay`, they ask what port the relay listens on. This splits a compound into its parts
 * so both surfaces exist: the exact name in the body field, the parts in a lower-weighted alias
 * field beside it. Parts that the tokenizer already produced from the same text are dropped, so
 * ordinary prose contributes nothing here and pays nothing for it.
 */
export const memoryAliasLexemes = (value: string): string[] => {
  const direct = new Set(memoryLexemes(value));
  const aliases = new Set<string>();
  for (const chunk of value.normalize('NFKC').split(ALIAS_BOUNDARY)) {
    if (!chunk) continue;
    for (const part of chunk.replace(CAMEL_BOUNDARY, '$1 $2').split(' ')) {
      const word = part.toLocaleLowerCase('en');
      if (word.length < MIN_ALIAS_CHARS || !HAS_LETTER.test(word)) continue;
      if (memoryStopWords.has(word)) continue;
      const stemmed = PLAIN_WORD.test(word) ? stemPlainWord(word) : word;
      if (!direct.has(stemmed)) aliases.add(stemmed);
    }
  }
  return [...aliases].sort();
};

/**
 * pg_trgm-shaped trigrams: lowercase, split on non-alphanumerics, pad each word with two leading
 * and one trailing space. Jaccard over these sets is what `similarity()` computes, so hashing each
 * trigram preserves the score exactly while keeping the plaintext out of the database.
 */
export const memoryTrigrams = (value: string): string[] => {
  const words = value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const grams = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1)
      grams.add(padded.slice(index, index + 3));
  }
  return [...grams].sort();
};

/**
 * Blobs flatten IDF for everything else: a base64 payload or a minified bundle contributes
 * thousands of lexemes that occur exactly once. They are stored, and stay reachable by id or
 * origin, but never enter the lexical index. The signal is the share of characters that sit in
 * word-shaped runs - a blob is one enormous run, prose and command output are many short ones.
 */
const poisonsLexicalIndex = (body: string, lexemes: readonly string[]): boolean => {
  if (Buffer.byteLength(body, 'utf8') > MAX_INDEXED_BYTES) return true;
  const dense = body.replace(/\s+/gu, '').length;
  if (dense < MIN_RATIO_SAMPLE_CHARS) return false;
  const printable = lexemes.reduce(
    (total, lexeme) => total + (lexeme.length <= MAX_WORD_CHARS ? lexeme.length : 0),
    0
  );
  return printable / dense < MIN_PRINTABLE_WORD_RATIO;
};

/** Cheap deterministic estimate; the real budget is enforced against this, never against an API. */
export const estimateMemoryTokens = (value: string): number => Math.ceil(value.length / 4);

const keyedLexemeLine = (value: string, key: Uint8Array): string =>
  memoryLexemes(value)
    .slice(0, MAX_INDEXED_TOKENS)
    .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
    .join(' ');

const keyedTrigramSet = (value: string, key: Uint8Array): string[] =>
  memoryTrigrams(value).map((gram) => keyedToken('trg', gram, key, TRIGRAM_TOKEN_CHARS));

/** The alias surface is a set, not a sentence: it is deduped and bounded rather than positional. */
const keyedAliasLine = (value: string, key: Uint8Array): string =>
  memoryAliasLexemes(value)
    .slice(0, MAX_ALIAS_TOKENS)
    .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
    .join(' ');

/** Entity and object names are matched by equality, so they are normalized but never stemmed. */
export const normalizeMemoryTerm = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();

export const memorySubjectKey = (subject: string, key: Uint8Array): string =>
  keyedToken('subject', normalizeMemoryTerm(subject), key, KEY_TOKEN_CHARS);

export const memoryObjectKey = (object: string, key: Uint8Array): string =>
  keyedToken('object', normalizeMemoryTerm(object), key, KEY_TOKEN_CHARS);

/**
 * Keyed handle for where a verbatim row came from - a path, URL or command. Compacted sources
 * leave the lexical index, so this is what still finds "everything I ever ran in /srv/garden".
 */
export const memoryOriginKey = (locator: string, key: Uint8Array): string =>
  keyedToken('origin', normalizeMemoryTerm(locator), key, KEY_TOKEN_CHARS);

export interface MemoryItemContent {
  readonly title?: string | null;
  readonly tags?: readonly string[];
  readonly body: string;
  readonly subject?: string | null;
  readonly object?: string | null;
}

export interface MemoryItemIndex {
  readonly titleTokens: string;
  readonly tagTokens: string;
  /**
   * Keyed component words of the entry's compound terms - its subject, object, title and the
   * identifiers in its body. Indexed at a weight below the title, so `relay` reaches a fact whose
   * subject is `garden-relay` without outranking an entry that is actually titled "relay".
   */
  readonly aliasTokens: string;
  readonly bodyTokens: string;
  readonly tagsHashed: string[];
  readonly trigrams: string[];
  readonly subjectKey: string | null;
  readonly objectKey: string | null;
  /** Keyed hash of the normalized item body; exact-duplicate suppression in the pack uses it. */
  readonly dedupeKey: string;
  readonly tokensEst: number;
  readonly indexed: boolean;
}

export const buildMemoryItemIndex = (
  content: MemoryItemContent,
  key: Uint8Array
): MemoryItemIndex => {
  const tags = content.tags ?? [];
  const bodyLexemes = memoryLexemes(content.body);
  const indexed = !poisonsLexicalIndex(content.body, bodyLexemes);
  const fuzzySurface = [
    content.title ?? '',
    content.subject ?? '',
    content.object ?? '',
    ...memoryIdentifiers(content.body)
  ]
    .filter(Boolean)
    .join(' ');
  // Everything an entry could be asked by rather than everything it contains: the names it is
  // about, and the identifiers its body names. The body's prose is deliberately absent - it is
  // already indexed at D weight and would only re-weight itself.
  const aliasSurface = [
    content.title ?? '',
    content.subject ?? '',
    content.object ?? '',
    tags.join(' '),
    memoryIdentifiers(content.body).join(' ')
  ]
    .filter(Boolean)
    .join(' ');
  return {
    titleTokens: indexed ? keyedLexemeLine(content.title ?? '', key) : '',
    tagTokens: indexed ? keyedLexemeLine(tags.join(' '), key) : '',
    aliasTokens: indexed ? keyedAliasLine(aliasSurface, key) : '',
    bodyTokens: indexed
      ? bodyLexemes
          .slice(0, MAX_INDEXED_TOKENS)
          .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
          .join(' ')
      : '',
    tagsHashed: [
      ...new Set(
        tags.flatMap((tag) =>
          memoryLexemes(tag).map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
        )
      )
    ].sort(),
    trigrams: indexed ? keyedTrigramSet(fuzzySurface, key) : [],
    subjectKey: content.subject ? memorySubjectKey(content.subject, key) : null,
    objectKey: content.object ? memoryObjectKey(content.object, key) : null,
    dedupeKey: keyedToken(
      'dedupe',
      normalizeMemoryTerm(`${content.title ?? ''} ${content.body}`),
      key,
      KEY_TOKEN_CHARS
    ),
    tokensEst: estimateMemoryTokens(
      [content.title ?? '', tags.join(' '), content.body].join('\n').trim()
    ),
    indexed
  };
};

export interface MemorySourceIndex {
  readonly bodyTokens: string;
  readonly tokensEst: number;
  readonly indexed: boolean;
}

export const buildMemorySourceIndex = (body: string, key: Uint8Array): MemorySourceIndex => {
  const lexemes = memoryLexemes(body);
  const indexed = !poisonsLexicalIndex(body, lexemes);
  if (!indexed) return { bodyTokens: '', tokensEst: estimateMemoryTokens(body), indexed };
  // A verbatim row has one field, so its aliases ride at the end of the same D-weight surface.
  // Positions past the body are meaningless for cover density, which only ranks item titles.
  const aliases = memoryAliasLexemes(memoryIdentifiers(body).join(' ')).slice(0, MAX_ALIAS_TOKENS);
  return {
    bodyTokens: [...lexemes.slice(0, MAX_INDEXED_TOKENS), ...aliases]
      .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
      .join(' '),
    tokensEst: estimateMemoryTokens(body),
    indexed
  };
};

/**
 * How much of a conversation's opening request is indexed beside its name.
 *
 * The name has no bound worth applying - it is a line. The request has none at all: a conversation
 * can open with a pasted document, and a tsvector of every lexeme of one, on every conversation
 * ever started, is a second copy of the corpus attached to a table that is read on every page load.
 *
 * This is the only surface the whole request would have bought, and it is a narrow one. From the
 * moment the first answer lands the request is in the verbatim corpus in full, chunked and indexed,
 * and reachable there at any age. What this covers is the gap before that - a conversation the
 * owner started, went to make coffee, and came back to search for. Two thousand characters is more
 * than anyone types into that gap, and for a pasted document it is the opening they would search by
 * rather than page eleven of it.
 */
export const MAX_INDEXED_OPENING_CHARS = 2_000;

/**
 * The band of prefixes a conversation's name is findable by.
 *
 * A person searching their own history types the first few letters of a word they half remember
 * and waits for the list to narrow. The index matches whole stemmed lexemes, so `grimbold` cannot
 * reach a conversation called *Grimbolder audit* however it is planned - a keyed token is not a
 * string the database can match the front of, which is the price of the plaintext never being
 * there. The only way a prefix becomes matchable is for it to have been indexed as a token in its
 * own right, so that is what happens here, at write time, under the same key.
 *
 * Three at the short end because two letters narrow nothing on any real history - the list still
 * holds most of the box - and because a two-letter prefix is the rung a frequency attack on a
 * stolen database labels first. Twenty-four at the long end because nobody types more of one word
 * than that, and because it is the bound that stops a pasted path in a name from indexing itself
 * once per character. A query longer than the band uses its first twenty-four characters, which
 * can only over-match, and twenty-four characters of agreement is a match by any reading.
 *
 * The request is deliberately not prefixed. It is up to two thousand characters, which is a couple
 * of hundred lexemes and would be a couple of thousand prefixes, on a column read on every page
 * load - the corpus twice over to buy the second half of a surface the reader already has by name.
 */
const MIN_NAME_PREFIX_CHARS = 3;
const MAX_NAME_PREFIX_CHARS = 24;
/** A name needing more prefixes than this is a pasted line; its whole words are indexed regardless. */
const MAX_NAME_PREFIX_TOKENS = 128;

/**
 * Every prefix, within the band, of every word a name is findable by.
 *
 * Both surfaces the name already has, because a prefix has to reach whatever the whole word
 * reaches: `garden-relay` for its exact name, and the `garden` and `relay` its alias expansion
 * produced, so `rel` narrows to it the way `relay` already does.
 *
 * Whole chains first, in the order the words were found, because the bound below cuts the tail off
 * this list: keeping a word's rungs together means a name too long to index entirely loses whole
 * words from the end rather than losing the middle of every word it has.
 */
const namePrefixes = (name: string): string[] => {
  const prefixes = new Set<string>();
  for (const lexeme of [...memoryLexemes(name), ...memoryAliasLexemes(name)]) {
    const longest = Math.min(lexeme.length, MAX_NAME_PREFIX_CHARS);
    for (let chars = MIN_NAME_PREFIX_CHARS; chars <= longest; chars += 1)
      prefixes.add(lexeme.slice(0, chars));
  }
  return [...prefixes];
};

/**
 * The prefix token a half-typed request is looking for, or nothing when it is not looking for one.
 *
 * Only the last word, because that is the only one a person is in the middle of. Everything before
 * it they finished typing and meant as a word, and treating a finished word as a prefix would
 * quietly widen every search anyone ever ran. There is no trailing space to consult either way -
 * the route trims the query before it gets here.
 *
 * The same stemmer as the index, for the same reason the rest of this file uses it: a half-typed
 * `releas` and an indexed `released` have to arrive at the same place.
 */
export const conversationNamePrefixTokens = (query: string, key: Uint8Array): string[] => {
  const words = query.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? [];
  const last = words.at(-1)?.replace(TRAILING_PUNCTUATION, '') ?? '';
  if (!last || memoryStopWords.has(last)) return [];
  const stemmed = PLAIN_WORD.test(last) ? stemPlainWord(last) : last;
  if (stemmed.length < MIN_NAME_PREFIX_CHARS) return [];
  return [keyedToken('pre', stemmed.slice(0, MAX_NAME_PREFIX_CHARS), key, LEXEME_TOKEN_CHARS)];
};

/**
 * Which shape of name vector a row carries, written into every one of them.
 *
 * A row indexed before prefixes existed is not distinguishable from a fresh one by looking at it:
 * a name of one short word indexes to no prefixes at all, so "has no prefix tokens" and "was
 * written by the old indexer" are the same picture, and a backfill that guessed would either miss
 * the whole history or re-read it on every boot forever. Stamping the shape makes the question
 * exact, and makes the next change to this vector a one-line bump rather than a migration that
 * cannot reach the tokens anyway.
 *
 * Unkeyed on purpose - it is the same value in every workspace and on every box, so it says
 * nothing about any owner. It is drawn from the same alphabet as a keyed token so it can be handed
 * to `to_tsvector` and `tsquery` on the same terms, and it is longer than any of them so it can
 * never be mistaken for one.
 *
 * At v3 because v2 wrote its prefixes in the order of the words they came from, which put the
 * alphabetical order of the plaintext into the positions the vector keeps. Any row a box wrote in
 * that shape has to be read again rather than left sitting there saying it, and this is the line
 * that asks for it.
 */
export const CONVERSATION_NAME_INDEX_STAMP = encodeToken(
  createHash('sha256').update('garden-conversation-name-index-v3-sorted-prefixes').digest(),
  20
);

/**
 * The keyed surfaces a conversation is findable by before anything it said was captured: what it
 * is called, the prefixes of what it is called, and what it was asked to do.
 *
 * The name and the request go through `buildMemorySourceIndex`, which is the same tokenizer, the
 * same stemmer, the same alias expansion and the same keyed token space the verbatim corpus uses -
 * so a query planned by `planMemoryQuery` matches a conversation's name exactly as it matches its
 * transcript, and there is no second indexer to drift away from the first. Running it twice rather
 * than over one joined string is what keeps a pasted-blob request from taking the name down with
 * it: the blob guard fires on the request alone and the name is still indexed.
 *
 * The prefixes sit in their own domain rather than beside the whole words, so a row that matched
 * `grimbold` as a prefix can be told apart from one whose name is that word, and ranked below it.
 *
 * They are also sorted after they are keyed, which matters more than it looks. A tsvector keeps the
 * position of every lexeme it was given, so whatever order this line hands over is written down and
 * can be read back off a stolen database. Handing over the prefixes in the order of the words they
 * came from would publish, row by row, which keyed token sorts before which - and one such row is
 * harmless where a history of them is not: merged across a few hundred conversations they compose
 * into a near-total alphabetical order over the whole prefix vocabulary, and an alphabetical order
 * over a set as guessable as "the first three letters of an English word" is most of the way to
 * reading the names back. Sorting by the token puts each one where its own value says it goes,
 * which is something the reader can already work out from the token, so the positions say nothing
 * the tokens did not already say.
 */
export interface ConversationNameIndex {
  /** Keyed lexemes of the conversation's own name; indexed above the request. */
  readonly nameTokens: string;
  /**
   * Keyed prefixes of those lexemes. Optional because a caller with nothing to index says so by
   * passing empty strings, and a name whose every word is a stop word has none of these either.
   */
  readonly prefixTokens?: string;
  /** Keyed lexemes of the opening of the request, bounded by `MAX_INDEXED_OPENING_CHARS`. */
  readonly openingTokens: string;
}

export const buildConversationNameIndex = (
  name: string,
  opening: string,
  key: Uint8Array
): ConversationNameIndex => {
  const named = buildMemorySourceIndex(name, key);
  return {
    nameTokens: named.bodyTokens,
    // Only when the name was indexable at all: a name the blob guard refused must not come back in
    // through its prefixes.
    prefixTokens: named.indexed
      ? namePrefixes(name)
          .slice(0, MAX_NAME_PREFIX_TOKENS)
          .map((prefix) => keyedToken('pre', prefix, key, LEXEME_TOKEN_CHARS))
          .sort()
          .join(' ')
      : '',
    openingTokens: buildMemorySourceIndex(opening.slice(0, MAX_INDEXED_OPENING_CHARS), key)
      .bodyTokens
  };
};

/* ------------------------------------------------------------------------ *
 * Excerpting
 * ------------------------------------------------------------------------ */

/** Wide enough to carry a whole exchange, short enough that twelve of them are not a context. */
export const MEMORY_EXCERPT_CHARS = 480;

/**
 * The passage of a stored body that actually answers the query.
 *
 * A verbatim row is up to 6 KB, and returning all of it for every hit is how a search result costs
 * more than the answer is worth. The window is chosen by the same stemmed lexemes the index matched
 * on, so a hit found by "restarted" is shown at the line that says "restart" - a substring search
 * over the raw query cannot find that position at all, and silently excerpts from character zero.
 *
 * Ties break towards the earliest window: when two passages cover the same terms equally well, the
 * first one is the one the reader would have found by scrolling.
 */
export const memoryExcerpt = (
  body: string,
  query: string,
  options: { readonly maxChars?: number } = {}
): string => {
  const maxChars = Math.max(80, Math.trunc(options.maxChars ?? MEMORY_EXCERPT_CHARS));
  // Runs of spaces collapse, single newlines survive: a transcript of command output is unreadable
  // as one line, and a blank-line-separated wall is mostly padding.
  const text = body
    .normalize('NFKC')
    .replace(/\r\n/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const clip = (start: number, end: number): string =>
    `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
  if (text.length <= maxChars) return text;

  // The query's own words and the parts of its compound terms, symmetrically with the alias surface
  // the index matched on: a row admitted because `garden-relay` contains `relay` has to be
  // excerpted at that name, not at the first prose word that happened to agree.
  const wanted = new Set([...memoryLexemes(query), ...memoryAliasLexemes(query)]);
  const hits = locatedLexemes(text).filter(
    (entry) =>
      wanted.has(entry.lexeme) ||
      (!PLAIN_WORD.test(entry.lexeme) &&
        memoryAliasLexemes(entry.lexeme).some((part) => wanted.has(part)))
  );
  if (hits.length === 0) return clip(0, maxChars);

  // Best window: most distinct query terms covered inside `maxChars`, then the tightest span that
  // covers them, then earliest. Tightness matters more than hit count - a window that repeats one
  // term ten times covers less of the question than a short one carrying three different terms, and
  // ranking by count alone chose the repetitive one. Every candidate starts at a hit, because a
  // window starting anywhere else covers no more terms than the next hit's window does.
  let best = { start: hits[0]!.at, distinct: 0, span: Number.POSITIVE_INFINITY };
  for (const [index, anchor] of hits.entries()) {
    const seen = new Set<string>();
    let span = 0;
    for (let cursor = index; cursor < hits.length; cursor += 1) {
      const hit = hits[cursor]!;
      const reach = hit.at + hit.lexeme.length - anchor.at;
      if (reach > maxChars) break;
      if (!seen.has(hit.lexeme)) span = reach;
      seen.add(hit.lexeme);
    }
    if (seen.size > best.distinct || (seen.size === best.distinct && span < best.span))
      best = { start: anchor.at, distinct: seen.size, span };
  }

  // Centre the covered span rather than starting on it, so the sentence the match sits in survives.
  const span = Math.min(maxChars, text.length);
  let start = Math.max(0, Math.min(best.start - Math.floor(span / 4), text.length - span));
  // Snap to a word boundary so an excerpt never opens mid-token.
  if (start > 0) {
    const boundary = text.lastIndexOf(' ', start);
    if (boundary > start - 24) start = boundary + 1;
  }
  return clip(start, Math.min(text.length, start + span));
};

/* ------------------------------------------------------------------------ *
 * Query planning
 * ------------------------------------------------------------------------ */

// "What did I use before?" must be able to reach retired facts; a present-tense question must not.
const TEMPORAL_INTENT =
  /\b(used to|use to|previously|formerly|no longer|back then|originally|before (?:i|we|you|it|the)|last (?:year|month|week)|in (?:19|20)\d{2})\b/iu;

/**
 * Sanity bounds, not selection.
 *
 * These used to be 24 apiece, applied as `.sort().slice(24)` over the *keyed* tokens - and an HMAC
 * output sorts as noise, so which two dozen of a request's terms reached the database was
 * pseudorandom with respect to meaning. On a realistic opening request that discarded `dovecot`,
 * `imap_idle_notify_interval`, `connector` and `reboot` while keeping `morn`, `week`, `which` and
 * `if`. Selection belongs to the database: it is the only party that knows document frequency, and
 * `MEMORY_RECALL_SQL`'s `terms` CTE already orders by it. These caps exist only so a pathological
 * request cannot hand PostgreSQL an unbounded array.
 */
const MAX_QUERY_LEXEMES = 512;
const MAX_QUERY_ENTITY_KEYS = 256;
const MAX_QUERY_TRIGRAMS = 240;

export interface MemoryQueryPlan {
  /**
   * Every keyed content lexeme of the request, plus the component words of its compound terms.
   * Deduped and bounded but never selected from here: the database keeps the rarest of them.
   */
  readonly lexemes: string[];
  /** Keyed trigrams of identifier-shaped query terms; drives the fuzzy channel. */
  readonly trigrams: string[];
  /** Keyed subject keys for unigrams and bigrams, so facts about a named thing are pulled exactly. */
  readonly entityKeys: string[];
  /** Keyed lexemes used to match procedure tags. */
  readonly tagTokens: string[];
  readonly temporalIntent: boolean;
}

export const planMemoryQuery = (
  query: string,
  key: Uint8Array,
  options: { readonly entities?: readonly string[] } = {}
): MemoryQueryPlan => {
  // The request's own words and the parts of its compound terms, symmetrically with the alias
  // surface every indexed row carries: `garden-relay` in the request reaches an entry that only
  // says `relay`, and `relay` reaches one that only says `garden-relay`.
  const lexemes = [...memoryLexemes(query), ...memoryAliasLexemes(query)];
  const keyedLexemes = [
    ...new Set(lexemes.map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS)))
  ]
    .sort()
    .slice(0, MAX_QUERY_LEXEMES);

  const rawTerms = (query.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? [])
    .map((term) => term.replace(TRAILING_PUNCTUATION, ''))
    .filter((term) => term.length >= 2 && !memoryStopWords.has(term));
  const entityCandidates = new Set<string>(options.entities?.map(normalizeMemoryTerm) ?? []);
  for (let index = 0; index < rawTerms.length; index += 1) {
    entityCandidates.add(rawTerms[index]!);
    const next = rawTerms[index + 1];
    if (next) entityCandidates.add(`${rawTerms[index]!} ${next}`);
  }

  const identifiers = memoryIdentifiers(query);
  return {
    lexemes: keyedLexemes,
    trigrams: [...new Set(keyedTrigramSet(identifiers.join(' '), key))]
      .sort()
      .slice(0, MAX_QUERY_TRIGRAMS),
    entityKeys: [...entityCandidates]
      .map((term) => memorySubjectKey(term, key))
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort()
      .slice(0, MAX_QUERY_ENTITY_KEYS),
    tagTokens: keyedLexemes,
    temporalIntent: TEMPORAL_INTENT.test(query)
  };
};

/* ------------------------------------------------------------------------ *
 * Packing quotas
 * ------------------------------------------------------------------------ */

export interface MemoryPackQuota {
  readonly kind: MemoryKind;
  /** Fraction of the token budget this slot may take before other slots get their turn. */
  readonly share: number;
  readonly cap: number;
  /** Per-subject cap; keeps one loud entity from taking the whole fact slot. */
  readonly perSubject: number;
}

/**
 * Top-k by fused score starves whichever channel has a flatter score distribution, so the pack is
 * filled per kind. Shares follow the design's verbatim-vs-artifact split: verbatim source keeps a
 * fifth of the budget because replacing it with extracted facts measurably loses accuracy.
 */
export const MEMORY_PACK_QUOTAS: readonly MemoryPackQuota[] = [
  { kind: 'fact', share: 0.35, cap: 25, perSubject: 4 },
  { kind: 'procedure', share: 0.15, cap: 5, perSubject: 5 },
  { kind: 'episode', share: 0.3, cap: 8, perSubject: 8 },
  { kind: 'source', share: 0.2, cap: 6, perSubject: 6 }
];

/**
 * What a kind with no quota entry gets. The recall query joins the quota table by kind, so an
 * unquota'd kind would be ranked and then silently dropped. A named fallback makes a missing quota
 * a small allowance rather than a hole; `MEMORY_PACK_QUOTAS` covering every kind is asserted in
 * the tests so the two lists cannot drift apart unnoticed.
 */
export const MEMORY_PACK_DEFAULT_QUOTA: Omit<MemoryPackQuota, 'kind'> = {
  share: 0.05,
  cap: 4,
  perSubject: 2
};

/**
 * Mirrors pg_trgm's default `similarity_threshold`. Without it a single shared padding trigram -
 * two unrelated strings both containing a word starting with "t" - is enough to admit a row.
 */
export const MEMORY_FUZZY_SIMILARITY_THRESHOLD = 0.3;

export const MEMORY_PACK_BUDGET_TOKENS = 6_000;

/* ------------------------------------------------------------------------ *
 * Agent-initiated recall
 *
 * The pack is chosen once, from the opening request, and frozen so the prompt cache survives. That
 * is the right trade for what a task opens with and the wrong one for what it turns out to need: an
 * entity, a path or a decision the first sentence never mentioned is unreachable for the rest of the
 * task, however relevant it is. Recall is the same fusion query asked again, mid-task, in the
 * agent's own words - and because its result lands at the end of the message list rather than in the
 * cached prefix, asking costs the query and the answer, and nothing behind it.
 * ------------------------------------------------------------------------ */

/**
 * A quarter of the pack. A recall answers one question the task already knows it has, so it is
 * bought with the tokens of a long tool result rather than the tokens of a second pack.
 */
export const MEMORY_RECALL_BUDGET_TOKENS = 1_500;
/**
 * There was a `MEMORY_RECALL_MAX_BUDGET_TOKENS = 4_000` here, the ceiling of a clamp on a
 * `budgetTokens` the tool schema never declared and `additionalProperties: false` therefore
 * refused. No model has ever been able to ask for more than the figure above, so the ceiling was
 * a tuned-looking number governing nothing - and a maintainer reading it would have taken the
 * recall budget for something the agent negotiates. Deleted rather than wired: `maxItems` below is
 * already the dial for how much recall costs (ATH-164).
 */
export const MEMORY_RECALL_MAX_ITEMS = 12;
export const MEMORY_RECALL_ITEM_CEILING = 40;

/**
 * Even shares, unlike the pack's.
 *
 * The pack is answering "what does this task need to know", where verbatim text earns a fifth of the
 * budget because facts alone measurably lose accuracy. A recall is answering one narrow question,
 * and which tier holds its answer is exactly what the asker does not know - so no tier is given a
 * head start, and `kinds` is there for an agent that does know.
 */
export const MEMORY_RECALL_QUOTAS: readonly MemoryPackQuota[] = MEMORY_KINDS.map((kind) => ({
  kind,
  share: 0.5,
  cap: MEMORY_RECALL_ITEM_CEILING,
  perSubject: 4
}));

/** A procedure that has not been verified within this window stops being injected. */
export const MEMORY_PROCEDURE_STALE_DAYS = 180;
export const MEMORY_PROCEDURE_MIN_SUCCESS_RATE = 0.5;

/* ------------------------------------------------------------------------ *
 * How a memory's own history is scored
 *
 * `consolidateMemory` recomputes three activations per row from `mem.item_use` - how much the row
 * has been packed, how much the model reached for it, how much it failed when used - z-scores each
 * against the workspace, and writes the weighted sum to `mem.item.salience`, which `mem.prior`
 * multiplies onto the fused rank at query time.
 *
 * WHAT WAS HERE BEFORE: `count(*) FILTER (WHERE used_at > now - INTERVAL '90 days')`. A use on day
 * 89 counted in full and a use on day 91 counted zero, so an owner returning from a three-month
 * break found every row's usage history erased in a single step - measured on a seeded copy of
 * this owner's workspace, 191 of 191 rows had a nonzero salience at an 89-day break and 2 of 191
 * at a 91-day break, the two survivors being pinned. Inside the window nothing decayed at all, so
 * fifty uses massed into one week and fifty spread over a year scored identically. Neither
 * behaviour is anywhere in the owner's data: on their own transcripts a power law beats an
 * exponential on the need curve by AIC +958 (`file`, 188,290 trials) and +550 (`topic`, 320,520),
 * and every distribution family that fits at all has a decreasing hazard and unbounded support.
 *
 * WHAT IS HERE NOW is Anderson & Schooler's (1991) result as ACT-R operationalises it - the
 * probability an item is needed again decays as a power law in the time since it was last needed,
 * and the activation of a memory is the log of a power-law sum over EVERY prior use:
 *
 *     B = ln( 1 + SUM_j max(age_days(j), MEMORY_USE_AGE_FLOOR_DAYS) ^ -MEMORY_USE_DECAY_EXPONENT )
 *
 * No window and no floor: `t^-d > 0` for every finite `t`, so "further away, never gone" is a
 * property of the shape rather than a constant somebody had to choose. A use from ten years ago
 * contributes 0.0166 where a use from one day ago contributes 1.0 - small, and never absent.
 *
 * WHAT THE WINDOW WAS ALSO DOING, AND THIS DOES NOT. `recallMemory` records a use for every row it
 * returns (`apps/worker/src/memory-runtime.ts`), uncited and outcome `unknown`, so the score has a
 * feedback path into itself: a row that gets packed is thereby more likely to be packed again. A
 * count inside 90 days let an unearned lead expire; a sum that decays as `t^-d` and never reaches
 * zero does not. Measured on two rows built identically - same body, same observation date, ten
 * cited uses each on the same ten days - the first pack was decided by `ORDER BY score DESC, id`
 * on a random UUID, and sixty turns later the winner held 70 uses to 10 and a salience of +0.5
 * against -0.5, unchanged when the clock is advanced one year and ten. Nothing about the two rows
 * differs except which id sorted first. This is a property of the loop rather than of the curve -
 * the same lock-in happens under the window, which only releases it after ninety idle days - and
 * it is written down here because it is the cost of removing the window and nothing measures it.
 * The fix, if it is wanted, is on the writer and not on `d`: an uncited use with an unknown
 * outcome is the system agreeing with itself, and it could reasonably be recorded at a lower
 * weight than one the model cited or the harness graded.
 * ------------------------------------------------------------------------ */

/**
 * The power-law exponent, `d`.
 *
 * CHOSEN, not fitted, and the distinction is the honest one. What this owner's corpus DOES
 * establish is the SHAPE: on 685 owner turns / 235,236 characters / 11 projects / 49 active days
 * (2026-04-16..08-31), a power law beats an exponential on the need curve by AIC +1,525 and +922
 * on the `file` stream under a calendar and an active-day clock, and +19,840 and +7,603 on
 * `topic`. Four constructions, four times the same answer: decreasing hazard, unbounded support,
 * no cliff. That is the part of Anderson & Schooler (1991) this corpus replicates, and it is the
 * part the score depends on.
 *
 * THE EXPONENT ITSELF IS NOT IDENTIFIED BY THIS CORPUS, and three independent constructions of it
 * on the same transcripts disagree by more than 4x: an aggregate need-curve fit gives 0.4589 at
 * the memory-item grain, 0.7300 on `topic` and 1.4000 on `file` (95% bootstrap [1.3500, 1.4450],
 * which excludes 0.5 as firmly as the item-grain interval excludes 0.25) - aggregate need curves
 * mix items of different base rates and steepen with the mixture, so the number moves with the
 * population, not with the memory. Held-out day-ahead ranking does not settle it either: pooled
 * AUC rises monotonically across the band, 0.8555 at `d` = 0.25 to 0.8638 at 0.50 and 0.8656 at
 * 0.60, and the two streams' argmaxes are 4x apart (`file` near 1.00 at 0.8689, `topic` near 0.25
 * at 0.8751). So 0.5 is ACT-R's canonical value, taken from the literature, and what this corpus
 * says about it is only that it is inside every interval measured here and is never the worst
 * choice on any of them.
 *
 * WHAT WOULD CHANGE IT: a measurement that separates the exponent from the population it is
 * averaged over - a per-item fit with enough returns per item to be stable, on a corpus spanning
 * more than one project era, since roughly 90% of this one's tool volume falls inside its final
 * 32 days. Not another aggregate need curve: that is the construction that gave three answers.
 */
export const MEMORY_USE_DECAY_EXPONENT = 0.5;

/**
 * The youngest age a use may be scored at, in days. 0.01 d = 14.4 minutes.
 *
 * DERIVED, and load-bearing rather than a formality: `t^-d` diverges at `t = 0`, and consolidation
 * runs at the end of the same turn that recorded the use, so the most recent use of every packed
 * row really is seconds old when this is evaluated. The floor is therefore what sets the ceiling
 * on one use's contribution - `0.01^-0.5` = 10 activation units, against 1.0 for a use one day old.
 *
 * The value is the median gap between two consecutive turns inside one session on this owner's
 * corpus: 642 gaps across 42 sessions, median 14.53 min, Q1 3.30 min, Q3 67.77 min. Two uses in
 * one session must not read as simultaneous, so the floor cannot exceed the median inter-turn gap;
 * and nothing finer is measurable, because a use is recorded once per turn.
 *
 * WHAT WOULD CHANGE IT: a shift in that median. Note that the day-grain analysis of return
 * intervals has NO evidence about this number in either direction - ages there are whole days, so
 * every floor from 0.001 to 1.0 days gives bit-identical held-out AUC. This is derived from the
 * session record and from nowhere else.
 */
export const MEMORY_USE_AGE_FLOOR_DAYS = 0.01;

/**
 * The three weights on the three z-scored activations.
 *
 * The signals: `use` is a use the harness did not watch fail, `fail` is one it did, and `cite` is
 * a use the model reached for in its answer. So `use` and `fail` PARTITION the uses and `cite` is
 * a subset of both - which is what makes the weights comparable at all, and is the shape the
 * shipped formula did not have.
 *
 * `MEMORY_SALIENCE_FAIL_WEIGHT` is DERIVED: it equals the use weight exactly. The same event,
 * graded the other way, has to move the score by the same magnitude in the other direction;
 * anything else asserts that a success and a failure are different sizes of evidence, and nothing
 * here measures that. It is what makes the term reinforcement rather than a discount - a row whose
 * every use failed scores below a row that has never been used at all, because its successes are
 * an empty sum AND it carries the whole of the negative one.
 *
 * WHAT THIS REPLACES: `- 0.30 * (neg_count / use_count)`. `neg_count`'s only writer also set
 * `status = 'retracted'`, which no admission predicate admits, so the term was identically zero
 * for every row recall could return - a row that failed ten uses out of ten scored +0.70, the
 * highest salience in its workspace, against -0.70 for a row that had never failed. The evidence
 * was never missing: `recordMemoryUse` has written `outcome='fail'` onto the use row all along and
 * only the procedure-health gate read it. And 0.30 was a weight on a rate in [0,1] sitting beside
 * two z-scores, so "more per unit than citation" was not a comparison that could be made. All
 * three are now z-scores of the same construction and 0.50 > 0.20 says what it looks like.
 *
 * WHAT WOULD CHANGE 0.50 / 0.20: they were not measured. The two signals correlate at r = 0.9344
 * on this owner's data, which is set nesting rather than redundancy, so equalising them is not the
 * free correction it looks like. A corpus where citation and packing genuinely diverge, or a
 * measurement of how often a cited row answers the question against how often a merely packed one
 * does.
 */
export const MEMORY_SALIENCE_USE_WEIGHT = 0.5;
export const MEMORY_SALIENCE_CITE_WEIGHT = 0.2;
export const MEMORY_SALIENCE_FAIL_WEIGHT = MEMORY_SALIENCE_USE_WEIGHT;

/* ------------------------------------------------------------------------ *
 * Dead ends
 *
 * A procedure is written when the harness watches an acceptance command pass, and nothing at all is
 * written when it watches one fail - so the box remembers every route that worked and walks back
 * into every route that did not. This is the missing half, and it is built out of the same evidence:
 * a command the harness ran itself, its working directory, and the result it observed.
 *
 * It is the more dangerous half. "This worked" is wrong only if the machine has changed; "this did
 * not work" is wrong the moment anything downstream of it changes, and it is wrong in the direction
 * that talks the next turn out of the approach that would now succeed. Three things hold that edge:
 * it is written in the past tense about one run rather than as a rule; it carries a validity window
 * an order of magnitude shorter than a procedure's, after which the retrieval prior discounts it
 * almost to nothing; and the same command observed passing retires it outright, which is the
 * store's existing supersession rather than a second lifecycle invented here.
 * ------------------------------------------------------------------------ */

/**
 * The tag every dead end carries. Hyphenated on purpose: the tokenizer keeps it whole rather than
 * stemming it to `fail`, so an ordinary question about something that failed does not pull every
 * dead end in the workspace into the structural channel on the strength of one word.
 */
export const MEMORY_DEAD_END_TAG = 'check-failed';

/**
 * The keyed form of that tag. The database holds no plaintext, so this is the only handle it has on
 * the rows a later success has to retire.
 */
export const memoryDeadEndTagKey = (key: Uint8Array): string =>
  keyedToken('lex', MEMORY_DEAD_END_TAG, key, LEXEME_TOKEN_CHARS);

/**
 * How long one observed failure is worth carrying. Two weeks against a procedure's 180 days: a
 * command that succeeded says something about how this project is built, where a command that
 * failed says something about the state it was in on one afternoon, and that state is exactly what
 * later work sets out to change.
 */
export const MEMORY_DEAD_END_TRUST_DAYS = 14;

/** Enough for the first line of a compiler or test failure, and nothing like enough for a log. */
const MEMORY_DEAD_END_DETAIL_CHARS = 240;

export interface MemoryDeadEndCheck {
  readonly label: string;
  /** Executable and arguments as one line, matching the subject a passing run is keyed on. */
  readonly command: string;
  readonly cwd: string;
  /** What the harness reported. Redacted by the caller: this is command output. */
  readonly detail: string;
}

/**
 * Keyed on the command exactly as a passing run is, so both sides of one command share a subject
 * and the pack ranks them against each other instead of in separate worlds.
 */
export const deadEndFromCheck = (
  check: MemoryDeadEndCheck,
  observedAt: Date,
  indexKey: Uint8Array
): { content: MemoryItemContent; index: MemoryItemIndex; validTo: Date } => {
  const command = check.command.slice(0, 400);
  const content: MemoryItemContent = {
    title: check.label.slice(0, 200),
    subject: command,
    tags: [MEMORY_DEAD_END_TAG],
    // What was observed, and the bound on it in the same breath. The sentence deliberately never
    // says the command is broken: the harness saw one run end this way, which is a smaller claim
    // and the only one it can support.
    body:
      `In ${check.cwd}, \`${command}\` did not pass when the harness last ran it: ` +
      `${check.detail.slice(0, MEMORY_DEAD_END_DETAIL_CHARS)}. ` +
      'Running it again is what settles whether that is still true.'
  };
  return {
    content,
    index: buildMemoryItemIndex(content, indexKey),
    validTo: new Date(observedAt.getTime() + MEMORY_DEAD_END_TRUST_DAYS * 86_400_000)
  };
};

/* ------------------------------------------------------------------------ *
 * Contradiction resolution policy
 * ------------------------------------------------------------------------ */

export type MemoryContradictionVerdict = 'agree' | 'contradict' | 'refines' | 'unrelated';

export type MemoryContradictionAction =
  | { readonly action: 'none' }
  | { readonly action: 'supersede'; readonly winnerId: string; readonly loserId: string }
  | { readonly action: 'retract'; readonly winnerId: string; readonly loserId: string }
  | { readonly action: 'dispute'; readonly ids: readonly [string, string] }
  | { readonly action: 'support'; readonly ids: readonly [string, string] };

export interface MemoryContradictionSide {
  readonly id: string;
  readonly trust: MemoryTrust;
  readonly observedAt: string;
}

/**
 * The resolution half of section 4.3: deterministic given a verdict, so the only thing a model is ever
 * asked for is the verdict itself. Two things the owner stated that genuinely conflict are never
 * auto-resolved - single-owner is exactly why asking is affordable.
 *
 * What is wired, and what is not, because the difference decides whether this is dead code:
 *
 * The `dispute` arm has a destination. `markMemoryFactsDisputed` writes the status and the
 * `contradicts` links as one statement, `listDisputedMemoryItems` reads them back, and the review
 * queue at `GET /v1/workspaces/:id/memory-review` serves them to the owner beside the stale
 * procedures, with `retract` and `verify` as the two answers. That path is tested end to end.
 *
 * Path A, the deterministic engine, is live on the write path: `recordMemoryFact` retires the
 * previous value of a `cardinality: 'one'` predicate without a model call, which is `supersede`
 * reached by a different and cheaper route.
 *
 * *Path B* - the nightly pass - now exists for the half of it that needs no model.
 * `consolidateMemory` pairs the current facts a subject holds under one predicate and, where the
 * registry declares that predicate `cardinality: 'one'`, hands this function the verdict the
 * registry has already given: two different current values of a one-valued predicate contradict,
 * by definition. Those pairs are real and were unreachable by any other route - a release that
 * narrows a cardinality leaves them behind deliberately (see `#backfillPredicateFunctional`, whose
 * own comment promises they will be resolved "the ordinary way", which until now nothing did).
 *
 * What is still absent is a verdict over pairs under a `many` predicate, where "do these two
 * disagree" is a question about meaning rather than about the schema. That pass calls this same
 * table with a verdict it has bought from a model, which is exactly why the table takes one rather
 * than deciding for itself.
 */
export const resolveMemoryContradiction = (
  left: MemoryContradictionSide,
  right: MemoryContradictionSide,
  verdict: MemoryContradictionVerdict
): MemoryContradictionAction => {
  if (verdict === 'unrelated' || verdict === 'agree') return { action: 'none' };
  if (verdict === 'refines') return { action: 'support', ids: [left.id, right.id] };
  if (left.trust === 'stated' && right.trust === 'stated')
    return { action: 'dispute', ids: [left.id, right.id] };
  if (left.trust === 'stated') return { action: 'retract', winnerId: left.id, loserId: right.id };
  if (right.trust === 'stated') return { action: 'retract', winnerId: right.id, loserId: left.id };
  const leftNewer = new Date(left.observedAt).getTime() >= new Date(right.observedAt).getTime();
  return leftNewer
    ? { action: 'supersede', winnerId: left.id, loserId: right.id }
    : { action: 'supersede', winnerId: right.id, loserId: left.id };
};

/* ------------------------------------------------------------------------ *
 * Byte-stable pack rendering
 * ------------------------------------------------------------------------ */

export interface MemoryPackEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly trust: MemoryTrust;
  readonly observedAt: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly body: string;
}

export interface RenderedMemoryPack {
  readonly body: string;
  readonly sha256: string;
  readonly itemIds: string[];
  readonly tokensEst: number;
}

/**
 * What the open end of a validity interval is rendered as.
 *
 * It used to be nothing at all - `valid=2026-07-01T00:00:00.000Z/` - and the block's own header
 * explains what an entry whose validity has *ended* means while saying nothing about the empty
 * side. A trailing separator with nothing after it is the one shape a reader has to guess at: it
 * reads equally as "no end recorded", "the end was lost" and "the string was truncated", and the
 * third reading is the dangerous one because it invites the model to discount a current fact. One
 * word settles it, costs three tokens on entries that are by definition the live ones, and is a
 * word rather than an instant because there is no instant to write: the interval is open, and
 * `9999-12-31` would be a fact nobody stated.
 */
export const MEMORY_PACK_OPEN_INTERVAL = 'Present';

const PACK_SECTIONS: readonly { readonly kind: MemoryKind; readonly heading: string }[] = [
  { kind: 'fact', heading: 'Facts' },
  { kind: 'procedure', heading: 'Procedures' },
  { kind: 'episode', heading: 'Episodes' },
  { kind: 'source', heading: 'Verbatim' }
];

const isoInstant = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new GardenError('memory_pack_timestamp_invalid', 'Memory pack timestamps must be dates');
  return parsed.toISOString();
};

/**
 * The pack sits behind a prompt-cache breakpoint, so the same items must always produce the same
 * bytes: entries are ordered by (kind, id) rather than by score, every timestamp is absolute
 * ISO-8601, and nothing derived from the current time or from a request identifier is rendered.
 */
export const renderMemoryPack = (entries: readonly MemoryPackEntry[]): RenderedMemoryPack => {
  const kindOrder = new Map(PACK_SECTIONS.map((section, index) => [section.kind, index]));
  const unique = new Map<string, MemoryPackEntry>();
  for (const entry of entries) unique.set(entry.id, entry);
  const ordered = [...unique.values()].sort(
    (left, right) =>
      (kindOrder.get(left.kind) ?? PACK_SECTIONS.length) -
        (kindOrder.get(right.kind) ?? PACK_SECTIONS.length) || left.id.localeCompare(right.id)
  );

  const lines: string[] = ['# MEMORY PACK'];
  for (const section of PACK_SECTIONS) {
    const members = ordered.filter((entry) => entry.kind === section.kind);
    if (members.length === 0) continue;
    lines.push('', `## ${section.heading}`);
    for (const entry of members) {
      const validity = entry.validTo
        ? `${isoInstant(entry.validFrom)}/${isoInstant(entry.validTo)}`
        : `${isoInstant(entry.validFrom)}/${MEMORY_PACK_OPEN_INTERVAL}`;
      const head = [
        `- id=${entry.id}`,
        `trust=${entry.trust}`,
        `observed=${isoInstant(entry.observedAt)}`,
        `valid=${validity}`
      ];
      if (entry.tags.length > 0) head.push(`tags=${[...entry.tags].sort().join(',')}`);
      lines.push(head.join(' '));
      if (entry.title) lines.push(`  ${entry.title}`);
      for (const line of entry.body.replace(/\r\n/gu, '\n').trimEnd().split('\n'))
        lines.push(`  ${line}`);
    }
  }
  const body = `${lines.join('\n')}\n`;
  return {
    body,
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    itemIds: ordered.map((entry) => entry.id),
    tokensEst: estimateMemoryTokens(body)
  };
};

/* ------------------------------------------------------------------------ *
 * Which recalled entries the finished work actually used
 *
 * `mem.item.cited_count` is one of four terms of the salience formula that decides what survives
 * consolidation - `0.20 *` the standardised citation count, in `packages/data/src/store/memory.ts`
 * - and until this wave nothing anywhere wrote it. `recordMemoryUse` is its only writer, behind a
 * `cited` parameter, and both production callers left it out, so the column was zero for every
 * item in every workspace that had ever run and a fifth of the score was a constant. What was
 * missing was not the column or the formula but an answer to "which of the twelve entries in the
 * block did this turn actually use", and that answer has to come from the finished work rather
 * than from the moment of injection, which is why the recall path deliberately cannot supply it.
 *
 * Two channels produce it, and they are deliberately different in kind:
 *
 * - **Named.** The finished text contains the entry's `id`. Exact, and the one a caller with a
 *   structured citation list (a `finish` that names its memory evidence) feeds through `named`.
 * - **Quoted.** The finished text reuses a run of the entry's own wording that no other entry in
 *   the block and no part of the owner's request also contains. This is the channel that works
 *   without asking the model for anything, and both of its exclusions are load-bearing: wording
 *   two entries share cannot say which of them was read, and wording the owner supplied is the
 *   turn echoing the request rather than the memory.
 *
 * The bias is deliberately towards under-counting. A missed citation loses a fraction of one term
 * of one score; a false one credits an entry that was never read, and the whole point of the term
 * is to tell those two apart.
 * ------------------------------------------------------------------------ */

/** One entry of a rendered pack, as text, with the head line's metadata dropped. */
export interface MemoryPackTextEntry {
  readonly id: string;
  readonly text: string;
}

const PACK_ENTRY_HEAD = /^- id=(\S+)(?:\s|$)/u;

/**
 * Reads a rendered pack back into per-entry text.
 *
 * The inverse of `renderMemoryPack` for exactly the part attribution needs, which is the wording
 * and not the metadata: the head line is dropped whole, because `trust=`, `observed=` and `valid=`
 * are identical in shape on every entry and would otherwise be the only thing every entry has in
 * common. Written against the stored pack rather than against the candidate rows because the pack
 * is what the model was actually shown - a turn cannot have used bytes that were budgeted out.
 */
export const parseMemoryPackBody = (body: string): MemoryPackTextEntry[] => {
  const entries: { id: string; lines: string[] }[] = [];
  for (const line of body.split('\n')) {
    const head = PACK_ENTRY_HEAD.exec(line);
    if (head?.[1]) {
      entries.push({ id: head[1], lines: [] });
      continue;
    }
    // Continuation lines are the two-space indent `renderMemoryPack` writes; a `## ` heading or a
    // blank line belongs to no entry and ends the one in hand only in the sense that nothing more
    // is appended to it.
    if (line.startsWith('  ')) entries.at(-1)?.lines.push(line.slice(2));
  }
  return entries.map(({ id, lines }) => ({ id, text: lines.join('\n') }));
};

/**
 * Words in a row that must match for the quoted channel to fire.
 *
 * Four, over lexemes rather than over raw words - so stop words are already gone and a run of four
 * is four *content* words, which is a far stronger coincidence than four words of English. Three
 * fired on ordinary phrasing shared by a fact and the sentence that happened to answer it; five
 * missed a paraphrase that had genuinely been read. An entry with fewer than four lexemes has no
 * shingle at all and can only ever be cited by name, which is correct: "London." quoted back is
 * not evidence that anything was read.
 */
export const MEMORY_CITATION_SHINGLE_LEXEMES = 4;

const citationShingles = (value: string): Set<string> => {
  const lexemes = memoryLexemes(value);
  const shingles = new Set<string>();
  for (let at = 0; at + MEMORY_CITATION_SHINGLE_LEXEMES <= lexemes.length; at += 1)
    shingles.add(lexemes.slice(at, at + MEMORY_CITATION_SHINGLE_LEXEMES).join(' '));
  return shingles;
};

export interface MemoryCitationInput {
  /** The block as the model saw it, read back by `parseMemoryPackBody`. */
  readonly entries: readonly MemoryPackTextEntry[];
  /**
   * Everything the finished turn produced: its answer, its summary, the claims its verification
   * made, and the commands the harness itself watched pass. The last of those is why a procedure
   * that was followed rather than quoted still counts - nobody writes a shell command out in prose
   * to the owner, and grading a followed procedure `unknown` because of that would be the same
   * defect one layer down.
   */
  readonly used: readonly string[];
  /**
   * The owner's own words. Wording that came from here is excluded: a turn that echoes the request
   * has demonstrated nothing about the block, and requests overlap memory by construction because
   * the request is what the block was retrieved with.
   */
  readonly request?: string;
  /** Ids a structured citation channel named outright, if the caller has one. */
  readonly named?: readonly string[];
}

/**
 * The ids of the pack entries this turn can be shown to have used, in pack order.
 *
 * Pure and total: an empty `used` cites nothing rather than everything, which is the direction that
 * keeps a turn nobody can attribute from inflating every counter in the workspace.
 */
export const memoryPackCitations = (input: MemoryCitationInput): string[] => {
  const known = new Set(input.entries.map((entry) => entry.id));
  const cited = new Set<string>();
  for (const id of input.named ?? []) if (known.has(id)) cited.add(id);

  const used = input.used.filter((part) => part.trim().length > 0).join('\n');
  if (used.trim().length > 0) {
    // The machine-parseable half. It costs one substring search and needs nothing of the model
    // beyond the id it was already shown on the entry's own head line.
    for (const entry of input.entries) if (used.includes(entry.id)) cited.add(entry.id);

    const perEntry = input.entries.map((entry) => ({
      id: entry.id,
      shingles: citationShingles(entry.text)
    }));
    const sharing = new Map<string, number>();
    for (const entry of perEntry)
      for (const shingle of entry.shingles) sharing.set(shingle, (sharing.get(shingle) ?? 0) + 1);
    const usedShingles = citationShingles(used);
    const requestShingles = citationShingles(input.request ?? '');
    for (const entry of perEntry) {
      if (cited.has(entry.id)) continue;
      for (const shingle of entry.shingles) {
        if (sharing.get(shingle) !== 1) continue;
        if (requestShingles.has(shingle)) continue;
        if (!usedShingles.has(shingle)) continue;
        cited.add(entry.id);
        break;
      }
    }
  }
  return input.entries.map((entry) => entry.id).filter((id) => cited.has(id));
};
