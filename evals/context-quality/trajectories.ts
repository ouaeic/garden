/**
 * The long-running trajectories the probes are asked about, with the answers planted in them.
 *
 * A trajectory here is the message list `apps/worker/src/agent.ts` builds - the same preamble
 * blocks in the same order at production sizes, an assistant turn carrying prose, reasoning,
 * reasoning details and a tool call, and a tool result serialized the way the loop serializes it.
 * `evals/harness.ts` runs the real loop and cannot answer a question about content, because its
 * model is scripted; this file goes the other way, scripting the trajectory precisely so that the
 * questions have known answers.
 *
 * Everything is planted deliberately and at a stated distance from where it is asked for, because
 * distance is the whole experiment. One step appends two messages, and the two constants under
 * review are counted in messages: `RECENT_DETAIL_MESSAGES = 8` is about four steps of reasoning
 * history, `= 2` is about one. A probe set clustered at one distance would measure one constant
 * and report it as a property of the design, so the distances below run from 1 step to 23.
 *
 * Two probes are controls and must score 1.00 in every configuration:
 *
 *   `recall-owner-constraint`   the owner's own goal message, which every pass protects by name.
 *                               If this ever moves, the run is measuring a broken driver.
 *   `recall-newest-reasoning`   asked one step after it is planted. It looks like a control and it
 *                               is not - see the note on it below, which is the single most useful
 *                               thing this file found.
 *
 * The sizes and the seeded size sequence are the ones `apps/worker/src/context.test.ts` settled on
 * for its sixty-step harness: tool results spread 0.6-24 kB, assistant turns carrying reasoning,
 * the real catalogue in front. A fixture whose results are all one size measures one branch of the
 * squeeze, which is how the plan came to quote numbers from a 20 kB-uniform fixture that the Wave
 * 0 harness then corrected.
 */
import type { ModelMessage } from '../../packages/model-gateway/src/index.js';

import { BASE_SYSTEM_PROMPT, serializeToolResultForModel } from '../../apps/worker/src/context.js';
import { renderNumbered, toLines } from '../../apps/worker/src/edit/index.js';
import type { Probe } from './probes.js';

/* --------------------------------------------------------------- what a read looks like, and why
 *
 * The line-addressed editor addresses lines by the numbers a read displayed, so every `file_read`
 * result on this machine is now `N:TEXT` rather than the file's own text. That is a permanent tax
 * on the widest thing in the window, and `docs/design/edit/COST.md` had to answer a question no
 * character count can: a tool result is BOUNDED at `RECENT_TOOL_OUTPUT_CHARS` before it enters the
 * window, so the surcharge does not make the window bigger - it makes less of the file fit inside
 * the same 24,000 characters. Whether that costs recall is this rig's question and nothing else
 * here could ask it.
 *
 * Three shapes, chosen with `GARDEN_CONTEXT_READ_SHAPE`, defaulting to the one the committed
 * baseline was accepted under:
 *
 *   raw       one unbroken run of text, as this fixture has always built it
 *   lines     the identical bytes, with a space replaced by a newline every `width` characters
 *   numbered  those lines through the shipped `renderNumbered`, which is what a read returns now
 *
 * `lines` is not decoration and it is not the experiment either: it is the control that makes the
 * experiment mean anything. Numbering requires lines, so a straight `raw` against `numbered`
 * comparison would move two things at once - the line breaks and the numbers - and report their
 * sum. The wrap replaces a space with a newline rather than inserting one, so `lines` is the same
 * length as `raw`, plants the same spans at the same offsets, and should score identically. If it
 * does not, the wrap is disturbing the fixture and the numbered row cannot be read.
 *
 * The trajectory IDS carry the shape whenever it is not `raw`. That is deliberate and it is the
 * whole safety of putting a switch here at all: a row measured under a different read shape gets a
 * different `rowKey`, so it can never be checked against - or silently accepted as - a baseline row
 * that was measured under another. An environment variable that could quietly redefine what a
 * committed number means is the shape of the defect this directory already caught once, when a
 * control became a copy of `shipped` and printed a reassuring `+0.00` for a whole wave.
 */

export type ReadShape = 'raw' | 'lines' | 'numbered';

/** The width the wrap uses when the setting does not name one. See `readShape` for why 80. */
const DEFAULT_READ_WIDTH = 80;

/**
 * The read shape this process is measuring, read once.
 *
 * Spelled `shape` or `shape:width` - `numbered:43` is garden's own mean source line, `numbered:130`
 * is about a log line, and the default 80 sits between them. Width matters more than anything else
 * in this experiment: the surcharge is a fixed few bytes per LINE, so it is 9% of a 43-character
 * source line and 3% of a 130-character log line, and a report that quoted one number without its
 * line width would be quoting an accident of the corpus.
 */
const readShape = (): { readonly shape: ReadShape; readonly width: number } => {
  const raw = process.env.GARDEN_CONTEXT_READ_SHAPE?.trim();
  if (!raw) return { shape: 'raw', width: DEFAULT_READ_WIDTH };
  const [name, width] = raw.split(':');
  if (name !== 'raw' && name !== 'lines' && name !== 'numbered')
    throw new Error(
      `GARDEN_CONTEXT_READ_SHAPE=${raw}: expected raw, lines or numbered, optionally :width`
    );
  const parsed = width === undefined ? DEFAULT_READ_WIDTH : Number(width);
  if (!Number.isInteger(parsed) || parsed < 8)
    throw new Error(`GARDEN_CONTEXT_READ_SHAPE=${raw}: width must be an integer of at least 8`);
  return { shape: name, width: parsed };
};

const READ_SHAPE = readShape();

/** What the shape adds to a trajectory id, so no two shapes can share a baseline row. */
const SHAPE_SUFFIX =
  READ_SHAPE.shape === 'raw' ? '' : `+${READ_SHAPE.shape}-reads-${READ_SHAPE.width}`;

/**
 * Breaks a body into lines of about `width` without changing a single byte of it.
 *
 * A space becomes a newline; nothing is inserted and nothing is removed. That is what keeps the
 * `lines` control honest - the body stays exactly as long, so every plant sits at exactly the
 * offset it sat at, and `truncateMiddle` keeps and drops exactly the same regions.
 *
 * `protect` is the planted spans. A break inside one would split the evidence a probe looks for
 * with `String.includes`, and the probe would read 0.0 because this function moved the answer
 * rather than because the window lost it - a fabricated finding, in the direction the lane arguing
 * against the format would want. So a space inside a planted span is never chosen.
 */
const wrapPreservingLength = (body: string, width: number, protect: readonly string[]): string => {
  const guarded: Array<readonly [number, number]> = [];
  for (const span of protect) {
    if (!span) continue;
    const at = body.indexOf(span);
    if (at >= 0) guarded.push([at, at + span.length]);
  }
  const characters = [...body];
  let sinceBreak = 0;
  for (let index = 0; index < characters.length; index += 1) {
    sinceBreak += 1;
    if (sinceBreak < width || characters[index] !== ' ') continue;
    if (guarded.some(([from, to]) => index >= from && index < to)) continue;
    characters[index] = '\n';
    sinceBreak = 0;
  }
  return characters.join('');
};

/** A read result's body as the model is shown it, under the shape this process is measuring. */
const shapeReadBody = (body: string, protect: readonly string[]): string => {
  if (READ_SHAPE.shape === 'raw') return body;
  const wrapped = wrapPreservingLength(body, READ_SHAPE.width, protect);
  return READ_SHAPE.shape === 'lines' ? wrapped : renderNumbered(toLines(wrapped), 1);
};

/** Tool results at the sizes production actually produces, up to the 24 kB recent bound. */
const RESULT_SIZES = [600, 900, 1_500, 3_200, 6_400, 12_000, 18_000, 24_000];

/** Tagged and non-repeating, so two different messages can never share bytes by accident. */
const text = (chars: number, tag: string): string => {
  let value = '';
  while (value.length < chars)
    value += `${tag} ${value.length} the pooler answered in ${value.length % 97} ms and held ${value.length % 13} sessions. `;
  return value.slice(0, chars);
};

/**
 * Splices a span into a body at a fraction of its length, keeping the body exactly as long.
 *
 * Length is preserved because the position of a fact inside a result is the thing being tested:
 * `truncateMiddle` keeps the leading 62% and the trailing remainder, so a span at 0.05 survives
 * every truncation the window applies and the same span at 0.5 is the first thing to go. A splice
 * that also changed the length would move the result across a size band at the same time and the
 * two effects would be inseparable.
 */
const embed = (body: string, span: string, at: number): string => {
  const start = Math.min(
    Math.max(0, Math.floor(body.length * at)),
    Math.max(0, body.length - span.length)
  );
  return `${body.slice(0, start)}${span}${body.slice(start + span.length)}`;
};

interface Plant {
  /** Embedded in this step's reasoning, which is what the detail boundary deletes. */
  readonly reasoning?: string;
  /** Embedded in this step's assistant prose, which nothing but a compaction removes. */
  readonly prose?: string;
  /** Embedded at 5% of the tool result, inside the head every truncation keeps. */
  readonly resultHead?: string;
  /** Embedded at 50% of the tool result, inside the span every truncation removes. */
  readonly resultMiddle?: string;
  /** Makes this step a write, which is what an artifact probe is asked about. */
  readonly write?: { readonly path: string; readonly bytes: number; readonly resultChars: number };
}

const OWNER_GOAL_CONSTRAINT = 'never exceed 40 pooled connections during business hours';

const PLAN_LINE =
  'Plan: (1) audit every caller, (2) stand up the pooler, (3) migrate the writer pool, ' +
  '(4) dry run the cutover, (5) re-point the notifications service, (6) retire the direct role.';

const PLANTS: ReadonlyMap<number, Plant> = new Map<number, Plant>([
  [4, { resultMiddle: 'pool_max_conn = 137' }],
  [
    6,
    {
      reasoning:
        'transaction pooling was chosen over session pooling because each task opens four short-lived connections',
      // The same decision, said out loud as well as thought. Its pair is what keeps the reasoning
      // result honest: an agent usually states a choice in its visible answer too, and a fixture
      // that only ever plants rationale in reasoning would overstate what the detail window costs.
      prose: 'session pooling was ruled out for the writer pool'
    }
  ],
  [7, { prose: PLAN_LINE }],
  [8, { write: { path: 'workspace/infra/pooler.ini', bytes: 2_180, resultChars: 700 } }],
  [10, { resultHead: 'SQLSTATE 53300 too_many_connections on replica two' }],
  [14, { write: { path: 'workspace/src/db/pool.ts', bytes: 9_400, resultChars: 18_000 } }],
  [
    18,
    {
      reasoning:
        'LISTEN NOTIFY was rejected because transaction pooling drops the session that owns the listener'
    }
  ],
  [
    22,
    {
      write: {
        path: 'workspace/services/notifications/config.json',
        bytes: 1_100,
        resultChars: 620
      }
    }
  ],
  [26, { reasoning: 'replica lag peaked at 4812 ms during the dry run' }],
  [31, { write: { path: 'workspace/docs/runbook-pool.md', bytes: 6_700, resultChars: 900 } }],
  [33, { resultMiddle: 'migration 0067 pool ceiling applied in 1420 ms' }],
  [40, { write: { path: 'workspace/infra/pgbouncer-userlist.txt', bytes: 430, resultChars: 640 } }],
  [
    44,
    {
      reasoning:
        'the next action is to re-point the notifications service at the pooler on port 6432'
    }
  ]
]);

/**
 * The block `refreshActivePlan` (agent.ts:9394-9462) maintains, in its shape and its wording.
 *
 * It is re-pushed only when the plan VERSION changes, not on every step - the function returns
 * early when `plan.version === state.planVersion` - so the block lands at the tail on the steps
 * below and sits still in between. That is why it belongs in this fixture at all: on a plan step
 * the newest assistant message is one position further from the tail than usual, and the detail
 * boundary is counted from the tail.
 *
 * It is also the answer to a question this rig would otherwise get wrong. The published probe work
 * says artifact tracking "may need dedicated state tracking beyond summarization". Garden already
 * has exactly that for the plan - a durable, re-rendered, model-visible block that no compaction
 * and no truncation reaches - and has nothing of the kind for the set of files it has written.
 */
const PLAN_STEPS = new Set([2, 12, 24, 36, 48]);

const PLAN_BLOCK_STEPS = [
  'Audit every caller of the direct database role',
  'Stand up the pooler',
  'Migrate the writer pool',
  'Dry run the cutover',
  'Re-point the notifications service',
  'Retire the direct role'
];

/** The plan block as it stands at a given step, with the step it is on marked in progress. */
export const activePlanBlock = (step: number): ModelMessage => {
  const version = [...PLAN_STEPS].filter((planStep) => planStep <= step).length;
  const current = Math.min(PLAN_BLOCK_STEPS.length - 1, version - 1);
  return {
    role: 'system',
    content: `ACTIVE USER-VISIBLE PLAN v${version} (Main). Follow this newest version and do not execute stale work. The user watches these statuses live, so call set_plan again whenever one changes: send every step with its status (pending, in_progress, completed or skipped) and keep the step you are working on marked in_progress.\n${PLAN_BLOCK_STEPS.map(
      (title, index) =>
        `${index + 1}. [${index < current ? 'completed' : index === current ? 'in_progress' : 'pending'}] ${title}`
    ).join('\n')}`
  };
};

export const isPlanStep = (step: number): boolean => PLAN_STEPS.has(step);

/**
 * What the `file_write` at this step actually landed, or nothing.
 *
 * The same two numbers the step's tool result already carries - `{"ok":true,"path":…,"bytesWritten":…}`
 * - which is the point rather than a convenience: in production the ledger row is built from the
 * workspace's own answer to the write, so a rig that invented its own figures would be measuring a
 * block garden does not render. `measure.ts` folds these through `recordArtifactWrite` at the end
 * of the step, so the row appears in the window one step later, exactly as `openStep` publishes it.
 */
export const writeAt = (step: number): { readonly path: string; readonly bytes: number } | null => {
  const write = PLANTS.get(step)?.write;
  return write ? { path: write.path, bytes: write.bytes } : null;
};

/**
 * The step the owner interrupts on, and the sentence the correction turns on.
 *
 * 13 rather than 12, and the one off-by-one is a measurement rather than a preference. A user
 * message is one more thing between the newest assistant turn and the tail, and the detail
 * boundary is `index < length - RECENT_DETAIL_MESSAGES`. On an ordinary step the newest assistant
 * sits three from the tail and a correction puts it at four, which `detail-4` still carries; on a
 * PLAN step it already sits four, and the correction puts it at five, which `detail-4` drops. So a
 * correction planted on a plan step costs that configuration the current turn's own thinking on
 * the step the owner spoke - measured, `newestReasoningSteps` 59/60 -> 58/60 on all three
 * trajectories - which is a true fact about a four-message window and not a fact about
 * corrections. Planted one step later it is nil, and the probe measures the thing it is named for.
 */
const CORRECTION_STEP = 13;
const CORRECTION_SPAN = 'the pooled connection ceiling is now 64 and applies around the clock';

/**
 * A correction the owner types in the middle of a running task.
 *
 * Nothing else in this fixture is a mid-task `user` message, and that is the gap it fills. Every
 * other probe asks about something garden produced, so every one of them is answered by a
 * mechanism that treats the material as recoverable tool output or as discardable reasoning. What
 * the owner types has neither property: no tool call brings it back, nothing re-pushes it, and a
 * window that loses it leaves the agent working to an instruction that was withdrawn.
 *
 * Short on purpose. Length was tried and measured: at 3,000 characters the message adds 1.14% to
 * tokens-per-task on the small window, which is over half the 2% tolerance `check` allows for a
 * real regression, and it buys nothing - the verbatim-user pass this length was meant to reach is
 * never entered on any of these trajectories at any configuration (measured at 40,000 characters
 * with `VERBATIM_USER_CHARS` patched to 400: the probe still reads 5.00). At 600 it costs 0.19%.
 */
export const correctionAt = (step: number, trajectory?: Trajectory): ModelMessage | null => {
  const accumulating = accumulatedCorrectionAt(step, trajectory);
  if (accumulating) return accumulating;
  return step === CORRECTION_STEP
    ? {
        role: 'user',
        content: embed(`Stopping you there. ${text(600, 'correction')}`, CORRECTION_SPAN, 0.5)
      }
    : null;
};

/**
 * How often, and how long, the owner keeps typing on a trajectory built to show that.
 *
 * The one mid-task correction above is 600 characters and lands once, which is the right fixture
 * for the axis it was written for and is exactly why it cannot see this one. The single variable
 * that decides whether compaction still works on a long task is how much owner text has piled up
 * behind it - `planCompaction` may not condense a `user` message, so the accumulation sits inside
 * the tail it is allowed to keep and eventually fills it - and on this fixture that variable was
 * held at its minimum. Measured on a real 8,159-step session recorded on this repository: 77
 * mid-task owner messages totalling 75,003 characters, which is 125 times the owner text of the
 * fixture over 136 times the steps - and that session is one where compaction still works, so the
 * fixture below deliberately carries more.
 *
 * WRITTEN AS A CADENCE RATHER THAN A LIST, because the count is now the variable that matters. The
 * bound on this class holds every candidate at `OWNER_MINIMUM_CHARS` at worst, so past
 * `budget / OWNER_MINIMUM_CHARS` candidates - around 141 on this trajectory's preamble, around 306
 * on a bare one - an equal share of the budget is below the length of the marker itself and a cut
 * stops paying for itself. Thirteen messages is a long way inside that line, so the fixture below
 * could show what the bound COSTS and could not show what it is for. The cadence is `step >= 8 &&
 * step % 4 === 0`, which over sixty steps is exactly the thirteen steps this used to list, so the
 * shorter fixture is byte-identical to the one its baseline was accepted at.
 */
const accumulatedCorrectionStep = (step: number): boolean => step >= 8 && step % 4 === 0;
/** The last step at which the owner types, which is the one message the bound may never touch. */
const lastAccumulatedStep = (steps: number): number => {
  for (let step = steps - 1; step >= 0; step -= 1) if (accumulatedCorrectionStep(step)) return step;
  return -1;
};
const ACCUMULATED_CORRECTION_CHARS = 14_000;
/** The opening of the FIRST accumulated correction: a cut keeps the head, so this must survive. */
export const ACCUMULATED_FIRST_OPENING =
  'Stop using the writer pool for reads, the read replica is what that traffic belongs on';
/** The middle of the same message: this is exactly what a cut removes, and it is measured saying so. */
export const ACCUMULATED_FIRST_MIDDLE =
  'the archive box in the rack is on spinning disks and must never be given more than 6 sessions';
/** The newest correction, which is never a candidate for the bound and must survive whole. */
export const ACCUMULATED_NEWEST =
  'forget the retry budget entirely, the pooler is allowed to queue for 900 ms and then fail';

const accumulatedCorrectionAt = (step: number, trajectory?: Trajectory): ModelMessage | null => {
  if (!trajectory?.ownerKeepsTyping) return null;
  if (!accumulatedCorrectionStep(step)) return null;
  const body = text(ACCUMULATED_CORRECTION_CHARS, `pasted-${step}`);
  const first = step === 8;
  const newest = step === lastAccumulatedStep(trajectory.steps);
  if (first)
    return {
      role: 'user',
      content: embed(embed(body, ACCUMULATED_FIRST_OPENING, 0), ACCUMULATED_FIRST_MIDDLE, 0.5)
    };
  if (newest) return { role: 'user', content: embed(body, ACCUMULATED_NEWEST, 0.5) };
  return { role: 'user', content: body };
};

const ARTIFACT_PATHS = [
  'workspace/infra/pooler.ini',
  'workspace/src/db/pool.ts',
  'workspace/services/notifications/config.json',
  'workspace/docs/runbook-pool.md',
  'workspace/infra/pgbouncer-userlist.txt'
] as const;

export const PROBES: readonly Probe[] = [
  {
    id: 'recall-owner-constraint',
    kind: 'recall',
    plantedAtStep: -1,
    askedAtStep: 55,
    question: 'What connection ceiling did the owner impose, and when does it apply?',
    reference: `${OWNER_GOAL_CONSTRAINT}.`,
    evidence: [OWNER_GOAL_CONSTRAINT],
    // The goal is never dropped by any pass, so nothing is ever re-read to recover it.
    reworkChars: 0
  },
  {
    id: 'recall-pool-ceiling',
    kind: 'recall',
    plantedAtStep: 4,
    askedAtStep: 12,
    question: 'What value was pool_max_conn set to in the configuration that was read earlier?',
    reference: 'pool_max_conn = 137.',
    evidence: ['pool_max_conn = 137'],
    reworkChars: 18_000
  },
  {
    id: 'recall-sqlstate',
    kind: 'recall',
    plantedAtStep: 10,
    askedAtStep: 14,
    question: 'Which SQLSTATE did the replica raise, and which replica raised it?',
    reference: 'SQLSTATE 53300 too_many_connections, on replica two.',
    evidence: ['SQLSTATE 53300 too_many_connections on replica two'],
    reworkChars: 12_000
  },
  {
    id: 'recall-migration-id',
    kind: 'recall',
    plantedAtStep: 33,
    askedAtStep: 41,
    question: 'Which migration applied the pool ceiling, and how long did it take?',
    reference: 'migration 0067, the pool ceiling, applied in 1420 ms.',
    evidence: ['migration 0067 pool ceiling applied in 1420 ms'],
    reworkChars: 12_000
  },
  {
    /**
     * Planted one step before it is asked for, which reads like a control and is not.
     *
     * At request time the tail of the window is not the assistant turn. `refreshRuntimeContext`
     * (agent.ts:9144, called at agent.ts:9798 on every step) removes and re-pushes the runtime
     * block at the very end, and `refreshActivePlan` and the step-budget notice push there too. So
     * the newest assistant message sits at least three from the end and often five, and the detail
     * boundary is `index < messages.length - RECENT_DETAIL_MESSAGES`.
     *
     * At 8 the current turn's own thinking is inside the window. At 2 it is outside it: the model
     * is asked to take its next step having had the thoughts that produced the last one deleted
     * from the request. That is not a defect - `openai-compatible.ts:781-793` already carries a
     * fallback for the inverse case, so nothing breaks - and it is precisely the kind of change
     * that passes 49/49 while altering what the model can think with.
     */
    id: 'recall-newest-reasoning',
    kind: 'recall',
    plantedAtStep: 26,
    askedAtStep: 27,
    question: 'What did the replica lag peak at during the dry run?',
    reference: '4812 ms.',
    evidence: ['replica lag peaked at 4812 ms during the dry run'],
    // Reasoning is the agent's own thinking. No tool call brings it back, at any price.
    reworkChars: 0
  },
  {
    id: 'decision-pooling-mode',
    kind: 'decision',
    plantedAtStep: 6,
    askedAtStep: 9,
    question: 'Which pooling mode was chosen, and what was the stated reason?',
    reference:
      'Transaction pooling, over session pooling, because each task opens four short-lived connections.',
    evidence: [
      'transaction pooling was chosen over session pooling because each task opens four short-lived connections'
    ],
    reworkChars: 0
  },
  {
    /**
     * The pair to `decision-pooling-mode`: one decision, stated once in thinking and once out
     * loud. Prose is not touched by the detail boundary at all, so the two together separate "the
     * detail window costs decisions" from the true and much narrower "the detail window costs
     * decisions the agent never said out loud".
     */
    id: 'decision-pooling-mode-prose',
    kind: 'decision',
    plantedAtStep: 6,
    askedAtStep: 9,
    question: 'Was session pooling used for the writer pool?',
    reference: 'No, it was ruled out.',
    evidence: ['session pooling was ruled out for the writer pool'],
    reworkChars: 0
  },
  {
    id: 'decision-notify-rejected',
    kind: 'decision',
    plantedAtStep: 18,
    askedAtStep: 21,
    question: 'Was LISTEN/NOTIFY adopted, and why?',
    reference:
      'No. It was rejected because transaction pooling drops the session that owns the listener.',
    evidence: [
      'LISTEN NOTIFY was rejected because transaction pooling drops the session that owns the listener'
    ],
    reworkChars: 0
  },
  {
    /**
     * The plan as the agent narrated it in prose at step 7. Prose is not state: nothing re-pushes
     * it, a compaction condenses it like any other turn, and what survives is whatever the
     * summariser chose to keep. Read against `continuation-plan-block` directly below, which is
     * the same question asked of the mechanism garden actually maintains for this.
     */
    id: 'continuation-plan-order',
    kind: 'continuation',
    plantedAtStep: 7,
    askedAtStep: 30,
    question: 'What is step 5 of the plan agreed at the start of this task?',
    reference: 'Re-point the notifications service.',
    evidence: ['(5) re-point the notifications service'],
    reworkChars: 0
  },
  {
    /**
     * The same fact carried by the durable plan block instead. This is expected to score 5.0 in
     * every configuration on every window, and it is not a control - it is the finding: a fact
     * held in a re-rendered block is out of reach of every mechanism in `context.ts`, and a fact
     * held in the conversation is not. Anything a long task must not lose belongs in a block.
     */
    id: 'continuation-plan-block',
    kind: 'continuation',
    plantedAtStep: 2,
    askedAtStep: 55,
    question: 'According to the active plan, what is step 5?',
    reference: 'Re-point the notifications service.',
    // The status at step 55, not a guess: five plan versions have landed by then, so step 5 is
    // the one in progress. A probe that named the wrong status would score zero and read as a loss.
    evidence: ['5. [in_progress] Re-point the notifications service'],
    reworkChars: 0
  },
  {
    id: 'continuation-resume-next',
    kind: 'continuation',
    plantedAtStep: 44,
    askedAtStep: 47,
    question: 'What is the next action, and against which port?',
    reference: 'Re-point the notifications service at the pooler on port 6432.',
    evidence: ['re-point the notifications service at the pooler on port 6432'],
    reworkChars: 0
  },
  {
    /**
     * The owner changing their mind mid-task, asked for thirty-three steps later.
     *
     * A control, in the sense `recall-owner-constraint` is one: it reads 5.00 in every shipped
     * configuration and is not expected to move, and that is the point rather than a weakness.
     * What carries it is `context.ts`'s `if (message.role === 'user') continue;` in
     * `condensableWindow` - a guard whose own comment names exactly this content, "the
     * corrections, the changes of mind, the 'not that one, the other one' that is the only
     * steering channel a running task has". Before that guard a mid-task correction went through
     * the summariser like any other line and what survived was the model's account of it, which is
     * the text least able to correct the model. Nothing in this rig could see that.
     *
     * It is a control rather than a variable because no integer can reach it. `configurations.ts`
     * makes a configuration by substituting integer literals, and the mechanism here is a boolean
     * guard - so the column is saturated by construction, not because the probe stopped reading
     * the window. Verified by deleting the guard in a scratch copy of the rig: this probe drops
     * 5.0 -> 0.0 on both compacted trajectories and holds 5.0 on the uncompacted one, where
     * nothing is condensed and there is nothing for the guard to protect against.
     */
    id: 'recall-user-correction',
    kind: 'recall',
    plantedAtStep: 13,
    askedAtStep: 45,
    question: 'What did the owner change their mind about part-way through, and to what?',
    reference: 'The pooled connection ceiling is now 64 and applies around the clock.',
    evidence: [CORRECTION_SPAN],
    // Nothing brings back what the owner typed. Asking again is a question, not a tool call.
    reworkChars: 0
  },
  {
    /**
     * The probe the published work says is the worst of the four, at 2.45/5 for the winning
     * method, and the reason it names is structural rather than fixable by a better summary: a
     * running list of side effects is state, and a summariser is asked to write prose.
     */
    id: 'artifact-files-touched',
    kind: 'artifact',
    plantedAtStep: 8,
    askedAtStep: 45,
    question: 'List every file this task has written or modified so far.',
    reference: ARTIFACT_PATHS.join(', '),
    evidence: ARTIFACT_PATHS,
    // Recovering the set means listing the workspace and diffing it, not re-running one call.
    reworkChars: 4_000
  },
  {
    /**
     * The same question asked of the mechanism garden now maintains for it, and the pair to
     * `artifact-files-touched` in exactly the way `continuation-plan-block` is the pair to
     * `continuation-plan-order`.
     *
     * The evidence is one verbatim row of the ARTIFACTS WRITTEN block, and the row is the point: the
     * path is in the window four other ways (the call's arguments, the result's head, the anchor
     * index, the brief), but "2180 bytes, on step 8, and the whole file was replaced" is one fact in
     * one place and it is the fact a rewind dialog is asking for. Nothing else in this trajectory
     * states it, so this probe reads the block or it reads nothing.
     *
     * Expected 5.0 in every configuration and 0.0 in `starved`, which sets ARTIFACT_LEDGER_ROWS to
     * zero - the block's own destructive end, and the arm that keeps the artifact column honest now
     * that the ledger holds the paths through a compaction.
     */
    id: 'artifact-ledger-row',
    kind: 'artifact',
    plantedAtStep: 8,
    askedAtStep: 45,
    question:
      'How large was workspace/infra/pooler.ini when this task last wrote it, and at which step?',
    reference: '2,180 bytes, written whole at step 8.',
    evidence: ['workspace/infra/pooler.ini | wrote | 2180 bytes | step 8'],
    // A byte count and a step number are not re-obtainable by one call: the file has been written
    // since, and no tool answers "how big was it when you wrote it".
    reworkChars: 0
  }
];

/**
 * What a bound on the owner's accumulated text costs, and what it keeps, asked in three places.
 *
 * Every one of these is a `user` message, so `reworkChars` is 0 on all three: no tool call brings
 * back something the owner typed, which is the whole reason the class is protected and the whole
 * reason a bound on it has to be argued for rather than assumed. They are counted as unrecoverable
 * losses when they go, which is the honest column for them.
 *
 * The three positions are the experiment. A cut keeps the leading 62% and the trailing remainder,
 * so the opening of a superseded message survives a bound that removes its middle - and the newest
 * correction is never a candidate at all. A change that loses the opening or the newest has taken
 * the steering channel, not the accumulation.
 */
export const OWNER_PROBES: readonly Probe[] = [
  {
    id: 'owner-earliest-opening',
    kind: 'recall',
    plantedAtStep: 8,
    askedAtStep: 58,
    question:
      'Which pool did the owner tell you to stop using for reads, and what should serve them?',
    reference: 'Stop using the writer pool for reads; the read replica serves them.',
    evidence: [ACCUMULATED_FIRST_OPENING],
    reworkChars: 0
  },
  {
    id: 'owner-earliest-middle',
    kind: 'recall',
    plantedAtStep: 8,
    askedAtStep: 58,
    question: 'What session limit did the owner put on the archive box, and why?',
    reference: 'Never more than 6 sessions, because it is on spinning disks.',
    evidence: [ACCUMULATED_FIRST_MIDDLE],
    reworkChars: 0
  },
  {
    id: 'owner-newest',
    kind: 'recall',
    plantedAtStep: 56,
    askedAtStep: 58,
    question:
      'How long may the pooler queue before it fails, and what happened to the retry budget?',
    reference: 'It may queue for 900 ms and then fail; the retry budget is gone.',
    evidence: [ACCUMULATED_NEWEST],
    reworkChars: 0
  }
];

/**
 * The same three questions, asked at a length where the class stops being holdable by cutting.
 *
 * `OWNER_PROBES` asks at step 58 of a sixty-step fixture carrying thirteen accumulated messages,
 * which is inside the region where every candidate still fits above `OWNER_MINIMUM_CHARS`. The
 * defect this rig could not see lives past `budget / OWNER_MINIMUM_CHARS` candidates - about 141
 * behind this trajectory's preamble - where an equal share of the budget is below the marker's own
 * length, a cut stops paying for itself, and the class costs 240 characters a message however many
 * of them there are. These are the same probes at 150 accumulated messages instead of 13.
 *
 * What each one is for, and they are deliberately not all in the same direction:
 *
 *   the goal          never a candidate, and it is the single fact that has to survive any length;
 *   the newest        never a candidate either, and it is the correction not yet acted on;
 *   the earliest      the OLDEST of the middles, which is the first thing the eviction order gives
 *                     up - so this one is expected to read 0.0 on every bounded configuration and
 *                     5.0 with the bound off, and that difference is the price of the bound stated
 *                     as a number rather than as a paragraph.
 */
const longOwnerProbes = (steps: number): readonly Probe[] => {
  const asked = steps - 1;
  return [
    {
      id: 'long-owner-goal',
      kind: 'recall',
      plantedAtStep: -1,
      askedAtStep: asked,
      question: 'What connection ceiling did the owner impose, and when does it apply?',
      reference: `${OWNER_GOAL_CONSTRAINT}.`,
      evidence: [OWNER_GOAL_CONSTRAINT],
      reworkChars: 0
    },
    {
      id: 'long-owner-newest',
      kind: 'recall',
      plantedAtStep: lastAccumulatedStep(steps),
      askedAtStep: asked,
      question:
        'How long may the pooler queue before it fails, and what happened to the retry budget?',
      reference: 'It may queue for 900 ms and then fail; the retry budget is gone.',
      evidence: [ACCUMULATED_NEWEST],
      reworkChars: 0
    },
    {
      id: 'long-owner-earliest-opening',
      kind: 'recall',
      plantedAtStep: 8,
      askedAtStep: asked,
      question:
        'Which pool did the owner tell you to stop using for reads, and what should serve them?',
      reference: 'Stop using the writer pool for reads; the read replica serves them.',
      evidence: [ACCUMULATED_FIRST_OPENING],
      reworkChars: 0
    }
  ];
};

export interface Trajectory {
  readonly id: string;
  readonly why: string;
  readonly contextTokens: number;
  readonly steps: number;
  /** The step at which the agent declares a phase finished, as the two `long-` eval fixtures do. */
  readonly declaredCompactionStep: number | null;
  readonly probes: readonly Probe[];
  /**
   * Whether the owner keeps typing long corrections as the task runs.
   *
   * Off everywhere but one trajectory, and off by default, so the three rows this rig has always
   * reported keep the shape they were accepted at. @see accumulatedCorrectionAt.
   */
  readonly ownerKeepsTyping?: boolean;
}

/** The preamble `agent.ts:8586-8799` assembles, in its order and at its sizes. */
export const preambleFor = (): ModelMessage[] => [
  { role: 'system', content: BASE_SYSTEM_PROMPT },
  {
    role: 'system',
    content: `WORKSPACE BRIEF (user-visible persistent project context)\n${text(2_400, 'brief')}`
  },
  {
    role: 'system',
    content: `CURATED ENCRYPTED KNOWLEDGE (user-visible and review-controlled; frozen for this run)\n${text(3_600, 'knowledge')}`
  },
  {
    role: 'system',
    content: `RECALLED MEMORY PACK (retrieved once at task start)\n${text(3_250, 'pack')}`
  },
  {
    role: 'user',
    content: `Move every service off the direct database role and onto a connection pooler. ${OWNER_GOAL_CONSTRAINT}. ${text(400, 'goal')}`
  }
];

/** One step's assistant turn and the result that answers it, identical for every configuration. */
export interface TrajectoryStep {
  readonly assistant: ModelMessage;
  readonly result: ModelMessage;
}

/**
 * The seeded size sequence, reproduced exactly for every configuration.
 *
 * Drawn per step from one seed rather than from a shared generator, so a run that scores a subset
 * of steps produces the same sizes as a run that scores all of them.
 */
const sizeAt = (step: number): number => {
  let seed = 20_260_303;
  for (let index = 0; index <= step; index += 1)
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return RESULT_SIZES[Math.floor((seed / 2_147_483_648) * RESULT_SIZES.length)] ?? 6_400;
};

export const stepAt = (step: number): TrajectoryStep => {
  const plant = PLANTS.get(step);
  const write = plant?.write;
  let prose = text(420, `answer-${step}`);
  if (plant?.prose) prose = embed(prose, plant.prose, 0.2);
  let reasoning = text(1_200, `thinking-${step}`);
  if (plant?.reasoning) reasoning = embed(reasoning, plant.reasoning, 0.3);

  const assistant: ModelMessage = {
    role: 'assistant',
    content: prose,
    reasoning,
    reasoningDetails: [{ type: 'reasoning.text', text: text(900, `detail-${step}`) }],
    toolCalls: [
      write
        ? {
            id: `call-${step}`,
            name: 'file_write',
            arguments: { path: write.path, content: text(write.bytes, `written-${step}`) }
          }
        : // Every seventh call carries arguments past COMPACTED_TOOL_ARGUMENT_CHARS, so the
          // argument half of the detail boundary is crossed as well as the reasoning half.
          step % 7 === 6
          ? {
              id: `call-${step}`,
              name: 'code_search',
              arguments: {
                pattern: `connect\\(${step}\\)`,
                note: text(6_000, `why-${step}`)
              }
            }
          : {
              id: `call-${step}`,
              name: 'file_read',
              arguments: {
                path: `workspace/logs/service-${step}.log`,
                note: text(180, `why-${step}`)
              }
            }
    ]
  };

  const chars = write ? write.resultChars : sizeAt(step);
  let body = text(chars, write ? `wrote-${step}` : `log-${step}`);
  if (plant?.resultHead) body = embed(body, plant.resultHead, 0.05);
  if (plant?.resultMiddle) body = embed(body, plant.resultMiddle, 0.5);
  /*
   * Only a `file_read` result is shaped, because only a `file_read` result is numbered.
   *
   * A write echoes back what was written and a search returns matches with their own addressing;
   * neither goes through `renderNumbered` in `apps/worker/src/tools/workspace.ts`, and shaping them
   * here would spread the surcharge over results that do not pay it and understate what a read
   * costs by flattering the average.
   */
  const isRead = !write && step % 7 !== 6;
  if (isRead) body = shapeReadBody(body, [plant?.resultHead ?? '', plant?.resultMiddle ?? '']);

  const result: ModelMessage = {
    role: 'tool',
    toolCallId: `call-${step}`,
    content: serializeToolResultForModel(
      write
        ? { ok: true, path: write.path, bytesWritten: write.bytes, content: body }
        : {
            ok: true,
            path: `workspace/logs/service-${step}.log`,
            lines: Math.floor(chars / 80),
            content: body
          }
    )
  };
  return { assistant, result };
};

/**
 * The same sixty-step script on both shipped context windows, and once with nothing declared.
 *
 * The two window sizes disagree on purpose: the small window's older-result floor descends all the
 * way to 2,000 characters and re-cuts every older result on the way, the large one's barely moves.
 * A configuration that costs quality on one and nothing on the other is exactly the shape the last
 * three briefed changes to `context.ts` turned out to have.
 *
 * The undeclared row separates the two mechanisms. With a declaration the window is condensed into
 * the running brief - content leaves the window and only what the summariser wrote survives. With
 * none, nothing is condensed and every loss is truncation. They fail differently and a single row
 * would report their sum.
 */
export const TRAJECTORIES: readonly Trajectory[] = [
  {
    id: `pool-migration-131k${SHAPE_SUFFIX}`,
    why: 'The smallest shipped window, where the older-result floor descends all the way. Both mechanisms run.',
    contextTokens: 131_072,
    steps: 60,
    declaredCompactionStep: 30,
    probes: PROBES
  },
  {
    id: `pool-migration-1m${SHAPE_SUFFIX}`,
    why: 'The largest shipped window, where the floor barely moves and the detail boundary is almost the only thing cutting.',
    contextTokens: 1_000_000,
    steps: 60,
    declaredCompactionStep: 30,
    probes: PROBES
  },
  {
    /**
     * The name is about the DECLARED pass, not about compaction. Nothing declares a phase here, so
     * the only thing that can fire is the budget trigger - and it does, once, at step 52. Measured
     * by printing the step of every successful `compactContext` through the shipped module: 131k
     * and 1m compact at their declared step 30 and nowhere else, this trajectory compacts at 52,
     * `-owner` at 34 and 47, `-owner-long` 56 times beginning at 34. The `refuse` column prints
     * `refused/attempted`, so with no refusals its denominator is the number of compactions and the
     * `0/1` on this row has said so all along, while the row's own summary said the opposite. Of
     * the fourteen probes here, the twelve asked at or before step 52 are measuring truncation
     * alone; `recall-owner-constraint` and `continuation-plan-block`, both asked at 55, are not.
     */
    id: `pool-migration-131k-uncompacted${SHAPE_SUFFIX}`,
    why: 'The same job with the phase never declared, so no compaction crosses the first fifty steps and the losses there are truncation alone. The budget trigger still fires once, at step 52.',
    contextTokens: 131_072,
    steps: 60,
    declaredCompactionStep: null,
    probes: PROBES
  },
  {
    /**
     * The trajectory the other three could not be: one where the owner keeps typing.
     *
     * Everything above holds the owner's mid-task text at 600 characters landing once, and that is
     * the single variable which decides whether compaction still works on a long task - so on this
     * rig automatic compaction always had something to condense and the `refuse` column was zero
     * by construction. On real work it is not: replayed on an 8,159-step session recorded on this
     * repository with the owner's own text on it scaled to 171,196 characters, 651 of 888 attempts
     * came back with no candidate at all, because the owner's accumulated turns are the one class
     * `planCompaction` may not touch and they had filled the space between the protected head and
     * the tail it has promised to keep.
     *
     * Thirteen pasted messages of 14,000 characters is 182,000 characters of owner text over sixty
     * steps, which crosses that line around step 40 - the same crossing the scaled session makes
     * at step 5,700, reached inside a fixture that still runs in a few seconds. The phase is never
     * declared, so every compaction here is the budget trigger and the `refuse` column is
     * measuring the thing it is named for.
     *
     * `owner-earliest-opening` reads 0.0 on every bounded configuration here and 5.0 with the
     * bound off, and that is the price of holding the class to ONE budget rather than to
     * `n x OWNER_MINIMUM_CHARS`. A message this bound has already cut may not be cut again - the
     * marker's count would then be true of the string in front of it and false about what the
     * owner wrote - so once thirteen cut messages fill the budget exactly, the fourteenth arrives
     * and the oldest of them is given up whole rather than shaved. Availability fell 4.12 -> 3.82
     * and unrecoverable losses 3 -> 4 when that landed, on this row and on the eight bounded
     * configurations beside it; `owner-unbounded` and `starved` did not move, because the bound is
     * off in one and differently set in the other. `docs/design/finish/DEGRADATION.md` states what
     * would recover it and what has to be settled first.
     */
    id: `pool-migration-131k-owner${SHAPE_SUFFIX}`,
    why: 'The owner keeps typing: 182,000 characters of mid-task correction, which is the one class compaction may not condense and the reason it stops working on a long task.',
    contextTokens: 131_072,
    steps: 60,
    declaredCompactionStep: null,
    ownerKeepsTyping: true,
    probes: [...PROBES, ...OWNER_PROBES]
  },
  {
    /**
     * The same shape at the length where the bound stops being a bound by cutting alone.
     *
     * Sixty steps is thirteen accumulated messages, and thirteen is a long way inside the line the
     * defect lives past. Six hundred steps is 150 of them - 2,100,000 characters of owner text -
     * which is past `budget / OWNER_MINIMUM_CHARS` on this preamble, so every candidate is at the
     * floor and the class costs 240 characters a message with nothing bounding the count. That is
     * the state the row above could not reach and therefore could not price: measured through this
     * file's own path at six thousand steps, `planCompaction` refused 3,953 of 5,937 attempts and
     * the deterministic soft pass stood in for the mechanism on 5,715 of the 6,000 steps.
     *
     * Six hundred rather than six thousand because the rig runs every configuration against every
     * trajectory and `owner-unbounded` is unbounded by construction - the cost of the row is set
     * by the arm that has no bound on it, not by the shipped one. Six hundred crosses the line and
     * still runs in seconds; the unit proof in `context.test.ts` carries 3,000 and 6,000.
     */
    id: `pool-migration-131k-owner-long${SHAPE_SUFFIX}`,
    why: 'The owner keeps typing for 600 steps: 150 accumulated messages, past the count at which holding the class by cutting alone stops being possible. The `refuse` column and the earliest-owner probe are the two halves of what the bound costs and buys.',
    contextTokens: 131_072,
    steps: 600,
    declaredCompactionStep: null,
    ownerKeepsTyping: true,
    // `PROBES` as well as the long set, and not only for coverage: every one of them is asked at
    // step 55 to 58, so they measure the same early window the sixty-step rows measure, on a task
    // that then runs ten times longer. A row carrying one probe kind reports the other three as
    // NaN, which is a hole in the table rather than a finding.
    probes: [...PROBES, ...longOwnerProbes(600)]
  }
];
