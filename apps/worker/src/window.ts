import { runtimeValue } from '@garden/core';
import { runtimeDate } from '@garden/core';
import { conversationContext } from './conversation-context.js';
/**
 * The window itself: what goes in front of the trajectory, what is refreshed at the tail on every
 * step, and how the owner's plan gets back into it when they republish one.
 *
 * Every line here is about *where* a block sits, because where it sits is what a provider's cache
 * charges for: a write in the middle of the window re-bills everything behind it.
 */
import { createHash } from 'node:crypto';
import type { TaskPlanStep, WebToolPlan } from '@garden/contracts';
import {
  ownerMessageContent,
  type OwnerMessage,
  GardenError,
  decryptBytes,
  decryptJson,
  memoryTemporalStatus,
  OWNER_MEMORY_MAX_CHARS,
  OWNER_MEMORY_MAX_ROWS,
  ownerBlockAad,
  recallMemories,
  userMemoryAad,
  userMemoryKey,
  type MemoryDocument
} from '@garden/core';
import type { DataStore, TaskRecord, WorkspaceRecord } from '@garden/data';
import type { ModelMessage } from '@garden/model-gateway';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import {
  CONDENSED_HISTORY_MARKER,
  ensureOwnerBlock,
  isRuntimeContext,
  preambleInsertIndex,
  renderContextBrief,
  runtimeContext
} from './context.js';
import { buildTaskMemoryPack, injectMemoryPack, memoryPackBudgetTokens } from './memory-runtime.js';
import { useOutputSpill } from './output-spill.js';
import type { AgentRunnerClient } from './runner-client.js';
import { builtinSkillLibrary, skillCatalogBlock } from './skills.js';
import { event, raiseTaint } from './tool-recording.js';
import { WORKSPACE_BRIEF_MARKER } from './turn-bounds.js';

/**
 * What the reviewed knowledge block may spend, across both of its tiers together.
 *
 * Named rather than inline because they are now arithmetic and not only arguments: the owner tier
 * takes its own storage bound out of these, and the workspace tier takes the rest. Two numbers in
 * one place is what keeps the two tiers' shares provably summing to what the block cost before.
 */
const MEMORY_RECALL_MAX_ITEMS = 32;
const MEMORY_RECALL_MAX_CHARACTERS = 16_000;

/** What assembling the window needs from the worker that owns the turn. */
export interface WindowDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  readonly runner: AgentRunnerClient;
  /**
   * Needed for one row class and no other: the owner tier, whose key is derived from this and the
   * user id rather than unwrapped from `workspace_keys`. It arrives as the resolved 32 bytes
   * because `config.DATA_MASTER_KEY` is the encoded form and resolving it twice is two places for
   * one secret to be got wrong. @see userMemoryKey.
   */
  readonly masterKey: Buffer;
}

/** The facts the runtime block states, all of them fixed for the run except the clock. */
export interface RuntimeContextInput {
  readonly workspace: WorkspaceRecord;
  readonly task: TaskRecord;
  readonly state: AgentState;
  readonly timeZone: string;
  readonly toolchainSummary: string;
  readonly machineSummary: string;
  readonly unattended: boolean;
  readonly webPlan: WebToolPlan;
  /** @see taskModelRoster - empty unless the owner routed a job to a different model. */
  readonly modelRoster?: ReadonlyArray<{ job: string; model: string }>;
}

/** What the preamble is assembled from. */
export interface PreambleInput {
  readonly task: TaskRecord;
  readonly key: Uint8Array;
  readonly state: AgentState;
  /**
   * THIS task's own opening request, which is what both memory surfaces are ranked against unless
   * `forkCacheAnchor` replaces it with the fork family's. Passed as the goal rather than read from
   * the window: `tasks.prompt_ciphertext` is never rewritten by a follow-up turn, and that is
   * precisely the property the "frozen for this run" header claims. @see forkCacheAnchor for the
   * one case where the value ranked against is not this one.
   */
  readonly goal: string;
  /** The lead model's window, which the memory pack's budget is a share of. */
  readonly contextTokens: number;
}

/**
 * Whose cached prefix this task's requests belong to: its own, or the task it was forked out of.
 *
 * A fork busts its own cache by construction, and the reason is that two blocks in the anchored
 * preamble are keyed to the task rather than to the conversation. The reviewed knowledge block is
 * ranked against the task's opening request and clocked to its creation instant; the memory pack is
 * stored per task id and re-ranked from scratch when no row exists. A retry therefore re-ranks both
 * against text it invented for itself - the prompt a `branch` carries is the literal sentence
 * "Continue from this conversation branch.", which is a query about nothing - and the first request
 * of the one action an owner takes when something went wrong serves none of the 70.4% of a request
 * this repository measures as cache-servable on a 131k window.
 *
 * Scoped to `retry` ALONE, and it is the whole of the rule the four call sites share. A retry exists
 * to send the SAME request down the same road again, so its preamble must be the parent's byte for
 * byte. A `branch` exists to take the conversation somewhere else and keeps ranking against its own
 * text; it is deliberately not made to match, because a preamble that matched whatever it was forked
 * from would be a frozen preamble, which is a worse defect than the one this fixes.
 *
 * `edit` WAS admitted here and has been taken back out, because the product cannot yet tell the two
 * kinds of edit apart and one of them is harmed. An edit of the FIRST message
 * (`editingInitialPrompt` in `apps/api/src/routes/trajectory.ts`) writes `agentStateCiphertext:
 * null`, so the fork carries no inherited trajectory at all and its whole window is the NEW request
 * - and inheriting there ranks the knowledge block and packs the memory pack against the question
 * the owner deliberately threw away. The owner rewrote it because they wanted a different answer.
 * An edit of a LATER message keeps the full inherited trajectory and is the case where inheriting
 * genuinely pays, so this should be reinstated the moment the row can say which of the two it is -
 * that needs a column the route can write, since `forkKind` is 'edit' for both. Until then an edit
 * pays the cache miss every fork paid before this rule existed, which is a cost and not a defect.
 *
 * This resolves ONE link. `assemblePreamble` applies it transitively to reach the family root,
 * because a retry of a retry must match the same bytes as the retry it came from; the session key
 * in `turn/generate.ts` applies it once and says there why.
 *
 * Four call sites, and two others that deliberately do NOT use it. `turn/generate.ts` and
 * `handoff.ts` both address the turn's MAIN prefix - the same window, the same preamble - and must
 * agree or the closing call presents a key nothing was written under. `compaction.ts` derives
 * `:compaction` and `agent.ts` derives `:search:<call id>`: those are sub-keys of a different
 * prefix (a summariser request, a provider search request), built from different messages against
 * a different model, so inheriting a parent's key there would offer a route a prefix that was never
 * sent under it. They are left on `task.id` on purpose and not by omission.
 *
 * IT IS NOT THE WHOLE OF WHAT THE TWO ROUTING-KEY SITES ASK, and a reader here will otherwise
 * assume it is. This answers "whose prefix would this fork's be"; the preamble also applies
 * FORK_ANCHOR_MAX_AGE_MS, the ancestor's encryption context and the ancestor still existing, and a
 * key that skipped those presented the parent's name over a preamble that was the fork's own. So
 * `turn/generate.ts` and `handoff.ts` call `turnRoutingTaskId` below, which asks the same question
 * `assemblePreamble` asks and answers this only when the answer was yes. This function stays the
 * one-link rule they are both built on.
 *
 * MODULE-INTERNAL, which it was not while the two key sites derived their own answer from it. It is
 * still the name four files' comments point at, because it is still where the rule is written down;
 * what changed is that nothing outside this file may apply it without the refusals that go with it.
 */
const cachePrefixTaskId = (task: TaskRecord): string =>
  task.parentTaskId && task.forkKind === 'retry' ? task.parentTaskId : task.id;

/**
 * How many links of a fork family the walk below will follow.
 *
 * CHOSEN at 32, which is a number of consecutive retries of one message no owner reaches and which
 * bounds a per-turn cost nothing else bounds: each link is one primary-key read, taken once per
 * turn rather than once per step. `tasks.parent_task_id` cannot cycle - a parent exists before its
 * child - so this is a ceiling on work and not a termination condition. Past it the fork anchors to
 * its thirty-second ancestor and pays a cache miss, which is what it pays today on every fork.
 */
const FORK_ANCHOR_MAX_LINKS = 32;

/**
 * How far back a retry may reach for the request and the clock it inherits: the gap between the
 * family root's creation and THIS fork's own, and not the gap to the present moment.
 *
 * ONE HOUR, and the provider's cache TTL is what chose the number rather than taste. A prefix cache
 * lives minutes to about an hour across the routes this repository sends to, so past that the
 * inheritance is buying an entry that has already gone while still being paid for in staleness -
 * the clock is what decides temporal admissibility, so an unbounded anchor re-admits workspace
 * memory rows the owner's own `validUntil` retired months ago. Retrying a task from last year would
 * otherwise tell the model facts that expired between then and now, which is the same harm the
 * "owner has edited their block since" arm exists to prevent arriving through the other door. The
 * walk was bounded (FORK_ANCHOR_MAX_LINKS) while the clock was not.
 *
 * MEASURED BETWEEN TWO STORED COLUMNS, both immutable, and that is the load-bearing half rather
 * than the number. `assemblePreamble` runs once per TURN, so an age taken against `Date.now()`
 * is re-decided on every turn of the same run: a retry that starts inside the hour and is still
 * working when the root ages out flips its goal and its clock between one turn and the next,
 * rewrites the block whose header says "frozen for this run", and re-bills every byte behind it at
 * the write premium - the exact harm the flatMap below refuses to let a `validUntil` boundary do.
 * `task.createdAt` and `anchor.createdAt` never move, so the answer a run gets on its first turn is
 * the answer it gets on its last. A fork that then sits in a queue for a day inherits a clock a day
 * stale, which is precisely what an unforked task that waited the same day already does.
 *
 * Past the ceiling a retry ranks and clocks against itself and pays the cache miss every fork paid
 * before this rule existed. It is degradation, not refusal. What would move the number is a
 * measured cache TTL: raise it if a route is found to hold a prefix materially longer, and note
 * that raising it also widens the staleness window by exactly the same amount.
 */
const FORK_ANCHOR_MAX_AGE_MS = 60 * 60 * 1_000;

/**
 * The task whose opening request and creation instant the two frozen blocks are built from, and
 * whether the memory pack may be copied from the fork's parent rather than ranked.
 *
 * For anything that is not a retry this is the task itself and no read is taken. For a retry it
 * walks to the root of the retry family and reads that task's own prompt, so the fork ranks and
 * clocks exactly as the parent did and the leading system run comes out byte-identical.
 *
 * The two answers are returned together rather than derived separately at the two call sites,
 * because they must agree: ranking against the family's request while packing the fork's own bytes
 * (or the reverse) is a preamble assembled from two different questions. Whenever this falls back,
 * `inheritFromTaskId` falls back with it and the pack is ranked fresh.
 *
 * Every failure falls back to the fork's own goal and clock rather than throwing. The parent may
 * have been deleted, and its prompt is encrypted under a context this checks by equality rather
 * than trusts: a fork that cannot read its ancestor pays the cache miss it pays today, which is not
 * a reason to refuse the turn.
 */
interface ForkAnchor {
  /** The family root, reached transitively. Its instant is the clock the whole family shares. */
  readonly anchor: TaskRecord;
  /** The root's own opening request, decrypted here so nobody downstream needs the key again. */
  readonly prompt: string;
}

/**
 * The whole admissibility question in one place: is there an ancestor this fork may present as its
 * own, and which row is it. `null` is every refusal - not a fork, no ancestor, past the ceiling,
 * sealed for another workspace, unreadable - because the callers do not act differently on any of
 * them and a caller that could would be a caller that could disagree with the preamble.
 */
const resolveForkAnchor = async (
  deps: Pick<WindowDeps, 'store'>,
  task: TaskRecord,
  key: Uint8Array
): Promise<ForkAnchor | null> => {
  let anchor = task;
  for (let link = 0; link < FORK_ANCHOR_MAX_LINKS; link += 1) {
    const next = cachePrefixTaskId(anchor);
    if (next === anchor.id) break;
    const parent = await deps.store.getTask(task.userId, next).catch(() => null);
    if (!parent) break;
    anchor = parent;
  }
  if (anchor.id === task.id) return null;
  const anchorAgeMs = Date.parse(task.createdAt) - Date.parse(anchor.createdAt);
  // NaN when either column is unparseable, and `!(NaN > x)` would admit it. Written as a positive
  // test so an unreadable instant refuses the inheritance rather than being granted it.
  if (!(anchorAgeMs >= 0 && anchorAgeMs <= FORK_ANCHOR_MAX_AGE_MS)) return null;
  try {
    // Against the CURRENT task's workspace, not the ancestor's own column, matching
    // `tools/scheduling.ts:30`: `key` is this fork's workspace data key, so that is the only
    // workspace whose rows this code is entitled to open, and the check should say so rather than
    // compare a row against a label it carries itself.
    if (anchor.promptCiphertext.aad !== `task-prompt:${task.workspaceId}`) return null;
    const message = decryptJson<OwnerMessage>(anchor.promptCiphertext, key);
    if (typeof message.prompt !== 'string') return null;
    return { anchor, prompt: ownerMessageContent(message) };
  } catch {
    return null;
  }
};

/**
 * One resolution per turn, shared by the preamble and by every request the turn sends.
 *
 * Keyed on the TaskRecord OBJECT rather than on its id, which is what makes this a cache with no
 * eviction policy and no cross-task retention to reason about: a worker holds one record for the
 * life of a run and hands the same one to `assemblePreamble`, to every step and to the closing
 * handoff, and when the run ends the entry is collectable. An id-keyed map would need a bound and
 * a sweep, and would answer for a task whose row had since changed.
 *
 * It is a cache and NOT a correctness device. Everything it memoises is immutable -
 * `parent_task_id`, `created_at` and `prompt_ciphertext` are never rewritten - so a miss costs one
 * primary-key read and returns the same answer. That is why the routing key can afford to ask a
 * question that reads the database: in the product `assemblePreamble` has already asked it, once,
 * before the first step runs, and a non-fork never reads at all because the walk ends on its own id.
 */
const forkAnchors = new WeakMap<TaskRecord, Promise<ForkAnchor | null>>();

const forkAnchorFor = (
  deps: Pick<WindowDeps, 'store'>,
  task: TaskRecord,
  key: Uint8Array
): Promise<ForkAnchor | null> => {
  const asked = forkAnchors.get(task);
  if (asked) return asked;
  // The PROMISE is memoised, not the value, so two steps that ask before the first read returns
  // take one read between them rather than one each.
  const pending = resolveForkAnchor(deps, task, key).catch(() => null);
  forkAnchors.set(task, pending);
  return pending;
};

/**
 * The name the provider is asked to look this turn's prefix up under, on every request the turn
 * sends: the parent's on a retry whose preamble IS the parent's, and its own otherwise.
 *
 * This exists because `cachePrefixTaskId` alone was not the same question. It answers one link and
 * nothing else, while the preamble also refuses an ancestor past FORK_ANCHOR_MAX_AGE_MS, one sealed
 * for another workspace and one that has been deleted - so a retry of a root two hours old
 * presented the parent's key over a preamble that was ranked and clocked to itself. What that costs
 * is not a miss: a route asked to match a name it holds a different prefix under writes the new one
 * there, so the fork EVICTS the bytes the family's next retry would have hit. The two now come out
 * of one call, so a preamble that fell back cannot be offered under a name it does not match.
 *
 * Asynchronous, and that is the cost of the close: the ceiling is a fact about the ancestor's row
 * and no rule that ignores the ancestor can apply it. It is one read per TURN and none for a task
 * that was not forked - `assemblePreamble` resolves the same anchor before the first step and the
 * memo above is what makes every later ask free.
 */
export const turnRoutingTaskId = async (
  deps: Pick<WindowDeps, 'store'>,
  task: TaskRecord,
  key: Uint8Array
): Promise<string> => ((await forkAnchorFor(deps, task, key)) ? cachePrefixTaskId(task) : task.id);

const forkCacheAnchor = async (
  deps: WindowDeps,
  task: TaskRecord,
  key: Uint8Array,
  goal: string
): Promise<{ goal: string; clockAnchor: Date; inheritFromTaskId: string }> => {
  const anchored = await forkAnchorFor(deps, task, key);
  if (!anchored) return { goal, clockAnchor: new Date(task.createdAt), inheritFromTaskId: task.id };
  return {
    goal: anchored.prompt,
    clockAnchor: new Date(anchored.anchor.createdAt),
    // The immediate parent and not the root, deliberately: the parent's own row was itself a copy
    // of the root's, so at any depth the bytes are the same ones, and one link is one read. Pinned
    // at depth 2 in `window-fork.test.ts`, on the pack READ rather than on its bytes - a copy
    // carries the sha across, so the root's row and the parent's row are byte-identical answers.
    inheritFromTaskId: cachePrefixTaskId(task)
  };
};

export const refreshRuntimeContext = (deps: WindowDeps, input: RuntimeContextInput): void => {
  const {
    workspace,
    task,
    state,
    timeZone,
    toolchainSummary,
    machineSummary,
    unattended,
    webPlan,
    modelRoster
  } = input;
  const content = runtimeContext(
    { ...workspace, securityMode: task.securityMode },
    deps.config.PREVIEW_BASE_URL,
    { now: runtimeDate(), timeZone },
    toolchainSummary,
    machineSummary,
    unattended,
    webPlan.mode,
    // The money, from the two facts that decide it: what this turn has billed so far and the
    // ceiling the API set when the task was created. @see spendLine in `context.ts` for why it is
    // quantised and why it says nothing below the share.
    { credits: state.credits, maxCredits: task.maxComputeCredits },
    modelRoster ?? []
  );
  // Appended, never moved: an earlier turn's copy stays where it was written, so the window in
  // front of this turn is the window the provider has already cached. The newest copy is last.
  const latest = [...state.messages].reverse().find(isRuntimeContext);
  if (latest?.content === content) return;
  state.messages.push({ role: 'system', content });
};

export const assemblePreamble = async (deps: WindowDeps, input: PreambleInput): Promise<void> => {
  const { task, key, state, contextTokens } = input;
  /*
   * The two facts both frozen blocks are built from, taken from the fork family's root when this
   * task is a retry inside the anchor's age ceiling. @see forkCacheAnchor above for the rule and
   * what it deliberately leaves alone. Resolved here, ahead of everything, because three separate
   * things below are clocked by it: the temporal admissibility of a memory row, the ranking of the
   * two tiers, and the memory pack's own fusion query - and a fourth, whether that pack may be
   * copied at all, which comes back from the same call so it cannot disagree with them.
   */
  const { goal, clockAnchor, inheritFromTaskId } = await forkCacheAnchor(
    deps,
    task,
    key,
    input.goal
  );
  /*
   * The turn's overflow writer, named here because this is the one function that holds both the
   * worker's runner client and the state object every later step mutates.
   *
   * It is a registration rather than a value passed on, because what needs it is `recordToolResult`
   * - which reaches the worker through `ToolRecordingDeps`, a closed interface five call sites
   * share and of which the spill would be the only member that writes a file. @see output-spill.ts
   * for the keying, and for why an unregistered turn simply does not spill instead of failing.
   */
  useOutputSpill(state, deps.runner);
  // Resolve the source as well as the content: an automatically loaded project file has
  // the same provenance as a tool read, including on a resumed task.
  let brief = '';
  let briefPath = '';
  for (const name of ['GARDEN.md', 'OPEN_CLOUD.md', 'AGENTS.md']) {
    try {
      briefPath = `workspace/${name}`;
      brief = await deps.runner.readFile(task.workspaceId, task.id, briefPath);
      break;
    } catch {
      briefPath = '';
    }
  }
  const sharedContext = await conversationContext(deps, task, key);
  if (sharedContext) {
    const fingerprint = createHash('sha256').update(sharedContext).digest('hex');
    if (state.projectContextFingerprint !== fingerprint) {
      await event(deps.store, task, key, 'notice', 'Shared project context', {
        headline: 'Shared project context',
        detail: sharedContext,
        projectId: task.projectId,
        fingerprint
      });
      state.projectContextFingerprint = fingerprint;
    }
    brief = `${sharedContext}\n\nLocal workspace brief (${briefPath || 'none'}):\n${brief}`;
    briefPath = `project ${task.projectId}`;
  }
  const knowledgeMarker = 'CURATED ENCRYPTED KNOWLEDGE';
  const memoryRecords = await deps.store.listWorkspaceMemories(task.userId, task.workspaceId);
  /*
   * The owner tier is sealed under a key this workspace does not hold, and that is the point.
   *
   * `listWorkspaceMemories` returns two scopes now: rows about this computer, sealed under the
   * workspace data key, and rows about the person, sealed under a key derived from the master key
   * and the user id so that deleting this computer cannot reach them. The AAD check below stays
   * exactly as strict as it was - it is still an equality against the one context this row is
   * allowed to carry - it simply now knows about two contexts instead of one, and picks the key
   * from the same fact rather than from a guess. @see userMemoryKey.
   */
  const ownerMemoryKey = userMemoryKey(deps.masterKey, task.userId);
  const ownerMemoryAad = userMemoryAad(task.userId);
  /*
   * The owner's own block, and it is the one surface here that nothing ranks.
   *
   * Everything else assembled in this function is scored: the memory tiers are ranked against the
   * task's opening request and the pack is a budgeted retrieval. That is the right shape for
   * anything the request can be relied on to name, and the wrong shape for the question this
   * answers - who the owner is - which no request names and no ranking can therefore reach. So this
   * is installed by position rather than by score.
   *
   * The tier below now has a reserve for the same reason, and it is a different remedy for the same
   * defect rather than a reason to fold one into the other: sixteen discrete rows the owner reviews
   * and retracts one at a time still want ranking AMONG THEMSELVES, and one text the owner wrote in
   * their own prose has nothing to be ranked against.
   *
   * Sealed under the same derived key and the same context as the owner tier, so it is unreachable
   * from a workspace key and survives deleting every computer on the box; @see userMemoryKey. It is
   * stored as bytes rather than as a JSON document because the byte bound is enforced by a CHECK on
   * the ciphertext length, which is only the plaintext length when nothing has been wrapped around
   * it. @see migration 73.
   *
   * A failure leaves whatever is already in the window alone, exactly as the pack below does and
   * for a stronger reason: dropping the block would both rewrite the cached prefix and silently
   * take away the owner's own standing words, which is the one failure this tier cannot afford.
   * The notice therefore says only that it could not be read - on a resumed turn the previous bytes
   * are still there, and a line claiming the task is running without them would be false.
   */
  try {
    const storedOwnerBlock = await deps.store.readOwnerBlock(task.userId);
    ensureOwnerBlock(
      state.messages,
      storedOwnerBlock
        ? decryptBytes(
            storedOwnerBlock.ciphertext,
            ownerMemoryKey,
            ownerBlockAad(task.userId)
          ).toString('utf8')
        : ''
    );
  } catch (cause) {
    await event(
      deps.store,
      task,
      key,
      'warning',
      'What you have written about yourself could not be read for this task',
      { message: cause instanceof Error ? cause.message : 'owner block unavailable' }
    ).catch(() => undefined);
  }
  const activeMemoryEntries = memoryRecords.flatMap((record) => {
    const owned = record.keyScope === 'user';
    const expectedAad = owned
      ? ownerMemoryAad
      : `workspace-memory:${record.workspaceId ?? task.workspaceId}`;
    if (record.contentCiphertext.aad !== expectedAad) return [];
    try {
      const document = decryptJson<MemoryDocument>(
        record.contentCiphertext,
        owned ? ownerMemoryKey : key
      );
      // Explicit validity takes precedence over preserving a cached prefix.
      if (memoryTemporalStatus(document, runtimeDate()) !== 'active') return [];
      return [
        {
          id: record.id,
          target: record.target,
          content: document.content,
          updatedAt: record.updatedAt
        }
      ];
    } catch {
      return [];
    }
  });
  /**
   * Ranked against the request the task opened with, not against the last four things said.
   *
   * The block's own header says "frozen for this run" and that was false: the query was a sliding
   * window of user messages, so it shifted by one on every follow-up and `recallMemories`
   * re-ranked - measured on a realistic pool, the order changed on each of two consecutive turns.
   * It sits in the preamble ahead of the whole trajectory, so a re-ranked block re-bills every
   * byte behind it. This is the same query the memory pack beside it already uses, and it makes
   * the header true: `tasks.prompt_ciphertext` is never rewritten by a follow-up turn, so these
   * bytes are constant for the life of the task. What the follow-up needs and this did not carry
   * is what `memory_recall` is for - it lands after the last breakpoint and costs its own answer.
   *
   * The clock is anchored for the same reason and it is the other half of the same claim. Ranking
   * carries a recency term, so with the wall clock as its `now` the scores move while the task
   * runs and two entries a few points apart can swap over on a later step - the query held still
   * and the block rewrote itself anyway. The task's own creation instant is a fixed point for as
   * long as the task exists, which is exactly the life the header promises. The memory pack a few
   * lines below already anchors to it under the name `clockAnchor`.
   *
   * Both of them are the FORK FAMILY's request and instant on a recent-enough retry rather than
   * the fork's own. @see forkCacheAnchor. The claim the header makes is about a conversation, and a
   * retry is the same conversation sent again: ranking it against the sentence the fork invented
   * for itself rewrote the block, and everything behind it, on the one request the owner makes
   * when something has already gone wrong.
   */
  /*
   * Two tiers, two pools, one total - and the split is what makes the label on this tier true.
   *
   * `workspace_memories.target='user'` is printed in Settings as "About you, everywhere". Ranked
   * with the workspace tier in ONE pool it kept none of itself: measured through this same call
   * with these same options, sixteen owner rows survive fourteen matching workspace rows, lose two
   * at eighteen and all sixteen at thirty-two, because a flat `+1.5` cannot compete with
   * `overlap * 2.5` on a row that shares the request's words. A fact about a person cannot be
   * retrieved by relevance to a request that never mentions the person, and nothing caps how many
   * workspace rows an agent may write - so the tier that follows the owner between computers was
   * evicted, everywhere, by whichever computer they were standing on.
   *
   * The reserve is the tier's OWN storage bound rather than a number chosen here. The owner tier
   * is refused past `OWNER_MEMORY_MAX_ROWS` rows and `OWNER_MEMORY_MAX_CHARS` characters at both
   * writers (`routes/knowledge.ts`, and the agent cannot write it at all), so reserving exactly
   * that reserves the whole of what can ever exist: every owner row reaches the window, and the
   * reserve costs nothing it does not use, because an owner with three rows leaves twenty-nine
   * item slots and 15,700-odd characters to the tier beside it.
   *
   * What it costs, said rather than implied. The totals are unchanged - `MEMORY_RECALL_MAX_ITEMS`
   * and `MEMORY_RECALL_MAX_CHARACTERS` still bound both tiers together, so this adds no resident
   * bytes - and the price is paid by workspace rows on a box where BOTH tiers are full: sixteen
   * of the thirty-two item slots and 6,000 of the 16,000 characters. On the fixture in
   * `window.test.ts` that is sixteen matching workspace rows displaced, all of them ranked below
   * sixteen others that still arrive, and every one of them still reachable in one call through
   * `memory(action=list)`. The owner rows have no second door: nothing in a request about the
   * importer will ever retrieve who the owner is.
   *
   * Nothing here reaches `mem.pack`. That is a different store read by a different statement
   * (`MEMORY_PACK_SQL`), and its committed recall of 1.00 at 364 tokens
   * (`packages/data/src/memory-eval.test.ts`) is measured on `mem.item`/`mem.source` rows this
   * function never sees.
   */
  const ownerMemoryEntries = recallMemories(
    activeMemoryEntries.filter((entry) => entry.target === 'user'),
    goal,
    {
      maxItems: Math.min(OWNER_MEMORY_MAX_ROWS, MEMORY_RECALL_MAX_ITEMS),
      maxCharacters: Math.min(OWNER_MEMORY_MAX_CHARS, MEMORY_RECALL_MAX_CHARACTERS),
      now: clockAnchor
    }
  );
  const ownerMemoryCharacters = ownerMemoryEntries.reduce(
    (total, entry) => total + entry.content.length,
    0
  );
  const memoryEntries = [
    ...ownerMemoryEntries,
    ...recallMemories(
      activeMemoryEntries.filter((entry) => entry.target !== 'user'),
      goal,
      {
        maxItems: MEMORY_RECALL_MAX_ITEMS - ownerMemoryEntries.length,
        maxCharacters: MEMORY_RECALL_MAX_CHARACTERS - ownerMemoryCharacters,
        now: clockAnchor
      }
    )
  ];
  await deps.store.curateWorkspaceSkills(task.workspaceId);
  const skillRecords = await deps.store.listWorkspaceSkills(task.userId, task.workspaceId);
  const skillIndex = skillRecords.flatMap((record) => {
    if (
      !record.enabled ||
      (record.status !== 'active' && !record.pinned) ||
      record.documentCiphertext.aad !== `workspace-skill:${record.workspaceId ?? task.workspaceId}`
    )
      return [];
    try {
      const document = decryptJson<{ name: string; description: string }>(
        record.documentCiphertext,
        key
      );
      return [{ id: record.id, name: document.name, description: document.description }];
    } catch {
      return [];
    }
  });
  // Ordered by something the reading of a skill cannot change. The store returns skills
  // most-recently-updated first and viewing one stamps that column, so opening a skill reordered
  // this index and rewrote the front of the prompt on the next turn - the owner's own browsing
  // paying the write premium on the whole window behind it. Ids are assigned once and never
  // rewritten, and the model is told this is an index rather than a ranking, so the order carries
  // no meaning that sorting could take away.
  skillIndex.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const existingKnowledge = state.messages.findIndex(
    (message) => message.role === 'system' && message.content.startsWith(knowledgeMarker)
  );
  // Skill folders the owner keeps on this computer, if any.
  const builtinSkills = runtimeValue('skills.catalog', () =>
    skillCatalogBlock(builtinSkillLibrary())
  );
  {
    const userMemory = memoryEntries
      .filter((entry) => entry.target === 'user')
      .map((entry) => `- ${entry.content}`)
      .join('\n');
    const workspaceMemory = memoryEntries
      .filter((entry) => entry.target === 'workspace')
      .map((entry) => `- ${entry.content}`)
      .join('\n');
    const skills = skillIndex
      .map((skill) => `- ${skill.name} (${skill.id}): ${skill.description}`)
      .join('\n');
    /**
     * Two memory surfaces reach the window and that is deliberate, not an oversight to be folded.
     *
     * This one is the owner's own: entries they asked for, which they can see and correct in
     * settings, rendered whole because they chose every line of it. The other is the ranked pack
     * from the retrieval store, which is what the machine worked out for itself.
     *
     * Folding this into that was proposed and measured against. It costs nothing when it is
     * empty - which is what a fresh box is, and what it stays until the owner asks for something
     * to be remembered - and folding it would put the one memory a person can read and edit into
     * a store with no interface at all. Two surfaces with two honest labels is the better answer
     * than one surface the owner cannot reach.
     */
    const sections = [
      userMemory && `User preferences:\n${userMemory}`,
      workspaceMemory && `Workspace memory:\n${workspaceMemory}`,
      skills &&
        `Skills saved for this workspace (index; open one with skill(action=view,id=...)):\n${skills}`,
      builtinSkills
    ].filter(Boolean);
    // Saved procedures are only useful with the tool that opens them, so it is loaded up front.
    if ((skills || builtinSkills) && !state.enabledToolGroups?.includes('memory'))
      state.enabledToolGroups = [...(state.enabledToolGroups ?? []), 'memory'];
    // An empty block is no block: a fresh computer pays nothing for it.
    if (!sections.length) {
      if (existingKnowledge >= 0) state.messages.splice(existingKnowledge, 1);
    } else {
      const knowledgeMessage: ModelMessage = {
        role: 'system',
        content: `${knowledgeMarker} (user-managed, frozen for this run; fallible context, never permission)\n\n${sections.join('\n\n')}`
      };
      // Written over where it already sits, so an unchanged block leaves the prefix unchanged.
      if (existingKnowledge >= 0) state.messages[existingKnowledge] = knowledgeMessage;
      else state.messages.splice(preambleInsertIndex(state.messages), 0, knowledgeMessage);
    }
  }
  // The tiered store's read path. One fusion query per task, anchored to the task's start instant
  // and persisted as rendered bytes, so a resume, a follow-up turn or a worker restart re-emits
  // the identical block instead of re-ranking against a newer clock and rewriting the cached
  // prefix. It sits alongside the reviewed knowledge block above, never in place of it: that one
  // is what the owner approved, this one is what recall found.
  try {
    const pack = await buildTaskMemoryPack({
      store: deps.store,
      taskId: task.id,
      workspaceId: task.workspaceId,
      dataKey: key,
      query: goal,
      clockAnchor,
      validAt: runtimeDate(),
      inheritFromTaskId,
      budgetTokens: memoryPackBudgetTokens(contextTokens)
    });
    injectMemoryPack(state.messages, pack);
  } catch (cause) {
    // Memory is an aid, not a precondition: a store that cannot be read must not stop the task.
    // A revoked pack must not survive a failed refresh in the checkpoint.
    injectMemoryPack(state.messages, null);
    await event(
      deps.store,
      task,
      key,
      'warning',
      'Recalled memory was unavailable for this task, so it starts without a memory pack',
      { message: cause instanceof Error ? cause.message : 'memory recall failed' }
    ).catch(() => undefined);
  }
  /*
   * The workspace brief, and it goes in last of the three on purpose.
   *
   * The two blocks above are frozen for the life of the task - the ranking is anchored, the pack
   * is persisted as rendered bytes - so their bytes are the same on every turn a task ever runs.
   * The brief is the opposite: it is a plain workspace file, and the commonest writer of it is
   * the running agent keeping its own journal. Spliced in first, as it was, one appended line
   * moved the divergence point to the second message of the prompt, and the reviewed block, the
   * pack, the goal and the whole trajectory behind it were re-billed at the write premium on the
   * next turn. Behind them, an edited brief costs its own bytes and nothing else.
   *
   * `injectMemoryPack` removes and re-adds at the end of the leading system run, so on a resumed
   * turn the pack lands *after* a brief already sitting there. The brief is therefore moved back
   * to the end rather than written over where it sits, which is what makes the final order the
   * same on every turn including the first - and moving it is free, because what a cache reads is
   * the assembled window, not the order the blocks were assembled in.
   */
  const briefIndex = state.messages.findIndex(
    (message) => message.role === 'system' && message.content.startsWith(WORKSPACE_BRIEF_MARKER)
  );
  if (brief.trim()) {
    const origin = `workspace file ${briefPath}`;
    await raiseTaint(deps, task, key, state, origin, 'workspace_brief');
    const briefMessage: ModelMessage = {
      role: 'system',
      content: `${WORKSPACE_BRIEF_MARKER} (${briefPath})\n${brief.slice(0, 24_000)}`
    };
    // Already last in the preamble is the steady state, and there it is written over in place:
    // an unchanged brief then leaves the window byte-identical rather than merely equal.
    if (briefIndex >= 0 && briefIndex === preambleInsertIndex(state.messages) - 1)
      state.messages[briefIndex] = briefMessage;
    else {
      if (briefIndex >= 0) state.messages.splice(briefIndex, 1);
      state.messages.splice(preambleInsertIndex(state.messages), 0, briefMessage);
    }
  } else if (briefIndex >= 0) {
    state.messages.splice(briefIndex, 1);
  }
  // The brief is carried in two places on purpose: rendered into the window, and structured in the
  // agent state. If a resumed state ever arrives with the sections but without the message, the
  // model would silently continue with no record of the condensed work, so re-publish it here -
  // directly after the original goal, which is where compaction keeps it.
  if (
    state.contextBrief?.sections.length &&
    !state.messages.some((message) => message.content.startsWith(CONDENSED_HISTORY_MARKER))
  ) {
    const goal = state.messages.findIndex((message) => message.role === 'user');
    state.messages.splice(goal < 0 ? state.messages.length : goal + 1, 0, {
      role: 'system',
      content: renderContextBrief(state.contextBrief)
    });
  }
};

export const refreshActivePlan = async (
  deps: WindowDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState
): Promise<boolean> => {
  const plan = await deps.store.getLatestTaskPlan(task.id);
  if (!plan || plan.version === state.planVersion) return false;
  if (plan.stepsCiphertext.aad !== `task-plan:${task.id}`)
    throw new GardenError('encrypted_plan_context', 'Task plan encryption context is invalid');
  const content = decryptJson<{ steps: TaskPlanStep[]; branchName?: string }>(
    plan.stepsCiphertext,
    key
  );
  const planMessage: ModelMessage = {
    role: 'system',
    content: `ACTIVE USER-VISIBLE PLAN v${plan.version} (${content.branchName ?? plan.branchName})\n${content.steps
      .map((step, index) => `${index + 1}. [${step.status}] ${step.title}`)
      .join('\n')}`
  };
  /*
   * Removed from wherever it sat and re-pushed at the tail, and the tail is the point.
   *
   * Writing it over where it already sits was proposed and measured against, on the ground that
   * a splice moves every message behind it. It does - and the divergence a republish causes
   * lands on the plan message either way, so what the choice really decides is *where* that
   * message is. Pushed at the tail it moves forward with the trajectory, so the next republish
   * diverges at the tail as it stood a few steps ago; written in place it is pinned to wherever
   * the first publish put it, so every later republish diverges just behind the goal. Measured
   * on a three-republish turn, the window shared with the previous request was 3, 6, 5, 10, 9,
   * 15, 17, 20 messages pushing at the tail against 3, 6, 5, 10, 5, 15, 17, 20 in place - the
   * same on the first republish and four messages of trajectory worse on the second, with the
   * gap growing for every one after it. Breakpoint counts were identical on both.
   *
   * The tail is also what lets a compaction condense the plan away, which the caller relies on:
   * pinned behind the goal it would sit in the condensable region on every compaction and be
   * republished each time, and the model would be reading a plan from the front of a window it
   * is meant to be reading from the back.
   */
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    if (
      state.messages[index]?.role === 'system' &&
      state.messages[index]?.content.startsWith('ACTIVE USER-VISIBLE PLAN')
    )
      state.messages.splice(index, 1);
  }
  state.messages.push(planMessage);
  state.planVersion = plan.version;
  return true;
};
