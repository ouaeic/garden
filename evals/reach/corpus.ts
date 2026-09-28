/**
 * The probe corpus: the owner's own recorded trajectories, filtered the way the memory work counts
 * them, mined for questions whose answer exists only in a tool result.
 *
 * Nothing here is committed. The corpus is read off this machine's `~/.claude/projects` on every
 * run and never written into the repository, for the reason `README.md` gives at length: it is the
 * owner's private transcripts, the checkout lands on every owner's machine, and a rig that shipped
 * its corpus would be shipping them. What is committed is the aggregate and a digest of the probe
 * keys, and neither can be read back into a sentence anybody typed.
 *
 * ── The filter ────────────────────────────────────────────────────────────────────────────────
 *
 * The owner-turn filter is the corrected one, and it is corrected because the same corpus has been
 * miscounted three times by admitting machine-written text. `type:'user'` and `userType:'external'`
 * and not `isSidechain`; not a tool result; not an `isMeta` record carrying a `sourceToolUseID`; no
 * slash-command block and no compaction continuation; deduplicated by uuid; `task-notification`
 * origins stripped. Run against this disk it yields 676 turns / 233,178 characters / 11 projects /
 * 49 active days, which is `docs/design/sota/RULING.md` §2.1's 675 / 233,064 / 11 / 49 plus one
 * turn typed since that pass. Mean, median, p95 and max all reproduce to the character.
 *
 * `ownerCorpus` reports those numbers on every run so the basis is printed rather than remembered,
 * and `selftest.ts` holds them against floors: a filter that has started admitting the assistant's
 * own words shows up as a corpus fifteen times the size, not as a quietly worse number downstream.
 *
 * ── What makes a probe ────────────────────────────────────────────────────────────────────────
 *
 * A probe is a turn plus one **gold token** drawn from one of that turn's tool results, subject to
 * every one of these:
 *
 *   - it occurs in exactly one tool result of that turn, so the citation has to be the right one;
 *   - as a raw substring it occurs in no owner turn, no assistant message, no reasoning block and
 *     no tool call's arguments, anywhere in the whole corpus. The first two are the two tiers
 *     `mem.source` indexes, so a probe that failed this would be answerable by the verbatim tier
 *     that already scores 93.8% and would flatter this number by exactly that much. The last two
 *     are indexed by nothing and are excluded anyway, because a detail the agent wrote down while
 *     thinking, or typed into a command, is not a thing it observed;
 *   - it appears at most `GOLD_MAX_CORPUS_HITS` times across every tool result in the corpus, so
 *     the answer is a detail and not a word;
 *   - it carries a digit and a letter and is 8 to 48 characters, so a substring test for it means
 *     something.
 *
 * The question is built from the request's own rarest words and never contains the gold. That makes
 * locating the turn about as easy as it can be, which is deliberate: this rig measures the reach
 * from a located memory to its material, and a question that also stressed retrieval would report
 * one number for two mechanisms. `locate@1` is reported beside the headline for exactly that
 * reason - it is the ceiling the reach works under, and when it moves the headline moves with it
 * for a reason that has nothing to do with reach.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Where this machine's Claude Code trajectories live. Absent on any other machine; see `README`. */
export const TRAJECTORY_ROOT = path.join(homedir(), '.claude', 'projects');

/* ----------------------------------------------------------------- what a trajectory record is */

/**
 * The fields of a transcript record this rig reads, and nothing else.
 *
 * Declared rather than cast through `any`, because the filter below is the basis of every number in
 * this directory: a misspelled field name would silently widen the corpus, which is the exact
 * defect - machine-written text counted as the owner's - that made the filter "corrected".
 */
interface TrajectoryRecord {
  readonly type?: unknown;
  readonly uuid?: unknown;
  readonly timestamp?: unknown;
  readonly isSidechain?: unknown;
  readonly userType?: unknown;
  readonly isMeta?: unknown;
  readonly sourceToolUseID?: unknown;
  readonly isCompactSummary?: unknown;
  readonly origin?: { readonly kind?: unknown };
  readonly message?: { readonly content?: unknown };
}

interface ContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly input?: unknown;
  readonly tool_use_id?: unknown;
  readonly content?: unknown;
}

/** One tool call the assistant made inside a turn, and the result it was answered with. */
export interface TurnToolCall {
  readonly id: string;
  readonly name: string;
  /** The call's own arguments, serialised. Excluded from the gold vocabulary - see the header. */
  readonly argumentsText: string;
  /** The raw result, as the transcript recorded it. Empty when the call was never answered. */
  readonly resultText: string;
}

/** One owner turn: what they typed, what the assistant said back, and what it ran in between. */
export interface OwnerTurn {
  /** Project directory name. Eleven of these on this disk. */
  readonly project: string;
  /** The conversation file. One of these becomes one `tasks` row when the store is seeded. */
  readonly conversation: string;
  readonly uuid: string;
  readonly occurredAt: string;
  /** Exactly what the owner typed, after the filter. This is `recordTurnEpisode`'s `request`. */
  readonly request: string;
  /**
   * The assistant's closing message, which is what `recordTurnEpisode` stores as `summary`.
   *
   * The closing one and not all of them: garden's summary is the finish's own account of the turn,
   * not a transcript of everything it said on the way. Every assistant message still goes into the
   * forbidden vocabulary through `said`, so the exclusion is computed over more text than the store
   * will ever index. Wider exclusion, narrower index - both in the direction that cannot flatter.
   */
  readonly summary: string;
  /** Every assistant message in the turn, and every reasoning block. Exclusion only. */
  readonly said: readonly string[];
  readonly reasoning: readonly string[];
  readonly calls: readonly TurnToolCall[];
}

/** The numbers that say which corpus produced a run, printed on every run. */
export interface CorpusBasis {
  readonly turns: number;
  readonly characters: number;
  readonly projects: number;
  readonly days: number;
  readonly conversations: number;
}

/* --------------------------------------------------------------------------------- the filter */

const SLASH_COMMAND_MARKERS = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>'
] as const;

const CONTINUATION_MARKERS = [
  'This session is being continued from a previous conversation',
  'Caveat: The messages below were generated by the user while running local commands'
] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const blocksOf = (record: TrajectoryRecord): ContentBlock[] => {
  const content = record.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ContentBlock => typeof block === 'object' && block !== null
  );
};

/**
 * The result body as the transcript recorded it, whether it arrived as a string or as blocks.
 *
 * This stands in for `tool-recording.ts`'s untruncated `task_events` write. It is what the model
 * was shown rather than what a harness stored, so where a transcript truncated a result this rig
 * is measuring the shorter thing - which can only make the number worse, never better.
 */
const resultTextOf = (block: ContentBlock): string => {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && (part as ContentBlock).type === 'text'
        ? text((part as ContentBlock).text)
        : ''
    )
    .join('\n');
};

/** The owner's words on this record, or null when the record is not an owner turn. */
const ownerTextOf = (record: TrajectoryRecord): string | null => {
  if (record.type !== 'user') return null;
  if (record.isSidechain) return null;
  if (record.userType !== 'external') return null;
  if (record.isMeta && text(record.sourceToolUseID)) return null;
  if (record.origin?.kind === 'task-notification') return null;
  if (record.isCompactSummary) return null;
  const blocks = blocksOf(record);
  if (blocks.some((block) => block.type === 'tool_result')) return null;
  const body = blocks
    .filter((block) => block.type === 'text')
    .map((block) => text(block.text))
    .join('\n');
  if (!body.trim()) return null;
  if (SLASH_COMMAND_MARKERS.some((marker) => body.includes(marker))) return null;
  if (CONTINUATION_MARKERS.some((marker) => body.trimStart().startsWith(marker))) return null;
  return body;
};

/** Every `.jsonl` under the trajectory root, in a fixed order so a run is reproducible. */
export const trajectoryFiles = (root: string): string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(root);
  return found;
};

/** What one owner turn accumulates while its records are being read. */
interface PartialTurn {
  uuid: string;
  occurredAt: string;
  request: string;
  said: string[];
  reasoning: string[];
  calls: Map<string, { name: string; argumentsText: string; resultText: string }>;
  order: string[];
}

/**
 * Every owner turn on this disk, with the assistant activity that followed each one attached.
 *
 * Sidechain records are dropped wherever they appear, so a subagent's own transcript contributes
 * nothing - neither an owner turn nor a tool result. Measured both ways on this disk, walking the
 * whole tree and walking only the top-level session files give the identical 676 turns, which is
 * the check that the exclusion does what it says.
 */
export const readOwnerTurns = (root: string = TRAJECTORY_ROOT): OwnerTurn[] => {
  const turns: OwnerTurn[] = [];
  const seen = new Set<string>();
  for (const file of trajectoryFiles(root)) {
    const project = path.relative(root, file).split(path.sep)[0] ?? '';
    let current: PartialTurn | null = null;
    const flush = (turn: PartialTurn | null): void => {
      if (!turn) return;
      turns.push({
        project,
        conversation: file,
        uuid: turn.uuid,
        occurredAt: turn.occurredAt,
        request: turn.request,
        summary: turn.said.filter((line) => line.trim()).at(-1) ?? '',
        said: turn.said,
        reasoning: turn.reasoning,
        calls: turn.order.flatMap((id) => {
          const call = turn.calls.get(id);
          return call ? [{ id, ...call }] : [];
        })
      });
    };
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: TrajectoryRecord;
      try {
        record = JSON.parse(line) as TrajectoryRecord;
      } catch {
        // A partially written last line, which every append-only log has. Nothing else is skipped.
        continue;
      }
      if (record.isSidechain) continue;
      const owner = ownerTextOf(record);
      if (owner !== null) {
        const uuid = text(record.uuid);
        if (!uuid || seen.has(uuid)) continue;
        seen.add(uuid);
        flush(current);
        current = {
          uuid,
          occurredAt: text(record.timestamp),
          request: owner,
          said: [],
          reasoning: [],
          calls: new Map(),
          order: []
        };
        continue;
      }
      if (!current) continue;
      if (record.type === 'assistant')
        for (const block of blocksOf(record)) {
          if (block.type === 'text') current.said.push(text(block.text));
          else if (block.type === 'thinking') current.reasoning.push(text(block.thinking));
          else if (block.type === 'tool_use') {
            const id = text(block.id);
            if (!id || current.calls.has(id)) continue;
            current.calls.set(id, {
              name: text(block.name),
              argumentsText: JSON.stringify(block.input ?? null),
              resultText: ''
            });
            current.order.push(id);
          }
        }
      else if (record.type === 'user')
        for (const block of blocksOf(record)) {
          if (block.type !== 'tool_result') continue;
          const call = current.calls.get(text(block.tool_use_id));
          if (call) call.resultText = resultTextOf(block);
        }
    }
    flush(current);
  }
  return turns;
};

export const ownerCorpus = (turns: readonly OwnerTurn[]): CorpusBasis => ({
  turns: turns.length,
  characters: turns.reduce((total, turn) => total + turn.request.length, 0),
  projects: new Set(turns.map((turn) => turn.project)).size,
  days: new Set(turns.map((turn) => turn.occurredAt.slice(0, 10)).filter(Boolean)).size,
  conversations: new Set(turns.map((turn) => turn.conversation)).size
});

/* ---------------------------------------------------------------------------------- the probes */

/** Golds and question terms are cut from the same alphabet, so neither can contain the other. */
const TOKEN = /[A-Za-z0-9][A-Za-z0-9_.:/@+-]{5,62}[A-Za-z0-9]/g;
const WORD = /[A-Za-z][A-Za-z0-9_-]{3,31}/g;

/** Past this many appearances across every tool result in the corpus, a token is a word. */
export const GOLD_MAX_CORPUS_HITS = 3;
/** A question needs at least this many rare words of its own, or it cannot locate anything. */
export const QUESTION_MIN_TERMS = 4;
export const QUESTION_TERMS = 6;
/** A word in more owner requests than this is not what distinguishes one conversation. */
export const QUESTION_TERM_MAX_DF = 8;
/** One conversation must not be able to decide the number on its own. */
export const MAX_PROBES_PER_CONVERSATION = 8;

/**
 * Words that carry no conversation. Deliberately short: the document-frequency bound above is what
 * removes ordinary language, and a long stop list would be a second, unmeasured filter doing the
 * same job less honestly.
 */
const STOPWORDS = new Set(
  `the and for with that this from have will your you our are was were been being into about which
   what when where they them their there here would could should than then also just like more most
   some such only very much many make made sure please thing things need needs want wants use used
   using does doing done get gets got give given take taken look looking see seen say said know
   known think after before while because between across through over under again still even both
   each other another work works working file files code line lines test tests run runs running
   check checks report reports`
    .split(/\s+/)
    .filter(Boolean)
);

const distinctive = (token: string): boolean =>
  token.length >= 8 &&
  token.length <= 48 &&
  /\d/.test(token) &&
  /[A-Za-z]/.test(token) &&
  !/^\d{4}-\d{2}-\d{2}/.test(token);

export interface Probe {
  /** `r001`, assigned in corpus order. Carries nothing about what the owner typed. */
  readonly id: string;
  readonly project: string;
  readonly conversation: string;
  readonly turnUuid: string;
  /** The question, built from the request's rarest words. Never contains the gold. */
  readonly question: string;
  /** Those words on their own, for the policy that stands in for the model - see `measure.ts`. */
  readonly terms: readonly string[];
  /** The detail that exists only inside one tool result. */
  readonly gold: string;
  /** The call whose result holds it - the one a `finish` would have cited. */
  readonly citedCallId: string;
  readonly citedCallName: string;
  /** Where in that result the gold sits, and how long the result is. Reported, not asserted. */
  readonly goldOffset: number;
  readonly resultLength: number;
}

/** Every token this corpus is not allowed to answer with, as raw substrings of the two tiers. */
interface Forbidden {
  /** The two tiers `mem.source` indexes, joined: owner requests and every assistant message. */
  readonly indexed: string;
  /** Reasoning and tool arguments. Indexed by nothing, excluded anyway - see the header. */
  readonly unindexed: string;
  readonly tokens: ReadonlySet<string>;
}

const forbiddenVocabulary = (turns: readonly OwnerTurn[]): Forbidden => {
  const indexed: string[] = [];
  const unindexed: string[] = [];
  for (const turn of turns) {
    indexed.push(turn.request, ...turn.said);
    unindexed.push(...turn.reasoning, ...turn.calls.map((call) => call.argumentsText));
  }
  const joinedIndexed = indexed.join('\n');
  const joinedUnindexed = unindexed.join('\n');
  const tokens = new Set<string>();
  for (const source of [joinedIndexed, joinedUnindexed])
    for (const match of source.matchAll(TOKEN)) tokens.add(match[0]);
  return { indexed: joinedIndexed, unindexed: joinedUnindexed, tokens };
};

/**
 * Mines one probe per turn, at most, and never more than `MAX_PROBES_PER_CONVERSATION` per file.
 *
 * The gold chosen for a turn is the rarest admissible token in that turn's results, ties broken by
 * the token itself, so the choice does not depend on set iteration order and two runs on the same
 * disk mine the same probes in the same order.
 */
export const mineProbes = (turns: readonly OwnerTurn[]): Probe[] => {
  const forbidden = forbiddenVocabulary(turns);
  const documentFrequency = new Map<string, number>();
  for (const turn of turns)
    for (const word of new Set(
      [...turn.request.matchAll(WORD)].map((match) => match[0].toLowerCase())
    ))
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);

  const corpusHits = new Map<string, number>();
  for (const turn of turns)
    for (const call of turn.calls)
      for (const match of call.resultText.matchAll(TOKEN)) {
        const token = match[0];
        if (forbidden.tokens.has(token) || !distinctive(token)) continue;
        corpusHits.set(token, (corpusHits.get(token) ?? 0) + 1);
      }

  const questionTerms = (request: string): string[] => {
    const chosen = new Map<string, string>();
    for (const match of request.matchAll(WORD)) {
      const word = match[0];
      const lower = word.toLowerCase();
      if (STOPWORDS.has(lower)) continue;
      const frequency = documentFrequency.get(lower) ?? 0;
      if (frequency < 1 || frequency > QUESTION_TERM_MAX_DF) continue;
      if (!chosen.has(lower)) chosen.set(lower, word);
    }
    return [...chosen.keys()]
      .sort((left, right) => {
        const difference = (documentFrequency.get(left) ?? 0) - (documentFrequency.get(right) ?? 0);
        return difference !== 0 ? difference : left.localeCompare(right);
      })
      .slice(0, QUESTION_TERMS)
      .map((lower) => chosen.get(lower) ?? lower);
  };

  const perConversation = new Map<string, number>();
  const probes: Probe[] = [];
  for (const turn of turns) {
    if ((perConversation.get(turn.conversation) ?? 0) >= MAX_PROBES_PER_CONVERSATION) continue;
    const terms = questionTerms(turn.request);
    if (terms.length < QUESTION_MIN_TERMS) continue;
    /*
     * Cheap tests over every candidate, then the expensive ones over the ranked shortlist.
     *
     * The two substring sweeps below run over the whole indexed tier and the whole unindexed tier -
     * megabytes each - and the "exactly one result" test rescans every result in the turn. Run for
     * every token in every result they cost about a minute a run; run in rarity order, stopping at
     * the first token that survives, they cost about a second. Nothing about which gold is chosen
     * changes: the order is total, so the survivor is the same one the exhaustive pass picked.
     */
    const shortlist: { call: TurnToolCall; gold: string; hits: number }[] = [];
    for (const call of turn.calls) {
      if (call.resultText.length < 40) continue;
      for (const token of new Set([...call.resultText.matchAll(TOKEN)].map((match) => match[0]))) {
        const hits = corpusHits.get(token);
        if (hits === undefined || hits > GOLD_MAX_CORPUS_HITS) continue;
        if (terms.some((term) => term.toLowerCase().includes(token.toLowerCase()))) continue;
        shortlist.push({ call, gold: token, hits });
      }
    }
    shortlist.sort((left, right) =>
      left.hits !== right.hits ? left.hits - right.hits : left.gold.localeCompare(right.gold)
    );
    let best: { call: TurnToolCall; gold: string; hits: number } | null = null;
    for (const candidate of shortlist) {
      // Exactly one result in this turn, so the reach has to follow the right citation.
      if (turn.calls.filter((other) => other.resultText.includes(candidate.gold)).length !== 1)
        continue;
      // The token-set prefilter cannot see a gold that sits inside a LONGER token in the indexed
      // tiers, and the scoring test is a raw substring test. So the finalist is re-checked as a
      // substring, which is the test that actually has to hold.
      if (forbidden.indexed.includes(candidate.gold)) continue;
      if (forbidden.unindexed.includes(candidate.gold)) continue;
      best = candidate;
      break;
    }
    if (!best) continue;
    perConversation.set(turn.conversation, (perConversation.get(turn.conversation) ?? 0) + 1);
    probes.push({
      id: `r${String(probes.length + 1).padStart(3, '0')}`,
      project: turn.project,
      conversation: turn.conversation,
      turnUuid: turn.uuid,
      question: `In the earlier conversation about ${terms.join(', ')} - what exactly did the ${best.call.name} result say?`,
      terms,
      gold: best.gold,
      citedCallId: best.call.id,
      citedCallName: best.call.name,
      goldOffset: best.call.resultText.indexOf(best.gold),
      resultLength: best.call.resultText.length
    });
  }
  return probes;
};

/**
 * A digest of the probe set that reveals none of it.
 *
 * The committed baseline is a number measured over a corpus that is not in the repository, so it
 * needs some way to say "the same corpus". This is that: the ordered probe keys, hashed. A run on a
 * disk whose transcripts have moved on prints a different digest, and the report says so as a note
 * rather than as a failure, because a new day of the owner's work is not a regression.
 */
export const corpusDigest = (probes: readonly Probe[]): string => {
  const hash = createHash('sha256');
  for (const probe of probes) hash.update(`${probe.turnUuid} ${probe.citedCallId} ${probe.gold}\n`);
  return hash.digest('hex').slice(0, 12);
};
