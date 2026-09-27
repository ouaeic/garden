import { runtimeDate, runtimeNow } from '@athanor/core';
/**
 * What a finished turn deposits in the tiered store: the episode, and the cautions the harness
 * earned by watching an acceptance command fail.
 *
 * Lifted out of `AgentWorker` in Wave 7.2 unchanged. Both halves are write paths with their own
 * failure discipline - one reports, one swallows, and the comments say why they differ - and both
 * were reachable only through a completed turn.
 */
import {
  deadEndFromCheck,
  encryptJson,
  memoryDeadEndTagKey,
  memoryIndexKey,
  memorySubjectKey,
  redactText,
  type MemoryDeadEndCheck
} from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { AcceptanceCommandCheck } from './acceptance.js';
import type { AgentState } from './agent-state.js';
import type { CompletionVerification } from './completion.js';
import {
  extractTurn,
  finishedAnswerText,
  MEMORY_MAX_SOURCE_CHUNKS,
  memoryItemAad,
  recordMemoryPackOutcome,
  recordTurnEpisode,
  shouldConsolidateMemory
} from './memory-runtime.js';
import { event } from './tool-recording.js';

/** What the memory write path needs from the worker that owns the turn. */
export interface MemoryCaptureDeps {
  readonly store: DataStore;
  /**
   * When each workspace's memory was last consolidated, held by the worker rather than the store
   * because the cadence is an optimisation rather than a guarantee. Passed in so the claim before
   * the await still stops a second turn finishing concurrently from running it twice.
   */
  readonly memoryConsolidatedAt: Map<string, number>;
}

/**
 * The tiered store's write path, run once per verified turn.
 *
 * Episodes are captured automatically because they are mechanical: goal, outcome and the
 * artifacts touched, all of which the turn already produced. Durable facts are held back one
 * step further: anything the owner said that looks like a lasting truth is only ever *observed*
 * into `mem.fact_candidate`, and becomes memory on a second independent sighting on a later day,
 * from untainted input. What makes this the owner's rather than the harness's is that it is
 * reversible - deleting the conversation deletes the episode and the verbatim sources it cites,
 * and deleting the workspace removes everything. There is no approval step, deliberately:
 * automatic memory that asks permission for every line is a review queue, not memory.
 */
export const captureMemory = async (
  deps: MemoryCaptureDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  completion: {
    summary: string;
    verification: CompletionVerification;
    /** Present, and true, only on a turn the harness stopped rather than the model. */
    interrupted?: boolean;
    /** Acceptance checks the harness ran and watched pass on the finishing turn. */
    verifiedCommands?: readonly AcceptanceCommandCheck[];
  },
  /** The commands it watched fail on that same run, which is the other half of the same lesson. */
  deadEnds: readonly MemoryDeadEndCheck[] = []
): Promise<void> => {
  const occurredAt = runtimeDate();
  try {
    const { request, artifacts } = extractTurn(state.messages);
    // What this turn touched, including the steps a compaction removed from the window. Carried
    // first so the earliest work is named first, which is the order it happened in.
    const touched = [...new Set([...(state.carriedArtifacts ?? []), ...artifacts])];
    const written = await recordTurnEpisode({
      store: deps.store,
      userId: task.userId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      dataKey: key,
      request,
      summary: completion.summary,
      // Every turn that reaches #completeTurn is recorded here, the verified finish and the
      // step-limit handoff alike, so the label has to say which one this was. Keyed off
      // `interrupted` and never off verification.status: `not_applicable` is the correct status
      // for an answer that needed no tools, so keying off it would file most chat turns as
      // failures.
      outcome: completion.interrupted ? 'interrupted' : 'ok',
      verifiedClaims: completion.verification.evidence.map((item) => item.claim),
      /*
       * The pointer the completion contract already produced, kept instead of dropped.
       *
       * `completion.ts` makes the agent cite the `toolCallId` of the call that justifies each
       * claim, and `tool-recording.ts` writes that call's raw untruncated result to the timeline.
       * Both ends of the edge existed; the line above mapped the evidence to `item.claim` and the
       * id went no further. So athanor computed, on every verified turn, exactly the pointer into
       * the eighty per cent of a trajectory that is tool output - the part that is not re-derivable
       * and is worth keeping - and threw it away at the memory boundary.
       *
       * Resolved through `state.turnToolResults`, which is the harness's own ledger of what it ran
       * this turn, and that is the bound rather than a check bolted on afterwards: an id the model
       * invented resolves to nothing here and is dropped, so nothing downstream has to ask whether
       * a stored citation was real. Costs zero resident bytes - the episode body is unchanged, and
       * what is stored is two ids in a table nothing renders into a window.
       */
      citedCalls: completion.verification.evidence.flatMap((item) => {
        const eventId = item.toolCallId
          ? state.turnToolResults?.[item.toolCallId]?.eventId
          : undefined;
        return eventId ? [{ toolCallId: item.toolCallId!, eventId }] : [];
      }),
      remainingRisks: completion.verification.remainingRisks,
      artifacts: touched,
      // What the harness itself verified about this workspace, which is the half of memory that
      // does not come from anything the owner typed.
      ...(completion.verifiedCommands?.length
        ? {
            verifiedCommands: completion.verifiedCommands.map((check) => ({
              label: check.label,
              executable: check.executable,
              args: check.args,
              cwd: check.cwd
            }))
          }
        : {}),
      // A turn that read somebody else's words records what happened but settles nothing.
      tainted: Boolean(state.taint),
      /*
       * And now it records WHAT it read, not only that it read something.
       *
       * The boolean is enough for the gates that run at capture time - they refuse and forget. It
       * is not enough for the reach, which hands stored material from this turn back to a later
       * one: that material has to arrive fenced and carrying an origin, and the origin has to name
       * a real source or the owner's timeline can only ever say "somewhere".
       *
       * The newest source rather than the first, which is the same choice `raiseTaint` makes when
       * it keeps `slice(-8)`: the arrival is the one that matters, and the openers of a research
       * turn are the eight that do not.
       */
      ...(state.taint?.sources.at(-1) ? { taintOrigin: state.taint.sources.at(-1)! } : {}),
      occurredAt
    });
    /*
     * What the source cap refused, said out loud.
     *
     * The cap itself is right and is unchanged: eight rows of six kilobytes per part, keeping the
     * head. What was wrong is that a 400 KB brief was stored as its first 48 KB with no event of
     * any kind, so the owner could later search memory for a constraint they had definitely
     * written and be told, truthfully and uselessly, that nothing matched.
     *
     * HOW OFTEN IT FIRES ON THIS MACHINE: never, so far. Measured over the owner's real corpus -
     * 675 turns, 233,064 characters, 11 projects, 49 active days, filtered as `type: user`,
     * `userType: external`, not a sidechain, not a tool result, not `isMeta` with a
     * `sourceToolUseID`, no slash-command or compaction-continuation block, deduped by uuid, with
     * `origin.kind: "task-notification"` stripped - the largest single turn is 14,625 characters
     * against a cap of 48,000 bytes per part. It fires 0 times and 100.0% of what the owner typed
     * reaches a source row. The 197-of-3,950 and 57.7% this comment used to state were measured on
     * a corpus that counted machine-written text as the owner's, and are void.
     *
     * The event stays, and so does the cap. A number that has never fired is not a number that
     * cannot: one 400 KB paste is one turn away, and the whole point of the line below is that the
     * owner finds out on the day it happens rather than a month later from a search that misses.
     *
     * A status rather than a warning: the turn WAS recorded, and the sentence above it - "this
     * turn was not recorded in memory" - is the one that must stay reserved for when it was not.
     * Never fatal, like every other line in this function after the episode is written.
     */
    if (written && written.sourceChunksDropped > 0)
      await event(
        deps.store,
        task,
        key,
        'status',
        `Stored the first ${MEMORY_MAX_SOURCE_CHUNKS} parts of this turn verbatim; ${written.sourceChunksDropped} further ${written.sourceChunksDropped === 1 ? 'part is' : 'parts are'} searchable in the conversation but not in memory`,
        { droppedChunks: written.sourceChunksDropped, keptChunks: written.sourceIds.length }
      ).catch(() => undefined);
    await recordDeadEnds(deps, task, key, {
      tainted: Boolean(state.taint),
      passed: completion.verifiedCommands ?? [],
      failed: deadEnds,
      observedAt: occurredAt
    });
    // A turn that never finished has graded nothing. The injection-time row already counted the
    // use as `unknown`, so the items keep their salience and simply stay ungraded, which is the
    // truth. Not `fail` either: the pack is not what ran out of steps, and marking it down would
    // punish the items that did help.
    if (!completion.interrupted)
      await recordMemoryPackOutcome({
        store: deps.store,
        workspaceId: task.workspaceId,
        taskId: task.id,
        outcome: 'ok',
        // The one place in the product that knows both what was recalled and what was done with
        // it, which is why the citation is written here and not at injection time.
        //
        // `cited_count` is a fifth of the salience score that decides which memories survive
        // consolidation, and its only writer takes a `cited` flag that no production caller had
        // ever passed - so the column was zero in every workspace that had ever run and the term
        // was a constant for every row in the pool. What was missing was never the column: it was
        // an answer to "which of these entries did the turn use", and the only moment that answer
        // exists is here, with the finished work in hand.
        dataKey: key,
        used: [
          finishedAnswerText(state.messages),
          completion.summary,
          ...completion.verification.evidence.map((item) => item.claim),
          // The commands the harness itself watched pass. Without them a procedure that was
          // followed to the letter grades identically to one that was ignored, because nobody
          // writes a shell command out to the owner in prose.
          ...(completion.verifiedCommands ?? []).map((check) =>
            [check.executable, ...check.args].join(' ')
          )
        ],
        // Excluded from attribution rather than added to it: the block was retrieved *with* this
        // request, so an entry and the request overlap by construction.
        request
      });
    const now = runtimeNow();
    if (shouldConsolidateMemory(deps.memoryConsolidatedAt.get(task.workspaceId), now)) {
      // Claimed before the await so a second turn finishing concurrently does not run it twice.
      deps.memoryConsolidatedAt.set(task.workspaceId, now);
      if (deps.memoryConsolidatedAt.size > 256) {
        deps.memoryConsolidatedAt.clear();
        deps.memoryConsolidatedAt.set(task.workspaceId, now);
      }
      await deps.store.consolidateMemory(task.workspaceId);
    }
  } catch (cause) {
    // The user already has their verified result; a memory write must never turn that into a
    // failed task. It is reported rather than swallowed so a store that stops recording is
    // visible instead of silently degrading recall for months.
    await event(
      deps.store,
      task,
      key,
      'warning',
      'This turn was not recorded in memory, so it will not be recalled later',
      { message: cause instanceof Error ? cause.message : 'memory capture failed' }
    ).catch(() => undefined);
  }
};

/**
 * What the harness watched an acceptance command fail to do, and what a later pass does to it.
 *
 * The write half carries the same gate as a fact and a procedure: a turn that read somebody
 * else's words settles nothing durable. It matters more here than there. The commands are the
 * model's, and a page that can steer the model into declaring a check against the wrong directory
 * gets a standing "this does not work" out of the machine's own observation - which is the one
 * way something outside could plant a belief that survives the conversation it arrived in.
 *
 * The retirement half deliberately runs anyway. Nothing anyone reads can make a command exit
 * zero, and forgetting a caution costs a re-run where keeping a wrong one costs the approach.
 *
 * Failures here are swallowed rather than reported. The turn's own record is already written by
 * the time this runs, and the warning above says the turn was not recorded at all - which would
 * be false, and the owner would go looking for a conversation that is in fact there.
 */
export const recordDeadEnds = async (
  deps: MemoryCaptureDeps,
  task: TaskRecord,
  key: Uint8Array,
  input: {
    tainted: boolean;
    passed: readonly AcceptanceCommandCheck[];
    failed: readonly MemoryDeadEndCheck[];
    observedAt: Date;
  }
): Promise<void> => {
  const indexKey = memoryIndexKey(key);
  // Sliced exactly as a passing run keys its subject, so the two sides of one command meet.
  const passed = input.passed.map((check) =>
    memorySubjectKey([check.executable, ...check.args].join(' ').slice(0, 400), indexKey)
  );
  const failed = input.tainted
    ? []
    : input.failed.map((observation) => {
        const { content, index, validTo } = deadEndFromCheck(
          // Redacted at the door, like everything else that lands in memory: this is up to two
          // kilobytes of stderr, which is where an inline token in a failing request shows up.
          { ...observation, detail: redactText(observation.detail) },
          input.observedAt,
          indexKey
        );
        return {
          userId: task.userId,
          workspaceId: task.workspaceId,
          // Derived like the passing half, and for the same reason: the harness ran it and
          // watched the result. Nothing here is the model's account of its own work.
          trust: 'derived' as const,
          documentCiphertext: encryptJson(content, key, memoryItemAad(task.workspaceId)),
          index,
          observedAt: input.observedAt,
          validFrom: input.observedAt,
          validTo,
          taskId: task.id
        };
      });
  if (passed.length === 0 && failed.length === 0) return;
  await deps.store
    .recordMemoryDeadEnds({
      workspaceId: task.workspaceId,
      markerTag: memoryDeadEndTagKey(indexKey),
      passed,
      failed,
      at: input.observedAt
    })
    .catch(() => undefined);
};
