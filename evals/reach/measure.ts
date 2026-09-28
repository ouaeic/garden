/**
 * One probe, asked at the production call site, and what came back.
 *
 * Every scored call in this file goes through `executeToolCall` - `apps/worker/src/tool-dispatch.ts`,
 * the table the running loop indexes by tool name - with a `ModelToolCall` in the shape the gateway
 * parses out of a model's reply. Nothing calls `reachMemoryEvidence`, `searchMemorySessions` or
 * `recallMemory` directly, and that is the whole point of pinning here: a reach wired into the
 * runtime but not into the dispatch table would score zero, which is what it is worth to the model.
 *
 * The context handed to it carries the four things the knowledge arms read - the store, the task,
 * the workspace key and the turn's state - and **throws on every other property**. An arm that
 * reached for the runner, the gateway or a credential would fail loudly here rather than being
 * quietly answered by a stub, which is the failure mode `evals/harness.ts` records paying for.
 *
 * ── The two budgets ──────────────────────────────────────────────────────────────────────────
 *
 * `@1` is the number the ruling names, and the budget is one dispatched retrieval call. What the
 * turn gets for free is what a real turn gets for free: the memory pack, built by
 * `buildTaskMemoryPack` from the question and injected by `injectMemoryPack`, which is prompt and
 * not a call. The pack prints `id=` for every entry, so an id is in the window before the call is
 * made - which is exactly the precondition `idReturnedInWindow` enforces, met the way a real turn
 * meets it.
 *
 * Choosing WHICH id is the one judgement a model makes and this rig cannot. It is made by a stated
 * policy over text already in the window - the pack entry sharing the most of the question's own
 * rare words - and the policy can see the question and the pack and nothing else. It cannot see the
 * gold: the gold appears in no owner turn and no summary, so it is in no pack entry by
 * construction. `packed` is reported beside `@1` because it is the ceiling that policy works under:
 * when the gold episode is not in the pack, no choice of id can reach it and the loss is the pack's
 * rather than the reach's.
 *
 * `@2` spends two calls and needs no stand-in for a model at all: `memory_recall` returns entries
 * the store itself ranked by relevance, and the reach follows the first of them. It is the cleaner
 * measurement of the mechanism and the weaker claim about the product, so both are reported.
 */
import * as memoryRuntime from '../../apps/worker/src/memory-runtime.js';
import {
  MEMORY_SOURCE_CHUNK_BYTES,
  buildTaskMemoryPack,
  injectMemoryPack
} from '../../apps/worker/src/memory-runtime.js';
import { executeToolCall, type ToolContext } from '../../apps/worker/src/tool-dispatch.js';
import {
  encryptJson,
  buildConversationNameIndex,
  memoryIndexKey,
  planMemoryQuery
} from '../../packages/core/src/index.js';
import type { ModelMessage } from '../../packages/model-gateway/src/protocol.js';
import type { AgentState } from '../../apps/worker/src/agent-state.js';
import type { TaskRecord } from '../../packages/data/src/index.js';
import type { Probe } from './corpus.js';
import type { SeededStore } from './seed.js';

/**
 * The reach's own character bound, read off the module rather than imported by name.
 *
 * A named import of an export that does not exist is a link error, and this rig has to be runnable
 * against a tree that predates the reach - which is exactly what the red baseline is: the same rig,
 * the same probes, `apps/` and `packages/` at `00a2168`. So the constant is read through the
 * namespace and falls back to the width it is derived from, `MEMORY_SOURCE_CHUNK_BYTES`, which has
 * been in that file since the tier existed. The fallback is arithmetic, not a guess: the reach
 * declares `MEMORY_REACH_MAX_CHARS = MEMORY_SOURCE_CHUNK_BYTES`.
 */
export const REACH_BOUND: number =
  (memoryRuntime as { MEMORY_REACH_MAX_CHARS?: number }).MEMORY_REACH_MAX_CHARS ??
  MEMORY_SOURCE_CHUNK_BYTES;

/** What one probe produced, as flags a roll-up can count. */
export interface ProbeResult {
  readonly probe: Probe;
  /** The gold episode was in the pack the turn opened with. The ceiling `@1` works under. */
  readonly packed: boolean;
  /** `memory_recall` ranked the gold episode first. The ceiling `@2` works under. */
  readonly ranked: boolean;
  /** `session_search({query})` found the turn's own verbatim row. The verbatim tier's own number. */
  readonly located: boolean;
  /** The gold detail was in the bytes one dispatched call returned. **The headline.** */
  readonly reachedAt1: boolean;
  readonly reachedAt2: boolean;
  /**
   * The counterfactual, and the finding this rig exists to have produced.
   *
   * `session_search` matches the right stored turn on 100% of these probes and returns its
   * `mem.source` id - and reaching a `mem.source` id returns that turn, never the tool results
   * behind it, because only an episode carries citations. The episode is not hidden: it is
   * `mem.source.episode_id`, it is already SELECTed, and `MemorySourceHit` already carries it. The
   * tool's own return type, `MemorySessionTurn`, drops it on the floor.
   *
   * This measures what one field on that type would be worth: the same two calls, with the reach
   * pointed at the episode of the hit the search already found. **It is not a path the model has
   * today**, and it is reported as a counterfactual and never as the product's number.
   */
  readonly reachedViaSearch: boolean;
  /** The owner's own request for that turn came back whole. What the evidence span decides. */
  readonly verbatimAt1: boolean;
  /** The gold sits past `MEMORY_REACH_MAX_CHARS` into the cited result: unreachable by any id. */
  readonly beyondBound: boolean;
  /** What the one call refused, when it refused. Printed, never scored. */
  readonly refusal: string | null;
}

/**
 * A context that answers what the knowledge arms read and throws at everything else.
 *
 * A `Proxy` rather than a record of stubs, because a stub is a silent answer and this rig's whole
 * claim is that it drove the production path. The trap names the property, so an arm that grows a
 * dependency reports which one in the failure rather than producing a quietly emptier result.
 */
const contextFor = (seeded: SeededStore, task: TaskRecord, state: AgentState): ToolContext =>
  new Proxy(
    { store: seeded.store, task, key: seeded.dataKey, state, consequentialApproved: false },
    {
      get(target, property) {
        if (property in target) return (target as Record<string | symbol, unknown>)[property];
        throw new Error(
          `evals/reach: the knowledge arm reached for context.${String(property)}, which this rig does not provide`
        );
      }
    }
  ) as unknown as ToolContext;

const stateWith = (messages: ModelMessage[]): AgentState => ({ messages, step: 0, credits: 0 });

/** The bytes one call put in front of the model, as one string to test for the gold. */
const returned = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

const refusalOf = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 120) : 'threw a non-Error';

/** A fresh conversation for one probe, so no pack and no earlier turn decides its answer. */
const openTask = async (seeded: SeededStore, question: string): Promise<TaskRecord> =>
  seeded.store.createTask({
    userId: seeded.userId,
    workspaceId: seeded.workspaceId,
    titleCiphertext: encryptJson({ title: 'probe' }, seeded.dataKey, 'task-title:probe'),
    nameIndex: buildConversationNameIndex('probe', question, memoryIndexKey(seeded.dataKey)),
    modelId: 'reach-eval',
    privacyRoute: 'provider_zdr',
    maxComputeCredits: 1,
    promptCiphertext: encryptJson({ prompt: question }, seeded.dataKey, 'task-prompt:probe')
  });

/**
 * Which id the turn reaches for, decided from the window alone.
 *
 * The pack is rendered as `## <heading>` sections, then `- id=<uuid> …` and that entry's indented
 * body, so an entry is a block between one `- id=` line and the next. The block scoring the most of
 * the question's rare words wins; ties go to the first, which under `renderMemoryPack`'s own
 * ordering is stable.
 *
 * Restricted to the Episodes section, and that is a statement about the mechanism rather than a
 * hint about the answer. Only an episode carries `mem.cited_call` rows - `recordTurnEpisode` is
 * their only writer - so an episode is the only kind of memory whose reach can return a tool result
 * at all, and `session_search`'s own description says as much: "for a memory, the raw output of the
 * tool calls that work cited". The section headings are in the window, so this is a choice a model
 * reading the pack can make. Reaching a fact instead returns that fact's verbatim rows, which is a
 * correct answer to a different question.
 *
 * Deliberately the crudest defensible policy otherwise. Anything cleverer would be this rig
 * guessing at how good a model is at reading a pack, and the number would then be partly a claim
 * about that.
 */
const chooseFromPack = (packBody: string, terms: readonly string[]): string | null => {
  const blocks: { id: string; text: string }[] = [];
  let inEpisodes = false;
  for (const line of packBody.split('\n')) {
    if (line.startsWith('## ')) {
      inEpisodes = line === '## Episodes';
      continue;
    }
    if (!inEpisodes) continue;
    const opened = /^- id=([0-9a-f-]{36})\b/iu.exec(line);
    if (opened?.[1]) blocks.push({ id: opened[1], text: line });
    else if (blocks.length) blocks[blocks.length - 1]!.text += `\n${line}`;
  }
  /*
   * Ties broken on the block's own text, never on its id.
   *
   * `renderMemoryPack` orders by `(kind, id)` for byte-stability and the ids are random UUIDs, so
   * "the first of the equal scorers" is a coin toss that changes every run. Comparing the text is
   * arbitrary too, but it is arbitrary the same way twice.
   */
  let best: { id: string; score: number; text: string } | null = null;
  for (const block of blocks) {
    const lowered = block.text.toLowerCase();
    const score = terms.filter((term) => lowered.includes(term.toLowerCase())).length;
    if (
      !best ||
      score > best.score ||
      (score === best.score && block.text.localeCompare(best.text) < 0)
    )
      best = { id: block.id, score, text: block.text };
  }
  return best?.id ?? null;
};

export const measureProbe = async (
  seeded: SeededStore,
  probe: Probe,
  goldEpisodeId: string,
  goldSourceIds: ReadonlySet<string>,
  ownerRequest: string
): Promise<ProbeResult> => {
  const beyondBound = probe.goldOffset >= REACH_BOUND;
  let refusal: string | null = null;

  /* ---- @1: the pack is free, then exactly one dispatched call. ---- */
  const packTask = await openTask(seeded, probe.question);
  const pack = await buildTaskMemoryPack({
    store: seeded.store,
    taskId: packTask.id,
    workspaceId: seeded.workspaceId,
    dataKey: seeded.dataKey,
    query: probe.question,
    clockAnchor: seeded.clockAnchor
  });
  const window: ModelMessage[] = [
    { role: 'system', content: 'You are garden.' },
    { role: 'user', content: probe.question }
  ];
  injectMemoryPack(window, pack);
  const packed = pack.itemIds.includes(goldEpisodeId);
  const chosen = chooseFromPack(pack.body, probe.terms);
  let atOne = '';
  if (chosen) {
    const state = stateWith(window);
    try {
      atOne = returned(
        await executeToolCall(contextFor(seeded, packTask, state), {
          id: 'reach-1',
          name: 'session_search',
          arguments: { id: chosen }
        })
      );
    } catch (error) {
      refusal = refusalOf(error);
    }
  }

  /* ---- @2: one recall, then one reach into the entry the store ranked first. ---- */
  const recallTask = await openTask(seeded, probe.question);
  const recallState = stateWith([
    { role: 'system', content: 'You are garden.' },
    { role: 'user', content: probe.question }
  ]);
  const recallContext = contextFor(seeded, recallTask, recallState);
  let ranked = false;
  let atTwo = '';
  try {
    const recalled = await executeToolCall(recallContext, {
      id: 'recall-1',
      name: 'memory_recall',
      arguments: { query: probe.question }
    });
    /*
     * The first EPISODE the store ranked, for the reason `chooseFromPack` gives: an episode is the
     * only kind of memory that cites a tool call, so it is the only kind a reach into tool output
     * can be made on. `memory_recall` returns the kind on every entry.
     *
     * Measured over this corpus the first entry is a `fact` on every single probe - the two-sighting
     * gate's promotions outrank a turn's own episode on the owner's own question - so a policy that
     * took `entries[0]` would report 0% and would be reporting the quota order, not the reach.
     */
    const entries = (recalled as { entries?: { id?: unknown; kind?: unknown }[] }).entries ?? [];
    const episode = entries.find((entry) => entry.kind === 'episode');
    const first = typeof episode?.id === 'string' ? episode.id : null;
    ranked = first === goldEpisodeId;
    // The result reaches the window as a tool message, which is how the id it names becomes an id
    // the reach is allowed to dereference. Anything else would be testing the bound rather than
    // meeting it.
    recallState.messages.push({
      role: 'tool',
      toolCallId: 'recall-1',
      content: returned(recalled)
    });
    if (first)
      atTwo = returned(
        await executeToolCall(recallContext, {
          id: 'reach-2',
          name: 'session_search',
          arguments: { id: first }
        })
      );
  } catch (error) {
    refusal ??= refusalOf(error);
  }

  /* ---- The verbatim tier's own number, measured on its own call and scored on its own. ---- */
  const locateTask = await openTask(seeded, probe.question);
  let located = false;
  let viaSearch = '';
  try {
    const searched = await executeToolCall(
      contextFor(seeded, locateTask, stateWith([{ role: 'user', content: probe.question }])),
      { id: 'locate-1', name: 'session_search', arguments: { query: probe.question } }
    );
    const matches =
      (searched as { matches?: { id?: unknown; context?: { id?: unknown }[] }[] }).matches ?? [];
    located = matches.some(
      (match) =>
        (typeof match.id === 'string' && goldSourceIds.has(match.id)) ||
        (match.context ?? []).some((row) => typeof row.id === 'string' && goldSourceIds.has(row.id))
    );
    /*
     * The same search, asked of the store rather than of the tool, for the one field the tool drops.
     *
     * `searchMemorySources` is the query `searchMemorySessions` runs, and its rows are
     * `MemorySourceHit`, which carries `episodeId`. The tool maps them to `MemorySessionTurn`,
     * which does not. So this is the identical retrieval with nothing added - same plan, same
     * ranking - reaching for the episode of whichever hit ranked first.
     *
     * The id is put into the window before the reach, because that is what `session_search` would
     * have done had it returned the field; the refusal being met rather than bypassed is what keeps
     * this a counterfactual about ONE field rather than about the bound.
     */
    const hits = await seeded.store.searchMemorySources({
      workspaceId: seeded.workspaceId,
      plan: planMemoryQuery(probe.question, memoryIndexKey(seeded.dataKey)),
      limit: 10
    });
    const episodeOfTopHit = hits.find((hit) => hit.episodeId)?.episodeId ?? null;
    if (episodeOfTopHit) {
      const counterfactual = stateWith([
        { role: 'user', content: probe.question },
        { role: 'tool', toolCallId: 'locate-1', content: `episodeId=${episodeOfTopHit}` }
      ]);
      viaSearch = returned(
        await executeToolCall(contextFor(seeded, locateTask, counterfactual), {
          id: 'reach-3',
          name: 'session_search',
          arguments: { id: episodeOfTopHit }
        })
      );
    }
  } catch (error) {
    refusal ??= refusalOf(error);
  }

  return {
    probe,
    packed,
    ranked,
    located,
    reachedAt1: atOne.includes(probe.gold),
    reachedAt2: atTwo.includes(probe.gold),
    reachedViaSearch: viaSearch.includes(probe.gold),
    // The owner's own request, whole, out of the same one call. Cut to what a stored chunk holds,
    // because a request longer than one row is stored across several and the reach cites them all.
    verbatimAt1: ownerRequest.length > 0 && atOne.includes(escapedHead(ownerRequest)),
    beyondBound,
    refusal
  };
};

/**
 * The head of the owner's request as it survives `JSON.stringify`, which is what the returned bytes
 * are tested as.
 *
 * A hundred characters rather than the whole request: `spanOfBody` returns a range of the row, and
 * the question this flag answers is whether the range STARTS where the row does. A shifted span
 * loses the first character, so a test anchored to the head catches it and a test anchored anywhere
 * else does not.
 */
const escapedHead = (request: string): string => {
  const head = request.trim().slice(0, 100);
  const quoted = JSON.stringify(head);
  return quoted.slice(1, quoted.length - 1);
};

/** The roll-up, as counts rather than rates, so a report can render either. */
export interface Rollup {
  readonly n: number;
  readonly packed: number;
  readonly ranked: number;
  readonly located: number;
  readonly reachedAt1: number;
  readonly reachedAt2: number;
  readonly reachedViaSearch: number;
  readonly verbatimAt1: number;
  readonly beyondBound: number;
  readonly refused: number;
}

export const rollUp = (results: readonly ProbeResult[]): Rollup => ({
  n: results.length,
  packed: results.filter((result) => result.packed).length,
  ranked: results.filter((result) => result.ranked).length,
  located: results.filter((result) => result.located).length,
  reachedAt1: results.filter((result) => result.reachedAt1).length,
  reachedAt2: results.filter((result) => result.reachedAt2).length,
  reachedViaSearch: results.filter((result) => result.reachedViaSearch).length,
  verbatimAt1: results.filter((result) => result.verbatimAt1).length,
  beyondBound: results.filter((result) => result.beyondBound).length,
  refused: results.filter((result) => result.refusal !== null).length
});
