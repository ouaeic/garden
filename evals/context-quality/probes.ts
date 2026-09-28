/**
 * What a probe is, and what a probe can be scored on without a model.
 *
 * `evals/harness.ts` asserts `modelCalls`, `tools`, `status`, `minCachePrefix`, `compactions` and
 * a dozen more counters. Every one of them is a count. None of them is an answer, and structurally
 * none of them can be: the model in that rig is a function of what garden just said, so a fixture
 * that narrows the model's window by 75% produces the identical scripted reply and reports green.
 * Every recommendation that changes what the model *sees* is therefore unfalsifiable there.
 *
 * A probe closes that. Take a real long-running trajectory, compress its earlier portion through
 * garden's own production path at some configuration, then ask a question that can only be
 * answered from the part that was compressed. Four kinds, because they fail differently:
 *
 *   recall        one specific fact stated once, early, and never repeated;
 *   artifact      "which files did we modify, and how?" - the union of a run's side effects;
 *   continuation  can the agent correctly resume the next step;
 *   decision      a choice made early, with the reason it was made for.
 *
 * The published result this design comes from grades those 0-5 with a judge blinded to which
 * method produced the answer, and reports artifact tracking as the worst of the four at 2.45/5
 * even for the winning method - "may need dedicated state tracking beyond summarization". Expect
 * garden to score badly there too, and report it rather than tune the probe until it passes.
 *
 * ── The part that runs with no model, and exactly what it is worth ────────────────────────────
 *
 * A judge needs a provider key. A gate that only runs where a key is present is a gate that never
 * runs. So each probe also declares the literal spans that must survive into the prepared window
 * for the question to be answerable AT ALL, and those are checkable with `String.includes`.
 *
 * This is an UPPER BOUND on the judged score and is named that way everywhere it is reported. If
 * the bytes are gone the model cannot answer and the judged score is 0; if the bytes are present
 * the model still has to find them among a hundred thousand tokens and may not. Availability is
 * necessary and not sufficient. Reporting it as a quality score would repeat the exact error this
 * whole step exists to correct - measuring the thing that is easy to count and calling it the
 * thing that matters.
 *
 * What it is genuinely good for: availability is the axis a context configuration MOVES. A change
 * to `RECENT_DETAIL_MESSAGES` cannot make a model better at finding a fact; it can only decide
 * whether the fact is in the request. So the deterministic subset measures the whole of the effect
 * a context change has on the numerator, and the judge measures how much of it the model converts.
 */
import type { ModelMessage } from '../../packages/model-gateway/src/index.js';

export type ProbeKind = 'recall' | 'artifact' | 'continuation' | 'decision';

export const PROBE_KINDS: readonly ProbeKind[] = ['recall', 'artifact', 'continuation', 'decision'];

export interface Probe {
  readonly id: string;
  readonly kind: ProbeKind;
  /**
   * Where the evidence entered the window. Distance from `askedAtStep` is the whole experiment:
   * one step appends two messages, so `RECENT_DETAIL_MESSAGES = 8` is about four steps of history
   * and `= 2` is about one. A probe set clustered at one distance measures one constant.
   */
  readonly plantedAtStep: number;
  /** The step at which this trajectory needs the fact back. Scored on that step's window. */
  readonly askedAtStep: number;
  /** Put to the answering model in judged mode. Never mentions where the answer might be. */
  readonly question: string;
  /** The correct answer. Given to the judge, never to the answering model. */
  readonly reference: string;
  /**
   * Spans that must appear verbatim in the prepared window for the question to be answerable.
   *
   * Plain ASCII with no quotes or backslashes, because a tool result reaches the model as a JSON
   * string and anything needing an escape would stop matching itself.
   */
  readonly evidence: readonly string[];
  /**
   * Characters of tool output the agent would have to fetch again to recover this, when it is
   * gone. Feeds the tokens-per-task model in `measure.ts`; see the note there about what that
   * number is and is not.
   */
  readonly reworkChars: number;
}

/**
 * Everything in a prepared window that the model can read.
 *
 * Not just `content`: `openai-compatible.ts:714-744` puts `reasoning`, `reasoning_details` and
 * each tool call's serialized arguments on the wire as well, and two of the four probe kinds are
 * about material that lives in exactly those fields. Scoring `content` alone would report the
 * reasoning window as free, which is the mistake this file exists to prevent.
 */
export const readableWindow = (messages: readonly ModelMessage[]): string => {
  const pieces: string[] = [];
  for (const message of messages) {
    pieces.push(message.content);
    if (message.reasoning) pieces.push(message.reasoning);
    if (message.reasoningDetails?.length) pieces.push(JSON.stringify(message.reasoningDetails));
    for (const call of message.toolCalls ?? [])
      pieces.push(`${call.name} ${JSON.stringify(call.arguments)}`);
  }
  return pieces.join('\n');
};

export interface ProbeReading {
  readonly probeId: string;
  readonly kind: ProbeKind;
  readonly step: number;
  /** Share of the probe's evidence spans still present verbatim. */
  readonly retained: number;
  readonly missing: readonly string[];
}

export const readProbe = (probe: Probe, window: string, step: number): ProbeReading => {
  const missing = probe.evidence.filter((span) => !window.includes(span));
  return {
    probeId: probe.id,
    kind: probe.kind,
    step,
    retained: (probe.evidence.length - missing.length) / Math.max(1, probe.evidence.length),
    missing
  };
};

/**
 * The most a blinded judge could award, given what is in the request.
 *
 * Deliberately on the judge's own 0-5 scale so the two runs can be printed in one column and the
 * gap between them read directly: the ceiling is what the configuration allows, the judged score
 * is what the model achieved, and the difference is retrieval difficulty rather than truncation.
 */
export const judgeCeiling = (retained: number): number => Math.round(retained * 5 * 10) / 10;
