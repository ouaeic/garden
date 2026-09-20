import { invalidateWorkspaceReadCache } from './read-invalidation.js';
import { evidenceProgressKey } from './progress.js';
/**
 * What a turn writes down about a tool call: the timeline row, the window entry, the provenance it
 * moves forward, and the run of read-only calls that share one lease and one cancellation watch.
 *
 * Lifted out of `AgentWorker` in Wave 7.2. It was five unrelated jobs threaded through one 202-line
 * method plus two of its neighbours, and the thing that made it a file rather than a region is the
 * import graph: `event` is the encrypted timeline writer every other sub-machine needs, and leaving
 * it in `agent.ts` meant every one of them reached back through the class to get it.
 *
 * The vision handoff that used to close `recordToolResult` is not here. It returns the image
 * instead, and `vision.ts` - which imports `event` from this file - is entered by the caller. That
 * is the only reason the split falls where it does: a `tool-recording -> vision -> tool-recording`
 * cycle is the alternative.
 */
import type { ModelRelease, TaskEventKind, WebToolPlan } from '@athanor/contracts';
import { AthanorError, encryptJson } from '@athanor/core';
import type { DataStore, TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import { callDestinations } from './command-classification.js';
import { completionReference, shellObservation, processObservation } from './completion.js';
import {
  boundToolResultText,
  RECENT_TOOL_OUTPUT_CHARS,
  toolResultText,
  type TruncationRecovery
} from './context.js';
import {
  chargeNovelty,
  classifyDestination,
  rememberAddress,
  rememberOrigin,
  type DestinationContext
} from './egress.js';
import {
  botWallFromError,
  botWallFromRunner,
  isHarnessAnswer,
  originsFromResult,
  untrustedOriginOfResult,
  untrustedTurnNotice
} from './provenance.js';
import { spillOverflow, spillRecovery } from './output-spill.js';
import { sanitiseUntrusted, sanitiseUntrustedText, untrustedEnvelope } from './sanitise.js';
import { boundedToolResultForModel } from './streaming.js';
import { delegateOutputSummary } from './delegate-output.js';
import { surfaceActionVerb } from './surface-actions.js';
import type { BotWall } from './provenance.js';
import {
  failingCallKey,
  IDEMPOTENT_WITHIN_TURN,
  idempotentCallKey,
  repeatedFailureKey,
  repeatedFailuresAfter
} from './turn-bounds.js';
import { asRecord, textValue } from './values.js';
import {
  isMutatingToolCall,
  requiresAcceptanceChecks,
  writesOnlyDurableInstructions,
  writesOnlyProse
} from './write-classification.js';

/**
 * A picture a tool result carries, as the window will hold it.
 *
 * Moved here with `recordToolResult` because both halves of the split read it: this file decides
 * whether there is one, and `vision.ts` decides who looks at it.
 */
export interface ImageObservation {
  mimeType: string;
  base64: string;
  /**
   * What the file on disk is. The runner re-encodes every picture on its way out, which is what
   * takes a photograph's location and camera off it, so this is never the bytes the file holds.
   */
  convertedFrom?: string;
  screen?: {
    region?: { x: number; y: number; width: number; height: number };
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    scale?: number;
  };
}

/**
 * What recording a tool call needs from the worker that owns the turn.
 *
 * Passed rather than imported, for the reason the audit gave when it drew this file: every one of
 * these is a method whose behaviour depends on the worker's own private state - the master key, the
 * runner client, the lease it holds - and a function that closed over a module-level copy of any of
 * them would be a second worker in the same process.
 */
export interface ToolRecordingDeps {
  readonly store: DataStore;
  readonly config: AgentWorkerConfig;
  /** The owner-facing card a bot wall raises, which both the success and the failure path reach. */
  raiseTakeover(task: TaskRecord, key: Uint8Array, state: AgentState, wall: BotWall): Promise<void>;
  ensureTurnUndoPoint(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    tool: string
  ): Promise<void>;
  checkpoint(task: TaskRecord, key: Uint8Array, state: AgentState): Promise<void>;
  withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
  withCancellationWatch<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
  execute(
    task: TaskRecord,
    call: ModelToolCall,
    key: Uint8Array,
    approved: boolean,
    webPlan: WebToolPlan,
    state: AgentState
  ): Promise<unknown>;
  /** Where this run may send data, assembled once by the worker for everything that asks. */
  destinationContext(state?: AgentState): DestinationContext;
  /**
   * Recording *and* the vision routing that follows it, which is the caller's own sequencing of
   * this file and `vision.ts`. A parallel run answers each of its calls through the same door the
   * sequential path uses, so a picture read inside a run is looked at exactly as one read outside
   * it is.
   */
  recordToolResult(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    call: ModelToolCall,
    result: unknown,
    leadModel: ModelRelease,
    catalog: ModelRelease[]
  ): Promise<void>;
}

/**
 * One encrypted timeline row. `kind` is the declared enum rather than a string: the store parses it
 * at the write boundary, so an undeclared kind already threw at runtime - naming the type here moves
 * the same check to the compiler, where it costs nothing to find.
 */
export const event = async (
  store: DataStore,
  task: TaskRecord,
  key: Uint8Array,
  kind: TaskEventKind,
  summary: string,
  payload?: unknown,
  options?: { replacesEarlierFrames?: boolean }
) =>
  store.appendTaskEvent({
    taskId: task.id,
    kind,
    summary: `Encrypted ${kind.replaceAll('_', ' ')} event`,
    payloadCiphertext: encryptJson(
      { __athanorEventVersion: 1, summary, payload },
      key,
      `task-event:${task.id}`
    ),
    ...(options?.replacesEarlierFrames ? { replacesEarlierFrames: true } : {})
  });

/**
 * One record of a tool call that failed: the timeline event, the result the model reads, and the
 * owner's phone when the failure is one only they can clear.
 *
 * Both places a tool can be executed - the ordinary loop and the resumption of an approved call -
 * used to write this out separately, which is how the approved half could have been left without
 * the takeover raise.
 */
export const recordToolFailure = async (
  deps: ToolRecordingDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  error: unknown
): Promise<void> => {
  if (isMutatingToolCall(call.name, call.arguments) || call.name === 'code_diagnostics')
    invalidateWorkspaceReadCache(state);
  const message = error instanceof Error ? error.message : 'Tool failed';
  const wall = botWallFromError(error);
  await event(deps.store, task, key, 'error', `${call.name} failed`, {
    toolCallId: call.id,
    message,
    ...(error instanceof AthanorError ? { code: error.code } : {}),
    ...(wall ? { botWall: wall } : {})
  });
  state.messages.push({ role: 'tool', toolCallId: call.id, content: `Tool failed: ${message}` });
  state.turnToolResults ??= {};
  state.turnToolResults[call.id] = { name: call.name, success: false };
  // A call that threw still reached for its addresses, so the turn is charged for them here as
  // well as on the success path. Left out, a server that simply never answered made the whole
  // budget optional - see `#chargeCallNovelty`.
  chargeCallNovelty(deps, state, call);
  // Counted here rather than at the call sites for the same reason the takeover raise is: both
  // places a tool can be executed reach this one, and an approved call that fails on resumption
  // is the same failure as any other. What is done about the count is the loop's, at the end of
  // the step, where every other bound in this file speaks.
  state.repeatedFailures = repeatedFailuresAfter(state.repeatedFailures, {
    call: failingCallKey(call),
    failure: repeatedFailureKey(call, error)
  });
  if (wall) await deps.raiseTakeover(task, key, state, wall);
};

/**
 * Runs one run of read-only calls at the same time and answers them in the order they were asked.
 *
 * `calls` is a maximal run of `PARALLEL_SAFE_TOOLS` chosen by `parallelToolRun` and already past
 * the approval floor, and every one of them is answered here - the caller walks past all of them.
 *
 * Everything that is not the waiting stays sequential, deliberately. The results are recorded one
 * after another in the declared order rather than as they land, because the window is the turn's
 * memory and a window whose order depends on which read finished first is a turn that cannot be
 * reproduced, replayed or compared with itself. Recording is also where provenance, taint and the
 * novelty budget are moved forward, and those are cumulative: running them in order means they
 * see exactly what they saw before this existed.
 */
export const runToolCallsTogether = async (
  deps: ToolRecordingDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  calls: readonly ModelToolCall[],
  context: {
    model: ModelRelease;
    catalog: ModelRelease[];
    /**
     * The run's pinned web route. Required, where it was optional and spread in conditionally at
     * the one call site: `resolveWebToolPlan` never returns nothing, so the conditional described
     * a case that could not happen while letting `undefined` reach the dispatch table, which is
     * the one case that could.
     */
    webPlan: WebToolPlan;
    /** Whether the owner has published a newer plan since this batch was proposed. */
    refreshActivePlan: () => Promise<boolean>;
  }
): Promise<void> => {
  const { model, catalog, webPlan } = context;
  // Once for the run rather than once per call, which is the whole saving: it is a read of the
  // owner's plan, and the run holds nothing that could act on a change to it.
  if (await context.refreshActivePlan()) {
    for (const call of calls)
      await deps.recordToolResult(
        task,
        key,
        state,
        call,
        {
          skipped: true,
          reason:
            'The user changed the active plan after this tool call was proposed. Replan before acting.'
        },
        model,
        catalog
      );
    return;
  }
  // Registered after the plan is re-read, not before it: the sequential path registers a repeat
  // key at the point the call is dispatched, and a run that was answered wholesale because the
  // owner republished the plan dispatched nothing. Registering first left the re-issue the skip
  // notice had just demanded answered as a duplicate of a call that never ran.
  for (const call of calls)
    if (IDEMPOTENT_WITHIN_TURN.has(call.name) && !call.parseFailed)
      state.seenCalls = { ...(state.seenCalls ?? {}), [idempotentCallKey(call)]: call.id };
  for (const call of calls) {
    // Both of these are no-ops for everything in this set - it is read-only by construction - and
    // both are called anyway, so that the set gaining a member can never quietly cost the owner
    // their undo point or leave a change out of the plan the interface draws.
    await deps.ensureTurnUndoPoint(task, key, state, call.name);
    if (isMutatingToolCall(call.name, call.arguments)) {
      state.mutated = true;
      if (requiresAcceptanceChecks(call.name, call.arguments)) state.mutatedBeyondProse = true;
    }
    state.toolsStarted = (state.toolsStarted ?? 0) + 1;
    await event(deps.store, task, key, 'tool_started', `Running ${call.name}`, {
      toolCallId: call.id,
      tool: call.name,
      arguments: call.arguments
    });
  }
  /*
   * One lease renewal and one cancellation watch around the whole run, not one of each per call.
   * The lease is two minutes and the run is as long as its slowest member, so the renewal has to
   * span it; the watch is what a Stop pressed mid-run reaches, and it aborts every request in the
   * run at once because they all inherit its signal.
   *
   * Nothing here rejects. Each call is settled into its own outcome, so a runner that drops one
   * read cannot throw away three that already came back - the model is told which one failed and
   * keeps the rest, where before an exception left the whole run unanswered.
   */
  const settled = await deps.withLeaseRenewal(task, () =>
    deps.withCancellationWatch(task, () =>
      Promise.all(
        calls.map(async (call) => {
          try {
            return {
              ok: true as const,
              result: await deps.execute(task, call, key, false, webPlan, state)
            };
          } catch (error) {
            return { ok: false as const, error };
          }
        })
      )
    )
  );
  for (const [index, call] of calls.entries()) {
    const outcome = settled[index];
    if (!outcome) continue;
    if (outcome.ok)
      await deps.recordToolResult(task, key, state, call, outcome.result, model, catalog);
    else await recordToolFailure(deps, task, key, state, call, outcome.error);
  }
  /*
   * One state write for the run, where the sequential path writes twice around every call that
   * needs replay protection and nothing at all around a read.
   *
   * It is not an in-flight marker - a read that ran twice costs a round trip and tells the owner
   * nothing, which is the whole reason these tools are the ones allowed to overlap. It is the
   * point at which reads already paid for become durable, so a worker that dies between this run
   * and the next model call resumes with four answers in the window instead of fetching them
   * again. Guarded by the worker id like every other write from here, so a run whose task was
   * paused underneath it matches no rows and leaves the owner's own closing write in charge.
   */
  await deps.checkpoint(task, key, state);
};

/**
 * What one call sent, charged to the turn before the next one is judged against it.
 *
 * The novelty count was computed per address, reported on the card and added to nothing, so a
 * 2,048-byte secret left in twenty-two addresses that were each individually inside the bound.
 * Charged only while the turn is tainted: a clean research pass pays nothing at all.
 *
 * Charged on the attempt rather than on the answer. A request that throws still went out - the
 * hostname was resolved and the payload was in the path - and the only party who decides whether a
 * request is answered is the server being talked to, so charging on success alone made stalling a
 * free channel: a collector that accepts and never replies produced `TOOL_REQUEST_TIMEOUT_MS`,
 * left the total where it was, and the next chunk was judged against the same figure again.
 */
export const chargeCallNovelty = (
  deps: ToolRecordingDeps,
  state: AgentState,
  call: ModelToolCall
): void => {
  const reached = state.taint ? callDestinations(call.name, call.arguments) : [];
  if (!reached.length) return;
  // Assembled only when something actually reached the outside: the corpus is up to forty
  // kilobytes of the owner's own words, and most tool calls in a turn go nowhere near a host.
  const destinations = deps.destinationContext(state);
  state.turnNoveltyBytes = chargeNovelty(
    state.turnNoveltyBytes ?? 0,
    reached.map((url) => classifyDestination(url, destinations))
  );
};

/**
 * Moves the turn's provenance forward from one tool result.
 *
 * Two things are recorded and they pull in opposite directions on purpose. A read of something
 * attacker-reachable raises the taint, which raises the approval floor on the small set of calls
 * that can send data out or leave durable instructions behind. A read of a page the turn was
 * legitimately sent to also records that host as one the turn has been to, which is what keeps
 * ordinary research from asking for approval to follow its own links.
 */
export const recordProvenance = async (
  deps: ToolRecordingDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  result: unknown
): Promise<string | null> => {
  // A result the harness wrote rather than the runner - an idempotent repeat, a plan that changed
  // underneath the call, arguments that would not parse - is a request that was never made, and a
  // budget that spends itself on those raises cards on turns where nothing left the machine.
  if (!isHarnessAnswer(result)) chargeCallNovelty(deps, state, call);
  for (const url of originsFromResult(call, result)) {
    state.knownOrigins = rememberOrigin(state.knownOrigins ?? [], url);
    state.knownAddresses = rememberAddress(state.knownAddresses ?? [], url);
  }
  return raiseTaint(deps, task, key, state, untrustedOriginOfResult(call, result), call.name);
};

/**
 * The taint transition itself, shared by the tool results and the provider-side web tools.
 *
 * One place, because the floor is only as good as the narrowest way into it: a second copy of
 * "set the level, remember the source, write the event, return the notice" is a second copy that
 * can be one clause out of step with this one and still look right.
 */
export const raiseTaint = async (
  deps: Pick<ToolRecordingDeps, 'store'>,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  origin: string | null,
  tool: string
): Promise<string | null> => {
  if (!origin) return null;
  const first = !state.taint;
  // The newest eight, not the first eight. `slice(0, 8)` kept the openers and dropped the arrival:
  // a research turn that had read eight domains and then read the attacker's page recorded nothing
  // about the ninth - the set came back the same length, `changed` was false, and the function
  // returned before writing the warning. Every card raised afterwards named three of the eight
  // that did not matter. `changed` is membership for the same reason: it is the question being
  // asked, and length was only ever a proxy for it that a full window silenced.
  const changed = first || !state.taint?.sources.includes(origin);
  const sources = [...new Set([...(state.taint?.sources ?? []), origin])].slice(-8);
  state.taint = {
    level: 'untrusted',
    sources,
    sinceStep: state.taint?.sinceStep ?? state.step
  };
  if (!changed) return null;
  // A record the owner can go back to. A repeat origin across tasks is the strongest residual
  // attack in this design - buying the ranking for a query the owner will plausibly run - and it
  // is only visible if every transition is written down.
  await event(
    deps.store,
    task,
    key,
    origin.startsWith('workspace file') ? 'provenance' : 'warning',
    `Untrusted content entered this turn from ${origin}`,
    { taint: state.taint, tool }
  ).catch(() => undefined);
  // Returned rather than pushed as its own message: a bare system entry between an assistant's
  // tool call and the result answering it is exactly the shape providers reject, and the notice
  // belongs on the read that introduced the content in any case.
  return first ? untrustedTurnNotice(sources) : null;
};

export const recordToolResult = async (
  deps: ToolRecordingDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  result: unknown
): Promise<ImageObservation | undefined> => {
  if (
    call.name === 'delegate' &&
    result &&
    typeof result === 'object' &&
    Number.isFinite(Number((result as Record<string, unknown>).usageCredits))
  )
    state.credits += Number((result as Record<string, unknown>).usageCredits);
  let image: ImageObservation | undefined;
  if (call.name === 'image_read' && result && typeof result === 'object')
    image = result as ImageObservation;
  const surfaceScreenshot =
    ['browser_snapshot', 'desktop_observe'].includes(call.name) ||
    (call.name === 'desktop_action' && surfaceActionVerb(call.arguments) === 'zoom');
  const surface = asRecord(result);
  if (surfaceScreenshot && surface && !isHarnessAnswer(result)) {
    const screenshot = textValue(surface.screenshotBase64);
    const mimeType = textValue(surface.screenshotMimeType, 'image/jpeg');
    if (screenshot && ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
      const screen: NonNullable<ImageObservation['screen']> = {};
      for (const field of ['width', 'height', 'displayWidth', 'displayHeight', 'scale'] as const) {
        const value = surface[field];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) screen[field] = value;
      }
      const region = asRecord(surface.region);
      if (
        region &&
        ['x', 'y', 'width', 'height'].every(
          (field) => typeof region[field] === 'number' && Number.isFinite(region[field])
        ) &&
        Number(region.x) >= 0 &&
        Number(region.y) >= 0 &&
        Number(region.width) > 0 &&
        Number(region.height) > 0
      )
        screen.region = {
          x: Number(region.x),
          y: Number(region.y),
          width: Number(region.width),
          height: Number(region.height)
        };
      image = {
        mimeType,
        base64: screenshot,
        ...(Object.keys(screen).length ? { screen } : {})
      };
    }
  }
  const imageSummary =
    call.name === 'image_read' && image
      ? {
          mimeType: image.mimeType,
          bytes: Buffer.byteLength(image.base64, 'base64'),
          path: textValue(call.arguments.path),
          // Spread rather than assigned, because under exactOptionalPropertyTypes an explicit
          // undefined is not the same as an absent field.
          ...(image.convertedFrom ? { convertedFrom: image.convertedFrom } : {})
        }
      : undefined;
  /*
   * Asked here, before anything derived from this result is written anywhere.
   *
   * `recordProvenance` below asks the same question for its own purposes, and this is deliberately
   * a second call rather than a value threaded out of it: `untrustedOriginOfResult` is a pure
   * classification of the call and the result, the two answers cannot disagree, and the
   * alternative is a signature change on a function four other files enter. What it buys is that
   * the timeline row and the window entry are both written knowing whether these bytes are the
   * owner's own or somebody else's - which used to be knowable only after both had been written.
   *
   * A harness answer is not content at all: nothing ran, nothing was fetched, and what the model
   * is holding is this build's own sentence about why. Fencing that as data somebody else wrote is
   * worse than not fencing it - it tells the model the harness's own refusal cannot be trusted.
   * The taint transition below is deliberately left alone: whether a skipped repeat should still
   * raise it is a separate question from whose words these are.
   */
  const untrustedOrigin = isHarnessAnswer(result) ? null : untrustedOriginOfResult(call, result);
  /*
   * The owner's copy is stripped too, not only the model's.
   *
   * The Tags block is invisible in the timeline exactly as it is invisible in a browser, so a
   * hidden instruction that survives here is one the owner cannot see while deciding whether to
   * approve the thing it asked for - and the approval card is rendered from this record. Nothing
   * legible is lost: what is removed had no rendering to lose. Only untrusted results are touched,
   * so a file the owner wrote keeps every codepoint they put in it.
   */
  const eventResult = untrustedOrigin
    ? sanitiseUntrusted(imageSummary ?? result)
    : (imageSummary ?? result);
  /*
   * The row this is written to is now named, because something later has to be able to find it.
   *
   * These bytes are the raw object the tool returned - the model's copy below is bounded, fenced
   * and possibly spilled, and this one is not - and until now nothing in the product could reach
   * them: the readers of `task_events` are the owner's timeline and the privacy export. A `finish`
   * that cites this call can leave a durable pointer to it, and the pointer is worth keeping only
   * if following it is one lookup rather than a walk over the conversation decrypting payloads
   * until one matches. The id is the harness's own; nothing the model writes can name a row.
   */
  const recorded = await event(deps.store, task, key, 'tool_result', `${call.name} completed`, {
    toolCallId: call.id,
    result: eventResult
  });
  const provenanceNotice = await recordProvenance(deps, task, key, state, call, result);
  /*
   * Any result at all is this call producing something other than what it produced last time,
   * which is the only thing the repeat count counts.
   *
   * A non-zero exit is a result: the command ran and the runner said what it printed, so a suite
   * that fails, is fixed and passes never touches this - which is the ordinary rhythm of the work
   * this product exists to do. A harness answer is not a result: nothing ran, so it is evidence
   * of nothing in either direction, and it is skipped here exactly as the novelty charge skips it.
   */
  if (!isHarnessAnswer(result))
    state.repeatedFailures = repeatedFailuresAfter(state.repeatedFailures, {
      call: failingCallKey(call),
      failure: null
    });
  state.turnToolResults ??= {};
  /*
   * A harness answer is not a tool result, and this is where the completion contract learns that.
   *
   * `isHarnessAnswer` was already consulted twice above, for the novelty charge and the repeat
   * count, and not here - so the four things that answer a call without running it (an exact
   * repeat, a plan the owner republished mid-flight, arguments cut off mid-JSON) were recorded as
   * completed calls. A `file_read` truncated at the output ceiling could be cited by a `finish`
   * in the same batch and the turn completed `status:'verified'` on a call that never touched the
   * workspace: the single thing the completion contract exists to refuse.
   */
  const skipped = isHarnessAnswer(result);
  const progressKey = skipped ? undefined : evidenceProgressKey(call, result);
  state.turnToolResults[call.id] = {
    name: call.name,
    success: !skipped,
    ...(progressKey ? { progressKey } : {}),
    // Recorded for every result, including a harness answer: whether a call is citable is the
    // completion contract's question, and this is only where its bytes were put.
    ...(recorded?.id ? { eventId: recorded.id } : {}),
    ...(skipped ? { skipped: true } : {}),
    mutating: isMutatingToolCall(call.name, call.arguments),
    // Recorded, not subtracted from `mutating`: the approval card, the checkpoint set and
    // `state.mutated` all still treat a brief write as the change it is. Only the completion
    // contract reads this, because only there does "the last change" mean the work being proved.
    ...(writesOnlyDurableInstructions(call.name, call.arguments) ? { briefOnly: true } : {}),
    ...(writesOnlyProse(call.name, call.arguments) ? { proseOnly: true } : {}),
    ...(shellObservation(call, result) ?? {}),
    ...(!skipped ? (processObservation(task, call, result) ?? {}) : {})
  };
  if (
    !skipped &&
    (isMutatingToolCall(call.name, call.arguments) ||
      call.name === 'code_diagnostics' ||
      (call.name === 'process' && call.arguments.action !== 'describe'))
  )
    invalidateWorkspaceReadCache(state);
  const modelResult = boundedToolResultForModel(call.name, result, imageSummary);
  /*
   * Every untrusted result carries its own fence, not just the first one in the turn.
   *
   * The once-per-turn notice is the right thing to pay once - it says what the rules become - but
   * it is not what tells the model where one page stops and the harness starts. Between the notice
   * and step twenty there may be eleven reads, a compaction that dropped the notice's neighbours,
   * and a window in which a fetched page is a JSON object sitting flush against harness prose with
   * nothing between them. The marker is the answer to "is this line something I was told to do",
   * asked where the bytes are rather than where the notice was.
   *
   * Sanitised after serialisation rather than before: `JSON.stringify` emits non-ASCII literally,
   * so a tag character in a value or in a key is a tag character in this string, and one pass over
   * the serialised form covers both without walking the object a second time. Fenced after
   * truncation, so the closing marker cannot be the thing the 24,000-character cut removes.
   */
  const full = toolResultText(modelResult);
  /*
   * The bytes the window cannot hold, parked where the model can still go and get them.
   *
   * Awaited rather than fired off, because the marker is about to name the path: a notice that
   * races the write it describes is the unperformable recovery again, one step further along.
   * @see output-spill.ts for why an untrusted result is parked inside the download quarantine and
   * not beside a trusted one.
   *
   * `spillOverflow` answers null when it could not write - no writer registered, a body past
   * `MAX_SPILL_CHARS`, or a runner that refused: a full disk, a wedged service, a workspace being
   * deleted underneath the turn. The first of those cannot happen on this path - `useOutputSpill`
   * runs once in `assemblePreamble` (window.ts), the single production registration, so a lead
   * turn always has a writer - but it is the shape a delegated specialist's window has, since that
   * window runs no preamble, and it is the branch the cases in `output-spill.test.ts` drive here
   * with `register: false`. @see the three counts on `spillOverflow` itself.
   *
   * `undefined` here is not silence: it is the point at which
   * `boundToolResultText` applies `CUT_TOOL_OUTPUT_ADVICE`, which says that nothing was kept and
   * names the narrower requests this harness answers. What this line still does NOT do is give
   * that failed spill a second try or tell the owner it happened; the model is told what is true
   * of its own window and nothing about the runner.
   */
  const spilled =
    full.length > RECENT_TOOL_OUTPUT_CHARS
      ? await spillOverflow(task, state, full, untrustedOrigin !== null)
      : null;
  const recovery: TruncationRecovery | undefined = spilled ? spillRecovery(spilled) : undefined;
  const serialised =
    (call.name === 'delegate' && full.length > RECENT_TOOL_OUTPUT_CHARS
      ? delegateOutputSummary(
          modelResult,
          RECENT_TOOL_OUTPUT_CHARS,
          spilled ? { path: spilled } : null
        )
      : null) ?? boundToolResultText(full, RECENT_TOOL_OUTPUT_CHARS, recovery);
  const forModel = untrustedOrigin
    ? untrustedEnvelope(untrustedOrigin, sanitiseUntrustedText(serialised))
    : serialised;
  state.messages.push({
    role: 'tool',
    toolCallId: call.id,
    content: `${completionReference(state, call.id)}${forModel}${provenanceNotice ? `\n\n${provenanceNotice}` : ''}`
  });
  // A snapshot of a challenge page is a successful read, so the wall arrives here rather than in
  // the failure path - and it is the same thing to tell the owner about.
  const wall = botWallFromRunner(asRecord(result)?.botWall);
  if (wall) await deps.raiseTakeover(task, key, state, wall);
  /*
   * Handed back rather than routed from here.
   *
   * Reading a picture the lead model cannot see is a second model call with its own ranking, its own
   * price ceiling and its own billing, and it was the tail of this method only because both halves
   * happened to need `image`. Returning it splits the two along the line the import graph wants:
   * `vision.ts` may reach for `event` in here, and nothing in here has to know that vision exists.
   */
  return image;
};
