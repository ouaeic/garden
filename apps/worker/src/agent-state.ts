import type {
  MediaModelSelection,
  TaskMode,
  TaskReasoningEffort,
  WebToolMode
} from '@garden/contracts';
import type { ModelMessage, ModelToolCall } from '@garden/model-gateway';
import type { AcceptanceRecord } from './acceptance.js';
import type { WorkerConfig } from './config.js';
import type { ArtifactLedger, ContextBrief } from './context.js';
import type { StoredMediaRoutes } from './media.js';
import type { NativeInputReference, NativeInputApproval } from './native-input.js';
import type { TranscriptionApproval } from './transcription-approval.js';
import type { DecisionResult } from './decisions.js';
import type { MediaGenerationApproval } from './media-approval.js';

export interface AgentState {
  /** Ordered capability groups persist across compaction, pauses and worker leases. */
  enabledToolGroups?: string[];
  /** Last applied project main choice; subsequent explicit turn choices remain authoritative. */
  mainModelPreference?: string;
  decisionFloorBindings?: Record<string, string>;
  decisionReceipts?: Record<string, Extract<DecisionResult, { status: 'decided' }>>;
  projectContextFingerprint?: string;
  /**
   * The providers this task has already been walled by, so a re-route does not return to one.
   *
   * A rate limit or an outage used to park the whole task behind the provider that raised it, for
   * up to a day, even when the owner had another provider connected that could have answered
   * immediately - which was the only possible behaviour while an account could hold one credential.
   * Now that it can hold several, a wall is a reason to try the next one, and this is what stops
   * that walking in a circle between two providers that are both having a bad afternoon.
   */
  walledProviders?: string[];
  pendingNativeInputs?: NativeInputReference[];
  nativeInputApprovals?: Record<string, NativeInputApproval>;
  mediaApprovals?: Record<string, MediaGenerationApproval>;
  transcriptionApprovals?: Record<string, TranscriptionApproval>;
  codingMissionWaiting?: boolean;
  codingMissionReviews?: Record<string, { digest: string; generation: number }>;

  /** Direct owner text, kept separately from tool output and model summaries. */
  memoryOwnerRequest?: string;
  messages: ModelMessage[];
  step: number;
  credits: number;
  turn?: number;
  reservationKey?: string;
  planVersion?: number;
  /**
   * The durable running brief. It is also rendered into `messages`, but the structured sections are
   * what makes the next compaction append rather than rewrite, so they are persisted in their own
   * right and survive a resume, a pause for approval, and a follow-up turn.
   */
  contextBrief?: ContextBrief;
  /** Counts summarisation calls so each one bills under its own idempotency key. */
  compactions?: number;
  /** Observed provider cost per minute, retained for reporting; never bounds a later request. */
  transcriptionRates?: Record<string, number>;
  /**
   * The tightest floor any request in this task has applied to older tool results. Persisted so the
   * squeeze stays one-way: once a result has been shortened it is never restored, and the prompt
   * prefix a provider cached is never rewritten upwards when a compaction frees room.
   */
  toolOutputFloor?: number;
  openedSkills?: string[];
  /**
   * Whether this turn has already changed something. It gates the fallback plan - a request that
   * only needs an answer should not arrive with three boilerplate steps already running - and it is
   * what `completionVerification` checks evidence ordering against.
   */
  mutated?: boolean;
  /**
   * Whether any of those changes was something other than prose. A report, a README or a CSV is a
   * change, but there is nothing executable that could prove it: the only check available is reading
   * back the file just written, which passes whatever the file says. Demanding one anyway is how a
   * research task ends up inventing a check, failing it, and being refused its own finish - so the
   * acceptance gate asks only when code, commands or config were touched.
   */
  mutatedBeyondProse?: boolean;
  /** Whether this turn has said anything to the owner in its own voice. */
  answered?: boolean;
  /** Identity of the durable process dependency currently holding this turn. */
  jobWaitId?: string;
  /**
   * Set when the harness has just refused a finish and sent the model round again.
   *
   * The step that follows is bookkeeping - cite something newer, declare the checks, close the plan
   * - and whatever prose it carries is a restatement of an answer the owner already has.
   */
  repairStep?: boolean;
  /** Whether this turn has already been asked, once, to say something to the owner. */
  answerNagged?: boolean;
  turnToolResults?: Record<
    string,
    {
      name: string;
      success: boolean;
      /**
       * Whether garden answered this call itself instead of running it.
       *
       * Implies `success: false`, and every gate that only asks "did this work" is satisfied by
       * that alone. It is recorded separately because two consumers need the distinction: the
       * evidence floor, which reads `mutating` without reading `success`, and the completion
       * contract, which can then say nothing ran rather than that something failed.
       */
      skipped?: boolean;
      mutating?: boolean;
      briefOnly?: boolean;
      /** A change nothing can execute, so the write is the only observation there is. */
      proseOnly?: boolean;
      /**
       * The command garden ran here and what it exited with, when this was a foreground `shell`.
       *
       * Kept so an acceptance check naming a command garden has already run, after the last
       * change, is answered from that run instead of running the build or the suite a second time.
       */
      command?: { fingerprint: string; exitCode: number };
      /**
       * The timeline row this call's raw, untruncated result was written to.
       *
       * The result the model is holding has been bounded, fenced and possibly spilled; the row
       * named here is the object the tool actually returned. It is kept so that a `finish` citing
       * this call can leave behind a pointer a later turn can follow - `mem.cited_call` stores this
       * id, and the reach dereferences it by primary key rather than by walking a conversation's
       * events and decrypting each one until a payload matches.
       *
       * Absent on the paths that never wrote a result row: a call the harness answered itself, one
       * that threw, and the two failure paths in `agent.ts` that record only a name.
       */
      eventId?: string;
      progressKey?: string;
      /** Native process identity, retained independently of model-visible output. */
      process?: { id: string; completed: boolean };
    }
  >;
  /**
   * Reaches into stored evidence this turn has already spent.
   *
   * Per turn, like every counter around it, and for the reason the reach is bounded at all: it
   * returns material the compaction bound exists to keep OUT of the window. One reach is capped at
   * `MEMORY_REACH_MAX_CHARS` and a turn may spend `MEMORY_REACH_MAX_PER_TURN` of them, so the most
   * a turn can pull back out of the store is exactly `RECENT_TOOL_OUTPUT_CHARS` - what a single
   * live tool result is allowed to occupy. Replaying stored material must not cost more than
   * producing it did.
   */
  memoryReaches?: number;
  /**
   * Consecutive rejected `finish` calls this turn. Persisted rather than kept in the loop frame so a
   * pause, an approval, or a worker handover cannot reset it - otherwise a model that cannot ground
   * its completion resumes into the same loop and spends the whole step budget on it.
   */
  finishRejections?: number;
  /** A missing output gets one repair hold per turn, including across worker restarts. */
  deliveryNagged?: boolean;
  /** The owner selection survives checkpoints and is replaced when their next message starts. */
  ownerReasoningEffort?: TaskReasoningEffort;
  /**
   * What the last request actually weighed after the window was prepared.
   *
   * The compaction trigger used the raw trajectory instead, which is not what goes out: preparing
   * the window bounds older tool output, often heavily, so the trigger fired on a size no request
   * ever had. Compaction therefore ran about half again as often as it was designed to, and each
   * run costs a summariser call and rewrites the cached prefix from the brief onward.
   *
   * Triggering on the prepared size also makes the squeeze a real first tier for free: if bounding
   * tool output is enough to fit, no summary is written at all, and compaction is left for when the
   * squeeze has hit its floor and the trajectory genuinely will not fit.
   */
  preparedInputTokens?: number;
  /** Consecutive replies this turn that carried no tool call at all. Persisted for the same reason. */
  completionNags?: number;
  /** Counts rejected proposals, not executed actions; survives worker restarts. */
  approvalRecovery?: {
    turn: number;
    attempts: number;
    byReason?: Partial<
      Record<'verify_public_source' | 'separate_network_steps' | 'use_explicit_cwd', number>
    >;
  };
  /**
   * Tools this turn has actually started, counted where `tool_started` is written.
   *
   * The only evidence in the loop for "something ran". A tool call in the response is not it: five
   * of them the loop answers itself, and three more it answers instead of running - a repeat read,
   * a call cut off mid-JSON, a call overtaken by a plan the owner republished. Compared across a
   * step, this separates a step that acted from a step that only asked.
   */
  toolsStarted?: number;
  /** Consecutive steps that started no tool. See `MAX_IDLE_STEPS`. */
  idleSteps?: number;
  /**
   * Calls that have failed identically this turn, hashed, to how many times running.
   *
   * A count per call rather than one running total, because two tools failing alternately are two
   * problems and neither of them is a repeat of the other. See `MAX_REPEATED_FAILURES`. Keys carry
   * no arguments and no error text - both are digested, and what is stored proves only that two
   * attempts were the same attempt.
   */
  repeatedFailures?: Record<string, number>;
  /** Cut-off tool calls answered this turn, bounding the retry of an oversized payload. */
  argumentTruncations?: number;
  /** What each file held when this turn last read or wrote it, so a whole-file write can say so. */
  readFileHashes?: Record<string, string>;
  partialReads?: Record<string, number>;
  /**
   * Read-only calls already made this turn, keyed by tool and arguments, to the id that made them.
   * Only the tools in `IDEMPOTENT_WITHIN_TURN` are recorded, and only to answer an exact repeat
   * with the pointer rather than the same work again.
   */
  seenCalls?: Record<string, string>;
  /**
   * Paths, commands and URLs from steps a compaction has already removed from the window.
   *
   * The episode's `Touched:` list is read out of `state.messages` when the turn ends, and a
   * compaction genuinely deletes the messages it condensed - so on a long unattended run, which is
   * exactly the kind worth recalling later, everything before the last compaction was missing from
   * the record. These are the only mechanical identifiers an episode carries; the rest of the body
   * is the model's own prose about itself.
   */
  carriedArtifacts?: string[];
  /** Consecutive replies cut off at the model's output limit, so continuing them stays bounded. */
  truncatedReplies?: number;
  /**
   * Whether this turn has already said that some of the streamed reply never reached the
   * transcript. Said once: a channel that has started failing usually keeps failing, and a warning
   * on every step of it would bury the step where anything else went wrong.
   */
  frameLossNoted?: boolean;
  /**
   * Times this turn has condensed its window because the route refused it as too large.
   *
   * Bounded for the same reason `truncatedReplies` is: the repair sends the request again, and a
   * repair that can send it again without limit is a loop that pays for every attempt. Carried in
   * the persisted state rather than held in a local, so a resume cannot hand a task a fresh budget
   * for the same refusal it has already been condensed twice for.
   */
  contextOverflowRepairs?: number;
  /**
   * Notices this turn has already sent the owner. Persisted so a resume, an approval or a worker
   * handover cannot reset the count - the bound exists to stop a monitor becoming a stream, and a
   * bound a restart clears is not one. The next turn starts it again at zero, which is the only
   * reading that matches what the tool tells the model.
   */
  notices?: number;
  /**
   * The sites this conversation has already asked the owner to take over. A standing challenge is
   * re-reported by every browser call that lands on it, so without this one wall would buzz the
   * owner's phone on every step; keyed by site rather than by a flag because a challenge on a
   * second site is genuinely a second thing they have to deal with.
   */
  takeoversRaised?: string[];
  /**
   * Whether this task was started by a schedule rather than by the owner sitting in front of it.
   * Decided once, from the run's own opening event, and carried forward: every later turn of a
   * scheduled conversation is still unattended work until the owner replies to it.
   */
  unattended?: boolean;
  mode?: TaskMode;
  /** What the last step cost, in dollars, so the next one can be priced before it runs. */
  lastStepUsd?: number;
  /** Spend windows already warned about, so a long task says it once rather than every step. */
  spendWarnings?: string[];
  /**
   * The undo point for this turn: taken lazily, in front of the first call that could change the
   * computer, and remembered so a resume, an approval or a worker handover does not take a second
   * one. A null id means it was attempted and could not be taken - recorded so the turn does not
   * retry a failing checkpoint before every subsequent call.
   */
  checkpoint?: {
    turn: number;
    id: string | null;
    /**
     * The files inside the checkpointed trees that this checkpoint WALKED and did not HOLD - each
     * one over `CHECKPOINT_MAX_FILE_BYTES`, recorded by the scan and skipped - or absent when that
     * set is not known.
     *
     * The approval floor is the only reader. It frees a delete strictly inside `CHECKPOINT_CONTENT`
     * because a rewind puts it back, and that is false of exactly these paths, so a delete naming
     * one of them keeps its card while every other delete on the turn stays free.
     *
     * Absent keeps the card on ALL of them, and absent is what an old persisted state, a runner one
     * release behind, or a capped list all produce. The sole writer is
     * `AgentWorker.#ensureTurnUndoPoint`, which records `AgentRunnerClient.checkpoint`'s `uncovered`
     * verbatim; a refused checkpoint writes `{ turn, id: null }` and no set, which is right twice
     * over - there is nothing to rewind to.
     */
    uncovered?: readonly string[];
  };
  pending?: { approvalId: string; toolCall: ModelToolCall; handoffOnly?: boolean };
  /** The pending human question or browser handoff survives worker restarts. */
  browserHandoff?: { vendor: string; url: string; reason: string; tabId?: string | null };
  question?: {
    id?: string;
    question: string;
    askedAtStep: number;
    why?: string;
    continueWith?: string;
    waiting?: boolean;
    handoff?: { kind: 'challenge'; surface: 'browser'; tabId?: string; url: string };
  };
  questionsAsked?: number;
  /**
   * The tool call this worker had started but not yet recorded a result for. Written durably before
   * the call runs, so a worker that dies mid-call leaves evidence of what it had already set in
   * motion instead of nothing at all.
   */
  inFlight?: { toolCallId: string; tool: string; startedAt: string };
  /**
   * What the model said would prove this job is done, and how many times it has said it.
   *
   * Persisted with the rest of the state rather than held in the loop frame for the same reason the
   * plan is durable: it is the statement the finish is judged against, and it has to survive
   * compaction, an approval pause, a worker handover and the next turn.
   */
  acceptance?: AcceptanceRecord;
  /** Consecutive finishes refused because the harness ran the checks and they failed. */
  acceptanceFailures?: number;
  /** Whether this turn has already been asked once to state what would prove the job is done. */
  acceptanceNagged?: boolean;
  /** Declarations sent back this turn because the harness found every check already passing. */
  acceptanceBaselineRefusals?: number;
  /** The turn that declared the record, so a later turn is not proven by a check it inherited. */
  acceptanceTurn?: number;
  /**
   * Why this record's checks are weaker evidence than a check the harness watched fail, when they
   * are. Absent means the record was run against the unfinished job and at least one of it failed,
   * which is the only case where passing it at finish is proof of anything. It travels with the
   * record rather than with the turn - a record carried into the next turn carries how it was made.
   */
  acceptanceCaveat?: string;
  /**
   * How many times this turn has handed itself another step budget rather than stopping for a reply,
   * and what the harness had counted the last time it did.
   *
   * Both are persisted with the rest of the state because they are bounds: a count a worker restart
   * or an approval pause resets is not a bound, and the mark is what "still making progress" is
   * measured against. Per turn, like every other ceiling in this file - a reply from the owner is a
   * new turn and starts again from zero, which is the only reading that matches what the model is
   * told when a budget is renewed.
   */
  selfContinuations?: number;
  continuationMark?: { atStep: number; writes: number; evidence?: number };
  /** Whether this turn has already been sent back once for a plan whose steps were left open. */
  planCoverageNagged?: boolean;
  /** True while the only plan on record is the boilerplate one the harness wrote for itself. */
  planIsFallback?: boolean;
  /**
   * Where untrusted content entered this turn, and when.
   *
   * Absent means clean. It is persisted because a pause for approval or a worker handover must not
   * launder it: the whole point is that the floor knows what the turn has read, and a provenance
   * record a restart clears is not one.
   */
  taint?: { level: 'untrusted'; sources: string[]; sinceStep: number };
  /**
   * How much material has left for the outside since that happened, counting only what appears
   * nowhere the owner put it.
   *
   * Persisted for the same reason the taint is: the per-address bound is a bound on one request,
   * and a budget a restart or an approval resets is a budget an attacker gets to reset for free.
   */
  turnNoveltyBytes?: number;
  /**
   * The web route this run has been running under, so the decision cannot move mid-run.
   *
   * The fact behind it is the owner's stored credential, which they can replace from the settings
   * page while a task is still running. Without this, repointing the box at a provider that answers
   * searches would move a task that began under the in-house promise onto that search service,
   * without the owner ever being asked about that task. `resolveWebToolPlan` only ever reads it to
   * refuse, so recording it can move the answer one way and not the other.
   */
  webToolMode?: WebToolMode;
  /** Hosts the owner named, a search returned, or this turn already read. Bounded. */
  knownOrigins?: string[];
  /** The whole addresses behind those hosts, so following a link the turn was handed is not novel. */
  knownAddresses?: string[];
  /**
   * The reasoning effort this turn has ratcheted up to. Effort only ever rises within a turn: the
   * step that recovers from a failure is not a step to think less about, and a request field that
   * changes ten times in twenty-three steps throws away the provider's cached trajectory each time.
   */
  reasoningFloor?: 'medium' | 'high';
  /** The step a compaction last landed on, so the step that follows it thinks harder. */
  compactedAtStep?: number;
  /**
   * The files this turn has changed, as the workspace reported each change back.
   *
   * Durable for the reason every other block in the tail is durable: it is re-rendered into the
   * window from here on every step, so an approval pause, a worker handover or a compaction that
   * ate the calls themselves cannot take the record with them. Bounded where it is written rather
   * than where it is rendered - see `recordArtifactWrite` - so the persisted state a long turn
   * carries is bounded too, and a turn touching four hundred files does not encrypt four hundred
   * rows onto the task on every step.
   */
  artifactLedger?: ArtifactLedger;
}

export type AgentWorkerConfig = Omit<WorkerConfig, 'WORKER_HEALTH_PORT' | 'WORKER_HEALTH_HOST'>;

export interface InferenceCredential {
  provider: 'openrouter' | 'ollama-cloud' | 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  enforceZeroDataRetention: boolean;
  /** Owner preferences are resolved against the same current catalogue as Settings. */
  mediaModels?: MediaModelSelection;
  mediaRoutes?: StoredMediaRoutes;
}

export interface ExecObservation {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ProcessObservation {
  sessionId: string;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}
