/**
 * The three questions asked at the end of every step, and the one way a turn ends when any of
 * them is answered badly.
 *
 * They are three because they are blind to each other by construction:
 *
 *   - **idle** - the step asked for tools and started none. A turn that says everything and does
 *     nothing.
 *   - **repeated failure** - a call ran, threw, and threw the same way it did last time. A step
 *     cannot trip this and idle both: a call that runs and throws has started a tool, which zeroes
 *     the idle count, and a step that started nothing has nothing here to count.
 *   - **stationary** - a call that started, ran and *succeeded* - identically - twelve times. The
 *     one shape the other two cannot see, and derived from the window rather than from a counter,
 *     so it survives the compaction, the approval pause and the worker handover that a counter in
 *     the loop's own frame would not.
 *
 * Each has two rungs: a sentence pushed into the window at the lower count, and, at the higher one,
 * the turn ended. The ending is the part that was written out three times inside the loop -
 * warning event, outstanding-plan read that must not throw, `completeTurn` with `interrupted: true`
 * and a `not_applicable` verification carrying one sentence of explanation. `stopTurn` below is
 * that shape said once; the three sentences it is given are the three originals to the byte.
 *
 * Ended rather than raised, in all three cases: whatever the model has said is still the owner's,
 * the plan and the artifacts are still there, and a reply carries the conversation on. What the
 * owner is owed is the reason, and it goes where they already read reasons - the caveat on the
 * completion, beside the work.
 */
import type { DataStore, TaskRecord } from '@garden/data';
import type { AgentState } from '../agent-state.js';
import type { CompletionVerification } from '../completion.js';
import {
  IDLE_STEPS_BEFORE_STOP,
  MAX_IDLE_STEPS,
  MAX_REPEATED_FAILURES,
  REPEATED_FAILURES_BEFORE_STOP,
  idleStepBreak,
  idleStepsAfter,
  repeatedFailureBreak,
  repeatedFailureRise,
  stationaryStepBreak,
  stationaryStepRun,
  stationaryStepsBeforeStop
} from '../turn-bounds.js';
import { event } from '../tool-recording.js';

/** What ending a turn at one of these bounds needs from the worker that owns it. */
export interface StepBoundsDeps {
  readonly store: DataStore;
  outstandingPlanSteps(task: TaskRecord, key: Uint8Array): Promise<string[]>;
  completeTurn(
    task: TaskRecord,
    key: Uint8Array,
    state: AgentState,
    completion: {
      summary: string;
      verification: CompletionVerification;
      interrupted?: boolean;
      outstanding?: string[];
    }
  ): Promise<void>;
}

/** What the step that just ran did, which is the evidence all three bounds read. */
export interface StepOutcome {
  /** The tools the model asked for, in the order it asked for them. */
  readonly proposed: readonly string[];
  /** `state.toolsStarted` as it stood before the batch; the difference is what actually ran. */
  readonly startedBeforeBatch: number;
  /** `state.repeatedFailures` as it stood before the batch, for the same reason. */
  readonly failuresBeforeBatch: Readonly<Record<string, number>> | undefined;
}

/**
 * Ends the turn, honestly, and says why where the owner reads reasons.
 *
 * The summary is garden's own sentence rather than the model's last paragraph: these breaks only
 * fire on a step that asked for a tool, so whatever it wrote is prose written alongside a call -
 * the deliberation that caused the break. `completeTurn` publishes the summary as the reply when
 * the turn never spoke, so taking it from the model would put the spiral's last paragraph at the
 * top of the result card.
 */
const stopTurn = async (
  deps: StepBoundsDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  stop: {
    headline: string;
    payload: Record<string, unknown>;
    summary: string;
    /** The one sentence the owner is given, on the completion card, beside the work. */
    risk: string;
  }
): Promise<void> => {
  await event(deps.store, task, key, 'warning', stop.headline, stop.payload);
  const stillOpen = await deps.outstandingPlanSteps(task, key).catch(() => []);
  await deps.completeTurn(task, key, state, {
    summary: stop.summary,
    interrupted: true,
    ...(stillOpen.length ? { outstanding: stillOpen } : {}),
    verification: {
      status: 'not_applicable',
      evidence: [],
      remainingRisks: [stop.risk]
    }
  });
};

/**
 * Asks all three, in the order they cost, and reports whether the turn is over.
 *
 * Order matters between the second and third: a turn that is failing the same way should be told
 * the sharper of the two sentences, so the failure bound is asked before the stationary one.
 *
 * @returns true when the turn has been completed and the loop must return.
 */
export const enforceStepBounds = async (
  deps: StepBoundsDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  step: StepOutcome
): Promise<boolean> => {
  /*
   * The step is over; did anything happen in it.
   *
   * The one inversion of the silence hold, which holds a turn that did the work and never said
   * anything. This is a turn that says everything and does nothing, and this is the loop's
   * bound on it that a proposal cannot reset. Asked here rather than at the top of the
   * next step so the sentence lands in the same window the step it describes was billed for.
   */
  const idle = idleStepsAfter(state.idleSteps ?? 0, {
    proposed: [...step.proposed],
    started: (state.toolsStarted ?? 0) - step.startedBeforeBatch
  });
  if (idle !== undefined) state.idleSteps = idle;
  if (idle !== undefined && idle >= IDLE_STEPS_BEFORE_STOP) {
    await stopTurn(deps, task, key, state, {
      headline: 'Stopped a turn that had stopped moving',
      payload: { steps: idle },
      summary: `Stopped after ${idle} steps that asked for tools and started none.`,
      risk: `garden stopped this turn: ${idle} steps running asked for tools and started none, so the work was not moving. Reply to carry on, or say which way you want it decided.`
    });
    return true;
  }
  // Said again on every further step that starts nothing, with the number it has reached. A
  // sentence pushed once, four steps ago, under a thousand frames of the model's own prose, is
  // a sentence that is no longer in front of it - and the repeats are bounded by the stop above.
  if (idle !== undefined && idle >= MAX_IDLE_STEPS) {
    await event(deps.store, task, key, 'warning', `Nothing has run for ${idle} steps`, {
      steps: idle
    });
    state.messages.push({ role: 'system', content: idleStepBreak(idle) });
  }

  /*
   * And did any of it fail the way it failed last time.
   *
   * The step above and this one cannot both fire: a call that runs and throws has started a
   * tool, which zeroes the idle count, and a step that started nothing has nothing here to
   * count. They are the two halves of the same question - the first asks whether the turn is
   * still doing anything, the second whether what it is doing is still capable of working.
   */
  const repeated = repeatedFailureRise(step.failuresBeforeBatch, state.repeatedFailures);
  if (repeated && repeated.count >= REPEATED_FAILURES_BEFORE_STOP) {
    // The event carries the tool and the count and nothing else: the arguments are the owner's
    // file or the owner's command line, and the error can quote their own code back.
    await stopTurn(deps, task, key, state, {
      headline: 'Stopped a turn that was retrying a failure',
      payload: { tool: repeated.tool, attempts: repeated.count },
      summary: `Stopped after ${repeated.count} identical ${repeated.tool} calls that all failed the same way.`,
      risk: `garden stopped this turn: ${repeated.tool} was called ${repeated.count} times with the same arguments and failed the same way every time, so nothing it did in between was changing the outcome. Reply to carry on, or say which way you want it decided.`
    });
    return true;
  }
  if (repeated && repeated.count >= MAX_REPEATED_FAILURES) {
    await event(
      deps.store,
      task,
      key,
      'warning',
      `${repeated.tool} has failed ${repeated.count} times the same way`,
      { tool: repeated.tool, attempts: repeated.count }
    );
    state.messages.push({
      role: 'system',
      content: repeatedFailureBreak(repeated.count, repeated.tool)
    });
  }

  /*
   * And is it still doing anything different from what it did last step.
   *
   * The third of the three, and the one that sees the shape the other two are blind to by
   * construction: the step above needs a call that threw, the step above that needs a step that
   * started nothing, and the incident this was written for is a call that started, ran and
   * succeeded - identically - twelve times. Asked after both of them so that a turn which is
   * failing the same way is told the sharper of the two sentences; a step cannot trip both,
   * because a call that throws is answered with an error whose text the acting tier folds into
   * the signature only when it is byte-identical, and by then the failure guard has already
   * fired at a lower count.
   *
   * Derived from the window rather than from a counter, so it survives the compaction, the
   * approval pause and the worker handover that a counter in that frame would not.
   */
  const stationary = stationaryStepRun(state.messages, state.turnToolResults);
  if (stationary && stationary.steps >= stationaryStepsBeforeStop(stationary.limit)) {
    // The payload carries the signature rather than the arguments: sixteen bytes prove the steps
    // were identical, and the arguments they were identical *in* are the owner's own.
    await stopTurn(deps, task, key, state, {
      headline: 'Stopped a turn that had stopped changing',
      payload: {
        steps: stationary.steps,
        tools: stationary.tools,
        signature: stationary.signature
      },
      summary: `Stopped after ${stationary.steps} steps that all made the same ${stationary.tools.join(', ')} call.`,
      risk: `garden stopped this turn: ${stationary.steps} steps running made the identical ${stationary.tools.join(', ')} call, so the work had stopped moving. Reply to carry on, or say which way you want it decided.`
    });
    return true;
  }
  if (stationary && stationary.steps >= stationary.limit) {
    await event(
      deps.store,
      task,
      key,
      'warning',
      `The same ${stationary.tools.join(', ')} call has been made ${stationary.steps} steps running`,
      { steps: stationary.steps, tools: stationary.tools, signature: stationary.signature }
    );
    state.messages.push({
      role: 'system',
      content: stationaryStepBreak(stationary.steps, stationary.tools)
    });
  }
  return false;
};
