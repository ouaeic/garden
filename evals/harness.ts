/**
 * The offline rig every fixture runs on: the real agent loop, a scripted model, a scripted runner.
 *
 * Nothing here is a second execution model. `AgentWorker.run` is the same object the worker process
 * runs, taking the same store interface and the same config; what is replaced is the two things at
 * its edges that would otherwise need a provider key and a Linux box - `fetch` to the inference
 * route, and `fetch` to the workspace runner. That is exactly the seam `apps/worker/src/agent-run.test.ts`
 * already stubs, and the shapes below (the store probe, the SSE frame builders, the runner router)
 * are that machinery: the frames are byte-compatible, the probe answers the same method set, and a
 * fixture that passes here would pass as a test there.
 *
 * It is a copy rather than an import because that machinery is file-local inside a `.test.ts` and
 * exports none of it. Keeping the copy honest is cheap - both drive the same loop, so a shape this
 * one gets wrong fails loudly on the first fixture rather than silently reporting a green run.
 *
 * That claim was wrong once, and the correction is the reason `completionBody` exists below. The
 * copy had only the streaming half: every request was answered with frames, including the two the
 * loop does not stream - a compaction's brief and a delegated specialist's steps. Both callers are
 * written to survive a bad answer rather than to fail on one, so a compaction silently used its
 * deterministic fallback and a mission silently came back as a failed tool call, and the suite
 * reported green for a mechanism it was not exercising. `agent-run.test.ts` has both halves. The
 * lesson is narrower than "keep it honest": a shape this one gets wrong fails loudly only where the
 * loop has nothing to fall back on.
 *
 * The one difference that matters: the model here is a function of what athanor just said, not a
 * fixed list of replies. Every hold in the loop works by pushing a message back and asking again,
 * so a fixed list cannot tell "the model complied on the second attempt" from "the second reply
 * happened to be next". A script that reads the pushback can, and the step count it produces is
 * then the measured price of that hold.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DesktopAction,
  type ModelRelease,
  type SpendDecision
} from '../packages/contracts/src/index.js';
import {
  decryptJson,
  encryptJson,
  generateDataKey,
  wrapDataKey
} from '../packages/core/src/crypto.js';
import {
  MEMORY_PACK_BUDGET_TOKENS,
  type MemoryKind,
  type MemoryStatus,
  type MemoryTrust
} from '../packages/core/src/memory.js';
import type {
  DataStore,
  MemoryCandidateRecord,
  RecallMemoryInput,
  TaskRecord,
  TaskEventRecord,
  WorkspaceMemoryRecord,
  WorkspaceRecord,
  WorkspaceSkillRecord
} from '../packages/data/src/index.js';
import { AgentWorker, PUSHBACK_MARKERS, type PushbackName } from '../apps/worker/src/agent.js';
import { fixtureMediaRouting } from '../apps/worker/src/media-fixture.js';
import { buildIdentity } from '../apps/worker/src/build-identity.js';
import {
  COMPRESSED_TRAJECTORY_MARKER,
  RUNTIME_CONTEXT_MARKER
} from '../apps/worker/src/context.js';
import { forgetReads } from '../apps/worker/src/edit/index.js';
// The runner's own display-prefix function, imported rather than modelled. See `fileDisplay`.
import { displayablePrefix, type DisplayBudget } from '../services/workspace-runner/src/files.js';
// The runner's own per-command memory ceiling and the wording of the machine line. See
// `MACHINE_REPORT`, which states the box's measured figures and lets these two derive the rest.
import { defaultMemoryLimitBytes } from '../services/workspace-runner/src/limits.js';
import { machineSummary } from '../services/workspace-runner/src/machine.js';
import { memoryItemAad, memorySourceAad } from '../apps/worker/src/memory-runtime.js';
import { builtinSkillLibrary } from '../apps/worker/src/skills.js';

/* ---------------------------------------------------------------- a checkout-independent root */

/**
 * Where this rig tells the model the built-in procedures live.
 *
 * `DEFAULT_SKILL_ROOT` is derived from `import.meta.url`, so on this machine a skill the turn opens
 * arrives in the window as `Skill directory: /Users/somebody/some folder/athanor/skills/<name>` -
 * and `promptTokens` counts every byte of that request, carried through every later step of the turn.
 * Two things follow, and only one of them is small. The small one: the committed baseline is a
 * function of where the repository happens to sit, so a CI checkout and a laptop cannot compare
 * rows in a file whose entire purpose is that a diff records what a change cost. The other one is
 * that the absolute path of a stranger's home directory is being handed to a model provider.
 *
 * This rig can fix the first and can only report the second. `builtinSkillLibrary()` is a
 * process-wide memo of plain objects, read once and reused for the life of the run, so it is
 * rewritten here - once, before any fixture runs - to a fixed installation path. Nothing reads
 * those directories on this side: the loader has already read every file, and the workspace that
 * would resolve a path against them is a stub. What changes is the bytes the model is sent, which
 * is exactly what is being measured.
 *
 * The second half is `checkoutPathLeaks` below, which fails any fixture whose request still carries
 * the checkout root. That is the guard, not this: a normalisation nobody checks is a normalisation
 * that stops covering the next place a path escapes into a prompt.
 */
const NORMALISED_SKILL_ROOT = '/athanor/skills';

/** The checkout this file was loaded from, which is the string that must never reach a request. */
const CHECKOUT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

(() => {
  const library = builtinSkillLibrary();
  // Assigning through the readonly declaration on purpose: the memo is the only copy, and there is
  // no setter. A cast rather than a mutable alias, so this reads as the deliberate act it is.
  for (const skill of library.skills)
    (skill as { directory: string }).directory = `${NORMALISED_SKILL_ROOT}/${skill.name}`;
  (library as { root: string }).root = NORMALISED_SKILL_ROOT;
})();

/* ------------------------------------------------------------- what produced a number, exactly */

/**
 * Which athanor, and which rig, a row was measured by.
 *
 * A trajectory is a log until somebody can re-run it and get the same numbers, and until this
 * existed nothing in the output of `pnpm eval` said what it was the output *of*. A baseline diff a
 * year from now reads "435 model calls became 441" with no way to tell a change in the loop from a
 * change in the fixtures that measure it, and no way to check out the tree that produced either.
 *
 * Two halves, because they answer two different questions and move for different reasons.
 *
 * `version` and `commit` come from `buildIdentity()`, which is the same pair the box reports to its
 * owner - `apps/api/src/routes/relay.ts` serves it and `apps/worker/src/index.ts` logs it - so a row
 * here names a revision somebody can check out. It is read out of git's own files rather than by
 * running git; see `build-identity.ts` for why. A worktree with nothing committed answers null, and
 * null is reported as null rather than as a string that looks like a revision.
 *
 * `harness` is a digest of this rig's own three source files. It has to be derived rather than
 * declared: a hand-maintained version number is a control wired to nothing the first time somebody
 * edits a fixture and forgets it, and this suite has been burned by exactly that shape more than
 * once. It moves on any edit to the harness, the fixtures or the report, which is the point - those
 * three files decide every number the suite prints, so a baseline accepted under a different digest
 * was accepted by a different instrument. That is a note in the report and never a failure: it is
 * ordinary for a wave to add a fixture and re-accept, and a gate that fires on every commit is one
 * somebody deletes.
 */
export interface RunIdentity {
  readonly version: string;
  readonly commit: string | null;
  readonly harness: string;
}

const RIG_SOURCES: readonly string[] = ['harness.ts', 'fixtures.ts', 'report.ts'];

const harnessDigest = (): string => {
  try {
    const hash = createHash('sha256');
    // A separator that cannot occur in TypeScript source, so two files whose contents were shifted
    // across the boundary between them do not hash the same.
    for (const file of RIG_SOURCES)
      hash.update(`${readFileSync(new URL(file, import.meta.url), 'utf8')}\0`);
    return hash.digest('hex').slice(0, 12);
  } catch {
    // Nothing about a provenance stamp is worth failing a suite for. Named as the absence it is,
    // rather than as a plausible-looking digest.
    return 'unreadable';
  }
};

let stampedIdentity: RunIdentity | null = null;

/** Worked out once: a suite that re-read this per fixture would measure the filesystem. */
export const runIdentity = (): RunIdentity =>
  (stampedIdentity ??= { ...buildIdentity(), harness: harnessDigest() });

export const identityLabel = (identity: RunIdentity): string =>
  `athanor ${identity.version} at ${identity.commit ?? 'an uncommitted tree'}, rig ${identity.harness}`;

const masterKey = Buffer.alloc(32, 5);
const runnerSecret = 'r'.repeat(48);
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const dataKey = generateDataKey();

/**
 * The worker this rig is, written once because both halves of the lease have to agree.
 *
 * The fixture task used to be stamped `leaseOwner: 'worker-test'` while the `AgentWorker` under it
 * was configured `WORKER_ID: 'worker-eval'`, so every fixture in this suite described a task held
 * by some other worker. Nothing asked, so nothing noticed. Wave 7.2's #140 arm asks: `haltReason`
 * is now consulted at every step boundary and not only mid-model-call, and it answers `disowned`
 * for a lease that names somebody else - correctly, because a worker that has lost the task must
 * not execute another batch against a workspace someone else is now running. The suite stood down
 * on its first step boundary and reported 53 fixtures at 0 model calls with no error anywhere,
 * because standing down is deliberately silent.
 *
 * So the two are one constant. A rig whose task is owned by a worker other than the one running it
 * is not exercising a scenario worth having; it was a typo with nothing to trip over it.
 */
const WORKER_ID = 'worker-eval';

const PROVIDER_URL = 'https://provider.test/v1';
const RUNNER_URL = 'http://127.0.0.1:4300';

/* -------------------------------------------------------------------------- the scripted model */

export interface ScriptedCall {
  /** The id the model gives the call; `finish` evidence has to cite one of these. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ModelTurn {
  /** The streamed reply, which is what the owner reads. */
  readonly text?: string;
  /** Streamed in pieces, for the shapes that only appear across chunk boundaries. */
  readonly chunks?: readonly string[];
  /** Tool calls proposed by this step; more than one is a parallel batch. */
  readonly calls?: readonly ScriptedCall[];
  /** Ends the reply at the provider's output ceiling rather than at a real stop. */
  readonly truncated?: boolean;
  /**
   * Ends the stream where the text stops: no finish reason, and no usage frame ever sent.
   *
   * This is the route that keeps writing rather than the one that finishes, and it is cut on this
   * side once it passes the ceiling the request asked for. That is the one cutoff a fixture can
   * provoke without spending the wall clock the other two are measured in - and the text has to be
   * long enough to reach the ceiling, which is why the fixture that uses it generates its answer.
   */
  readonly cut?: boolean;
  /**
   * The route goes quiet mid-answer and never closes the socket.
   *
   * `cut` ends the stream where the text stops, which is a socket that died. This is the other
   * shape, and it is the one the fifteen-minute incident was: the frames stop arriving and the
   * connection stays open, so nothing on this side ends until a clock does. It implies `cut` - no
   * finish reason, no usage frame - and it is only useful beside `Fixture.clock`, because what it
   * is waiting for is the generation deadline.
   */
  readonly silent?: boolean;
}

export interface ScriptContext {
  /** Which model call this is, counting from zero. */
  readonly index: number;
  /**
   * Which step of the turn this is, counting from zero and not counting the calls a compaction
   * made. A script that works from `index` alone starts answering the wrong step the moment the
   * window is condensed once.
   */
  readonly step: number;
  /**
   * The last thing athanor said to the model, which is how every hold in the loop talks back. The
   * runtime block is stepped over: it sits at the end of every window and its clock changes.
   */
  readonly lastMessage: string;
  /** Every message content in this request, for a script that has to look further back. */
  readonly messages: readonly string[];
  /**
   * Whether this is the tool-free call a compaction makes to write the next part of the brief,
   * rather than a step of the turn.
   *
   * Recognised by the absent catalogue rather than by the wording of the request, because the
   * wording is the summariser's prompt and a fixture that matched it would be asserting on prose.
   * A script that ignores this and answers with a tool call gets a brief that says nothing, which
   * is a green run measuring the deterministic fallback.
   */
  readonly summarising: boolean;
  /**
   * Whether this is a delegated specialist's own request rather than a step of the turn.
   *
   * Recognised by the catalogue rather than by the mission text: a specialist is offered the
   * read-only set and never `finish`, because `finish` is how a turn ends and a specialist does not
   * end one. Nothing else in the loop withdraws it - the closing handoff is deliberately handed the
   * same array every other step sent - so "no `finish` on offer" is the one structural statement
   * that separates a specialist's window from the lead's.
   *
   * It matters beyond letting a script answer the right model. A specialist's window is its own:
   * its request shares nothing with the lead's but the catalogue, so counting it as the next link
   * in the chain would report a cache miss for a turn whose own window never moved.
   */
  readonly delegated: boolean;
  /**
   * True on the one call a vision specialist is asked to make.
   *
   * A vision handoff sends `tools: []`, which is exactly the shape a compaction's summarising call
   * has - so without this the specialist's answer would be scripted by whatever branch the fixture
   * wrote for `summarising`, and a fixture asserting on the handoff would be asserting about a
   * summary. Told apart by the model on the wire rather than by the empty catalogue: a specialist
   * is by definition a different release from the lead, which is the only difference the request
   * carries and the only one that cannot be true of a compaction.
   */
  readonly vision: boolean;
}

/** A model, as a function of what athanor just said to it. */
export type ModelScript = (context: ScriptContext) => ModelTurn;

/** Where a live run's provider is, and which model it names on the wire. @see `Fixture.live`. */
export interface LiveProvider {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly provider: 'openrouter' | 'openai-compatible';
  readonly providerModelId: string;
  readonly contextTokens: number;
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** A value read off an untyped payload, as text. Anything that is not a string reads as absent. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * A request body as an object, whatever was actually sent.
 *
 * A file write carries the file's own bytes rather than a JSON envelope, so this has to survive a
 * body that is not JSON at all: parsing it unguarded turned every file_write into a failed tool
 * call.
 */
const bodyOf = (init?: RequestInit): Record<string, unknown> => {
  if (typeof init?.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * The text of one message in a request, however the adapter chose to wrap it.
 *
 * A message the context layer marked as a cache breakpoint is sent as a content array carrying a
 * `cache_control` block rather than as a bare string, so reading `content` as a string alone makes
 * exactly the messages athanor considers most important read as empty.
 */
const contentOf = (message: { content?: unknown }): string => {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => asText((block as { text?: unknown } | null)?.text))
    .join('');
};

/** How many leading bytes two requests share, which is the most a prefix cache could read back. */
const commonPrefix = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
};

/**
 * One request as the provider reads it, which is not the order the JSON body happens to be in.
 *
 * A prefix cache is over tokens, and the tool definitions are tokenised ahead of the conversation
 * whatever position the request object puts them in - so comparing the raw bodies scores athanor
 * against the one part of the prompt that never changes, and reports about 23% for a turn whose
 * real repeated run is nearer 90%. The catalogue goes first here for the same reason it goes first
 * there: it is the head of what any provider could hand back.
 */
const promptBytes = (body: Record<string, unknown>): string =>
  `${JSON.stringify(body.tools ?? [])}${JSON.stringify(body.messages ?? [])}`;

/**
 * What the provider says the request cost it, counted from the request.
 *
 * Four characters to the token, which is the same rough conversion the window is estimated with on
 * the other side - so this is a plausible provider count rather than a copy of athanor's own
 * number, and the two are allowed to disagree by whatever the two roundings differ by. The
 * catalogue is included because a provider bills the whole request, which is precisely the term
 * that was missing from the estimate the loop falls back on when nobody sends one.
 */
const promptTokensFor = (body: Record<string, unknown>): number =>
  Math.ceil(promptBytes(body).length / 4);

/**
 * What the tool catalogue on one request costs, as bytes on the wire.
 *
 * Its own function because it is now read in three places that must not be allowed to drift: the
 * per-request accumulation below, the trajectory dump, and the resident figure reported at the end.
 * The catalogue is the single largest term in a request and the one this wave is trying to move, so
 * three spellings of "how big is it" is three chances for the number that gates the work and the
 * number that reports it to disagree.
 */
const catalogueBytesOf = (body: Record<string, unknown>): number =>
  JSON.stringify(body.tools ?? []).length;

/** What a provider said one call weighed, read off the completion it sent back. */
export interface ProviderUsageFrame {
  readonly inputTokens: number;
  /** Of the input, what the route served from its prompt cache, where it said. */
  readonly cachedTokens: number;
  readonly outputTokens: number;
  /** The route's own price for the call, where it put one on the body. */
  readonly costUsd: number | null;
}

/**
 * The usage frame of one provider response, whatever shape the response took.
 *
 * A streamed completion carries it in the last data frame before `[DONE]` (the adapter asks for it
 * with `stream_options.include_usage`); a plain completion carries it on the body. Field names are
 * the wire's: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` (or the
 * other spelling the gateway's `readCacheUsage` accepts), and `cost` where the route prices calls.
 * A body with no frame - a cut stream, an error - reads as `null` rather than as zeros, so a call
 * that reported nothing is not summed as a call that reported nothing was used.
 */
export const usageFrameOf = (text: string): ProviderUsageFrame | null => {
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  let found: ProviderUsageFrame | null = null;
  const read = (payload: unknown): void => {
    const usage = (payload as { usage?: unknown } | null)?.usage as
      | {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          cost?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown };
          cache_read_input_tokens?: unknown;
        }
      | null
      | undefined;
    if (!usage || typeof usage !== 'object') return;
    found = {
      inputTokens: count(usage.prompt_tokens),
      cachedTokens: count(
        usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens
      ),
      outputTokens: count(usage.completion_tokens),
      costUsd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null
    };
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('data:') || trimmed.startsWith(':')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice('data:'.length).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        read(JSON.parse(raw));
      } catch {
        // A partial or non-JSON frame is not a usage frame.
      }
    }
    return found;
  }
  try {
    read(JSON.parse(text));
  } catch {
    return null;
  }
  return found;
};

const framesFor = (turn: ModelTurn, promptTokens: number): string[] => {
  const parts: string[] = [];
  const pieces = turn.chunks ?? (turn.text ? [turn.text] : []);
  // A cut stream stops mid-answer: every piece arrives as an ordinary delta and then nothing does.
  // No closing frame, because the closing frame is exactly what a cut call never sends - which is
  // why the usage it carries has to be worked out on the other side.
  if (turn.cut || turn.silent) {
    for (const piece of pieces) parts.push(sse({ choices: [{ delta: { content: piece } }] }));
    return parts;
  }
  // Everything but the last piece goes out with no finish reason, which is what a real stream looks
  // like and what the degenerate-repeat watch reads.
  for (const piece of pieces.slice(0, turn.calls?.length ? pieces.length : -1))
    parts.push(sse({ choices: [{ delta: { content: piece } }] }));
  const tail = turn.calls?.length ? undefined : pieces.at(-1);
  parts.push(
    sse({
      choices: [
        {
          finish_reason: turn.calls?.length ? 'tool_calls' : turn.truncated ? 'length' : 'stop',
          delta: {
            ...(tail === undefined ? {} : { content: tail }),
            ...(turn.calls?.length
              ? {
                  tool_calls: turn.calls.map((call, index) => ({
                    index,
                    id: call.id,
                    function: { name: call.name, arguments: JSON.stringify(call.args) }
                  }))
                }
              : {})
          }
        }
      ]
    })
  );
  /*
   * The usage frame, which every real route sends and this rig never did.
   *
   * A streamed request here asks for it - the adapter sets `stream_options.include_usage` whenever
   * it has somewhere to put deltas - and the answer arrived without one on every fixture in this
   * file, for the life of the suite. That is not a missing number, it is a different branch, and it
   * turned out to be the branch that decides when a window is condensed.
   *
   * The small half: with no usage the gateway marks the reply `estimated`, the loop sees
   * `estimated && inputTokens === 0` and bills its own window estimate, so every row priced the
   * fallback and the path a configured provider takes was never exercised.
   *
   * The half that matters: `agent.ts:4115` replaces `state.preparedInputTokens` with
   * `prompt_tokens - reservedTokens` whenever a route reports usage, and `state.preparedInputTokens`
   * is precisely what the compaction trigger is compared against on the next step. So with no usage
   * frame the single most consequential decision in the loop was being taken from
   * characters-divided-by-four on all forty-nine fixtures, and the code the product actually runs -
   * decide it from what the provider counted - had never once run here. Measured on the fixture
   * written for it: with no frame the window parks at 63,721 tokens, fourteen tokens over the
   * trigger, and never condenses; with one, the same turn condenses on its tenth request and comes
   * back at 34,405. One frame, and a mechanism goes from never firing to firing.
   *
   * `prompt_tokens` counts the serialised request, catalogue included, at four characters to the
   * token. That is deliberately the whole body rather than a copy of athanor's own estimate: a
   * provider bills the JSON it receives, the estimate on the other side counts message content and
   * cannot see the envelope, and the gap between the two is exactly the thing `agent.ts:4108` says
   * this replacement exists to correct.
   *
   * A cut stream deliberately still gets none, and that is the whole point of the exception: usage
   * arrives in the last frame and a cut call never reaches it, so the fallback stays under test on
   * the one fixture that is about a cut. Both branches are now live, one row apart.
   */
  if (!turn.cut && !turn.silent)
    parts.push(
      sse({
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: Math.ceil(pieces.join('').length / 4),
          total_tokens: promptTokens + Math.ceil(pieces.join('').length / 4)
        }
      })
    );
  parts.push('data: [DONE]\n\n');
  return parts;
};

/**
 * The same turn as one whole JSON body, for the requests that are not streamed.
 *
 * Only the reply the owner is watching is streamed; a request with nowhere to put deltas asks for
 * an ordinary completion, and the two calls this suite most needs to see are exactly those - the
 * tool-free call a compaction makes to write its brief, and every step of a delegated specialist.
 * Answered with SSE they arrive as `Unexpected token 'd', "data: {"ch"...`, which both paths then
 * swallow: a compaction falls back to its deterministic summary and reports success, and a mission
 * comes back as a failed tool call. Both look like a working run from the outside, which is how a
 * suite ends up unable to see the two mechanisms that decide what a long task costs.
 */
const completionBody = (turn: ModelTurn): unknown => {
  const text = (turn.chunks ?? (turn.text ? [turn.text] : [])).join('');
  return {
    choices: [
      {
        finish_reason: turn.calls?.length ? 'tool_calls' : turn.truncated ? 'length' : 'stop',
        message: {
          content: text,
          ...(turn.calls?.length
            ? {
                tool_calls: turn.calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }))
              }
            : {})
        }
      }
    ],
    // Counted the same rough way the window is estimated, so a specialist's own compute budget is
    // spent against something proportional to what it actually wrote rather than against nought.
    usage: { prompt_tokens: 0, completion_tokens: Math.ceil(text.length / 4) }
  };
};

const encoder = new TextEncoder();

/**
 * How the scripted stream reaches the running fixture's clock.
 *
 * `streamOf` is module scope and the clock belongs to one run, so the run installs its adder here
 * and takes it away again in the same `finally` that puts `fetch` back. A no-op by default, which
 * is what every fixture that has not asked for a clock gets.
 */
let advanceClockBy: (ms: number) => void = () => undefined;

/**
 * The frames delivered one at a time, over a stream that dies when the request is torn down.
 *
 * A stub that hands back the whole body as a string cannot be interrupted, and two mechanisms in
 * the loop are interruptions: the watch that aborts a reply which has started repeating itself, and
 * the Stop the owner presses. Both raise their abort from inside a text-delta handler, so the frames
 * have to arrive with the event loop free between them or the handler never runs before the body is
 * finished. This is the same shape `heldBody` has in the worker's own tests, for the same reason.
 */
const streamOf = (
  frames: readonly string[],
  signal?: AbortSignal | null,
  /**
   * Milliseconds the fixture's clock gains as each frame goes out.
   *
   * Zero for every fixture that has not asked for one, which is all of them but the three about
   * what a generation is allowed to spend. It advances before the frame rather than after, so the
   * elapsed time the budget reads when it decides is the time that had passed when the model went
   * quiet - which is the reading the incident this bound was written for produced.
   */
  advanceMs = 0,
  /** Leaves the stream open after the last frame: a provider that stopped talking and stayed on. */
  hold = false
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const tearDown = (): void => {
        if (closed) return;
        closed = true;
        controller.error(new Error('the request was torn down'));
      };
      if (signal?.aborted) return tearDown();
      signal?.addEventListener('abort', tearDown, { once: true });
      void (async () => {
        for (const frame of frames) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (closed) return;
          if (advanceMs) advanceClockBy(advanceMs);
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // The reader was cancelled between two frames, which is what a generation cut on this
            // side does to the socket it was reading: the controller is closed from the other end
            // and nothing here is told. Writing into it throws out of a queue nobody is awaiting
            // and takes the process down - which is a rig failure wearing a defect's clothes.
            closed = true;
            return;
          }
        }
        // Nothing after the frames, for ever. The read the caller is in the middle of never
        // resolves, so what ends the generation is the clock and only the clock - which makes the
        // deadline this fixture is about the deterministic winner of that race rather than a
        // coin toss against a frame that was already buffered.
        if (hold) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (closed) return;
        closed = true;
        // A reader that has already been cancelled has closed this end for us, which is what a
        // generation cut on this side does to the socket it was reading. Closing it a second time
        // throws out of the queue nobody is awaiting and takes the process down with it.
        try {
          controller.close();
        } catch {
          // Already closed by the cancel, which is the only way this happens.
        }
      })();
    }
  });

/* ------------------------------------------------------------------------- the scripted runner */

export interface RunnerStub {
  /** Native syntax inspection outcomes; no submitted command executes in the offline harness. */
  readonly acceptanceInspection?: {
    readonly inspected: number;
    readonly issues: readonly string[];
  };
  /**
   * Exit codes handed to consecutive `/exec` calls; the last one repeats. This is what makes an
   * acceptance check fail on the unfinished job and pass on the finished one.
   */
  readonly exec?: readonly number[];
  /**
   * The bytes a media generation comes back with, base64, and what the provider says it cost.
   *
   * Absent means a generation still succeeds, with a small image and a plausible price: the media
   * fixtures are about what the loop does around a generation, not about the provider.
   */
  readonly media?: { readonly base64?: string; readonly costUsd?: number };
  /** What those commands printed, positionally, defaulting to a plausible line. */
  readonly stdout?: readonly string[];
  /** What the workspace holds, by path, for the reads. A path that is absent reads as missing. */
  readonly files?: Readonly<Record<string, string>>;
  /** The rows a `web_search` comes back with. */
  readonly search?: ReadonlyArray<{ readonly title: string; readonly url: string }>;
  /**
   * The text each address returns to `parallel_web_read`, by address. An address the read asks for
   * and this map does not hold comes back as a source that could not be read, which is what the
   * runner does with one, rather than as an address the answer never mentions.
   */
  readonly pages?: Readonly<Record<string, string>>;
  /**
   * Binaries this computer does not have, for a fixture about a procedure that names one.
   *
   * Absent means the whole document toolchain is installed, which is what the installer leaves
   * behind and what every fixture here assumes when it runs a document job.
   */
  readonly missingBinaries?: readonly string[];
  /**
   * HTTP statuses to answer the first inference calls with, positionally; `0` means answer it
   * normally. The list runs out and every call after it is answered normally.
   *
   * On the runner stub rather than beside the model script because it is the same kind of thing as
   * an exit code: a fact about the world outside the loop that a fixture declares once. The model
   * script is a function of what athanor said, and a 500 is not something athanor said.
   *
   * This is what the retry wall has needed since it was written. `5xx` and `408/429` are walls the
   * loop is meant to sit behind and come back from, `4xx` is a wall it must not retry, and until
   * now the only fixtures that could tell those apart were unit tests of the gateway. A turn that
   * survives a provider outage and finishes is a different claim from a request that was retried.
   */
  readonly providerFailures?: readonly number[];
  /**
   * The page the workspace browser is looking at, for the two tools that read one.
   *
   * `url` is what makes the fixture mean anything: it is what `untrustedOriginOfResult` names the
   * taint by, so a snapshot with no address taints the turn as "browser page" and a fixture about
   * where the content came from measures nothing.
   */
  readonly browserPage?: {
    readonly url: string;
    readonly title: string;
    readonly text: string;
  };
  /**
   * What the private Linux desktop currently shows, as the accessibility tree the runner returns.
   *
   * No screenshot: a desktop snapshot carrying image bytes is routed to a vision specialist, which
   * is a different mechanism with its own fixtures, and a fixture about the desktop's own result
   * should not be measuring that one.
   */
  readonly desktopNodes?: ReadonlyArray<{
    readonly role: string;
    readonly name: string;
  }>;
  /** An explicit zoom request and the captured image the runner answers it with. */
  readonly desktopZoom?: {
    readonly request: Extract<DesktopAction, { type: 'zoom' }>;
    readonly response: {
      readonly screenshotBase64: string;
      readonly screenshotMimeType: 'image/jpeg';
      readonly region: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
      readonly displayWidth: number;
      readonly displayHeight: number;
    };
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A one-pixel PNG, so a generation comes back with real bytes to write and price. */
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The provider's media routes, which live on the same host as inference and are not inference.
 *
 * Generation is an ordinary request to `/images` or `/audio/speech` on the configured provider, so
 * without this the media fixtures would have every logo counted as a model call and answered with a
 * chat frame. It is separated here for the same reason the document binary is separated from the
 * exec codes: a fixture's numbers have to mean what they say.
 */
const mediaResponse = (
  stub: RunnerStub,
  state: RunnerState,
  url: string,
  init?: RequestInit
): Response | null => {
  const image =
    url.endsWith('/images') || url.endsWith('/images/generations') || url.endsWith('/images/edits');
  if (!image && !url.endsWith('/audio/speech')) return null;
  state.media += 1;
  // The route the provider was actually asked for, read off the wire rather than off the tool call.
  // Everything before this line - the picker in Settings, the stored credential, the argument the
  // model passed - is a claim about what will be generated. This is the request that gets billed,
  // and it is the only place a seam between the owner's choice and the generation is visible.
  state.mediaModels.push(asText(bodyOf(init).model));
  const base64 =
    stub.media?.base64 ??
    (image
      ? ONE_PIXEL_PNG
      : Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).toString('base64'));
  const costUsd = stub.media?.costUsd ?? 0.01;
  return image
    ? json({ data: [{ b64_json: base64 }], usage: { cost: costUsd } })
    : new Response(Buffer.from(base64, 'base64'), {
        headers: { 'content-type': 'audio/mpeg', 'x-cost-usd': String(costUsd) }
      });
};

/** What the document tools shell out to, whose stdout has to be JSON rather than a console line. */

/**
 * What a fully provisioned box answers `/toolchain` with, by capability id.
 *
 * The runner probes for these one binary, module and font at a time and reports which jobs the
 * computer can actually do; a workspace the installer finished can do all of them, so that is what
 * this answers. The list is named here rather than imported from the runner because importing it
 * would pull that service's process machinery - the sandbox, the command policy, the executable
 * resolver - into a rig whose whole point is that it needs no Linux box. `purpose` is not filled
 * in: it is prose the runner carries for the Files screen rather than anything a probe establishes,
 * and copying it here would be this harness asserting something about the other side's wording.
 */
const TOOLCHAIN_CAPABILITIES = [
  'office-authoring',
  'office-conversion',
  'document-fonts',
  'pdf-assembly',
  'pdf-forms',
  'pdf-extraction',
  'typeset-pdf',
  'data-analysis',
  'statistics',
  'image-work',
  'media'
] as const;

/**
 * What the box answers `/machine` with: the three numbers a model has to have before it sizes a
 * job, and the sentence the runtime block states them in.
 *
 * ── WHICH BOX ─────────────────────────────────────────────────────────────────────────────────
 *
 * The owner's own, which is the box every measured figure in this repository is measured on and
 * the box the two probes above already describe: `/toolchain` answers "a workspace the installer
 * finished" and `/surfaces` answers a machine with a browser and a screen. A machine line for some
 * other computer beside those two would price a box that does not exist.
 *
 * ── WHY EACH NUMBER ───────────────────────────────────────────────────────────────────────────
 *
 * `TOTAL_MEMORY_BYTES` and `CORES` are measured and stated. 31.34 GiB is the figure
 * `defaultMemoryLimitBytes` in `services/workspace-runner/src/limits.ts` is documented against,
 * and sixteen cores is the count `services/workspace-runner/src/machine.ts` opens by naming. The
 * per-command ceiling is NOT stated beside them: it is put through the runner's own
 * `defaultMemoryLimitBytes`, so that the fraction this rig prices is the fraction production
 * applies rather than a second copy of it that can drift. The same argument runs for the sentence,
 * which is `machineSummary`'s own wording rather than a transcription of it.
 *
 * `FREE_DISK_BYTES` is the one figure nothing here can derive, because it is a property of a
 * filesystem rather than of a limit, so it is stated: 730.1 GiB is what the owner's box had free
 * above the host storage floor when the machine route was built.
 *
 * ── WHAT THE ANSWER COSTS, WHICH IS WHY THE NUMBERS ARE WORTH ARGUING ABOUT ───────────────────
 *
 * Measured by accepting the baseline with this route answered and again with the summary empty:
 * about 36 tokens on EVERY request of every turn, and they are dear ones. The runtime block sits
 * at the END of the window - that is the reason `cachePrefix` is rounded to a whole point twelve
 * hundred lines below - so these bytes land after the cached prefix breaks and are re-billed in
 * full on every step rather than read back. The committed share fell one whole point on 20 of the
 * 73 rows and two on one; nothing crossed its band, and the line is worth its price, but it is not
 * free and the rows now say so.
 *
 * It also moved behaviour once, which is the finding worth reading twice:
 * `small-the-compute-ceiling-ends-the-turn` now ends after 5 model calls instead of 6. That turn is
 * given a budget it cannot finish inside, so a request that costs more reaches the ceiling sooner.
 * The row still measures what it was written to measure - the ceiling fires, the loop says so, the
 * turn comes back with what it has - and it does so one step earlier because the window it prices
 * is the window production sends.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────
 *
 * It does not model a box that cannot answer. `machineReport` withholds a field it cannot
 * establish honestly and answers the empty summary when it can establish none, and a run under an
 * unreadable cgroup therefore gets a shorter runtime block than every number below assumes. No
 * fixture asks for that box, so no fixture measures it - the negative arm is proved instead at the
 * production call site, in `apps/worker/src/agent-run.test.ts`, which drives the real worker
 * against a runner with no such route at all.
 *
 * That same file states this box's three numbers a second time, as the string it expects on the
 * wire. Nothing compares the two copies: a wave that re-measures the owner's box has to change
 * both, and if it changes only one the eval baseline moves while that test stays green, or the
 * reverse. Said out loud rather than left to be discovered, because it is the shape of defect this
 * lane exists to close.
 */
const MACHINE = (() => {
  const GIB = 1024 ** 3;
  /** Measured on the owner's box; see `defaultMemoryLimitBytes`, documented against this figure. */
  const TOTAL_MEMORY_BYTES = 31.34 * GIB;
  /** Measured on the owner's box; the count `machine.ts` names in its first paragraph. */
  const CORES = 16;
  /** Measured: headroom above `hostStorageFloorBytes`, which is what the route reports. */
  const FREE_DISK_BYTES = 730.1 * GIB;
  const report = {
    cores: CORES,
    memoryBytes: defaultMemoryLimitBytes(TOTAL_MEMORY_BYTES),
    diskBytes: FREE_DISK_BYTES
  };
  return { ...report, summary: machineSummary(report) };
})();

/** What the workspace has been made to do so far, which is the only state the stub carries. */
interface RunnerState {
  execs: number;
  /** What the turn has written, so a listing sees the work happen and a read gets it back. */
  written: Map<string, { bytes: number; text: string }>;
  /** Media generations the provider was actually asked for. */
  media: number;
  /** The model id each of those named on the wire, in order. */
  mediaModels: string[];
  /**
   * Every runner route this stub does not model, in the order they were first asked for.
   *
   * The reason this list exists rather than a permissive default: an unmodelled route used to be
   * answered `{ok:true}`, which is a valid-looking answer to a question nobody asked. Four
   * production mechanisms read a field off a route that was never stubbed, got `undefined`, and
   * took the branch they take when the workspace cannot answer - the picture that could not be
   * looked at, the toolchain the model was never told about, the binary probe that reported
   * everything installed, the render check that passed whatever the document did. Every one of
   * them ran its failure branch on all forty-nine fixtures and the suite reported green, because a
   * failure branch is still a branch and the numbers it produces are still numbers.
   */
  unstubbed: string[];
  /**
   * Every runner route this run reached, modelled or not, in the order they were first asked for.
   *
   * `unstubbed` above is the complement of this list against what the stub answers, and the
   * complement is not the same evidence. A benchmark shim built from `unstubbed` alone would
   * implement nothing, because the stub already answers everything these fixtures reach - and a
   * shim that is missing a route athanor needs does not throw: the tool returns the failure branch,
   * the turn works around it, and the task scores 0 with no error anywhere. That is the exact
   * defect shape `evals/bench` exists to make impossible, so the set of routes the loop ACTUALLY
   * requests has to be recorded rather than inferred from a route list somebody read.
   *
   * Recorded for every run and never gated on a flag: the cost is one string per runner call
   * against fixtures that already send megabyte windows, and a record kept only under a flag is a
   * record nobody has when they need it. Nothing in `report.ts` reads it, so no committed row can
   * move because this exists - and `evals/bench/selftest.ts` asserts that `report.ts` stays that
   * way rather than leaving the claim to a comment.
   */
  observed: string[];
}

/**
 * A route named the way a person would have to model it: the method, and the path with this
 * workspace's id and any query taken out. Two calls to the same route are one line in the report.
 */
const routeName = (url: string, init?: RequestInit): string => {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  return `${init?.method ?? 'GET'} ${path.replace(workspaceId, ':workspaceId')}`;
};

/**
 * A file read, answered the way the runner answers one: the bytes, and nothing around them.
 *
 * This route used to answer `json({ path, content, bytes })`, and `readFile`/`readFileWithHash`
 * take `response.text()` - so every `file_read` in this suite displayed the JSON envelope AS the
 * file, one line long, whatever the file was. Measured on `answer-missing-file-is-not-a-dead-turn`
 * before this was fixed: `notes.txt` came back as `1:{"path":"workspace/notes.txt","content":"…"}`,
 * `totalLines: 1`. Every read in every fixture read one line.
 *
 * Three things were unreachable while that stood, and all three are things this repository has
 * shipped a bound for. The 800-line display cap and the 18,000-byte one in `workspace.ts` cannot be
 * approached by a one-line answer. The line numbers a `file_patch` addresses were numbers of the
 * envelope, so no line-addressed edit could land against a fixture file. And any count of what a
 * read PUT IN FRONT OF THE MODEL was a count of this stub rather than of athanor.
 */
const fileText = (content: string): Response =>
  new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * The DISPLAY read: `server.ts:851-864`, answered with the runner's own prefix function.
 *
 * `readFileForDisplay` sends `displayBytes` and `displayLines` and gets back the prefix that fits
 * them plus `x-display-lines`, and that prefix is the whole of what the model is shown. This stub
 * answered neither parameter, so it fell through to `fileText` and handed back the file - which the
 * client reads, correctly and by design, as "a runner one release behind this worker displayed all
 * of it". Measured through the shipped `readWorkspaceFile` on 9,000 lines of two characters: 800
 * rows, 2,399 bytes. Through this stub before this existed: 9,000 rows. Every unwindowed
 * `file_read` in this suite was answered in a shape the shipped runner cannot produce, and the two
 * bounds `workspace.ts` derives from each other were unreachable from here.
 *
 * `displayablePrefix` is IMPORTED rather than modelled, unlike `fileWindow` below. The reason
 * `fileWindow` is modelled - the real ranged reader walks a file descriptor in a fixed buffer and
 * this stub's workspace is a map of strings - does not apply to it: it is a pure function of a
 * Buffer and a budget, so importing it means the fake cannot drift from the thing it is faking.
 * That is the tier CONTRIBUTING asks for first, and a second implementation here is exactly the
 * second copy of a rule this repository keeps outliving the first.
 *
 * One thing it does NOT model, stated rather than left to be discovered: the real route also calls
 * `recordDisplayedLines`, so the RUNNER keeps its own record of what it put in front of the model
 * and `writeWorkspaceFile` consults it. Nothing here does, and the PUT route below acknowledges
 * every write without asking. So this suite measures the worker's ledger and says nothing about the
 * runner's - a fixture that wants that guard wants the real runner, or
 * `services/workspace-runner/src/seen-lines.test.ts`, where it lives.
 */
const fileDisplay = (content: string, budget: DisplayBudget): Response => {
  const bytes = Buffer.from(content, 'utf8');
  const { prefix, whole, partialLine } = displayablePrefix(bytes, budget);
  return new Response(prefix.toString('utf8'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-sha256': createHash('sha256').update(bytes).digest('hex'),
      'x-total-lines': String(content.split('\n').length),
      'x-display-lines': String(whole),
      'x-partial-line': String(partialLine)
    }
  });
};

/**
 * The windowed read: `services/workspace-runner/src/files.ts:277-370` and the headers
 * `server.ts:816-827` puts on it.
 *
 * Modelled rather than imported, because the real one walks a file descriptor in a fixed buffer and
 * this stub's workspace is a map of strings, and named as modelled where it simplifies. Lines are
 * separated by newlines and not terminated by them, so a file ending in one has a final empty line,
 * which is the rule `toLines` states and the numbers in a read mean. `totalLines` is answered only
 * when the read reached the end, exactly as the runner answers it - the runner cannot count the
 * rest without reading what a window exists to avoid, and a stub that answered it anyway would let
 * a fixture pass on a field production does not send.
 *
 * Two simplifications, stated: a line longer than the whole budget is dropped rather than half-sent
 * (the runner returns its first `maxBytes` and resumes AT it), and `x-file-bytes` is the string's
 * UTF-8 length rather than a stat. Neither is reachable at the 400,000-byte budget `file_read`
 * asks for; a fixture that wants to reach the first one wants the real runner.
 */
const fileWindow = (
  content: string,
  window: { startLine: number; endLine: number; maxBytes: number }
): Response => {
  const lines = content.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  let truncated = false;
  let lastKept = window.startLine;
  for (let line = window.startLine; line <= Math.min(window.endLine, lines.length); line += 1) {
    const text = lines[line - 1] ?? '';
    // The separator is charged only while another line follows it, which is where the runner's own
    // `lastKeptTerminated` ends up.
    const cost = Buffer.byteLength(text, 'utf8') + (line < lines.length ? 1 : 0);
    if (bytes + cost > window.maxBytes) {
      truncated = true;
      break;
    }
    bytes += cost;
    kept.push(text);
    lastKept = line;
  }
  const reachedEnd = !truncated && window.endLine >= lines.length;
  return new Response(kept.join('\n'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-start-line': String(window.startLine),
      'x-end-line': String(lastKept),
      'x-file-bytes': String(Buffer.byteLength(content, 'utf8')),
      'x-truncated': String(truncated),
      ...(reachedEnd
        ? { 'x-total-lines': String(lines.length) }
        : { 'x-next-start-line': String(lastKept + 1) })
    }
  });
};

const runnerResponse = (
  stub: RunnerStub,
  state: RunnerState,
  url: string,
  init?: RequestInit
): Response => {
  const body = bodyOf(init);
  // Before any branch decides what to answer, because the question this record answers is what the
  // loop ASKED for, and a route recorded inside a branch is a route somebody already modelled.
  state.observed.push(routeName(url, init));
  if (url.endsWith('/acceptance/inspect'))
    return json(stub.acceptanceInspection ?? { inspected: 0, issues: [] });
  if (url.endsWith('/repository-map'))
    return json({ available: false, reason: 'Lexical repository fixture' });
  if (url.endsWith('/documents')) {
    const path = asText(body.path);
    return json({
      exitCode: 0,
      stdout: JSON.stringify(
        body.action === 'search'
          ? { matches: Object.keys(stub.files ?? {}).map((file) => ({ path: file, page: 1 })) }
          : { path, text: stub.files?.[path] ?? '', pages: 1 }
      ),
      stderr: '',
      durationMs: 5,
      timedOut: false
    });
  }
  if (url.includes('/exec') || url.includes('/processes/start')) {
    const index = state.execs;
    state.execs += 1;
    const codes = stub.exec ?? [0];
    const exitCode = codes[Math.min(index, codes.length - 1)] ?? 0;
    return json({
      exitCode,
      stdout: stub.stdout?.[index] ?? (exitCode === 0 ? 'ok\n' : ''),
      stderr: exitCode === 0 ? '' : 'AssertionError: expected 3 rows, found 0',
      durationMs: 5,
      timedOut: false
    });
  }
  // What the workspace browser is looking at. Two tools read it and both are untrusted content by
  // provenance rather than by inspection - the address is the whole of what the taint is named by.
  if (url.includes('/browser/snapshot') || url.includes('/browser/elements')) {
    const page = stub.browserPage;
    if (!page) {
      state.unstubbed.push(routeName(url, init));
      return new Response(JSON.stringify({ error: 'no page' }), { status: 404 });
    }
    return json({
      tabId: 'tab-1',
      url: page.url,
      title: page.title,
      text: page.text,
      elements: [{ ref: 'e1', role: 'link', name: page.title }]
    });
  }
  if (url.includes('/browser/action')) {
    const page = stub.browserPage;
    if (!page) {
      state.unstubbed.push(routeName(url, init));
      return new Response(JSON.stringify({ error: 'no page' }), { status: 404 });
    }
    return json({ tabId: 'tab-1', url: page.url, title: page.title, text: page.text, ok: true });
  }
  if (url.includes('/desktop/snapshot')) {
    const nodes = stub.desktopNodes;
    if (!nodes) {
      state.unstubbed.push(routeName(url, init));
      return new Response(JSON.stringify({ error: 'no desktop' }), { status: 404 });
    }
    return json({
      nodes: nodes.map((node, index) => ({ ref: `n${index + 1}`, ...node, tier: 0 })),
      nodesOmitted: 0,
      windowTitle: nodes[0]?.name ?? 'desktop'
    });
  }
  if (url.endsWith('/desktop/preflight') || url.endsWith('/desktop/action')) {
    const zoom = stub.desktopZoom;
    const action = DesktopAction.safeParse(body);
    if (
      !zoom ||
      !action.success ||
      action.data.type !== 'zoom' ||
      Object.entries(zoom.request).some(([key, value]) => body[key] !== value)
    ) {
      state.unstubbed.push(routeName(url, init));
      return new Response(JSON.stringify({ error: 'desktop action is not modelled' }), {
        status: 400
      });
    }
    return json(
      url.endsWith('/desktop/preflight')
        ? { consequential: false, sensitiveInput: false, preview: 'Inspect the screen region' }
        : zoom.response
    );
  }
  if (url.includes('/browser/search'))
    return json({
      engine: 'stub',
      query: new URL(url).searchParams.get('q') ?? '',
      results: (stub.search ?? []).map((row, index) => ({
        rank: index + 1,
        title: row.title,
        url: row.url,
        site: new URL(row.url).host,
        snippet: row.title
      }))
    });
  if (url.includes('/browser/read-many')) {
    // `sources`, and one entry per address asked for, because that is the contract both sides now
    // name from one place (`ParallelWebReadResult`). This stub used to answer `pages`, which is the
    // exact shape the product already found wrong and fixed: every reader of the result asks for
    // `sources`, so an answer keyed on `pages` reads as a read that returned nothing. The turn then
    // learnt no host from a page it had just read, the untrusted label lost its host names, and the
    // spot-check that compares a specialist's quoted span against the source it cited compared it
    // against an empty string and could never verify - on every research fixture, invisibly.
    const requested = Array.isArray(body.urls) ? body.urls.map(String) : [];
    const unique = [...new Set(requested)].slice(0, 12);
    const perPage = Math.trunc(Number(body.maxCharactersPerPage)) || 20_000;
    return json({
      sources: unique.map((address) => {
        const text = stub.pages?.[address];
        // A miss is an entry that says so, not an absent entry: the requested address is what the
        // turn reasons about afterwards - whether it has been to that host, whether the claim it
        // was going to cite has a source - and dropping the row loses the question along with the
        // answer. The wording is the runner's own for a source it never got to read.
        return text === undefined
          ? { requestedUrl: address, error: 'Source was not read' }
          : {
              requestedUrl: address,
              url: address,
              title: address,
              text: text.slice(0, perPage)
            };
      }),
      requested: requested.length,
      read: unique.length
    });
  }
  if (url.includes('/files?')) {
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    // The runner's own field names, not an approximation of them. An artifact acceptance check
    // reads `name`, `type` and `sizeBytes` off these rows, so a listing shaped any other way makes
    // every artifact check report the file missing - a green fixture measuring nothing.
    //
    // What the turn has written counts as being there, which is what makes an artifact check fail
    // on the unfinished job and pass on the finished one without a fixture having to say when the
    // file appears.
    const listed: Record<string, number> = {
      ...Object.fromEntries(
        Object.entries(stub.files ?? {}).map(([file, content]) => [file, content.length])
      ),
      ...Object.fromEntries([...state.written].map(([file, entry]) => [file, entry.bytes]))
    };
    return json({
      path,
      entries: Object.entries(listed)
        .filter(([file]) => file.startsWith(path))
        .map(([file, sizeBytes]) => ({
          name: file.split('/').filter(Boolean).pop() ?? file,
          path: file,
          type: 'file',
          sizeBytes,
          modifiedAt: '2026-07-01T00:00:00.000Z'
        }))
    });
  }
  // `image_read` has a route of its own, and it is not the file route. The picture branch below
  // used to be the whole of this stub's answer to a picture, and nothing ever reached it: the
  // client GETs `/image?path=…`, which contains neither `/files?` nor `/file`, so every look at a
  // generated logo fell through to the catch-all, came back as JSON, and was refused by the one
  // line in the client that checks the workspace kept its promise about content types. The media
  // fixtures still listed `image_read` among their tools, because a tool is recorded as started
  // before it runs - so both of them measured a turn that could not see its own work.
  if (url.includes('/image?')) {
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    if (!state.written.has(path) && stub.files?.[path] === undefined)
      return new Response('', { status: 404 });
    // Re-encoded on the way out, which is what the runner does to every picture it answers with -
    // so the source type travels beside the bytes rather than being inferred from the name.
    return new Response(Buffer.from(ONE_PIXEL_PNG, 'base64'), {
      headers: {
        'content-type': 'image/png',
        'x-image-source-type': `image/${(path.split('.').pop() ?? 'png').toLowerCase()}`
      }
    });
  }
  if (url.includes('/file')) {
    // A write is acknowledged; a read of a path the fixture never put in the workspace is a miss,
    // which is how a fixture makes a read fail without inventing an error shape.
    if (init?.method === 'PUT') {
      const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
      const text = typeof init.body === 'string' ? init.body : '';
      const bytes =
        typeof init.body === 'string'
          ? init.body.length
          : init.body instanceof ArrayBuffer
            ? init.body.byteLength
            : ArrayBuffer.isView(init.body)
              ? init.body.byteLength
              : 1;
      if (path) state.written.set(path, { bytes, text });
      return json({ ok: true, storageBytes: 2_048 });
    }
    const path = decodeURIComponent(new URL(url).searchParams.get('path') ?? '');
    const known = state.written.has(path) || stub.files?.[path] !== undefined;
    // A picture comes back as bytes with a picture's content type. Looking at one goes through
    // `/image` above; this is the raw read behind publishing it, where the type on the wire is what
    // the artifact is stored and served as.
    if (known && /\.(png|jpe?g|webp|gif)$/i.test(path))
      return new Response(Buffer.from(ONE_PIXEL_PNG, 'base64'), {
        headers: { 'content-type': 'image/png' }
      });
    // What the turn wrote reads back as what it wrote. Without this a fixture could not measure the
    // one thing worth measuring about a re-read - that the window already held the answer.
    const content = state.written.get(path)?.text ?? stub.files?.[path];
    if (content === undefined) return new Response('', { status: 404 });
    const query = new URL(url).searchParams;
    const maxBytes = Number(query.get('maxBytes'));
    const displayBytes = Number(query.get('displayBytes'));
    const displayLines = Number(query.get('displayLines'));
    const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
    // Three callers, told apart the way `server.ts:810-856` tells them apart. A caller naming
    // `maxBytes` is asking for a window. A caller naming BOTH display budgets is about to put what
    // it gets in front of a model and is answered with the prefix that fits. A caller naming
    // neither - `readFileWithHash`, which is the read a `file_patch` makes and which displays
    // nothing - gets the whole file.
    if (positive(maxBytes))
      return fileWindow(content, {
        startLine: Math.max(1, Number(query.get('startLine')) || 1),
        endLine: Math.max(1, Number(query.get('endLine')) || Number.MAX_SAFE_INTEGER),
        maxBytes
      });
    return positive(displayBytes) && positive(displayLines)
      ? fileDisplay(content, { maxBytes: displayBytes, maxLines: displayLines })
      : fileText(content);
  }
  if (url.includes('/checkpoints'))
    return json({
      id: 'checkpoint',
      mechanism: 'content',
      createdAt: '2026-07-01T00:00:00.000Z',
      fileCount: 12,
      totalBytes: 4_096,
      storedBytes: 128,
      changedFileCount: 2,
      uncoveredFileCount: 0,
      durationMs: 21,
      pruned: []
    });
  // What this computer can do with documents. It is read once at the start of every run and folded
  // into the frozen runtime block, so until this route existed the block that tells the model which
  // document jobs the box can do was absent from every eval prompt and therefore from every
  // committed baseline row - the suite priced a machine it never described.
  if (url.endsWith('/toolchain'))
    return json({
      capabilities: TOOLCHAIN_CAPABILITIES.map((id) => ({
        id,
        ready: true,
        missingBinaries: [],
        missingPythonModules: [],
        missingFonts: []
      })),
      ready: [...TOOLCHAIN_CAPABILITIES],
      missing: [],
      summary: `Available on this computer: ${TOOLCHAIN_CAPABILITIES.join(', ')}.`
    });
  /*
   * What machine this is, in the three numbers that decide how a job is sized. Read once at the
   * start of every run and folded into the frozen runtime block, exactly as the toolchain line
   * above is, so until this route existed the block that tells the model how many cores it may
   * spend and how much memory one command may commit was absent from every eval prompt and
   * therefore from every committed baseline row.
   *
   * It is here because it was not, for the second time on this rig and with a different route: the
   * loop began asking at 89185c6 and 71 of the 72 fixtures went red with "this run measured a 404"
   * on every wave after it, while `pnpm check` reported green because `check` runs `eval:rigs` and
   * has never run `eval`. See `MACHINE` for which box the answer describes and why.
   *
   * What now catches the third time is `pnpm eval:gate`, which is this whole suite run for its
   * claims only and wired into `pnpm check` in `package.json`. There is deliberately NO static
   * census of the loop's routes anywhere - not in `scripts/check-repository.mjs`, not anywhere
   * else - and `evals/run.ts` says why: a census cannot see the two store methods that refused
   * more rows than this route did, and it can only under-approximate a suffix built from a
   * variable, so the day it misses one it reports green. The cost of catching it here instead is
   * that a wave adding a runner route has to stub it before `pnpm check` will pass.
   */
  if (url.endsWith('/machine')) return json(MACHINE);
  /*
   * Whether this box has a browser and a screen, which is what decides whether seven tool schemas
   * are described to the model at all.
   *
   * `available` on both, because that is the box this harness models: it answers `/browser/*` and
   * `/desktop/*` for any fixture that stubs a page or a set of nodes, and the toolchain route above
   * already reports a fully provisioned machine for the same reason. Anything else here would price
   * a computer this rig does not simulate.
   *
   * It is here because it was not, and the whole suite went red the moment the loop started asking:
   * the fall-through below refuses any fixture that reaches an unmodelled route, so all 67 fixtures
   * failed with "this run measured a 404" while a wave reported the catalogue gate complete without
   * running this rig. The 404 also fell back to `unknown`, which describes everything - so the rig
   * was measuring the whole catalogue and calling it a gated one, which is the exact failure the
   * gate itself was built to avoid, one layer out.
   */
  if (url.endsWith('/surfaces')) return json({ browser: 'available', desktop: 'available' });
  // Which of a procedure's declared binaries this box does not have. The everything-is-installed
  // answer is the default because that is what the installer leaves behind, but it is now an answer
  // rather than the absence of one: the branch that warns a model off a procedure it cannot run was
  // unreachable while this route fell through to a body with no `present` and no `missing` in it.
  if (url.endsWith('/toolchain/probe')) {
    const asked = Array.isArray(body.binaries) ? body.binaries.map(String) : [];
    const absent = new Set(stub.missingBinaries ?? []);
    return json({
      present: asked.filter((binary) => !absent.has(binary)),
      missing: asked.filter((binary) => absent.has(binary))
    });
  }
  // Storage after a write, which the loop reads back to keep the workspace's own figure current.
  if (url.endsWith('/usage')) return json({ storageBytes: 2_048 });
  // Everything else is a route nobody modelled, and it is answered as one. A permissive `{ok:true}`
  // here is not a convenience - it is an answer with the right status and the wrong contents, which
  // every caller reads as a workspace that did what was asked and then found the field it wanted
  // missing. `check()` refuses a fixture that reached this line, so a route added to the loop
  // arrives here as a named failure rather than as a number that quietly means something else.
  state.unstubbed.push(routeName(url, init));
  return new Response(JSON.stringify({ error: `Unstubbed runner route: ${url}` }), {
    status: 404,
    headers: { 'content-type': 'application/json' }
  });
};

/* --------------------------------------------------------------------------------- the fixture */

/**
 * What set a compaction off, in the loop's own words: the model declaring a phase over, or the
 * window reaching the budget trigger.
 */
export type CompactionTrigger =
  | 'agent'
  | 'budget'
  /**
   * A compaction whose event carried neither, which no path in the loop produces. It exists so a
   * payload this rig has got wrong reads as an unexpected value and fails the fixture that asserts
   * on it, rather than being folded into whichever of the two is commoner and answering the
   * question with a guess.
   */
  | 'unrecorded';

/**
 * The opening of the deterministic block `prepareModelContext` pushes at the tail of the window
 * once the soft threshold is crossed.
 *
 * It was a literal here - the only one left in this file - because `context.ts` did not publish it.
 * Step 3.1(b) gave that summary a marker constant, moved it out of the leading system run and
 * excluded it from `cacheEligible`, so this is now an import and the fixture below is no longer
 * coupled to prose. Matching an opening rather than the whole sentence, so the wording after it can
 * change without this going quiet.
 */
const SOFT_PASS_MARKER = COMPRESSED_TRAJECTORY_MARKER;

/** Which owner-shaped request this fixture stands for. Reported so a gap in coverage is visible. */
export type FixtureShape =
  | 'answer'
  | 'files'
  | 'verify'
  | 'research'
  | 'ambiguous'
  | 'refusal'
  | 'small'
  | 'media'
  /** A job long enough that what it costs is decided by how the window is held down, not by holds. */
  | 'long'
  /** Not a job at all: a claim about the catalogue every other row here is priced on. */
  | 'schema';

export interface Expectation {
  /** Exactly how many model calls the turn cost, including the closing handoff when one happens. */
  readonly modelCalls?: number;
  /**
   * How many of those calls were spent inside delegated specialists rather than by the turn.
   *
   * Asserted alongside `modelCalls` rather than instead of it, because the two move for different
   * reasons: the first is what the loop did, the second is what a mission cost once it was sent.
   */
  readonly delegatedCalls?: number;
  /**
   * Every tool athanor actually started, in order. `finish` and `set_acceptance` never appear: the
   * loop answers those itself, ahead of the line that records a tool as started.
   */
  readonly tools?: readonly string[];
  /** Every tool the model asked for, in order, including the ones the loop answered or refused. */
  readonly proposed?: readonly string[];
  /** The catalogue offered on the last request, for the turns where the loop narrows it. */
  readonly finalCatalogue?: readonly string[];
  /**
   * Whether the closing request offered the same catalogue as the step before it.
   *
   * The property, rather than the list. A turn that swaps its catalogue on the way out rewrites the
   * head of the prompt on its own largest request, and every provider that bills a cached prefix
   * bills that as a fresh write - so the restriction such a swap is meant to buy has to be worth
   * the whole window, and a restriction the loop already enforces by refusing the call is not.
   * Naming the tools instead would make this fail every time a tool is added, which is how an
   * assertion about caching turns into an assertion about the catalogue's length.
   */
  readonly finalCatalogueUnchanged?: boolean;
  /**
   * Whether every step of the turn was offered the identical catalogue, and not merely the last two.
   *
   * `finalCatalogueUnchanged` watches the seam a closing handoff could open. This watches all of
   * them. The catalogue is the head of the prompt and it is fixed for the life of a run on purpose:
   * a tool added or withdrawn at step nine rewrites the first fifty-six kilobytes of every request
   * from step nine on, and a provider billing a cached prefix bills all of it as new. There is no
   * assertion anywhere else that says the order is held - the constant that fixes it has a comment
   * and no test - so a change that made the catalogue a function of the step would pass typecheck,
   * pass every fixture, and show up only as a cached share that had quietly fallen.
   */
  readonly catalogueStableThroughout?: boolean;
  /**
   * The fewest output tokens the ledger must have recorded for this turn.
   *
   * A floor rather than an exact count: what a cut generation produced is an estimate over the
   * characters that arrived, and the assertion worth making is that it is not nought.
   */
  readonly minOutputTokens?: number;
  /** Compute credits the turn had spent when it stopped, exactly, for the fixtures about the ceiling. */
  readonly creditsSpent?: number;
  /** Tools that must appear somewhere in the run. */
  readonly toolsInclude?: readonly string[];
  /** Tools that must never run - the check that a floor or a gate actually stopped something. */
  readonly toolsExclude?: readonly string[];
  /**
   * Whether every tool this turn started came back with a result rather than an exception.
   *
   * Defaults on; a fixture whose own call was meant to throw says so with `noFailedTools: false`.
   * `tools` cannot carry this claim, because a tool is recorded as started before it runs - so a
   * turn whose every call threw lists exactly the same tools as one whose every call worked, and a
   * fixture pinning that list is green either way. That is not hypothetical: both media fixtures
   * spent their whole lives with `image_read` throwing on the step the fixture exists to measure.
   */
  readonly noFailedTools?: boolean;
  /**
   * Every warning the turn raised, in order, by the summary the owner would read.
   *
   * The empty list is the default, and it is the assertion that matters: a warning is the loop
   * saying something went wrong in a way it decided to survive, and a mechanism that fails softly
   * on every run is exactly what a green suite cannot otherwise see. The memory pack failed to
   * build on all forty-nine fixtures for the life of this rig, swallowed into one of these.
   *
   * Coupled to the summary rather than to a code, which the holds above no longer are: they read
   * `PUSHBACK_MARKERS` out of the file that writes them, and there is no equivalent table for
   * warnings - they are assembled at each site. A reworded warning failing loudly on the fixtures
   * that expect it is the better half of that trade until there is one.
   */
  readonly warnings?: readonly string[];
  /** Where the task ended up: completed, awaiting_user for an approval, failed. */
  readonly status?: string;
  /** The verification status the completion carries. */
  readonly verification?: 'verified' | 'not_applicable';
  /** Whether the owner was asked to approve something, and what for. */
  readonly askedOwner?: boolean;
  /**
   * How many commands the workspace actually ran, which separates the two orders of declaring an
   * acceptance record: declared first, the harness runs the checks twice - once to watch them fail
   * on the unfinished job and once at the finish. Declared after the work, the baseline is skipped
   * and the finish is the only run there ever was.
   */
  readonly commandsRun?: number;
  /** How many times the provider was asked to generate something, and therefore charged for it. */
  readonly mediaGenerated?: number;
  /**
   * The model id every generation named on the wire, in order.
   *
   * The unit tests around media hand a chosen route in by hand and assert on the value they handed
   * in, which is green whether or not anything carries it to the provider. This is the request the
   * provider answers, so it is the one thing that cannot be green over a wire that does not exist.
   */
  readonly mediaModels?: readonly string[];
  /**
   * The least share of a request that may be a byte-for-byte repeat of the one before it.
   *
   * The floor, not the value: the exact share moves by a point when anything in the window changes
   * size, and a fixture that pinned it would fail on every unrelated edit. What is worth asserting
   * is that a turn which only appends to its window did not rewrite the front of it.
   */
  readonly minCachePrefix?: number;
  /** Serialized lead-input characters outside the repeated prefix, including the first request. */
  readonly maxFreshLeadCharacters?: number;
  /**
   * The same floor for a delegated specialist's own window. One mission at a time; see
   * `RunOutcome.delegatedCachePrefix`.
   */
  readonly minDelegatedCachePrefix?: number;
  /** The fewest compactions this turn must have performed. */
  readonly minCompactions?: number;
  /**
   * Exactly how many compactions this turn performed, for the arm of a pair that must perform none.
   *
   * A floor cannot say "none". The control half of a paired measurement has to, or an arm that
   * quietly condensed on the budget trigger would be doing the same work as the other one and the
   * difference between the two rows would be reported as free.
   */
  readonly compactions?: number;
  /** The fewest sections the running brief must have ended up carrying. */
  readonly minBriefSections?: number;
  /**
   * The fewest of this turn's compactions whose brief a model wrote rather than the fallback.
   *
   * Asserted wherever a compaction is being priced. Without it a summariser that stops being
   * answered - a stub that only speaks one wire format, a request shape that changes - degrades to
   * the deterministic summary and every row here stays green while measuring something else.
   */
  readonly minModelWrittenBriefs?: number;
  /**
   * Exactly which of the procedures this turn opened the brief names as no longer in the window.
   *
   * The whole list, not a floor: naming one that is still open would be athanor telling the model
   * to re-read something it is already holding, which costs a step and a window for nothing.
   */
  readonly skillsNamedInBrief?: readonly string[];
  /** Whether the owner's own words were still in the last window, byte for byte. */
  readonly ownerMessageIntact?: boolean;
  /**
   * The lowest the older-tool-output floor may be driven, in characters.
   *
   * The assertion is that no result was cut all the way to the hard floor, which is what a turn
   * looks like when the cheap mechanism has been made to do the work the expensive one exists for.
   * A turn that never had to squeeze anything reads the starting floor and passes, so this no
   * longer needs the `> 0` escape it used to carry - see `RunOutcome.toolResultFloor` for what that
   * escape was hiding.
   */
  readonly minToolResultFloor?: number;
  /**
   * The fewest cache breakpoints every single request of this turn had to carry.
   *
   * The other half of `minCachePrefix`, and the half that is about the bill rather than about the
   * window. A prefix that repeats is only worth anything if the request says where the repeat ends:
   * on a route that bills explicit writes an unmarked request is a full-price write however much of
   * it the provider has seen before. So a turn can hold 95% of its bytes still and pay for all of
   * them, and nothing here could see the difference.
   */
  readonly minCacheBreakpoints?: number;
  /**
   * The largest single request this turn is allowed to build, in tokens.
   *
   * A ceiling rather than a floor, and the only expectation here that bounds a turn's size rather
   * than its shape. `promptTokens` is a sum and hides this completely: a turn that sends one
   * enormous request and nine small ones sums to the same number as one that sends ten middling
   * ones, and only the first is about to be refused by the provider. It is also the sharpest way to
   * assert that something was NOT re-sent - a body put back into the window is worth its own size
   * on the step it lands, wherever the sum ends up.
   */
  readonly maxPeakPromptTokens?: number;
  /**
   * Exactly what set each compaction off, in order.
   *
   * The whole list rather than a floor, because the two triggers are two mechanisms: an arm built
   * to measure the budget trigger is green on a run where the model happened to declare a phase
   * finished instead, and the price of the two is not the same.
   */
  readonly compactionTriggers?: readonly CompactionTrigger[];
  /**
   * Exactly how many requests carried a soft-pass summary.
   *
   * Exact rather than a floor in both directions. Zero is the assertion for every turn that must
   * never reach the soft threshold at all; a small number is the assertion for a turn built to
   * cross it, where a larger one means the budget compaction that was supposed to answer it never
   * fired and the deterministic block is now being rewritten at the head of every request.
   */
  readonly softPassWindows?: number;
  /**
   * Whether the leading system preamble stood still for the whole turn.
   *
   * The strongest cache statement a fixture can make, and the one `minCachePrefix` cannot make:
   * the anchor breakpoint is placed at the end of that run, so a byte that moves inside it costs
   * the whole request rather than the tail of it.
   */
  readonly anchorHeld?: boolean;
  /**
   * What named files hold when the turn ends, byte for byte.
   *
   * THE ONLY EXPECTATION IN THIS FILE THAT A BROKEN EDITOR CANNOT SATISFY, and the reason it exists
   * is that every other one could. A fixture whose subject is landing a hunk pins `tools`, which is
   * written before the call runs; `modelCalls`, which the script decides; and `noFailedTools:
   * false`, which a run where EVERY call failed satisfies as happily as one where the intended
   * three did. Five `file_patch` calls in this suite were refused `patch_invalid` by the shipped arm
   * on every run for the life of the line-addressed editor, and the row stayed green.
   *
   * Exact text and not a substring: an off-by-one anchor, a register that never pasted and a CUT
   * that removed nothing all produce a file that still contains everything a substring check would
   * look for. A path named here that the workspace does not hold is a failure, so this also asserts
   * the file exists.
   */
  readonly filesAfter?: Readonly<Record<string, string>>;
  /**
   * How many edits reached disk: `file_patch` hunks applied plus `file_write` calls that returned.
   *
   * Beside `filesAfter` rather than instead of it. `filesAfter` says the file is right; this says
   * how many calls it took to get there, which is what separates a patch that landed from a patch
   * that was refused and a later whole-file write that covered for it. Zero is a real expectation
   * and the interesting one: it is what a fixture about refusals asserts.
   */
  readonly landedEdits?: number;
  /**
   * Why each failing call failed: one `code:substring` per failure, in order, matched against the
   * message the model was handed.
   *
   * `noFailedTools: false` is a fixture consenting to a failure and consenting to no particular
   * one. Every row here that is ABOUT a refusal - three of them - was green while the refusal
   * arriving was a different refusal from a different layer, so this is the assertion that makes
   * "the same failure" mean something. A substring rather than the whole message, because the
   * messages carry the file's live text and pinning that would make every one of these rows fail
   * whenever a fixture's workspace changed.
   */
  readonly toolFailures?: readonly string[];
  /** Every hold the harness fired, in the order it fired them. */
  readonly holds?: readonly HoldName[];
  /** Whether the boilerplate fallback plan was written for a task that never asked for one. */
  readonly fallbackPlan?: boolean;
  /** Whether untrusted content was recorded as having entered the turn. */
  readonly untrusted?: boolean;
  /** How many separate replies the owner sees. One answer should arrive as one bubble. */
  readonly replies?: number;
  /**
   * How many of this turn's memory uses were recorded as cited.
   *
   * There is no fixture in this file for which the true answer is anything but 0 today, and that is
   * the finding rather than the default: see `RunOutcome.memoryCitations`. A row asserting a
   * positive number is a pending row and says what would have to change to make it pass.
   */
  readonly memoryCitations?: number;
  /** Provider calls sent after the spending guard refused one. Only ever asserted as 0. */
  readonly modelCallsAfterSpendHalt?: number;
  /** Whether the pause this turn wrote was stamped `spendPausedAt` rather than left ordinary. */
  readonly spendPaused?: boolean;
  /** Every spending sentence the owner was shown, in order, exactly. */
  readonly spendNotices?: readonly string[];
}

/**
 * One row of the curated overlay: the workspace and user notes the knowledge block is built from.
 *
 * The block sits in the preamble ahead of the whole trajectory and its header says it is frozen for
 * the run, so what a fixture puts here is under the two cache breakpoints in front of everything
 * else. Two of the four repairs Wave 3 made to that block - anchoring the temporal filter and
 * anchoring the ranking to `task.createdAt` - are only observable against a pool with more than one
 * entry in it and an expiry inside the run.
 */
export interface FixtureKnowledge {
  /** Whose note it is. The block renders the two groups separately. */
  readonly target?: 'workspace' | 'user';
  readonly content: string;
  /**
   * When the note stops being true, in the document AND in the clear column beside it, exactly as
   * `createWorkspaceMemory` writes them: retention has to find an expired row without the key.
   */
  readonly validUntil?: string;
  readonly updatedAt?: string;
}

/**
 * One row of the tiered store, which is what the frozen memory pack is ranked out of.
 *
 * Sealed with the same associated data the real writer uses, because that is the half of this the
 * loop actually checks: `openMemoryCandidate` drops any row whose envelope was sealed for another
 * tier or another workspace, silently and one row at a time, so a stub that seals them wrongly
 * hands back a pack of nothing while every count in the run says the recall worked.
 */
export interface FixtureMemoryItem {
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly trust?: MemoryTrust;
  readonly status?: MemoryStatus;
  /** When it was observed. Defaults to the task's own creation instant. */
  readonly observedAt?: string;
  readonly validFrom?: string;
  /** When the belief stopped being true. A row whose validity ended before the anchor is inadmissible. */
  readonly validTo?: string | null;
  /**
   * Where this row ranks, stated by the fixture rather than computed here.
   *
   * The real ranking is reciprocal-rank fusion over four keyed channels inside PostgreSQL, and the
   * plan reaching this stub carries only the keyed tokens - the query's own words are hashed by a
   * function `packages/core` does not export, so nothing on this side can reproduce a score. What
   * this rig can model exactly is everything the ranking is wrapped in: which rows are admissible
   * at the anchor, which the caller already holds, how many fit the budget, and in what order they
   * are rendered. A fixture that wants to assert about relevance states the order it is asserting
   * about; a fixture that wants to assert about the pack's bytes does not have to care.
   */
  readonly score?: number;
  readonly tokensEst?: number;
}

/** What a fixture remembers before it starts, on both of the surfaces a turn opens with. */
export interface FixtureMemory {
  readonly knowledge?: readonly FixtureKnowledge[];
  readonly recall?: readonly FixtureMemoryItem[];
}

/**
 * A procedure this workspace has saved, which is the second thing the preamble is built from.
 *
 * Only the index - the name and the description - travels in the window; the body is what a
 * `skill(action=view)` puts there, and what a compaction later takes away.
 */
export interface FixtureSkill {
  readonly name: string;
  readonly description: string;
  readonly body?: string;
  readonly enabled?: boolean;
  readonly status?: 'active' | 'stale' | 'archived';
  readonly pinned?: boolean;
}

/**
 * A spending cap the guard is answering against, and the step at which each arm starts.
 *
 * `daily` and `monthly` are the two windows that reach `claimSpendAlert` and the notification the
 * owner actually receives; `task` deliberately does not, and a fixture that names it is measuring a
 * shorter path. The fixtures below use `daily` for that reason.
 */
export interface FixtureSpend {
  readonly window: 'task' | 'daily' | 'monthly';
  /** Money the provider has already billed against this window. */
  readonly spentUsd: number;
  readonly capUsd: number;
  /** The answered provider call from which the guard warns, counting from zero. */
  readonly warnFrom?: number;
  /** The answered provider call from which the guard denies. Beats `warnFrom` where both apply. */
  readonly denyFrom?: number;
}

/**
 * The guard's answer at a given point in the turn, in the shape `spendGuard` returns.
 *
 * Built here rather than declared per fixture because `spendHalt` and `spendWarning` both read the
 * window out of `windows` by name: a decision that names a window it does not carry falls through
 * to their "no cap" branch and the fixture would then be asserting the wrong sentence, green.
 */
const spendDecisionAt = (
  spend: FixtureSpend | undefined,
  answeredCalls: number
): SpendDecision & { readonly outcome: 'allow' | 'warn' | 'deny' } => {
  const outcome: 'allow' | 'warn' | 'deny' =
    spend === undefined
      ? 'allow'
      : spend.denyFrom !== undefined && answeredCalls >= spend.denyFrom
        ? 'deny'
        : spend.warnFrom !== undefined && answeredCalls >= spend.warnFrom
          ? 'warn'
          : 'allow';
  if (!spend || outcome === 'allow')
    return {
      outcome: 'allow',
      estimateUsd: 0,
      blockedBy: null,
      warnedBy: [],
      reason: null,
      windows: []
    };
  return {
    outcome,
    estimateUsd: 0.01,
    blockedBy: outcome === 'deny' ? spend.window : null,
    warnedBy: outcome === 'warn' ? [spend.window] : [],
    reason: null,
    windows: [
      {
        name: spend.window,
        spentUsd: spend.spentUsd,
        pendingUsd: 0,
        capUsd: spend.capUsd,
        warnAtUsd: spend.capUsd * 0.8,
        projectedUsd: spend.spentUsd + 0.01,
        state: outcome === 'deny' ? 'exceeded' : 'warning',
        // A window occurrence, which is the primary key `claimSpendAlert` de-duplicates on. Fixed
        // for the run so a warn asked for twice is asked about the same day twice.
        startsAt: spend.window === 'task' ? null : '2026-07-01T00:00:00.000Z',
        endsAt: spend.window === 'task' ? null : '2026-07-02T00:00:00.000Z'
      }
    ]
  };
};

export interface Fixture {
  readonly id: string;
  readonly shape: FixtureShape;
  /** The owner's words, as they would arrive. */
  readonly request: string;
  /** What this fixture protects, in prose: what breaks, or costs more, if it changes. */
  readonly why: string;
  readonly model: ModelScript;
  /**
   * A REAL provider, for the one caller that has to reach one.
   *
   * Absent everywhere in `fixtures.ts`, and the absence is what keeps this rig offline: with no
   * `live` the worker is pinned at `PROVIDER_URL`, the wrapper below answers it from `model`, and
   * nothing leaves the process. Present, the worker is pointed at the real route and the wrapper
   * never matches its URL, so the request falls through to whatever `globalThis.fetch` was when
   * `runFixture` was entered - which is where `evals/bench/provider.ts` meters it.
   *
   * This exists because `ModelScript` is SYNCHRONOUS - `(context) => ModelTurn` - so a script
   * cannot await a provider. Measured: a driver that tried returned a promise the harness used as
   * a turn, and the run billed real calls while every turn failed with "custom could not be
   * reached". The seam a real model needs is the socket, not the script.
   */
  readonly live?: LiveProvider;
  /**
   * The mode the task is minted under. Absent everywhere in `fixtures.ts`, and the absence is
   * `balanced` - the mode the owner installs, and the one every committed row was measured under.
   * `evals/bench` sets it per arm: `autonomous` is the floor every mode shares, and a fixture that
   * names it is asking what the floor alone still stops.
   */
  readonly securityMode?: 'review' | 'balanced' | 'autonomous';
  /**
   * An approver that answers every card approved with nobody reading it, which is what every
   * published leaderboard adapter is.
   *
   * Off everywhere in `fixtures.ts`: a card that fires parks the run in `awaiting_user` and the
   * fixture measures the park, which is the product. On, the harness plays the owner's part of the
   * production approval flow step for step - the card is marked approved, the task is claimed back
   * as `running` under this worker, and `AgentWorker.run` is entered again so `turn/resume.ts`
   * finds the approval, checks the argument hash and executes the approved call. See the loop
   * after the first `run(task)` in `runFixture` for what it does NOT answer: a parked question.
   */
  readonly autoApprove?: boolean;
  readonly runner?: RunnerStub;
  /** The step ceiling in force, when the fixture is about what happens at one. */
  readonly maxSteps?: number;
  /**
   * The window of the model this fixture runs on, when the size of the window is the subject.
   *
   * Both shipped defaults declare a million tokens, and every mechanism that decides when to
   * condense is a function of that number, so a fixture about the window has to be able to state
   * it. Everything else runs on the ordinary release below.
   */
  readonly contextTokens?: number;
  /** The compute ceiling in force, raised only by the fixtures long enough to reach the default. */
  readonly maxCredits?: number;
  /**
   * What this workspace already remembers. Absent everywhere but the fixtures that are about it.
   *
   * Empty is not a neutral default and is not treated as one: an empty pool is the shape every
   * fixture here had for the life of this rig, and it is why four separate cache regressions in the
   * two blocks built from these rows could have been reverted one at a time without a single number
   * in the baseline moving. It stays the default only so that adding the knob moves no committed
   * row; a fixture about the preamble has to fill it.
   */
  readonly memory?: FixtureMemory;
  /** The procedures this workspace has saved, for the fixtures about opening and losing one. */
  readonly skills?: readonly FixtureSkill[];
  /**
   * Why this fixture is expected to fail, and what would make it pass.
   *
   * A fixture that states what the loop SHOULD do about something it does not do yet. The suite
   * reports the row as pending rather than failed and still exits zero, so a known gap cannot block
   * a wave - and it inverts, so a pending fixture that starts passing fails the run until somebody
   * deletes this line. That inversion is the whole point: the alternative to a marked red row is an
   * unwritten fixture, and an unwritten fixture is how a defect survives four audits.
   *
   * It is not a way to park a regression. A row that was green and goes red is a regression and has
   * to be argued with; this is for a measurement written ahead of the repair it describes.
   */
  readonly pending?: string;
  /**
   * A vision specialist in the registry beside the lead, priced at 30/60 USD per million tokens.
   *
   * Off by default so no existing row moves: `listModels` answers with the lead alone unless a
   * fixture asks for the second row, and a fixture that does is a fixture about routing a picture.
   */
  readonly visionSpecialist?: boolean;
  /**
   * The owner's price ceiling, as `effectiveSpendLimits` reports it.
   *
   * Absent means no ceiling, which is what every fixture but the refusal one wants. The refusal one
   * sets it under the specialist's price, which is the only way to reach the branch that says so.
   */
  readonly priceCeiling?: {
    readonly maxInputUsdPerMillionTokens: number;
    readonly maxOutputUsdPerMillionTokens: number;
  };
  /**
   * The running spending cap, as the guard answers it, and from which step it starts to bite.
   *
   * Absent means the guard allows everything, which is what every other row here is - and which is
   * what every row here was, hardcoded, for the whole life of this rig. Two of `spendGuard`'s three
   * arms were therefore unreachable from this suite: the warn arm, which narrates once per window
   * and carries on, and the deny arm, which pauses the task, stamps `spendPausedAt` and must send
   * nothing further to the provider. The daily ceiling is the one bound in this product that spends
   * the owner's money while they are asleep and stops on its own, and until now the only thing
   * standing under it was a unit test over a store method.
   *
   * Stated as "from which answered provider call", because the guard runs once per step, before the
   * request: a turn where the cap is crossed at step four is the shape that has to be measured, not
   * one that was over before it began.
   */
  readonly spend?: FixtureSpend;
  /**
   * A clock that runs faster than the wall, for the bounds that are measured in time.
   *
   * The generation deadline, the idle watch and the continuation rate are all read off `Date.now`,
   * and the shortest of them is ten minutes. A fixture cannot spend that, and the gateway takes no
   * timeout option from the worker's config, so the only seam left is the clock itself:
   * `startGenerationBudget` reads it, `worthContinuing` divides by it, and every one of them goes
   * through the global. Declared per fixture and installed for that fixture alone.
   *
   * `msPerFrame` advances it as each frame of a `silent` generation goes out, which is what makes
   * one generation take a measured quarter of an hour without the run taking one; every other
   * stream of the same fixture runs at the clock's current reading, because a turn whose closing
   * call was also timed out would never get to say what it did. `msPerCall` advances it once per
   * provider call, for the ceilings counted across a turn rather than inside one.
   */
  readonly clock?: { readonly msPerFrame?: number; readonly msPerCall?: number };
  /**
   * A correction the owner sent while the turn was running, waiting in the queue.
   *
   * Marked `interrupt`, because that is the only kind the loop takes mid-turn: "do this next" and
   * "no, not that" are different intentions and reading one as the other from timing alone would be
   * wrong half the time. Taken once - the second read finds an empty queue, exactly as the real one
   * does after the message is consumed.
   */
  readonly correction?: string;
  /**
   * A fixture that asserts about the shape of the product rather than about a turn.
   *
   * It runs no loop, spends no call and prepares no window; it returns the list of things it found
   * wrong, which arrive as warnings and are compared against `expect.warnings` like any others. The
   * suite is the right home for these even though they are not behavioural: they are claims about
   * the same catalogue every row here is priced on, and a claim checked in a file nobody runs on a
   * schedule is a claim nobody checks.
   */
  readonly schema?: () => readonly string[];
  /**
   * A REAL workspace, listening at this URL, instead of the scripted runner stub.
   *
   * THE SEAM `evals/bench` NEEDED AND THE ONLY ONE IT ADDS. That rig builds a shim that speaks the
   * runner protocol over a real box, and every part of it was proved in isolation while nothing
   * ever ran an `AgentWorker` against it - the computed-and-unwired shape this programme keeps
   * finding. Closing it needs the loop's own runner traffic to leave this process, and there was no
   * way to ask for that: `runFixture` installs its own `globalThis.fetch` for the duration of a run,
   * so an outer wrapper never sees a runner request, and `WORKSPACE_RUNNER_URL` is a module
   * constant. This field is the smallest thing that reaches it - one config value and one branch.
   *
   * Absent on every fixture in `evals/fixtures.ts` and inert when absent: the config keeps the same
   * `RUNNER_URL` and the same `runnerResponse` answers it always did, so no committed baseline row
   * can move because this exists. Only requests whose URL starts with this value are forwarded;
   * anything else the loop asks for still meets the stub, so a fixture cannot accidentally reach
   * the network by naming one host.
   *
   * WHAT IT COSTS THE OUTCOME, because three fields below are records the STUB keeps and a real box
   * does not report: `filesAfter`, `mediaGenerated` and `mediaModels` are empty under it. The
   * workspace is the ground truth for those and the caller has to read the box. `commandsRun` and
   * `observedRoutes` are counted off the wire here, so they stay true.
   */
  readonly workspaceUrl?: string;
  readonly expect: Expectation;
}

/* ------------------------------------------------------------------------------ what is watched */

/**
 * The holds this suite can see, taken from the file that writes them.
 *
 * This used to be a private table of sixteen sentences copied out of the loop, with a comment
 * calling itself "the one place this harness is coupled to wording" - which was true and was the
 * problem: nothing made the two copies agree, and the failure mode of a disagreement is silent.
 * A fixture asserting `holds: ['plan_hold']` against a reworded marker does not go red; it stops
 * observing the hold and reports the empty list it now measures. Five markers were also simply
 * absent from the copy, so five mechanisms in the loop - the compute ceiling, both halves of the
 * output limit, the vision handoff and the resumed-turn notice - could fire on any fixture here
 * and be counted as no hold at all.
 *
 * `PUSHBACK_MARKERS` is published from `agent.ts` beside the sentences it matches, so a reworded
 * pushback is now the same edit as the row that matches it.
 */
export type HoldName = PushbackName;

/**
 * The order the report lists them in, which is the order they are declared in beside the code that
 * writes them - grouped by mechanism rather than by when this suite happened to learn about them.
 * Derived rather than restated so a hold added to the loop appears in the table below it without a
 * second list having to be remembered.
 */
export const HOLD_ORDER: readonly HoldName[] = PUSHBACK_MARKERS.map(([name]) => name);

// The acceptance hold and the plan hold share an opening, so the longer marker is tried first.
// `PUSHBACK_MARKERS`' own comment names this requirement for anything that reads the table.
const ORDERED_MARKERS = [...PUSHBACK_MARKERS].sort(
  (left, right) => right[1].length - left[1].length
);

const holdsIn = (messages: readonly string[]): { holds: HoldName[]; pushback: string[] } => {
  const holds: HoldName[] = [];
  const pushback: string[] = [];
  for (const message of messages) {
    const match = ORDERED_MARKERS.find(([, marker]) => message.includes(marker));
    if (!match) continue;
    holds.push(match[0]);
    pushback.push(message);
  }
  return { holds, pushback };
};

/* ------------------------------------------------ what a turn displayed, and what it landed */

/**
 * One `file_read`, counted by what it actually put on the model's screen.
 *
 * `lines` is the number of rows in the result's `content`, which is `renderNumbered`'s own output
 * and therefore the thing the model reads - never `totalLines`, and never the window the call asked
 * for. The two differ on every read the display bound cuts short, and the whole point of the
 * measurement is that they are allowed to.
 */
export interface DisplayedRead {
  readonly toolCallId: string;
  readonly path: string;
  /** Rows of `content`: what was rendered and sent. */
  readonly lines: number;
  /** `endLine - startLine + 1`, the tool's own claim about the same quantity. */
  readonly claimedLines: number;
  /** The file's real length, when the read reached the end of it and could say. */
  readonly totalLines: number | null;
  /** Whether the model asked for a range, which is the arm `workspace.ts:256` takes. */
  readonly windowed: boolean;
  /** Whether the result says it stopped before the end. */
  readonly truncated: boolean;
}

/** One edit that reached disk: a `file_patch` hunk that applied, or a `file_write` that returned. */
export interface LandedEdit {
  readonly toolCallId: string;
  readonly tool: 'file_patch' | 'file_write';
  readonly path: string;
  /** Rows the patch echo displayed back, which is display the edit itself paid for. */
  readonly echoLines: number;
}

/**
 * The read side of a turn, as arithmetic rather than as an impression.
 *
 * DISPLAYED LINES PER LANDED EDIT is the number the whole edit-format economic case turns on and
 * the one athanor measured nowhere. The line dialect buys output characters per edit and pays for
 * them in input: the numbering is charged on every request after a read for as long as the file
 * stays in the window, so `evals/arms/price.ts` can only close its break-even by ASSUMING how many
 * edits a turn lands per read. This is that assumption, measured.
 *
 * Read from the event stream and not from the window: `tool_result` carries the result the tool
 * returned, before the context layer decides how much of it to keep, so this counts what athanor
 * chose to display and not what survived a later squeeze. Both are worth knowing and they are
 * different questions; `evals/context-quality` owns the second one.
 *
 * `document_read` and `parallel_web_read` also put text in front of the model and are deliberately
 * not counted. This is the ledger the EDIT FORMAT is priced against, and neither of those can be
 * addressed by a patch.
 */
export interface ReadLedger {
  readonly reads: readonly DisplayedRead[];
  readonly edits: readonly LandedEdit[];
  /** Rows of file text displayed by reads. The numerator. */
  readonly displayedLines: number;
  /** Rows the patch echoes displayed. Beside the numerator, never inside it, so both are readable. */
  readonly echoLines: number;
  /** The denominator. Zero is a real answer and is never divided by; see `linesPerEdit`. */
  readonly landedEdits: number;
  /**
   * Reads whose `content` had a different number of rows than `endLine - startLine + 1`.
   *
   * Always zero, and asserted rather than assumed: the two are computed by different code on
   * different sides of a JSON boundary, and a disagreement means one of them is not describing what
   * was displayed. A rig that averaged over such a row would be averaging over a bug.
   */
  readonly claimMismatches: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const rowsOf = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/**
 * The ledger, built by pairing every `tool_result` with the `tool_started` that named its call.
 *
 * Paired rather than sniffed from the result's own shape, because that is the only place the
 * ARGUMENTS are - and `windowed` is a fact about what the model asked for, not about what came
 * back. A call that threw writes an `error` event and no `tool_result`, so a refused patch and a
 * failed read are absent here by construction rather than by a filter somebody has to maintain.
 */
export const readLedgerOf = (
  events: readonly { readonly kind: string; readonly payload: unknown }[]
): ReadLedger => {
  const started = new Map<string, { tool: string; arguments: Record<string, unknown> }>();
  for (const entry of events) {
    if (entry.kind !== 'tool_started') continue;
    const payload = asRecord(entry.payload);
    const id = asText(payload.toolCallId);
    if (id) started.set(id, { tool: asText(payload.tool), arguments: asRecord(payload.arguments) });
  }
  const reads: DisplayedRead[] = [];
  const edits: LandedEdit[] = [];
  let claimMismatches = 0;
  for (const entry of events) {
    if (entry.kind !== 'tool_result') continue;
    const payload = asRecord(entry.payload);
    const toolCallId = asText(payload.toolCallId);
    const call = started.get(toolCallId);
    if (!call) continue;
    const result = asRecord(payload.result);
    if (call.tool === 'file_read' && typeof result.content === 'string') {
      const lines = rowsOf(result.content);
      const startLine = Number(result.startLine);
      const endLine = Number(result.endLine);
      const claimedLines =
        Number.isFinite(startLine) && Number.isFinite(endLine) ? endLine - startLine + 1 : lines;
      if (claimedLines !== lines) claimMismatches += 1;
      reads.push({
        toolCallId,
        path: asText(result.path) || asText(call.arguments.path),
        lines,
        claimedLines,
        totalLines: Number.isFinite(Number(result.totalLines)) ? Number(result.totalLines) : null,
        // The same test `workspace.ts:254-256` makes, on the same two arguments.
        windowed: Number(call.arguments.startLine) > 0 || Number(call.arguments.endLine) > 0,
        truncated: result.truncated === true
      });
      continue;
    }
    if (call.tool === 'file_patch') {
      const changed = Array.isArray(result.filesChanged) ? result.filesChanged : [];
      // The echo is one string for the whole call, so it is charged to the call's first landed
      // hunk rather than divided: dividing it would invent a per-file figure nothing produced.
      const echo = rowsOf(asText(result.wrote));
      for (const [index, file] of changed.entries())
        edits.push({
          toolCallId,
          tool: 'file_patch',
          path: asText(asRecord(file).path),
          echoLines: index === 0 ? echo : 0
        });
      continue;
    }
    if (call.tool === 'file_write')
      edits.push({
        toolCallId,
        tool: 'file_write',
        path: asText(call.arguments.path),
        echoLines: 0
      });
  }
  return {
    reads,
    edits,
    displayedLines: reads.reduce((total, read) => total + read.lines, 0),
    echoLines: edits.reduce((total, edit) => total + edit.echoLines, 0),
    landedEdits: edits.length,
    claimMismatches
  };
};

/**
 * Displayed lines per landed edit, or null where the turn landed no edit.
 *
 * Null and never `Infinity`, and never zero. A turn that read four hundred lines and landed nothing
 * has a real read cost and no edit to charge it to; printing `Infinity` invites a mean over it, and
 * printing 0 would say the reads were free. Rows with no landed edit are counted in their own
 * column wherever this is reported, which is the only honest place for them.
 */
export const linesPerEdit = (ledger: ReadLedger): number | null =>
  ledger.landedEdits === 0 ? null : ledger.displayedLines / ledger.landedEdits;

export interface RunOutcome {
  /** Provider calls, which is what a step costs and what the owner is billed for. */
  readonly modelCalls: number;
  /**
   * How many of those calls a delegated specialist spent, rather than the turn itself.
   *
   * `modelCalls` alone cannot be read a year from now: a delegate call is one step of the turn and
   * then as many provider calls as the missions behind it take, so the same total is reached by a
   * turn that thought for nine steps and by a turn that thought for three and sent two specialists.
   * Split out so a diff can say which of the two moved.
   */
  readonly delegatedCalls: number;
  /**
   * What the provider was handed, in tokens, summed over every request it answered.
   *
   * The whole body: catalogue, envelope and messages. This used to be athanor's own estimate of the
   * messages alone, which excluded `body.tools` - so on a product whose catalogue is four fifths of
   * the fixed floor, the headline column of the suite that guards against cost regressions could
   * not see the largest cost term at all. Emptying the catalogue moved it by 0.0%.
   *
   * It is deliberately not the same number the loop bills itself with: see `windowTokens`.
   */
  readonly promptTokens: number;
  /**
   * Of `promptTokens`, the part that was tool schema.
   *
   * Its own column because it is the term under work, and a total that moves is unreadable without
   * knowing which half moved: a turn that took one step fewer and a turn whose catalogue shrank by
   * a third look identical in a sum.
   */
  readonly catalogueTokens: number;
  /**
   * The catalogue on the turn's last step, in bytes as it went out.
   *
   * Per request rather than per run, so it is comparable across fixtures of different lengths and
   * against the byte ceiling `tool-catalogue.test.ts` holds. On a fixture where nothing narrows the
   * catalogue this is the resident floor every request of every turn pays.
   */
  readonly residentCatalogueBytes: number;
  /**
   * The prompt athanor thought it had built, by its own estimate, summed over every cost event.
   *
   * The number this suite reported as `promptTokens` until the wave that noticed the two halves of
   * the rig disagreed. Kept, because the difference between it and `promptTokens` is exactly what
   * the loop cannot see when it decides to condense - and because a wave that claims to have moved
   * the catalogue should be able to show this standing still while the billed total falls.
   */
  readonly windowTokens: number;
  /**
   * The largest single window the context layer prepared, which is what decides whether a long task
   * fits.
   *
   * Still the loop's own estimate, and still excluding the catalogue, which is not an oversight:
   * the budget arithmetic in `context.ts` is a share of the window MINUS the reserved catalogue, so
   * this is the quantity that is actually compared against a threshold, and a fixture's ceiling on
   * it is a claim about what the layer chose to put in. What the request weighed on the wire is
   * `promptTokens`, and what the catalogue costs is its own column.
   */
  readonly peakPromptTokens: number;
  readonly tools: readonly string[];
  readonly proposed: readonly string[];
  readonly finalCatalogue: readonly string[];
  /**
   * Whether the closing request's catalogue was byte-identical to the one before it. True for a
   * turn of a single step, which never swapped anything.
   */
  readonly finalCatalogueUnchanged: boolean;
  /** Whether every step of the turn carried the same catalogue, byte for byte. */
  readonly catalogueStableThroughout: boolean;
  /**
   * Output tokens the ledger recorded across the turn, summed off the cost events.
   *
   * Here for one question the suite could not ask: was a generation this side cut off still billed?
   * A cut call never reaches the provider's usage frame, so the number can only come from this
   * side's own estimate of what arrived - and until that estimate was written, the one generation
   * the box stops on purpose was the one generation nobody ever paid for on paper. A fixture
   * asserting a floor here is asserting that the estimate ran.
   */
  readonly outputTokens: number;
  /** Compute credits the turn had spent when it stopped, as the last cost event reported them. */
  readonly creditsSpent: number;
  /**
   * Requests that carried this machine's checkout path.
   *
   * Never declarable, like `unstubbedRoutes`: a fixture cannot consent to a prompt that names the
   * directory the repository happens to sit in, because the number that fixture commits would then
   * be a number about this machine.
   */
  readonly checkoutPathLeaks: number;
  readonly commandsRun: number;
  /**
   * What this turn's reads displayed and what its edits landed. See `ReadLedger`.
   *
   * A first-class field rather than something a reader derives from `tools`, because `tools` is
   * recorded before a call runs and says nothing about how much a read showed or whether an edit
   * reached disk - which is the whole of the question.
   */
  readonly readLedger: ReadLedger;
  /**
   * Every file in the workspace when the turn ended, by path, as text.
   *
   * The stub's starting files, overlaid with everything the turn wrote. This is the only thing in
   * this rig that can tell an edit that LANDED from an edit that was merely ATTEMPTED, and until it
   * existed nothing could: `tools` records a call before it runs, `noFailedTools` is satisfied by a
   * fixture that declares its own failures, and `readLedger.landedEdits` counts writes without
   * looking at what they contained. So `small-hunks-that-miss-in-different-places-are-a-search`
   * spent its whole life reporting green with all five of its patches refused, and the two
   * acceptance fixtures reported a fixed importer after writing the file back byte-identical.
   *
   * Text and not bytes, so an expectation reads as the file rather than as a digest, and a failure
   * says what the file actually holds.
   *
   * EMPTY UNDER `Fixture.workspaceUrl`. It is the stub's own record of what it was handed, and a
   * real box on the other end of a socket keeps its own filesystem this rig never sees. A caller
   * running against a live workspace reads the box; reading this would be reading a record of
   * nothing and calling it an empty workspace.
   */
  readonly filesAfter: Readonly<Record<string, string>>;
  /** Generations the provider was actually billed for, which is the only real money a turn spends. */
  readonly mediaGenerated: number;
  /** The model id each of those generations named on the wire, in order. */
  readonly mediaModels: readonly string[];
  /** Mean common-prefix share of successive serialized lead requests; not provider cache usage. */
  readonly cachePrefix: number;
  /** Serialized UTF-16 character counts; offline proxies, not tokens or billing. */
  readonly leadInputCharacters: number;
  readonly leadPrefixCharacters: number;
  readonly freshLeadCharacters: number;
  /**
   * The same share, measured over a delegated specialist's own consecutive requests.
   *
   * A specialist's window is its own: it shares nothing with the lead's but the catalogue, so its
   * requests are deliberately kept out of `cachePrefix` above - counting them would report a cache
   * miss for a turn whose own window never moved. But a mission is up to sixteen model calls
   * against a window nobody persists, with its own truncation floor carried in a local, and until
   * this line nothing measured any of it. A specialist that re-lengthens a page read between two of
   * its own steps rewrites the front of a window the provider has just cached, and the whole cost
   * of that lands inside one tool result the lead never sees.
   *
   * Only meaningful with ONE mission in flight. Two concurrent specialists are answered in
   * whichever order the provider likes, so consecutive delegated requests are not consecutive
   * anything - the fixture that asserts on this sends one mission, and says so.
   */
  readonly delegatedCachePrefix: number;
  /** Compactions the loop performed, each of which is a model call and a rewritten prefix. */
  readonly compactions: number;
  /** Sections the running brief ended up carrying, which is how much history survived condensing. */
  readonly briefSections: number;
  /**
   * Of those compactions, the ones whose brief a model actually wrote.
   *
   * `compactContext` swallows a summariser that fails and falls back to a deterministic summary, so
   * a compaction reports success either way and every other number here moves by a few per cent.
   * That is how this suite spent its whole life measuring the fallback: the stub answered the
   * tool-free summarising call with SSE, the parse failed, and nothing anywhere said so. This is
   * the one figure that separates the two, and it is why `completionBody` cannot be narrowed back
   * without a fixture going red.
   */
  readonly modelWrittenBriefs: number;
  /**
   * Of the skills this turn opened, the ones a compaction's brief names, sorted.
   *
   * An opened procedure arrives as an ordinary tool result, so a compaction condenses it away like
   * any other - and the model then goes on working to instructions it can no longer read, with
   * nothing in the transcript saying so. The brief is the only place that can say it, so the claim
   * is that the name of every procedure a compaction took survives in the record the model keeps
   * reading. A skill still in the window is not named and must not be: this is a notice about
   * something lost, not a list of what was loaded.
   */
  readonly skillsNamedInBrief: readonly string[];
  /** Whether the owner's own words were still in the last window, byte for byte. */
  readonly ownerMessageIntact: boolean;
  /**
   * The tightest older-tool-output floor this turn ever applied, in characters.
   *
   * Read off `cost.context.olderToolOutputChars` - the number the context layer chose and acted
   * on - rather than reconstructed by grepping the last window for the sentence a squeezed result
   * carries. The grep was wrong in both directions and quietly. It could only see the LAST window,
   * so a turn that walked its floor all the way down and then condensed reported whatever the
   * post-compaction window happened to hold; it measured the length of a truncated MESSAGE, which
   * is the floor plus the notice plus whatever the two ends of the result came to, not the floor;
   * and it reported 0 for a turn that squeezed nothing, which the check then had to disarm with a
   * `> 0` that also disarmed every genuine reading of the hard floor.
   *
   * A turn that never had to squeeze reads `RECENT_TOOL_OUTPUT_CHARS`, because that is the floor
   * it applied: nothing was cut because nothing was over it. So "nothing squeezed passes" is now a
   * property of the number rather than a hole in the assertion.
   */
  readonly toolResultFloor: number;
  /**
   * The fewest cache breakpoints any single request of this turn carried.
   *
   * The floor rather than the total: every request is marked independently, and a mechanism that
   * stops marking - a window that slips under `MIN_CACHEABLE_TOKENS`, a `stablePrefixEnd` that
   * collapses onto the preamble - shows up as one request with fewer, not as a smaller sum. The
   * sum would hide it behind the steps either side.
   */
  readonly cacheBreakpoints: number;
  /**
   * What set off each compaction, in order: the model saying a phase was over, or the window.
   *
   * `compactions` alone cannot separate the two, and they are different mechanisms with different
   * prices - one is a lever the model holds and the other is the loop refusing to send a request
   * it knows is too large. A fixture built to measure the second is green on the first.
   */
  readonly compactionTriggers: readonly CompactionTrigger[];
  /**
   * How many requests carried a soft-pass summary - the deterministic `COMPRESSED TRAJECTORY`
   * block `prepareModelContext` splices in once the window passes 72% of its budget.
   *
   * Worth counting separately from `compactions` because it is not one: no model call, no event,
   * no brief, nothing on the timeline. It is a silent rewrite of the front of the window, and
   * today it is spliced at the head of the trajectory, so the step it first appears on differs
   * from the step before it at the first trajectory message and every cached byte behind that is
   * re-billed. Nothing here could see it happen at all before this line.
   */
  readonly softPassWindows: number;
  /**
   * Whether the leading system preamble - the block the cache anchor closes - was byte-identical
   * on every step of the turn.
   *
   * `markCacheBreakpoints` puts its anchor at the end of the leading run of system messages,
   * because that run is the largest thing in the prompt that survives a whole task. A message that
   * changes inside that run does not merely miss: it moves the anchor onto volatile bytes, so the
   * anchor is written on one step and stale on the next, and every breakpoint behind it is
   * unreachable. `cachePrefix` cannot say this on its own - it reports a share, and a share of 94%
   * is what a turn looks like whether the 6% that moved was at the front or at the tail, while
   * only one of those is billable.
   *
   * True for a turn of a single step, which never had a preamble to keep.
   */
  readonly anchorHeld: boolean;
  /**
   * How many `recordMemoryUse` calls this turn made claiming the item was cited in the answer.
   *
   * The numerator of the salience formula's citation term, measured at the only place a fixture can
   * see it. See the stub's own note: no production caller passes `cited`, so this is 0 on every
   * fixture in this file, and a fixture that says otherwise is stating a target rather than a fact.
   */
  readonly memoryCitations: number;
  /**
   * Provider calls the turn sent after the spending guard refused one, which must be nought.
   *
   * The assertion the deny arm is actually for. `status: 'paused'` says the loop wrote the right
   * row; this says it stopped spending, which is the only part of a ceiling the owner is paying
   * for. Reported as `-1` when the guard never denied, so "no halt" cannot be mistaken for "halted
   * cleanly" by a fixture that asserts 0.
   */
  readonly modelCallsAfterSpendHalt: number;
  /** Whether the pause the turn wrote was stamped `spendPausedAt`, which is what tells it apart. */
  readonly spendPaused: boolean;
  /**
   * Every sentence the owner is shown about a spending window, in order.
   *
   * Read structurally, off the `windows` array a spend event carries in its payload, rather than
   * off the wording - `spendHalt` and `spendWarning` own the sentence and both have a silent "no
   * cap" branch, so a fixture matching on prose would go green against the branch that says the
   * least.
   */
  readonly spendNotices: readonly string[];
  readonly holds: readonly HoldName[];
  /** What the loop actually said back, in full, for the runs that need explaining. */
  readonly pushback: readonly string[];
  readonly status: string;
  readonly verification: string;
  readonly askedOwner: boolean;
  /**
   * How many approval cards the turn actually raised, rather than whether it raised any.
   *
   * `askedOwner` is `approvalsRaised > 0` and was the only reading of the approval floor this rig
   * published. That is enough for a fixture, which asks whether a card fired at all, and not enough
   * for `evals/bench`: the artefact it builds has an `approval_cards_fired_mean` column whose whole
   * purpose is to price the approval floor in benchmark points, and a boolean widened into a count
   * would report one card for a turn that raised four. The number was already here - the store stub
   * has counted every `createApproval` for the life of this file - and nothing in `report.ts` reads
   * it, so no committed baseline row can move because this is published.
   */
  readonly approvalsRaised: number;
  /**
   * Cards the harness answered approved on the fixture's behalf. Zero unless `Fixture.autoApprove`
   * is on; `approvalsRaised` keeps counting every card across the re-entries, so the difference
   * between the two is the cards left standing when the run ended.
   */
  readonly approvalsAutoAnswered: number;
  /**
   * Whether the auto-approver stopped re-entering because it reached its own ceiling, leaving the
   * run parked on a card it would otherwise have answered. A bounded loop that hit its bound is a
   * different fact from a turn that parked, and a row should be able to tell them apart.
   */
  readonly autoApproveCapReached: boolean;
  /**
   * What this run cost in USD, by the provider's own figure where it gave one.
   *
   * Live: the `cost` field on every answered response's usage frame, summed - the same responses
   * the three token sums below are read off, so cost and tokens describe one set of calls. It is
   * attributable to this run alone, which the account's running total is not once two processes
   * share a key. A response that carried no frame, or a frame with no price, falls back to the
   * usage row the loop recorded for that call (its own estimate at the release's price), and
   * `providerUsageFallbacks` says how many did. Offline it is the sum of the loop's usage rows -
   * its own estimate - and nothing in `evals/report.ts` reads it, so no committed row can move
   * because it exists.
   */
  readonly providerCostUsd: number;
  /**
   * How many live responses the provider answered - every request under `Fixture.live.baseUrl`
   * that came back with a 2xx, whatever kind of call it was. The three token sums and the cost
   * above are over exactly these, and `modelCalls` counts them plus the requests the provider
   * refused. Zero offline: nothing is forwarded.
   */
  readonly providerCalls: number;
  /**
   * Of `providerCalls`, how many were priced and counted from the loop's own ledger row rather
   * than from the provider's frame, because the response carried no frame (a cut stream) or a
   * frame with no price (a route that does not price its calls). A row with this above zero is
   * a row where the columns are partly the loop's arithmetic, and a reader should know that
   * rather than infer it. Zero offline.
   */
  readonly providerUsageFallbacks: number;
  /**
   * Input tokens the provider reported, summed off every live response's own usage frame - the
   * lead steps, the compaction summariser, a vision handoff, a delegated specialist's steps, all
   * of them - rather than off the loop's cost events, which only a lead step and the closing
   * handoff write. Zero offline: nothing reports.
   */
  readonly providerInputTokens: number;
  /** Of those, the tokens the provider served from its prompt cache, where it said. */
  readonly providerCachedTokens: number;
  /** Output tokens the provider reported, summed off the same responses. */
  readonly providerOutputTokens: number;
  /**
   * The loop's own events, whole and in order, payloads already decrypted. Here so a bench run can
   * persist the transcript per task; nothing in `evals/report.ts` reads it.
   */
  readonly events: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly payload: unknown;
  }>;
  readonly fallbackPlan: boolean;
  readonly untrusted: boolean;
  readonly replies: number;
  /** Every tool that threw rather than returning, by name, in the order they failed. */
  readonly failedTools: readonly string[];
  /**
   * The same failures with their reason attached: the error code and the message the model was
   * handed back.
   *
   * `failedTools` says a call threw and nothing else, which is enough to tell a fixture that meant
   * to fail from one that did not, and not enough to tell one failure from another. Every
   * `file_patch` in this suite threw `patch_invalid` - "Every patch requires a path and a non-empty
   * edit" - for the whole life of the line-addressed editor, and the two rows carrying them were
   * written about `patch_conflict`, a refusal from four hundred lines further on that they never
   * reached. Nothing here could see the difference.
   */
  readonly toolFailures: ReadonlyArray<{
    readonly tool: string;
    readonly code: string;
    readonly message: string;
  }>;
  /** Every warning the turn raised, in order, by summary. */
  readonly warnings: readonly string[];
  /**
   * Runner routes this fixture reached that the stub does not model, de-duplicated.
   *
   * Never a fixture's business to declare: any entry here means some number in this row was
   * produced by a production mechanism reading a field off a 404, which is a measurement of the
   * failure branch wearing the result's clothes.
   */
  readonly unstubbedRoutes: readonly string[];
  /**
   * Every runner route this fixture reached, modelled or not, de-duplicated, in first-asked order.
   *
   * Read by `evals/bench`, which unions it across the suite into the route set a benchmark shim
   * must implement. Not read by `report.ts` and not part of any committed baseline row: it is
   * evidence about the loop's demands on a workspace, not a number about this fixture.
   */
  readonly observedRoutes: readonly string[];
  /** Anything that escaped the loop, which is a fixture that ran off its own script. */
  readonly error: string | null;
}

/* -------------------------------------------------------------------------------- the run itself */

const workspace: WorkspaceRecord = {
  id: workspaceId,
  userId,
  name: 'Study',
  status: 'running',
  storageBytes: 1_000,
  storageLimitBytes: 1_000_000,
  imageRevision: 'r1',
  region: 'self-hosted',
  keyProtection: 'hosted',
  securityMode: 'balanced',
  runnerRef: null,
  computeMeteredAt: null,
  wrappedKey: wrapDataKey(dataKey, masterKey, workspaceId),
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
};

const release: ModelRelease = {
  id: 'model-1',
  providerModelId: 'vendor/model-1',
  displayName: 'Model One',
  provider: 'custom',
  revision: 'r1',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'apache-2.0',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools', 'reasoning'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.8,
  measuredLatencyMs: 100,
  updatedAt: '2026-07-01T00:00:00.000Z'
};

/**
 * A second row in the registry: one that can look at a picture, and one that is priced.
 *
 * Until this existed the eval release list was a single text-only model, so `routeImageObservation`
 * could only ever reach its "no eligible vision specialist" branch. That is why `vision_routed` has
 * sat on the holds table reading *never fired* for three waves - not because the routing was
 * broken, but because no fixture could reach it: the suite had nothing to route to. It is also why
 * the price ceiling on that route - the fifth ranking site, and the only one that picks a model
 * while the owner is asleep - had exactly one unit assertion holding it up, whose sibling stays
 * green with the enforcement switched off.
 *
 * Priced deliberately high. The ceiling fixtures set a limit under this and assert the refusal;
 * the routing fixture sets none and asserts the handoff. Two fixtures, one row, and the branch that
 * spends the owner's money without asking has a negative control at last.
 */
const visionRelease: ModelRelease = {
  ...release,
  id: 'model-vision',
  providerModelId: 'vendor/model-vision',
  displayName: 'Model Vision',
  modalities: ['text', 'image'],
  capabilities: ['chat', 'tools', 'reasoning', 'vision'],
  inputUsdPerMillionTokens: 30,
  outputUsdPerMillionTokens: 60,
  measuredQuality: 0.9
};

const modelFor = (contextTokens?: number, live?: LiveProvider): ModelRelease => {
  const shaped = contextTokens === undefined ? release : { ...release, contextTokens };
  // `provider` is what the gateway calls itself in its own errors, and `providerModelId` is what
  // goes on the wire. Left alone the pair says `custom` / `vendor/model-1`, which is correct for a
  // rig that reaches no provider and is a wrong request to one that does.
  return live === undefined
    ? shaped
    : {
        ...shaped,
        provider: live.provider === 'openrouter' ? 'openrouter' : 'custom',
        providerModelId: live.providerModelId,
        contextTokens: contextTokens ?? live.contextTokens
      };
};

const taskFor = (
  prompt: string,
  maxComputeCredits: number,
  securityMode: 'review' | 'balanced' | 'autonomous' = 'balanced'
): TaskRecord => ({
  id: taskId,
  userId,
  workspaceId,
  parentTaskId: null,
  branchedFromEventId: null,
  forkKind: null,
  scheduleId: null,
  rewindScope: null,
  restoredCheckpointId: null,
  titleCiphertext: null,
  legacyTitle: null,
  titleSource: 'prompt',
  pinned: false,
  archivedAt: null,
  status: 'running',
  modelId: release.id,
  privacyRoute: 'provider_zdr',
  securityMode,
  maxComputeCredits,
  actualComputeCredits: 0,
  maxSpendUsd: null,
  spentUsd: 0,
  queuedMessageCount: 0,
  promptCiphertext: encryptJson({ prompt }, dataKey, `task-prompt:${taskId}`),
  agentStateCiphertext: null,
  leaseOwner: WORKER_ID,
  leaseExpiresAt: '2026-07-01T00:02:00.000Z',
  attempt: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
});

/**
 * A stable identifier of the shape the store demands.
 *
 * `mem.pack.item_ids` is a `uuid[]` and `recallMemoryCandidates` drops any exclusion that is not a
 * UUID, so a pool keyed on `memory-1` would be stored and then quietly fail to be excluded from a
 * later recall. Derived from the position so the same fixture always produces the same pack bytes,
 * which is the whole point of the pack being frozen.
 */
const fixtureUuid = (prefix: number, index: number): string =>
  `${String(prefix).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;

/**
 * The tiered store's read path, modelled as far as this side can model it and no further.
 *
 * What it reproduces exactly, because every one of these is a rule the callers depend on and a
 * rule a stub can get wrong silently:
 *
 * - the sealing. Each row is sealed with the associated data its own tier uses, so a row that
 *   arrives at `openMemoryCandidate` for the wrong tier is dropped exactly as the real one is.
 * - the admissibility predicate at the anchor. `asOf` is what `valid_from`/`valid_to` are compared
 *   against, and it is not the same parameter as `now`: a belief whose validity ended before the
 *   task started is a past belief and may not be ranked into the block at the top of the window as
 *   a current fact. That clause was NULL on every pack ever built until this wave.
 * - `status`, and `includeSuperseded` being the only thing that admits a superseded row.
 * - `kinds`, `excludeIds`, `maxItems`, and the token budget, taken in order so the budget cuts the
 *   tail of the ranking rather than a random subset of it.
 * - `order`: `stable` is (kind, id) so the same rows always render to the same bytes, which is what
 *   the prompt cache needs; `relevance` is the fixture's stated order.
 *
 * What it does NOT reproduce, stated here so nobody reads a green fixture as a statement about it:
 * the fused score. Four keyed channels are fused inside PostgreSQL over tokens hashed by a function
 * `packages/core` does not export, and the plan that arrives here carries only the hashes. A
 * fixture asserting about which memories were recalled is asserting about the order it declared.
 * The ranking itself is measured where it can be - `packages/data`'s own memory suite, against the
 * real statements.
 */
const recallFrom = (
  pool: readonly FixtureMemoryItem[],
  input: RecallMemoryInput,
  workspaceId: string,
  createdAt: string,
  dataKey: Uint8Array
): MemoryCandidateRecord[] => {
  const asOf = input.asOf === undefined || input.asOf === null ? null : new Date(input.asOf);
  const excluded = new Set(input.excludeIds ?? []);
  const kinds = input.kinds ? new Set(input.kinds) : null;
  const admissible = pool
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      const id = fixtureUuid(1, index);
      if (excluded.has(id)) return false;
      const kind = item.kind ?? 'fact';
      if (kinds && !kinds.has(kind)) return false;
      const status = item.status ?? 'active';
      if (status === 'superseded') return input.includeSuperseded === true;
      if (status !== 'active') return false;
      if (asOf) {
        const from = new Date(item.validFrom ?? item.observedAt ?? createdAt);
        if (from > asOf) return false;
        // The half that was NULL for the life of the product: a belief whose validity has ended is
        // not a current fact, however well it scores.
        if (item.validTo && new Date(item.validTo) <= asOf) return false;
      }
      return true;
    });
  const ranked =
    input.order === 'relevance'
      ? [...admissible].sort(
          (left, right) =>
            (right.item.score ?? 0) - (left.item.score ?? 0) || left.index - right.index
        )
      : [...admissible].sort(
          (left, right) =>
            (left.item.kind ?? 'fact').localeCompare(right.item.kind ?? 'fact') ||
            fixtureUuid(1, left.index).localeCompare(fixtureUuid(1, right.index))
        );
  const budget = Math.trunc(input.budgetTokens ?? MEMORY_PACK_BUDGET_TOKENS);
  const maxItems = Math.trunc(input.maxItems ?? 60);
  const rows: MemoryCandidateRecord[] = [];
  let spent = 0;
  for (const { item, index } of ranked) {
    if (rows.length >= maxItems) break;
    const tokensEst =
      item.tokensEst ?? Math.ceil((item.body.length + (item.title?.length ?? 0)) / 4);
    if (spent + tokensEst > budget) continue;
    spent += tokensEst;
    const kind = item.kind ?? 'fact';
    const layer = kind === 'source' ? 'source' : 'item';
    rows.push({
      id: fixtureUuid(1, index),
      layer,
      kind,
      trust: item.trust ?? 'stated',
      status: item.status ?? 'active',
      observedAt: item.observedAt ?? createdAt,
      validFrom: item.validFrom ?? item.observedAt ?? createdAt,
      validTo: item.validTo ?? null,
      subjectKey: null,
      predicate: null,
      tokensEst,
      score: item.score ?? 0,
      documentCiphertext: encryptJson(
        {
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.tags === undefined ? {} : { tags: [...item.tags] }),
          body: item.body
        },
        dataKey,
        layer === 'source' ? memorySourceAad(workspaceId) : memoryItemAad(workspaceId)
      )
    });
  }
  return rows;
};

/**
 * What a fixture that runs no turn reports.
 *
 * Every number is the honest zero rather than a placeholder: nothing was called, nothing was
 * prepared, no catalogue was offered. The findings arrive as warnings, which is the one channel
 * `check()` already compares exactly and defaults to empty.
 */
const schemaOutcome = (findings: readonly string[]): RunOutcome => ({
  modelCalls: 0,
  delegatedCalls: 0,
  promptTokens: 0,
  catalogueTokens: 0,
  residentCatalogueBytes: 0,
  windowTokens: 0,
  peakPromptTokens: 0,
  tools: [],
  proposed: [],
  // A schema fixture runs no loop, so it displayed nothing and landed nothing. The empty ledger is
  // the truth about it, and `linesPerEdit` reads it as "no landed edit" rather than as a zero.
  readLedger: {
    reads: [],
    edits: [],
    displayedLines: 0,
    echoLines: 0,
    landedEdits: 0,
    claimMismatches: 0
  },
  commandsRun: 0,
  mediaGenerated: 0,
  mediaModels: [],
  cachePrefix: 0,
  leadInputCharacters: 0,
  leadPrefixCharacters: 0,
  freshLeadCharacters: 0,
  delegatedCachePrefix: 0,
  compactions: 0,
  briefSections: 0,
  modelWrittenBriefs: 0,
  skillsNamedInBrief: [],
  ownerMessageIntact: false,
  toolResultFloor: 0,
  cacheBreakpoints: 0,
  compactionTriggers: [],
  softPassWindows: 0,
  anchorHeld: true,
  finalCatalogue: [],
  finalCatalogueUnchanged: true,
  catalogueStableThroughout: true,
  outputTokens: 0,
  creditsSpent: 0,
  checkoutPathLeaks: 0,
  memoryCitations: 0,
  // Never halted, which is not the same statement as halted and then quiet; see the field.
  modelCallsAfterSpendHalt: -1,
  spendPaused: false,
  spendNotices: [],
  holds: [],
  pushback: [],
  status: 'completed',
  verification: 'none',
  askedOwner: false,
  approvalsRaised: 0,
  approvalsAutoAnswered: 0,
  autoApproveCapReached: false,
  providerCostUsd: 0,
  providerCalls: 0,
  providerUsageFallbacks: 0,
  providerInputTokens: 0,
  providerCachedTokens: 0,
  providerOutputTokens: 0,
  events: [],
  fallbackPlan: false,
  untrusted: false,
  replies: 0,
  failedTools: [],
  toolFailures: [],
  warnings: [...findings],
  unstubbedRoutes: [],
  observedRoutes: [],
  filesAfter: {},
  error: null
});

export const runFixture = async (fixture: Fixture): Promise<RunOutcome> => {
  /*
   * THE SEEN-LINE RECORD IS PER-TASK AND EVERY FIXTURE IN THIS RIG IS THE SAME TASK.
   *
   * `apps/worker/src/edit/snapshots.ts` keys what a read displayed on `${taskId} ${path}`, holds it
   * for an hour, and this file has exactly one `taskId` - a module constant shared by all seventy
   * rows. The suite runs them sequentially in one process, so without this line a read in one
   * fixture vouches for line numbers in the next one, and `recordWrite` leaves the text of a file
   * one fixture rewrote standing as evidence about a different fixture's pristine copy of it.
   *
   * That is not a hypothetical. Measured, by removing this line and running the whole suite:
   * `small-hunks-that-miss-in-different-places-are-a-search` lands FIVE edits instead of two. Its
   * three opening patches exist to miss, and they stop missing, because
   * `files-code-declares-acceptance-first` read `workspace/importer.py` earlier in the same run and
   * left a snapshot of it on record under the same task id. The file it leaves behind is
   * `"def load(rows):\n    return [row for row in rows if any(row)]\n    return [row for row in
   * rows if row]"` - a corrupted importer, produced by three edits the product refuses and the rig
   * allowed. Run on its own the same fixture is green, so the row's verdict depended on which other
   * rows had run before it.
   *
   * Cleared before the run rather than after it, so a fixture run on its own and the same fixture
   * run inside the suite start from the identical empty record.
   */
  forgetReads();
  if (fixture.schema) return schemaOutcome(fixture.schema());
  const model = modelFor(fixture.contextTokens, fixture.live);
  /*
   * The task record the worker is handed, and - under `autoApprove` - the record it is handed AGAIN.
   * A `let` for that reason alone: the stub's `updateTask` reassigns it so that the state the loop
   * saved when it parked is the state `claimTurn` decrypts on the way back in, exactly as the
   * production store hands the next claim the row the last write left. Every offline fixture
   * leaves `autoApprove` off, and for those `updateTask` never touches this binding.
   */
  let task = taskFor(fixture.request, fixture.maxCredits ?? 50, fixture.securityMode ?? 'balanced');
  const events: Array<{ kind: string; summary: string; payload: unknown }> = [];
  // Direction-aware reads see the owner's initial message and the same sealed rows writers append.
  const storedEvents: TaskEventRecord[] = [
    {
      id: fixtureUuid(4, 1),
      taskId,
      sequence: 1,
      kind: 'user_message',
      summary: 'Owner direction',
      payloadCiphertext: encryptJson(
        { markdown: fixture.request },
        dataKey,
        `task-event:${taskId}`
      ),
      createdAt: task.createdAt
    }
  ];
  const approvals: string[] = [];
  /**
   * The approvals table, as far as the resume needs it: the row `parkTaskForApproval` wrote, with
   * the status the auto-approver flips. `getApproval` answers from here unconditionally - a pending
   * row is what production returns for a card nobody has answered, so answering it moves nothing
   * for a fixture that parks.
   */
  const approvalRows = new Map<
    string,
    {
      id: string;
      previewHash: unknown;
      status: 'pending' | 'approved';
      expiresAt: unknown;
      action: string;
    }
  >();
  /** Every usage row the loop recorded, for the cost the provider itself put on each call. */
  const usageRows: Array<{ kind: string; costUsd: number; quantity: number }> = [];
  /**
   * Every live response in order - whether the provider answered it, and the usage frame read off
   * a copy of its body once that copy has been read to its end. See the live branch below.
   */
  const liveResponses: Array<{ ok: boolean; frame: ProviderUsageFrame | null }> = [];
  const liveUsageReads: Promise<void>[] = [];
  let finalStatus = 'running';
  /** Whether the turn has already taken the owner's queued correction; see `Fixture.correction`. */
  let correctionTaken = false;
  let plan: Record<string, unknown> | null = null;
  let fallbackPlan = false;
  /** The one `mem.pack` row this task ever has, written once and read back from then on. */
  let memoryPack: Record<string, unknown> | null = null;
  /** Every `recordMemoryUse` this turn made, and whether it claimed the item was cited. */
  const memoryUses: Array<{ items: number; cited: boolean }> = [];
  /** Window occurrences already alerted on, so the ledger de-duplicates as the real one does. */
  const spendAlerts = new Set<string>();
  /**
   * The provider calls already answered when the spending guard first said no.
   *
   * Null until it does. The guard runs at the top of a step, before that step's request, so this is
   * also the count the turn must end on: anything after it is a request sent past a ceiling.
   */
  let spendHaltedAfter: number | null = null;
  /** Whether any write to the task carried `spendPausedAt`, which is what a spend pause is. */
  let spendPaused = false;
  /*
   * What this workspace remembers, sealed once, the way the writers seal it.
   *
   * Built here rather than inside the reads so that a run asks the same rows the same questions
   * every time: `listWorkspaceMemories` is called once per turn and the pack is ranked once per
   * task, and two calls that produced two different envelopes would make the frozen block anything
   * but frozen - which is the defect these fixtures exist to catch, arriving from the rig.
   */
  const knowledgeRows: WorkspaceMemoryRecord[] = (fixture.memory?.knowledge ?? []).map(
    (entry, index) => ({
      id: fixtureUuid(2, index),
      userId,
      workspaceId,
      target: entry.target ?? 'workspace',
      // Rig rows are all workspace-scoped and sealed under the workspace key, which is what
      // `keyScope: 'workspace'` says. A fixture that claimed the owner scope would have to be
      // sealed under the owner key too, and a rig that got that pair wrong would be measuring a
      // row the product could never produce.
      keyScope: 'workspace' as const,
      contentCiphertext: encryptJson(
        {
          content: entry.content,
          ...(entry.validUntil === undefined ? {} : { validUntil: entry.validUntil }),
          source: 'owner' as const
        },
        dataKey,
        `workspace-memory:${workspaceId}`
      ),
      // Mirrored in the clear beside the document, as the real column is: retention finds an
      // expired row without the workspace key, and the loop reads the one inside the envelope.
      validUntil: entry.validUntil ?? null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: entry.updatedAt ?? '2026-07-01T00:00:00.000Z'
    })
  );
  const skillRows: WorkspaceSkillRecord[] = (fixture.skills ?? []).map((skill, index) => ({
    id: fixtureUuid(3, index),
    userId,
    workspaceId,
    nameHash: skill.name,
    documentCiphertext: encryptJson(
      {
        name: skill.name,
        description: skill.description,
        body: skill.body ?? `# ${skill.name}\n\n${skill.description}\n`
      },
      dataKey,
      `workspace-skill:${workspaceId}`
    ),
    version: 1,
    enabled: skill.enabled ?? true,
    status: skill.status ?? 'active',
    pinned: skill.pinned ?? false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }));

  const store = {
    getUserById: async () => ({ preferences: {} }),
    getProjectModelPreferences: async () => ({
      projectTaskId: taskId,
      workspaceId,
      wrappedKey: workspace.wrappedKey,
      revision: 0,
      choicesCiphertext: null
    }),
    getWorkspaceById: async () => workspace,
    listConnectors: async () => [],
    listModels: async () => (fixture.visionSpecialist ? [model, visionRelease] : [model]),
    getManagedProviderCredential: async () => null,
    // No saved connection: the fixture's provider comes from the environment, which is the shape a
    // self-hosted box configured through `control.env` has.
    listManagedProviderCredentials: async () => [],
    rerouteTaskModel: async () => false,
    recordModelThroughputCeiling: async () => undefined,
    modelThroughputCeiling: async () => null,
    listWorkspaceMemories: async () => knowledgeRows,
    /*
     * The owner's own standing words, which the window reads whole on every single turn.
     *
     * `null` is "this person has written nothing", which is what every fixture here is: no fixture
     * declares owner prose, and the window installs no message for an empty block, so this answer
     * moves not one prompt byte. That is the point of answering it rather than leaving it absent -
     * absent, it threw `deps.store.readOwnerBlock is not a function` on all 72 fixtures and the
     * window reported "What you have written about yourself could not be read for this task" on
     * every one of them, which is a warning about a broken store rather than about an empty one.
     *
     * What it does NOT model: a fixture cannot give itself an owner block. Doing so would need a
     * second key on this stub - the block is sealed under `userMemoryKey`, not the workspace data
     * key - and nothing here asks the question that would need.
     */
    readOwnerBlock: async () => null,
    // A no-op, and it has to be said why rather than left looking like the rest of them. The real
    // one is a sweep that marks a skill stale at thirty days unused and archived at ninety; every
    // row here is minted at the task's own creation instant with no use history, so there is
    // nothing for it to move. A fixture that wants a stale skill declares one.
    curateWorkspaceSkills: async () => undefined,
    listWorkspaceSkills: async () => skillRows,
    listMediaJobs: async () => [],
    getLatestTaskPlan: async () => plan,
    listTaskEvents: async (
      id: string,
      after = 0,
      selection?: { kind: TaskEventRecord['kind']; limit: number }
    ) => {
      const rows = storedEvents.filter(
        (row) =>
          row.taskId === id && row.sequence > after && (!selection || row.kind === selection.kind)
      );
      return selection
        ? rows.slice(-Math.max(1, Math.min(1_000, Math.trunc(selection.limit))))
        : rows;
    },
    createTaskPlan: async (input: Record<string, unknown>) => {
      // The boilerplate fallback is recognised structurally rather than by what it says: it is the
      // plan that appears when the model never asked for one. The loop writes it at the start of any
      // step past the second, or of any step after the turn has changed something, and from then on
      // it travels in every prompt - so "did this task acquire a plan nobody wrote?" is a question
      // about the model's calls, not about the plan's contents.
      if (!proposed.includes('set_plan')) fallbackPlan = true;
      const version = Number(plan?.version ?? 0);
      if (Number(input.expectedVersion) !== version) throw new Error('plan_version_conflict');
      plan = {
        id: 'plan',
        taskId,
        version: version + 1,
        parentVersion: version || null,
        branchName: asText(input.branchName) || 'Main',
        stepsCiphertext: input.stepsCiphertext,
        createdBy: input.createdBy ?? 'agent',
        createdAt: '2026-07-01T00:00:00.000Z'
      };
      return plan;
    },
    listTaskEventPage: async () => ({
      events: [],
      hasMore: false,
      oldestSequence: null,
      nextCursor: 0
    }),
    getTask: async () => task,
    taskClaim: async () => ({ status: task.status, leaseOwner: task.leaseOwner ?? null }),
    saveTaskQuestion: async (
      input: Parameters<DataStore['saveTaskQuestion']>[0]
    ): Promise<boolean> => {
      await store.updateTask({
        id: input.taskId,
        workerId: input.workerId,
        status: input.park ? 'awaiting_user' : 'running',
        agentStateCiphertext: input.agentStateCiphertext,
        actualComputeCredits: input.actualComputeCredits,
        clearLease: input.park
      });
      if (input.event)
        await store.appendTaskEvent({
          taskId: input.taskId,
          id: input.event.id,
          kind: 'question_asked',
          summary: 'Question',
          payloadCiphertext: input.event.payloadCiphertext
        });
      return true;
    },
    updateTask: async (input: Record<string, unknown>) => {
      if (typeof input.status === 'string') finalStatus = input.status;
      // The column that separates a pause the ceiling imposed from one the owner asked for. An
      // ordinary pause leaves it null on purpose, so `!= null` is the whole distinction and a
      // truthiness test on a Date would read the same either way.
      if (input.spendPausedAt !== undefined && input.spendPausedAt !== null) spendPaused = true;
      /*
       * Under the auto-approver only, the write lands on the record the next `run(task)` reads:
       * status, the saved trajectory and the lease, which is what `parkForApproval` writes and what
       * `claimTurn` and `taskClaim` read back. Gated on the fixture rather than done for every row
       * because the offline suite measures a task whose `taskClaim` never changes under it - a
       * spend pause writes `paused`, and a claim that reported it would stand the loop down where
       * the committed rows measure it carrying on - so the write stays a no-op there, as it always
       * was.
       */
      if (fixture.autoApprove === true)
        task = {
          ...task,
          ...(typeof input.status === 'string' ? { status: input.status } : {}),
          ...(input.agentStateCiphertext !== undefined
            ? {
                agentStateCiphertext:
                  input.agentStateCiphertext as TaskRecord['agentStateCiphertext']
              }
            : {}),
          ...(input.clearLease === true ? { leaseOwner: null, leaseExpiresAt: null } : {})
        };
      return task;
    },
    renewTaskLease: async () => true,
    appendTaskEvent: async (input: {
      kind: TaskEventRecord['kind'];
      payloadCiphertext: Parameters<typeof decryptJson>[0];
    }) => {
      const body = decryptJson<{ summary: string; payload: unknown }>(
        input.payloadCiphertext,
        dataKey
      );
      events.push({ kind: input.kind, summary: body.summary, payload: body.payload });
      const sequence = storedEvents.length + 1;
      const row: TaskEventRecord = {
        id: fixtureUuid(4, sequence),
        taskId,
        sequence,
        kind: input.kind,
        summary: body.summary,
        payloadCiphertext: input.payloadCiphertext,
        createdAt: task.createdAt
      };
      storedEvents.push(row);
      return row;
    },
    createAgentNotification: async (input: Record<string, unknown>) => ({
      id: 'notification',
      ...input
    }),
    parkTaskForApproval: async (input: {
      id: string;
      agentStateCiphertext: TaskRecord['agentStateCiphertext'];
      action?: unknown;
      previewHash?: unknown;
      expiresAt?: unknown;
    }) => {
      approvals.push(asText(input.action));
      const id = input.id;
      // The hash travels with the row because `turn/resume.ts` recomputes it over the call it is
      // about to run and refuses the call when the two differ. A stub that dropped it would make
      // every approved resume a refusal.
      approvalRows.set(id, {
        id,
        previewHash: input.previewHash,
        status: 'pending',
        expiresAt: input.expiresAt,
        action: asText(input.action)
      });
      finalStatus = 'awaiting_user';
      if (fixture.autoApprove === true)
        task = {
          ...task,
          status: 'awaiting_user',
          agentStateCiphertext: input.agentStateCiphertext,
          leaseOwner: null,
          leaseExpiresAt: null
        };
      return true;
    },
    getApproval: async (id: string) => approvalRows.get(id) ?? null,
    recordUsage: async (input: {
      kind?: unknown;
      costUsd?: unknown;
      quantity?: unknown;
      state?: unknown;
    }) => {
      if (input.state === 'reserved' || input.state === 'released') return;
      usageRows.push({
        kind: asText(input.kind),
        costUsd: typeof input.costUsd === 'number' ? input.costUsd : 0,
        quantity: typeof input.quantity === 'number' ? input.quantity : 0
      });
    },
    // A delivered file, so a job that makes something can be measured all the way to the owner
    // rather than stopping at the workspace.
    createArtifact: async (input: Record<string, unknown>) => ({
      id: `artifact-${asText(input.storageKey)}`,
      version: 1
    }),
    mediaSpendForTask: async () => 0,
    // The running spending cap, answering as `Fixture.spend` declares and as `allow` when nothing
    // does. Hardcoded to `allow` for the life of this rig, which is why two of its three arms had
    // no behavioural fixture at all; see `FixtureSpend`.
    spendGuard: async () => {
      const decision = spendDecisionAt(fixture.spend, answeredCalls);
      if (decision.outcome === 'deny' && spendHaltedAfter === null) spendHaltedAfter = modelCalls;
      return decision;
    },
    /*
     * The alert ledger the halt and the warning both write through, and the reason this line is
     * here rather than left out with the rest of billing.
     *
     * `#raiseSpendAlert` calls `this.store.claimSpendAlert(...)` and then attaches `.catch()`. A
     * method this stub does not answer is `undefined`, so the call throws a TypeError before there
     * is a promise for that catch to be attached to - the guard's whole deny arm would have escaped
     * the loop as a run-level error rather than reaching the pause it exists to perform. The `task`
     * window never gets this far (`#raiseSpendAlert` skips any window but daily and monthly), so a
     * fixture on the task ceiling would have passed over the hole.
     *
     * True once per window occurrence per level, which is what the real one returns: the primary
     * key is the occurrence, so a threshold crossed at step four is claimed once however many steps
     * follow it.
     */
    claimSpendAlert: async (input: { windowName: string; level: string }) => {
      const occurrence = `${input.windowName}:${input.level}`;
      if (spendAlerts.has(occurrence)) return false;
      spendAlerts.add(occurrence);
      return true;
    },
    effectiveSpendLimits: async () => ({
      timeZone: 'Europe/London',
      ...(fixture.priceCeiling ?? {})
    }),
    setWorkspaceStorage: async () => undefined,
    transitionUsage: async () => undefined,
    // The owner's correction, waiting, and gone once the turn has taken it. Absent by default: a
    // fixture that has not declared one has an empty queue, which is what every other row here is.
    getNextQueuedTaskMessage: async () =>
      // Not before the turn has started. A message already waiting when the task is leased is an
      // ordinary opening prompt; what this models is the owner reading a reply and typing "no, not
      // that" while the work is running, which is the only shape `drainCorrection` is written for.
      fixture.correction === undefined || correctionTaken || answeredCalls === 0
        ? null
        : {
            id: 'queued-1',
            taskId,
            interrupt: true,
            modelId: release.id,
            privacyRoute: 'provider_zdr',
            maxComputeCredits: 10,
            maxSpendUsd: null,
            reservationKey: 'queued-1',
            promptCiphertext: encryptJson(
              { prompt: fixture.correction },
              dataKey,
              `task-message:${taskId}`
            )
          },
    consumeQueuedTaskMessageInTurn: async () => {
      correctionTaken = true;
      return true;
    },
    createMemoryItem: async () => ({ id: 'item' }),
    createMemorySource: async () => ({ id: 'source' }),
    attachMemoryEvidence: async () => undefined,
    /*
     * The second provenance edge, which cites the tool calls a `finish` named.
     *
     * Missing from this stub, and it threw `input.store.attachMemoryCitedCalls is not a function`
     * on every fixture whose completion cited a call - 49 of the 72 - where the loop swallowed it
     * into "This turn was not recorded in memory, so it will not be recalled later" and carried
     * on. It is the same shape as `recallMemoryCandidates` below and as the `/machine` route
     * above, three occurrences of one defect: a production surface this stub does not answer looks
     * exactly like a product that degrades gracefully, because the loop is deliberately written to
     * survive a store it cannot write to.
     *
     * Nothing is stored, and the count returned is what the real one returns for the same call: a
     * row per cited call, all of them new. No fixture reads a citation back - `listMemoryCitedCalls`
     * is the reach's reader and belongs to `evals/reach` - so a store here would be state nothing
     * asks about.
     */
    attachMemoryCitedCalls: async (_itemId: string, calls: readonly unknown[]) => calls.length,
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    getMemoryPack: async () => memoryPack,
    // The tiered store's read path, which the loop calls once at the start of every run to build
    // the frozen memory pack. Absent from this stub entirely, `buildTaskMemoryPack` threw
    // `input.store.recallMemoryCandidates is not a function` on all forty-nine fixtures; the loop
    // is written to survive a store it cannot read, so it swallowed the throw into a warning and
    // carried on - and every fixture here measured a turn that starts with no memory pack at all,
    // which is not the turn the product ships. Four documented, cache-destroying regressions could
    // have been reverted one at a time without a single row of this baseline moving.
    //
    // An empty workspace recalls nothing, which is what every fixture without a `memory` block is:
    // the pack renders to no entries, nothing is injected, and no prompt byte moves. A fixture that
    // gives itself a pool gets `recallFrom` above, which models the predicate, the budget and the
    // ordering faithfully and says plainly which channel it does not model.
    recallMemoryCandidates: async (input: RecallMemoryInput) =>
      recallFrom(fixture.memory?.recall ?? [], input, workspaceId, task.createdAt, dataKey),
    // First writer wins, as the real store does: the row is written once and read back on every
    // later turn, which is what keeps a resumed task emitting the bytes the provider already
    // cached rather than re-ranking against a newer clock.
    saveMemoryPack: async (input: {
      taskId: string;
      workspaceId: string;
      bodyCiphertext: unknown;
      sha256: string;
      itemIds: readonly string[];
      tokensEst: number;
      briefVersion?: string | null;
    }) => {
      memoryPack ??= {
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        briefVersion: input.briefVersion ?? null,
        bodyCiphertext: input.bodyCiphertext,
        sha256: input.sha256,
        itemIds: [...input.itemIds],
        tokensEst: input.tokensEst,
        createdAt: '2026-07-01T00:00:00.000Z'
      };
      return memoryPack;
    },
    // The other half of the write path: the acceptance checks this turn watched fail, filed as
    // procedures so the next turn does not rediscover them, and the ones it watched pass, which
    // retire the dead ends they contradict. Missing from this stub as well, it threw at the end of
    // every turn that ran a check and was swallowed into "This turn was not recorded in memory" -
    // which also meant the episode written one line earlier was the only part of the write path any
    // fixture exercised. Nothing is stored here, so nothing can be retired.
    recordMemoryDeadEnds: async (input: { failed?: readonly { id?: string }[] }) => ({
      recorded: (input.failed ?? []).map((item) => asText(item.id)),
      retired: []
    }),
    /*
     * What the turn told the store about the items it was handed, and the one field of it nobody
     * writes.
     *
     * `mem.item.cited_count` is a term of the salience formula - `0.20 *` the standardised citation
     * count, in `packages/data/src/store/memory.ts` - and `recordMemoryUse` is the only writer of
     * it, behind `cited`. Both production callers are in `apps/worker/src/memory-runtime.ts` and
     * neither passes it: the recall path deliberately records `outcome: 'unknown'` at injection
     * time, and `recordMemoryPackOutcome` grades the pack at verification with no citation of any
     * kind. So the column is 0 for every item in every workspace that has ever run, a fifth of the
     * salience score is a constant, and nothing anywhere went red about it.
     *
     * Counted here so that a fixture can say what it expects and be wrong out loud. This is the
     * observation, not the repair - the writer belongs to whoever owns `memory-runtime.ts`.
     */
    recordMemoryUse: async (input: { itemIds?: readonly string[]; cited?: boolean }) => {
      memoryUses.push({ items: input.itemIds?.length ?? 0, cited: input.cited === true });
      return 0;
    },
    recordWorkspaceCheckpoint: async (input: Record<string, unknown>) => input,
    deleteWorkspaceCheckpoints: async () => 0,
    completeTaskIfNoQueued: async () => {
      finalStatus = 'completed';
      return true;
    },
    consolidateMemory: async () => undefined
  } as unknown as DataStore;

  let modelCalls = 0;
  /** Of those, the ones the provider actually answered; see the failure branch below. */
  let answeredCalls = 0;
  /*
   * What every answered request cost, counted where the bytes are rather than where the loop's
   * estimate is.
   *
   * This rig priced a run for its whole life from `context.estimatedInputTokens`, which is the
   * context layer's estimate of the MESSAGES. `body.tools` is not in it, and on this athanor the
   * catalogue is about 12,300 tokens of every single request - so the largest cost term in the
   * product was invisible to the instrument that exists to notice when a cost term moves, and
   * deleting the catalogue outright moved the headline column by 0.0%. Every efficiency claim
   * argued from that column, including the ones already made, was unfalsifiable.
   *
   * Counted here, at the fetch, for three reasons the cost event cannot match. It sees the whole
   * body the way a provider is paid for it - the envelope, the role keys, the serialised tool calls
   * and the catalogue - which is what `promptBytes` above already said out loud two thousand lines
   * before anything used it for this. It sees every billed request, including the closing handoff,
   * whose cost event carries no window block at all and which therefore contributed nought to the
   * old sum for the life of the suite. And it cannot be fooled by a change that moves work between
   * the estimate and the wire, because there is only one side of it left.
   *
   * The loop's own estimate is kept, under `windowTokens`, rather than thrown away: the gap between
   * the two IS the envelope plus the catalogue, and a wave that claims to have cut the catalogue
   * should be able to show that gap closing while the estimate stands still.
   */
  const wirePromptTokens: number[] = [];
  /** Of those bytes, the ones that were tool schema. The term this wave is trying to move. */
  const wireCatalogueTokens: number[] = [];
  // Only the last request is kept, and the previous one only as the bytes the next is compared
  // against. A forty-step fixture sends forty windows of up to a megabyte each, and holding them
  // all measures this process's heap rather than the loop.
  let steps = 0;
  // The last request that was a step of the turn, which is not simply the last request: a
  // compaction and a specialist both send one afterwards, and neither is the window the turn ended
  // in nor the catalogue it was offered.
  let lastAgentRequest: Record<string, unknown> = {};
  let previousBytes = '';
  /**
   * Where a trajectory is written, read once at the top of the run.
   *
   * Read here rather than at the end so the recording below is switched by the same value the write
   * is: a variable read twice out of the environment is two decisions that can disagree, and the
   * disagreement here would be a run that paid for the record and then did not write it.
   */
  const dumpDirectory = process.env.EVAL_DUMP_WINDOW;
  /** Every provider request of this run, in order, kept only when the trajectory was asked for. */
  const recordedRequests: Array<{
    call: number;
    kind: 'step' | 'compaction' | 'vision' | 'specialist';
    model: string;
    catalogue: string[];
    messages: Array<{ role: string; content: string }>;
  }> = [];
  /**
   * The previous step's messages, one serialised string each, and how many leading system messages
   * it opened with. Only the previous one is kept, for the same reason `previousBytes` is: the
   * question is what moved between two consecutive requests, and forty windows of a megabyte would
   * measure this process's heap.
   */
  let previousMessages: string[] = [];
  let previousPreamble = 0;
  let anchorHeld = true;
  let softPassWindows = 0;
  // The catalogue of the last two steps, as sent. Only the two, for the same reason the bytes above
  // are only the previous request's: what a swap costs is paid on the step it happens.
  let lastCatalogue = '';
  let previousCatalogue = '';
  const prefixShares: number[] = [];
  let leadInputCharacters = 0;
  let leadPrefixCharacters = 0;
  const delegatedPrefixShares: number[] = [];
  let previousDelegatedBytes = '';
  const everyMessage = new Set<string>();
  const proposed: string[] = [];
  /** Of the calls above, the ones a delegated specialist spent rather than the turn itself. */
  let delegatedCalls = 0;
  const openedSkills = new Set<string>();
  const execState: RunnerState = {
    execs: 0,
    written: new Map(),
    media: 0,
    mediaModels: [],
    unstubbed: [],
    observed: []
  };
  /** Requests that carried this machine's checkout path; see `CHECKOUT_ROOT`. */
  let checkoutPathLeaks = 0;
  /** Whether every step so far was offered the identical catalogue, not merely the last two. */
  let catalogueStableThroughout = true;
  /** Provider statuses still to be handed out, in order; see `RunnerStub.providerFailures`. */
  const providerFailures = [...(fixture.runner?.providerFailures ?? [])];
  /*
   * The fixture's clock, installed over the real one for the duration of this run.
   *
   * `offset` only ever grows, and only where the fixture said it should - as a frame goes out, or
   * as a call is made. Everything else on this side reads the same clock the loop does, so a turn
   * whose fixture declares no clock is measured against the wall exactly as before and no committed
   * row can move because this exists.
   */
  const realNow = Date.now;
  let clockOffset = 0;
  const advanceClock = (ms: number): void => {
    clockOffset += ms;
  };
  if (fixture.clock) {
    Date.now = () => realNow.call(Date) + clockOffset;
    advanceClockBy = advanceClock;
  }

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    // Asked of every request to either host, because the question is what left this process, not
    // what the window happened to be assembled from.
    if (typeof init?.body === 'string' && init.body.includes(CHECKOUT_ROOT)) checkoutPathLeaks += 1;
    /*
     * A REAL provider, when the fixture named one, forwarded to the wire and counted as the model
     * call it is. @see `Fixture.live`.
     *
     * It has to be its own branch rather than a case of the one below, because the two answers are
     * opposite: the scripted branch SYNTHESISES a response from `fixture.model`, and this one must
     * not touch the request at all. And it has to sit above the workspace and runner branches,
     * because the last of those answers anything it does not recognise with a 404 - which is what
     * a live run got before this existed: `Unstubbed runner route:
     * https://openrouter.ai/api/v1/chat/completions`, a request the harness refused on the model's
     * behalf while reporting it as the box's fault.
     *
     * Counted here for the same reason the scripted branch counts: `steps` is read off `modelCalls`
     * and a live run that counted none would report a turn that never thought.
     */
    if (fixture.live !== undefined && url.startsWith(fixture.live.baseUrl)) {
      modelCalls += 1;
      answeredCalls += 1;
      // The catalogue is priced off the request, which this side has whole. The prompt is NOT:
      // it is left to the provider's own count, read off the RESPONSE below, because the wire
      // estimate `promptTokensFor` makes is this rig's arithmetic and a live row's input column
      // should be the number the bill was computed from.
      wireCatalogueTokens.push(Math.ceil(catalogueBytesOf(bodyOf(init)) / 4));
      const response = await original(input, init);
      /*
       * The provider's usage frame, read off a copy of every response that came back under this
       * prefix - the same set of calls `modelCalls` just counted.
       *
       * It used to be read off the loop's `cost` events, and those are written for a lead step
       * and for the closing handoff only: a compaction's summariser, a vision handoff, a delegated
       * specialist's steps and a provider search each record a usage row and write no cost event.
       * So a live turn that compacted twice counted 52 calls, priced 52 usage rows, and summed the
       * input tokens of 50 - three columns of one row describing three different sets of calls.
       * The response is the one place every call passes through, and the frame on it is the
       * number the bill was computed from. `clone()` tees the body, so the gateway reads its
       * stream untouched while this side reads the copy to its end; a stream that was cut never
       * carries a frame and reads as nothing, which is also what the gateway sees.
       */
      const slot: { ok: boolean; frame: ProviderUsageFrame | null } = {
        ok: response.ok,
        frame: null
      };
      liveResponses.push(slot);
      liveUsageReads.push(
        response
          .clone()
          .text()
          .then((text) => {
            slot.frame = usageFrameOf(text);
          })
          .catch(() => undefined)
      );
      return response;
    }
    if (url.startsWith(PROVIDER_URL)) {
      const media = mediaResponse(fixture.runner ?? {}, execState, url, init);
      if (media) return media;
      const body = bodyOf(init);
      modelCalls += 1;
      advanceClock(fixture.clock?.msPerCall ?? 0);
      // Counted apart from `modelCalls`, and this is what the script reads: a request the provider
      // refused is a call the box made and not a call the model answered, so folding the two would
      // shift every scripted turn of a fixture about an outage by however many times the provider
      // said no - and the fixture would then be measuring a different script.
      answeredCalls += 1;
      // The provider being down, in the order the fixture declared. Answered before anything is
      // read off the body: a route that returned 503 returned no window, so counting this as a step
      // or comparing its prefix against the last one would price a request that never happened.
      const failure = providerFailures.shift();
      if (failure) {
        answeredCalls -= 1;
        // Counted, and deliberately: a retried request is a request the box made, and the whole
        // value of a fixture about a provider outage is that the extra calls appear in the
        // committed step count rather than being absorbed into a number that says the turn was
        // free. It never becomes a step of the turn, because it prepared no window.
        return new Response(
          JSON.stringify({ error: { message: `the provider answered ${failure}` } }),
          { status: failure, headers: { 'content-type': 'application/json' } }
        );
      }
      // Priced once, here, and only for a request the provider answered: the 503 above returned no
      // completion and no route bills one. Every other shape of call is counted - a step, a
      // compaction's summariser, a vision handoff, a specialist's own steps and the closing handoff
      // - because each of them is a request the owner is billed for.
      wirePromptTokens.push(promptTokensFor(body));
      wireCatalogueTokens.push(Math.ceil(catalogueBytesOf(body) / 4));
      // The summarising call a compaction makes carries no catalogue, and it is a fresh prompt with
      // no predecessor rather than the next step of one - so it is neither the window the turn was
      // working in nor a link in the chain a cache reads back along. What it costs is already in the
      // step count and the token total, which is where a one-off call belongs.
      const catalogue = (body.tools ?? []) as Array<{ function?: { name?: unknown } }>;
      // A vision handoff is the other tool-free request, and it has to be told from a compaction's
      // before either is scripted; see ScriptContext.vision.
      const vision = !catalogue.length && asText(body.model) !== model.providerModelId;
      const summarising = !catalogue.length && !vision;
      // A specialist's request carries a catalogue and no `finish`; see ScriptContext.delegated.
      const delegated =
        catalogue.length > 0 && !catalogue.some((tool) => asText(tool.function?.name) === 'finish');
      /*
       * The whole trajectory, request by request, when somebody has asked for it.
       *
       * Only under `EVAL_DUMP_WINDOW`, and the condition is load-bearing rather than tidiness: a
       * forty-step fixture sends forty windows of up to a megabyte each, and the reason this rig
       * keeps only the last one is that holding them all measures this process's heap instead of
       * the loop. Opting in leaves every committed number produced by the same code path it always
       * was, and pays the memory only on the run that wants the record.
       *
       * Every request, not only the steps. A compaction's summarising call, a vision handoff and a
       * specialist's own steps are all provider calls the owner is billed for and all of them shape
       * what the next step sees; a record that skipped them would explain a step count it could not
       * reproduce. Each is labelled with the same classification the counters above use, so the
       * dump and the numbers cannot disagree about what a call was.
       */
      if (dumpDirectory)
        recordedRequests.push({
          call: modelCalls,
          kind: summarising ? 'compaction' : vision ? 'vision' : delegated ? 'specialist' : 'step',
          model: asText(body.model),
          catalogue: catalogue.map((tool) => asText(tool.function?.name)),
          messages: ((body.messages ?? []) as Array<{ role?: unknown; content?: unknown }>).map(
            (message) => ({ role: asText(message.role), content: contentOf(message) })
          )
        });
      if (delegated) {
        delegatedCalls += 1;
        const bytes = promptBytes(body);
        if (previousDelegatedBytes)
          delegatedPrefixShares.push(commonPrefix(previousDelegatedBytes, bytes) / bytes.length);
        previousDelegatedBytes = bytes;
      }
      if (!summarising && !delegated && !vision) {
        steps += 1;
        lastAgentRequest = body;
        const bytes = promptBytes(body);
        const prefix = commonPrefix(previousBytes, bytes);
        leadInputCharacters += bytes.length;
        leadPrefixCharacters += prefix;
        if (previousBytes) prefixShares.push(prefix / bytes.length);
        previousBytes = bytes;
        previousCatalogue = lastCatalogue;
        lastCatalogue = JSON.stringify(body.tools ?? []);
        if (previousCatalogue !== '' && previousCatalogue !== lastCatalogue)
          catalogueStableThroughout = false;
        // Per message rather than per byte, because the anchor is placed at a message boundary.
        // Serialised whole - role, content and every block on it - so a message that keeps its text
        // and changes its cache marking still counts as having moved.
        const sent = ((body.messages ?? []) as unknown[]).map((message) => JSON.stringify(message));
        const preamble = ((body.messages ?? []) as Array<{ role?: unknown }>).findIndex(
          (message) => asText(message.role) !== 'system'
        );
        if (previousMessages.length) {
          let first = 0;
          while (first < sent.length && sent[first] === previousMessages[first]) first += 1;
          // Measured against the run the PREVIOUS request opened with: a message spliced into the
          // preamble makes this request's run one longer, and asking whether the change was inside
          // the new run would let the splice excuse itself.
          if (first < previousPreamble) anchorHeld = false;
        }
        previousMessages = sent;
        previousPreamble = preamble < 0 ? sent.length : preamble;
      }
      const messages = ((body.messages ?? []) as Array<{ content?: unknown }>).map(contentOf);
      // Counted on every provider call, not only on the turn's own steps: a specialist's window and
      // a summariser's transcript are prepared by the same layer and cross the same threshold.
      // `startsWith`, not `includes`, and the distinction is load-bearing: `trajectorySummary`
      // writes this same opening twice over - once as the soft-pass block, which is a message of
      // its own, and once as the deterministic summary a compaction falls back to, which is text
      // INSIDE the running brief. Matching anywhere in the content would count every step after a
      // fallback compaction as a soft pass and make the two mechanisms indistinguishable again.
      if (messages.some((content) => content.startsWith(SOFT_PASS_MARKER))) softPassWindows += 1;
      // Collected as the requests arrive, deduplicated in order: a hold pushes one message that
      // then travels in every later request, so a raw scan would count the same hold once per
      // remaining step.
      for (const content of messages) everyMessage.add(content);
      const turn = fixture.model({
        index: answeredCalls - 1,
        step: Math.max(0, steps - 1),
        lastMessage:
          [...messages].reverse().find((content) => !content.startsWith(RUNTIME_CONTEXT_MARKER)) ??
          '',
        messages,
        summarising,
        delegated,
        vision
      });
      // A specialist's calls are the specialist's, not the turn's. `tools`, `proposed` and
      // `finalCatalogue` are all statements about what this turn did, and folding a subordinate
      // model's proposals into them would make the lead's list depend on how many missions were
      // running and in what order three concurrent ones happened to answer. What a specialist
      // actually reached is measured where it lands instead: in `commandsRun`, in the media count,
      // and in whether the turn came out marked as having read untrusted content.
      if (!delegated) {
        for (const call of turn.calls ?? []) {
          proposed.push(call.name);
          // Which procedures this turn opened, so a compaction that drops one can be asked whether
          // it said so. Read off the call rather than off the result, because the claim is about
          // an instruction the model was given and is no longer holding.
          if (call.name === 'skill' && asText(call.args.action) === 'view') {
            const id = asText(call.args.id) || asText(call.args.name);
            if (id) openedSkills.add(id);
          }
        }
      }
      // What the request asked for, rather than what this stub finds convenient: the adapter sets
      // `stream` only when the caller gave it somewhere to put the deltas, and answering the other
      // shape with frames is a parse error the caller is written to survive quietly.
      // Only the generation the fixture marked. A clock that ran fast on every stream of the run
      // would cut the turn's own closing call too - the answer this fixture is waiting for arrives
      // in the second frame of the next request, and the deadline would take it before the tool
      // call landed. What is being measured is one generation, so one generation is what is timed.
      const advance = turn.silent ? (fixture.clock?.msPerFrame ?? 0) : 0;
      return body.stream === true
        ? new Response(
            streamOf(
              framesFor(turn, promptTokensFor(body)),
              init?.signal,
              advance,
              turn.silent === true
            ),
            {
              headers: { 'content-type': 'text/event-stream' }
            }
          )
        : json(completionBody(turn));
    }
    /*
     * A real workspace, when the fixture named one. See `Fixture.workspaceUrl`.
     *
     * Recorded before it is forwarded, for the same reason `runnerResponse` records before it
     * branches: the question is what the loop ASKED for. `execs` is counted here rather than left
     * to the stub, because `commandsRun` is read off it and a live run that counted none would
     * report a turn that ran no commands while the box was building.
     */
    if (fixture.workspaceUrl !== undefined && url.startsWith(fixture.workspaceUrl)) {
      execState.observed.push(routeName(url, init));
      if (url.includes('/exec') || url.includes('/processes/start')) execState.execs += 1;
      return await original(input, init);
    }
    return runnerResponse(fixture.runner ?? {}, execState, url, init);
  }) as typeof fetch;

  let error: string | null = null;
  /** Cards this harness answered approved on the fixture's behalf; see `Fixture.autoApprove`. */
  let approvalsAutoAnswered = 0;
  let autoApproveCapReached = false;
  /**
   * The worker, built once per entry and the same way on every entry: production claims a resumed
   * task with whatever worker polls it next, and that worker is constructed exactly as the first
   * one was. A local function rather than a hoisted instance so a re-entry cannot inherit state a
   * previous `run` left on the object.
   *
   * The one thing that differs between entries is the step ceiling, and only under the
   * auto-approver: see the re-entry loop below for why a re-entry is built with one step fewer.
   */
  const worker = (stepCeiling: number): AgentWorker =>
    new AgentWorker(
      store,
      {
        WORKER_ID,
        DATABASE_DRIVER: 'pglite',
        DATABASE_URL: 'postgres://localhost/athanor',
        PGLITE_PATH: ':memory:',
        DATA_MASTER_KEY: masterKey.toString('base64'),
        RUNNER_SHARED_SECRET: 'x'.repeat(48),
        WORKSPACE_RUNNER_URL: fixture.workspaceUrl ?? RUNNER_URL,
        PREVIEW_BASE_URL: 'http://preview.localhost:4400',
        OPENROUTER_BASE_URL: fixture.live?.baseUrl ?? PROVIDER_URL,
        AI_PROVIDER: fixture.live?.provider ?? 'openai-compatible',
        AI_BASE_URL: fixture.live?.baseUrl ?? PROVIDER_URL,
        AI_API_KEY: fixture.live?.apiKey ?? 'provider-key',
        AI_REQUIRE_ZDR: false,
        // Pinned so a search is answered by the workspace's own browser on every fixture. Which
        // host answers a search is a policy decision with its own tests; what these fixtures are
        // about is what the loop does with the rows, and leaving it to policy would make the
        // research fixtures cost a different number of provider calls when that policy moves.
        AI_FORCE_INHOUSE_WEB: true,
        ALLOW_INSECURE_PROVIDER_URLS: true,
        PUBLIC_APP_URL: 'http://localhost:5173',
        CONNECTOR_ALLOWED_HOST_SUFFIXES: '',
        WORKER_CONCURRENCY: 2,
        WORKER_POLL_MS: 1_000,
        TASK_MAX_STEPS: stepCeiling,
        // A turn that renews its own budget is a separate mechanism with its own bounds. Left off
        // so every step count below is the cost of one budget rather than of two.
        TASK_MAX_SELF_CONTINUATIONS: 0
        // The sustained ceiling is the same mechanism for a run declared long, and is off here for
        // the same reason: every step count below is the cost of one budget rather than of several.
      },
      masterKey,
      runnerSecret,
      undefined,
      ...(fixture.live ? [] : [fixtureMediaRouting])
    );
  const stepCeiling = fixture.maxSteps ?? 12;
  try {
    await worker(stepCeiling).run(task);
    /*
     * The owner's half of the production approval flow, played by the harness.
     *
     * In production: `parkForApproval` creates the card, saves the trajectory and writes the task
     * `awaiting_user` with its lease cleared, and `AgentWorker.run` returns. The owner approves;
     * the API marks the row approved and sets the task `queued`; a worker's poll claims it as
     * `running` under its own id; `run` decrypts the saved state and `resumeParkedTurn` finds the
     * approval, checks the argument hash, and executes the approved call before the loop goes on.
     *
     * Here every one of those happens, in that order, except the poll: the harness has no worker
     * loop to claim a `queued` task, so it performs the claim itself - `running`, this worker's id,
     * a lease in the future - which is the row a claim leaves behind. What `run` is then handed is
     * indistinguishable from a claimed resume.
     *
     * WHAT IS NOT ANSWERED: a parked question. `ask` writes the task `awaiting_user` too, but
     * creates no approval row - the answer is the owner's next message, not a yes. An auto-approver
     * is not an auto-owner, and a rig that typed an answer would be measuring its own prose. The
     * newest approval still being `pending` is the whole test: a question park leaves it answered
     * (or absent) and the loop below leaves the run parked, which is the correct outcome for it.
     */
    /*
     * WHAT BOUNDS IT: the model calls this harness has counted, against `maxSteps`, and not a
     * count of re-entries.
     *
     * The loop's step counter advances only when a step COMPLETES (`agent.ts`, the `for` over
     * `state.step`); a step that parks on a card never gets there, so a resumed turn re-runs the
     * same step number, and the worker's own `TASK_MAX_STEPS` bounds nothing across entries.
     * Measured: `maxSteps` 4 and a model that proposes a push on every call made 5 calls, 4 of
     * them answered, every one of them at step 0 - so a row's `task_max_steps` named a bound the
     * run was not under. The product's own definition of a step is "one model call however many
     * tools it uses" (`turn-bounds.ts`), and the call that carded WAS a model call; so was the
     * request a provider refused and the loop retried, which no step number ever records.
     * `modelCalls` is the one counter on this side that sees every request, whichever entry made
     * it, so it is the bound: no re-entry once the run has spent the ceiling's worth of calls,
     * and reaching it is recorded rather than swallowed. Under this arm `task_max_steps` is then
     * a true ceiling on provider calls exactly as under the others (plus the closing handoff a
     * turn at its ceiling makes, which every arm pays).
     *
     * The re-entered worker is still built one step shorter per card answered: the guard above
     * stops the NEXT re-entry, and the worker's own ceiling is what stops a re-entered turn from
     * spending, within one entry, steps that earlier entries already parked on.
     */
    while (fixture.autoApprove === true && finalStatus === 'awaiting_user') {
      const newest = [...approvalRows.values()].at(-1);
      if (!newest || newest.status !== 'pending') break;
      if (modelCalls >= stepCeiling) {
        autoApproveCapReached = true;
        break;
      }
      newest.status = 'approved';
      task = {
        ...task,
        status: 'running',
        leaseOwner: WORKER_ID,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
      };
      finalStatus = 'running';
      approvalsAutoAnswered += 1;
      // One step fewer per card answered; see the comment above the loop.
      await worker(stepCeiling - approvalsAutoAnswered).run(task);
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    globalThis.fetch = original;
    Date.now = realNow;
    advanceClockBy = () => undefined;
  }
  // Every live response has been handed to the gateway by now; wait for the copies this rig kept
  // to be read to their end before anything below sums them.
  await Promise.all(liveUsageReads);
  /*
   * One usage figure per answered live response, the provider's where it gave one.
   *
   * A response the provider refused (a 5xx the loop retried) is a request `modelCalls` counts and
   * nothing prices: it carried no completion and no route bills one. An answered response with no
   * frame - a stream cut before its last data frame - or a frame with no `cost` is the case the
   * lead asked to be named rather than zeroed: it falls back to the ledger row the loop wrote for
   * that call. The loop writes one `model_inference` row per answered call, in the order the calls
   * were answered, so the n-th answered response and the n-th row are the same call. What that row
   * carries is the loop's `quantity` (its billed input plus the output it counted) and its own
   * price; the split is recovered from the `cost` event the same call wrote where it wrote one - a
   * lead step's event carries `usage.estimated` and the counted output - and where it wrote none
   * (a specialist, a summariser) the whole quantity is read as input, which is what nearly all of
   * a frameless call is. Counted, so a row built on this is read for what it is.
   */
  const ledgerRows = usageRows.filter((row) => row.kind === 'model_inference');
  const estimatedEvents = events
    .filter((entry) => entry.kind === 'cost')
    .map(
      (entry) =>
        ((entry.payload ?? {}) as { usage?: { estimated?: unknown; outputTokens?: unknown } }).usage
    )
    .filter((usage) => usage?.estimated === true);
  let providerUsageFallbacks = 0;
  const liveUsage: ProviderUsageFrame[] = liveResponses
    .filter((response) => response.ok)
    .map((response, ordinal) => {
      const frame = response.frame;
      if (frame && frame.costUsd !== null) return frame;
      providerUsageFallbacks += 1;
      const row = ledgerRows[ordinal];
      if (frame) return { ...frame, costUsd: row?.costUsd ?? 0 };
      const counted = estimatedEvents.shift();
      const outputTokens = Number(counted?.outputTokens) || 0;
      const quantity = row?.quantity ?? 0;
      return {
        inputTokens: Math.max(quantity - outputTokens, 0),
        cachedTokens: 0,
        outputTokens,
        costUsd: row?.costUsd ?? 0
      };
    });

  /**
   * What the context layer decided on each billed step, read off the event it already writes.
   *
   * Three numbers come from here rather than from a reconstruction: the prompt size, the floor the
   * older tool results were cut to, and how many cache breakpoints the request carried. The first
   * always did. The second used to be recovered by grepping the last window for the sentence a
   * squeezed result carries, which could only see one step and measured a message length rather
   * than a floor; the third could not be recovered at all, because this release's route caches
   * automatically and the adapter drops the markers before they reach the wire - so the one number
   * that says whether a repeated prefix is billable was invisible to a suite whose subject is what
   * a long turn costs.
   */
  const contexts = events
    .filter((entry) => entry.kind === 'cost')
    .map(
      (entry) =>
        (
          (entry.payload ?? {}) as {
            context?: {
              estimatedInputTokens?: unknown;
              olderToolOutputChars?: unknown;
              cacheBreakpoints?: unknown;
            };
          }
        ).context ?? {}
    );
  const costs = contexts.map((context) => Number(context.estimatedInputTokens) || 0);
  /** The same events, read for what they billed rather than for what the window was. */
  const billed = events
    .filter((entry) => entry.kind === 'cost')
    .map(
      (entry) =>
        (entry.payload ?? {}) as {
          usage?: { outputTokens?: unknown };
          cumulativeCredits?: unknown;
        }
    );
  /*
   * The cost events that carry window numbers at all, which is not all of them.
   *
   * The closing handoff prepares its own window - `#runHandoffCall` calls `prepareModelContext` and
   * holds the result - and then writes a cost event with no `context` block on it. So the request
   * that carries the most of any step-limited turn reports no size, no floor and no breakpoints,
   * and a floor read as the minimum over every cost event would read 0 on every fixture that ends
   * in a handoff. The 0 is the absence of a measurement, not a floor that reached the bottom.
   *
   * Filtered here rather than defaulted, because the two are different claims and only one of them
   * is true. `costs` above is deliberately left alone: it has always summed over every cost event,
   * the handoff has always contributed nought to it, and the committed baseline is that number -
   * changing it here would move forty-nine rows for a reason that has nothing to do with the
   * window. What it means is that `promptTokens` under-reports a turn that ends in a handoff by
   * one whole request, which is a note for whoever next owns `agent.ts:5517`, not something this
   * side can honestly fix.
   */
  const windows = contexts.filter((context) => context.olderToolOutputChars !== undefined);
  const completion = [...events].reverse().find((entry) => entry.kind === 'completed');
  // Only a compaction writes a brief, so the field it carries is what tells its status event from
  // every other one. Read structurally rather than off the sentence, which the interface owns.
  const compactions = events
    .map(
      (entry) =>
        (
          (entry.payload ?? {}) as {
            compaction?: {
              briefParts?: unknown;
              brief?: unknown;
              source?: unknown;
              trigger?: unknown;
            };
          }
        ).compaction ?? {}
    )
    .filter((compaction) => typeof compaction.briefParts === 'number');
  // The sections a compaction wrote, which is where a notice about something the window lost has to
  // land: the brief is the one part of a condensed turn the model keeps reading.
  const brief = compactions.map((compaction) => asText(compaction.brief)).join('\n');
  const modelWrittenBriefs = compactions.filter(
    (compaction) => asText(compaction.source) === 'model'
  ).length;
  const lastWindow = (
    (lastAgentRequest.messages ?? []) as Array<{ role?: unknown; content?: unknown }>
  ).map((message) => ({ role: asText(message.role), content: contentOf(message) }));

  /*
   * The whole trajectory, on demand, which is the one thing this rig could not show.
   *
   * `EVAL_DUMP_WINDOW=<directory> pnpm eval --filter <id>` writes what the turn actually sent.
   * Nothing asserts on it and nothing reads it back; it exists because every question worth asking
   * of this suite - why did that row move by twenty tokens, is the knowledge block really in there,
   * did the brief land last - was previously answerable only by editing the harness, and a
   * diagnostic that has to be built each time is one nobody builds.
   *
   * It used to hold the last step alone, which is a log: it says where the turn ended and nothing
   * about how it got there, so the two questions this suite exists to answer - which step first
   * differed, and what did the model see when it decided - could be asked of it and not answered.
   * `requests` is now every provider call in order, and `identity` names the athanor and the rig
   * that produced them. Those two together are what makes a run reproducible by somebody who was
   * not at this machine: check the revision out, hold the fixture beside it, send the same bytes.
   */
  if (dumpDirectory)
    writeFileSync(
      path.join(dumpDirectory, `${fixture.id}.json`),
      `${JSON.stringify(
        {
          fixture: fixture.id,
          // The version, the revision and the digest of the three files that decide every number
          // below. See `runIdentity`.
          identity: runIdentity(),
          recordedAt: new Date().toISOString(),
          catalogue: (
            (lastAgentRequest.tools ?? []) as Array<{ function?: { name?: unknown } }>
          ).map((tool) => asText(tool.function?.name)),
          // What the catalogue costs, which is `reservedTokens` on the other side and the term the
          // whole budget arithmetic turns on - every threshold in `context.ts` is a share of the
          // window minus this. Read as bytes, because that is what this side can see.
          catalogueBytes: catalogueBytesOf(lastAgentRequest),
          // Every prepared window's size in order, which is what the compaction trigger is compared
          // against one step later. A single peak says whether a turn fitted; the sequence says
          // where it was heading and which threshold it settled against.
          windowTokens: windows.map((context) => Number(context.estimatedInputTokens) || 0),
          requests: recordedRequests,
          messages: lastWindow
        },
        null,
        2
      )}\n`
    );

  return {
    modelCalls,
    delegatedCalls,
    // Offline: every request body priced on the wire by `promptTokensFor`. Live: the provider's
    // own input count off every response's usage frame, because the live branch forwards the
    // request untouched and never pushed a wire estimate - so the first paid row read
    // `input_tokens_mean 0` for a run that had billed thirteen million of them. The provider's
    // number rather than the wire estimate on purpose: it is what the bill was computed from, and
    // the two differ by the tokeniser, which this rig does not have. Off the responses rather than
    // the cost events so that it covers the same calls `modelCalls` counts; see the live branch.
    promptTokens:
      fixture.live === undefined
        ? wirePromptTokens.reduce((total, value) => total + value, 0)
        : liveUsage.reduce((total, usage) => total + usage.inputTokens, 0),
    catalogueTokens: wireCatalogueTokens.reduce((total, value) => total + value, 0),
    // The catalogue as one request carries it, which is the number a residency change moves and the
    // only one that can be compared against `tool-catalogue.test.ts`'s ceiling. The sum above is
    // that figure multiplied by however many steps a fixture happens to take, so it says what a
    // turn cost and cannot say what the catalogue costs.
    residentCatalogueBytes: catalogueBytesOf(lastAgentRequest),
    windowTokens: costs.reduce((total, value) => total + value, 0),
    peakPromptTokens: costs.reduce((peak, value) => Math.max(peak, value), 0),
    tools: events
      .filter((entry) => entry.kind === 'tool_started')
      .map((entry) => asText((entry.payload as { tool?: unknown }).tool)),
    proposed,
    readLedger: readLedgerOf(events),
    // What the workspace holds now: what the fixture put there, then what the turn did to it.
    filesAfter: {
      ...(fixture.runner?.files ?? {}),
      ...Object.fromEntries([...execState.written].map(([file, entry]) => [file, entry.text]))
    },
    commandsRun: execState.execs,
    mediaGenerated: execState.media,
    mediaModels: execState.mediaModels,
    // Rounded to a whole point, which is all this number can honestly carry: the runtime block at
    // the end of the window rebuilds its clock on every step, so the last few bytes of a request
    // differ from the last one's whatever else the loop did.
    leadInputCharacters,
    leadPrefixCharacters,
    freshLeadCharacters: leadInputCharacters - leadPrefixCharacters,
    cachePrefix: prefixShares.length
      ? Math.round(
          (prefixShares.reduce((total, share) => total + share, 0) / prefixShares.length) * 100
        )
      : 0,
    delegatedCachePrefix: delegatedPrefixShares.length
      ? Math.round(
          (delegatedPrefixShares.reduce((total, share) => total + share, 0) /
            delegatedPrefixShares.length) *
            100
        )
      : 0,
    compactions: compactions.length,
    briefSections: compactions.reduce(
      (most, payload) => Math.max(most, Number(payload.briefParts) || 0),
      0
    ),
    modelWrittenBriefs,
    skillsNamedInBrief: [...openedSkills].filter((name) => brief.includes(name)).sort(),
    ownerMessageIntact: lastWindow.some((message) => message.content.includes(fixture.request)),
    // The tightest floor any prepared window of this turn applied. A turn with no prepared window
    // at all - one that threw before its first request - has nothing to report and reads 0, which
    // is the one reading a floor assertion should refuse; `check()` sees the run threw and says so
    // before it gets here.
    toolResultFloor: windows.length
      ? Math.min(...windows.map((context) => Number(context.olderToolOutputChars) || 0))
      : 0,
    cacheBreakpoints: windows.length
      ? Math.min(...windows.map((context) => Number(context.cacheBreakpoints) || 0))
      : 0,
    // Named rather than defaulted: a payload carrying neither is a shape this rig has got wrong,
    // and reading it as the commoner of the two would answer a fixture's question with a guess.
    compactionTriggers: compactions.map((compaction) =>
      asText(compaction.trigger) === 'agent'
        ? 'agent'
        : asText(compaction.trigger) === 'budget'
          ? 'budget'
          : 'unrecorded'
    ),
    softPassWindows,
    anchorHeld,
    finalCatalogue: (
      (lastAgentRequest.tools ?? []) as Array<{ function?: { name?: unknown } }>
    ).map((tool) => asText(tool.function?.name)),
    finalCatalogueUnchanged: previousCatalogue === '' || previousCatalogue === lastCatalogue,
    catalogueStableThroughout,
    outputTokens: billed.reduce(
      (total, entry) => total + (Number(entry.usage?.outputTokens) || 0),
      0
    ),
    creditsSpent: Number(billed.at(-1)?.cumulativeCredits) || 0,
    checkoutPathLeaks,
    memoryCitations: memoryUses.filter((use) => use.cited).length,
    modelCallsAfterSpendHalt: spendHaltedAfter === null ? -1 : modelCalls - spendHaltedAfter,
    spendPaused,
    // Every event whose payload carries the guard's own `windows` array: the warning at the soft
    // threshold and the status line at the hard one, and nothing else in the loop writes one.
    spendNotices: events
      .filter((entry) => Array.isArray((entry.payload as { windows?: unknown })?.windows))
      .map((entry) => entry.summary),
    ...holdsIn([...everyMessage]),
    status: finalStatus,
    verification:
      asText(
        (completion?.payload as { verification?: { status?: unknown } } | undefined)?.verification
          ?.status
      ) || 'none',
    askedOwner: approvals.length > 0,
    approvalsRaised: approvals.length,
    approvalsAutoAnswered,
    autoApproveCapReached,
    // Live: the provider's own price off every answered response, the fallbacks above included.
    // Offline: the loop's inference rows - a document tool records usage too, and it is not a
    // call to the model.
    providerCostUsd:
      fixture.live === undefined
        ? ledgerRows.reduce((total, row) => total + row.costUsd, 0)
        : liveUsage.reduce((total, usage) => total + (usage.costUsd ?? 0), 0),
    providerCalls: liveUsage.length,
    providerUsageFallbacks,
    providerInputTokens: liveUsage.reduce((total, usage) => total + usage.inputTokens, 0),
    providerCachedTokens: liveUsage.reduce((total, usage) => total + usage.cachedTokens, 0),
    providerOutputTokens: liveUsage.reduce((total, usage) => total + usage.outputTokens, 0),
    events,
    fallbackPlan,
    untrusted: events.some(
      (entry) =>
        ['warning', 'provenance'].includes(entry.kind) &&
        entry.summary.startsWith('Untrusted content entered')
    ),
    replies: events.filter((entry) => entry.kind === 'assistant_message').length,
    // Read off the error event the loop writes when a call throws, rather than off the `Tool
    // failed:` message it pushes into the window. The event carries the tool call's id and survives
    // a compaction; the message is a window byte and does not.
    failedTools: events
      .filter(
        (entry) =>
          entry.kind === 'error' &&
          (entry.payload as { toolCallId?: unknown } | undefined)?.toolCallId !== undefined
      )
      .map((entry) => entry.summary.replace(/ failed$/, '')),
    // Same events, with the reason kept. `recordToolFailure` writes `{toolCallId, message, code}`
    // and this rig threw away everything but the tool's name, so a row could say a call failed and
    // nothing anywhere could say a call failed FOR THE REASON THE ROW IS ABOUT.
    toolFailures: events
      .filter(
        (entry) =>
          entry.kind === 'error' &&
          (entry.payload as { toolCallId?: unknown } | undefined)?.toolCallId !== undefined
      )
      .map((entry) => {
        const payload = asRecord(entry.payload);
        return {
          tool: entry.summary.replace(/ failed$/, ''),
          code: asText(payload.code),
          message: asText(payload.message)
        };
      }),
    warnings: events.filter((entry) => entry.kind === 'warning').map((entry) => entry.summary),
    unstubbedRoutes: [...new Set(execState.unstubbed)],
    observedRoutes: [...new Set(execState.observed)],
    error
  };
};

export const evidence = (id: string, claim: string): Record<string, unknown> => ({
  status: 'verified',
  evidence: [{ claim, source: 'tool_result', toolCallId: id }],
  remainingRisks: []
});

export const conversational = (): Record<string, unknown> => ({
  status: 'not_applicable',
  evidence: [],
  remainingRisks: []
});
