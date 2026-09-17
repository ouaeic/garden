/**
 * What one generation is allowed to spend before this side stops waiting for it.
 *
 * Measured on the owner's box: a task asked for a cartoon logo, ran twelve model calls and eighteen
 * tools, and then made a thirteenth call that streamed for a quarter of an hour and never finished.
 * A thousand and fifteen frames reached the timeline in that stretch and nothing else did - no tool
 * call, no completion, no usage - until the request deadline killed it and the whole turn with it.
 * The frames carry at least eight characters each and go out no faster than one per hundred and
 * twenty milliseconds, so the rate can be read straight off the count: roughly ten characters a
 * second, about a tenth of what a working route on this box produces, sustained for the entire
 * fifteen minutes. Around twelve thousand characters in total.
 *
 * That last number is why size alone is the wrong thing to watch. Twelve thousand characters is an
 * ordinary long answer; the model was not writing too much, it was writing too slowly, forever. The
 * bound that catches it is on time, and the bound on size is here for the different failure the
 * same file already has a scar from - a route that ignores the output ceiling in the request and
 * keeps going past it.
 */

/**
 * How long a generation may run, counted from the response headers rather than from the request, so
 * a route that is slow to accept the connection is not charged for the waiting. What it does cover
 * is the wait for the first token, which on a reasoning route is most of the wait - though not much
 * of it, because a route that holds its tongue for two minutes together trips the idle clock first.
 *
 * Ten minutes against a caller deadline of fifteen. The largest single answer this product ever
 * asks for is bounded by the request's own `maxTokens`, which on this box is at most 16,384; the
 * caller's fifteen-minute deadline therefore already demands about eighteen tokens a second of any
 * route writing a full-length answer, and this asks for twenty-seven. That is a small tightening of
 * a floor the owner's box has always had, and it comes with a large loosening of the consequence:
 * passing this deadline no longer throws away the turn. What was generated comes back marked, and
 * the caller decides. A genuine long answer that trips it loses one step, not the task.
 */
export const DEFAULT_GENERATION_TIMEOUT_MS = 600_000;

/**
 * Characters allowed per token of the output ceiling the caller declared.
 *
 * A backstop, not a cap: the cap is `max_tokens` on the request, and the provider enforces it. This
 * only fires where a route ignored that number by a wide margin, which has happened - seventeen
 * thousand output tokens arrived against a ceiling of sixteen thousand three hundred and eighty
 * four. English runs about four characters to the token and whitespace-heavy structured output a
 * little more, so eight leaves an answer that used its whole ceiling at twice the room it needs.
 */
export const GENERATION_CHARS_PER_TOKEN = 8;

/** Where the ceiling lands when a caller declared no output cap at all: far past any real answer. */
export const DEFAULT_GENERATION_MAX_CHARS = 400_000;

/**
 * Why this side ended a generation the model had not finished.
 *
 * `cancelled` is the caller's own signal rather than a clock: the repetition watch aborting a model
 * that has stopped saying anything new, or the owner pressing Stop. It is here because those tokens
 * were generated and billed exactly like the other three - the abort used to escape as an exception
 * and take the whole step's billing with it, so the one generation the box stops on purpose was the
 * one generation nobody ever paid for on paper.
 */
export type GenerationCutoff = 'stalled' | 'timeout' | 'overrun' | 'cancelled' | 'framing';

export const generationCharCeiling = (maxTokens: number | undefined): number =>
  maxTokens === undefined
    ? DEFAULT_GENERATION_MAX_CHARS
    : Math.max(maxTokens * GENERATION_CHARS_PER_TOKEN, GENERATION_CHARS_PER_TOKEN);

/**
 * Tokens a stretch of generated text is worth, for a call that was cut off before the provider sent
 * its usage frame. Four characters to the token is the same rough conversion the rest of the
 * product estimates a window with; it is an estimate and travels marked as one.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

export const estimatedOutputTokens = (characters: number): number =>
  Math.ceil(characters / ESTIMATED_CHARS_PER_TOKEN);

/**
 * Where a request stops being an ordinary one, in estimated input tokens.
 *
 * The idle clock is the only bound in this file that a request can trip while the route is behaving
 * perfectly. The others all measure what was written; this one measures the gap before anything is
 * written, and that gap is a function of the prompt: a route reads the whole window before it emits
 * a token, and a reasoning route deliberates over it as well. A flat deadline is therefore generous
 * on a small step and, on the largest step a task takes - which is also the most expensive one to
 * throw away and re-run - a live risk of abandoning a route that was about to answer.
 *
 * Two rungs rather than a curve, because the honest resolution of the underlying estimate is about
 * that: the bytes on the wire are known exactly and the tokens they cost are not.
 */
export const LARGE_REQUEST_TOKENS = 50_000;
export const HUGE_REQUEST_TOKENS = 100_000;

/**
 * The idle deadline this request gets, from the base deadline and the size of the assembled body.
 *
 * Measured in bytes because bytes are what the caller has in hand - the body has just been
 * serialised to be sent - and converted at the same four characters to the token the rest of this
 * file estimates with. A base of zero or less is the escape hatch that turns the deadline off
 * entirely and is handed straight back: multiplying "no deadline" is still no deadline, and
 * scaling it would only put a number where the caller asked for none.
 */
export const streamIdleTimeoutFor = (baseMs: number, requestBytes: number): number => {
  if (baseMs <= 0) return baseMs;
  const tokens = requestBytes / ESTIMATED_CHARS_PER_TOKEN;
  if (tokens >= HUGE_REQUEST_TOKENS) return Math.round(baseMs * 2);
  if (tokens >= LARGE_REQUEST_TOKENS) return Math.round(baseMs * 1.5);
  return baseMs;
};

/**
 * The rate below which asking a route to carry on from where it stopped is throwing good money
 * after bad.
 *
 * The loop upstream continues a cut-off answer, and it allows three continuations - four calls in
 * all. Four calls at this deadline is forty minutes, and the largest answer this product ever asks
 * for is 16,384 tokens, or about 65,500 characters. A route producing fewer than twenty-eight
 * characters a second cannot finish that answer inside those four calls however patiently it is
 * asked: it spends the forty minutes and is still cut off at the end. The measured failure produced
 * ten. A working route on this box produces well over a hundred.
 */
export const MIN_CONTINUABLE_CHARS_PER_SECOND = 28;

export interface GenerationBudget {
  /** Milliseconds until the deadline, or `Infinity` where no deadline was set. */
  remainingMs: () => number;
  /** Adds to the running total and answers whether the character ceiling has now been passed. */
  produced: (characters: number) => boolean;
  characters: () => number;
  /** The ceiling the budget was started with, for a caller bounding something alongside it. */
  maxChars: () => number;
  elapsedMs: () => number;
}

export const startGenerationBudget = (options: {
  timeoutMs: number;
  maxChars: number;
  /** Injected so tests do not have to spend the wall time they are asserting about. */
  now?: () => number;
}): GenerationBudget => {
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();
  let characters = 0;
  return {
    remainingMs: () =>
      options.timeoutMs > 0 ? options.timeoutMs - (clock() - startedAt) : Number.POSITIVE_INFINITY,
    produced: (count: number): boolean => {
      characters += count;
      return options.maxChars > 0 && characters > options.maxChars;
    },
    characters: () => characters,
    maxChars: () => options.maxChars,
    elapsedMs: () => clock() - startedAt
  };
};

/**
 * Whether a generation ended here was writing an answer worth carrying on with, or had simply
 * stopped being productive.
 *
 * An overrun never is: it has already written more than twice the longest answer the request
 * allowed for, so the one thing it does not need is more room. A cancellation never is either, and
 * for a stronger reason - something on this side decided this generation should stop, so asking the
 * same route to carry on from where it stopped is asking it to undo the decision. The other two are
 * judged on the only evidence that separates a long answer from a stuck one, which is how fast it
 * arrived.
 */
export const worthContinuing = (cutoff: GenerationCutoff, budget: GenerationBudget): boolean => {
  if (cutoff === 'overrun' || cutoff === 'cancelled' || cutoff === 'framing') return false;
  const seconds = budget.elapsedMs() / 1000;
  return seconds > 0 && budget.characters() / seconds >= MIN_CONTINUABLE_CHARS_PER_SECOND;
};

/**
 * What the caller is told about a generation that was ended here. Written for the owner's timeline
 * rather than for a log: it says what stopped, how far it had got, and how long it had been going,
 * because the fifteen minutes this exists to prevent were fifteen minutes of a spinner and a price
 * that never moved.
 */
export const describeCutoff = (
  provider: string,
  cutoff: GenerationCutoff,
  budget: GenerationBudget
): string => {
  const seconds = Math.round(budget.elapsedMs() / 1000);
  const written = `${budget.characters()} characters in ${seconds} seconds`;
  if (cutoff === 'stalled')
    return `${provider} went quiet mid-answer after ${written}; what had arrived was kept`;
  if (cutoff === 'overrun')
    return `${provider} wrote past the output ceiling this request asked for, ${written}; the answer was cut there`;
  if (cutoff === 'framing')
    return `${provider} exceeded the stream framing or metadata limit after ${written}; the partial answer was kept`;
  if (cutoff === 'cancelled')
    return `the request was stopped here after ${provider} produced ${written}; what had arrived was kept`;
  return `${provider} was still writing after ${written} and the generation was cut there`;
};
