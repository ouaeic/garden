import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_TIMEOUT_MS,
  HUGE_REQUEST_TOKENS,
  LARGE_REQUEST_TOKENS,
  MIN_CONTINUABLE_CHARS_PER_SECOND,
  describeCutoff,
  generationCharCeiling,
  startGenerationBudget,
  streamIdleTimeoutFor,
  worthContinuing
} from './generation-budget.js';

describe('generation budget', () => {
  /*
   * The whole defence of the default, written as arithmetic rather than as a claim in a comment.
   *
   * The largest single answer this product ever asks for is 16,384 tokens. Four characters to the
   * token puts a full-length one at about 65,000 characters, and the ceiling has to sit well clear
   * of that or it fires on the best work the box does rather than on the worst.
   */
  it('leaves twice the room a full-length answer needs, and still bounds a route that ignores the cap', () => {
    const ceiling = generationCharCeiling(16_384);
    const fullLengthAnswer = 16_384 * 4;

    expect(ceiling).toBe(131_072);
    expect(fullLengthAnswer).toBe(ceiling / 2);
    // Structured output runs closer to six characters a token, which is the pessimistic case, and
    // even that fits.
    expect(16_384 * 6).toBeLessThan(ceiling);
    // Seventeen thousand tokens against a ceiling of 16,384 is what a route that ignores the cap
    // did on this box. Twice that is still bounded rather than running to the caller's deadline.
    expect(ceiling / 4).toBeLessThan(40_000);
  });

  it('holds a request that named no length to no length', () => {
    expect(generationCharCeiling(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  /*
   * The time default, against the two rates that matter: what the box measured while failing, and
   * what a working route does. The failing call streamed roughly ten characters a second for the
   * whole fifteen minutes - two and a half tokens a second. A full-length answer inside ten minutes
   * needs twenty-seven. There is an order of magnitude between them.
   */
  it('demands a rate an order of magnitude below a working route and above the measured failure', () => {
    const seconds = DEFAULT_GENERATION_TIMEOUT_MS / 1000;
    const requiredTokensPerSecond = 16_384 / seconds;

    expect(Math.round(requiredTokensPerSecond)).toBe(27);
    // What the failing call produced: 1,015 frames of at least eight characters over fifteen
    // minutes, which is about ten characters - two and a half tokens - a second.
    expect(requiredTokensPerSecond).toBeGreaterThan(10 * 2.5);
    // And still under the caller's own fifteen-minute deadline, so this is the bound that fires.
    expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeLessThan(900_000);
  });

  it('counts characters against the ceiling and reports the crossing once it happens', () => {
    const budget = startGenerationBudget({ timeoutMs: 0, maxChars: 10 });

    expect(budget.produced(6)).toBe(false);
    expect(budget.produced(5)).toBe(true);
    expect(budget.characters()).toBe(11);
    // Zero disables the clock rather than expiring it instantly.
    expect(budget.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it('spends its deadline against the clock it was given', () => {
    let now = 1_000;
    const budget = startGenerationBudget({ timeoutMs: 500, maxChars: 0, now: () => now });

    expect(budget.remainingMs()).toBe(500);
    now += 200;
    expect(budget.remainingMs()).toBe(300);
    expect(budget.elapsedMs()).toBe(200);
    now += 400;
    expect(budget.remainingMs()).toBeLessThan(0);
    // A ceiling of zero is off, so no amount of text crosses it.
    expect(budget.produced(10_000)).toBe(false);
  });

  /*
   * The other half of the defence: a bound that fires is only an improvement if what happens next
   * is right. The loop upstream continues a cut-off answer three times, so a route it should not
   * continue costs four calls at this deadline - forty minutes - and is still cut off at the end.
   */
  it('will not ask a route to carry on at a rate that cannot finish the answer', () => {
    const answerChars = 16_384 * 4;
    const callsTheLoopAllows = 4;
    const secondsAvailable = (DEFAULT_GENERATION_TIMEOUT_MS / 1000) * callsTheLoopAllows;

    expect(Math.ceil(answerChars / secondsAvailable)).toBe(MIN_CONTINUABLE_CHARS_PER_SECOND);

    let now = 0;
    const stuck = startGenerationBudget({ timeoutMs: 600_000, maxChars: 0, now: () => now });
    stuck.produced(12_000);
    now = 600_000;
    // The measured failure: about ten characters a second, which four more calls cannot rescue.
    expect(worthContinuing('timeout', stuck)).toBe(false);
    expect(worthContinuing('stalled', stuck)).toBe(false);
  });

  it('carries on from a long answer that was simply still being written', () => {
    let now = 0;
    const productive = startGenerationBudget({ timeoutMs: 600_000, maxChars: 0, now: () => now });
    productive.produced(48_000);
    now = 600_000;

    // Eighty characters a second - twenty tokens - is a working route on a long answer, and one
    // more call finishes it.
    expect(worthContinuing('timeout', productive)).toBe(true);
    // Except when the ceiling was what stopped it: a route already past twice the longest answer
    // the request allowed for does not need more room, whatever rate it wrote at.
    expect(worthContinuing('overrun', productive)).toBe(false);
  });

  /*
   * The idle clock is the one bound on a generation that a *large* request can trip while nothing
   * is wrong. Everything else here measures what the route wrote; this measures the gap before it
   * writes anything, and that gap grows with the prompt - a reasoning route reads a hundred
   * thousand tokens of window before it emits its first one. A flat two minutes is generous for an
   * ordinary step and a live risk of abandoning a healthy route on the largest step a task takes,
   * which is also the most expensive one to throw away.
   */
  it('lengthens the idle deadline for a large request and leaves an ordinary one alone', () => {
    const base = 120_000;
    // Four characters to the token, the same conversion the rest of this file estimates with.
    expect(streamIdleTimeoutFor(base, 40_000 * 4)).toBe(base);
    expect(streamIdleTimeoutFor(base, LARGE_REQUEST_TOKENS * 4)).toBe(180_000);
    expect(streamIdleTimeoutFor(base, 80_000 * 4)).toBe(180_000);
    expect(streamIdleTimeoutFor(base, HUGE_REQUEST_TOKENS * 4)).toBe(240_000);
    expect(streamIdleTimeoutFor(base, 900_000 * 4)).toBe(240_000);
    // Monotonic across the whole range: a bigger request is never given less patience than a
    // smaller one, which is the only property a caller can reason about without knowing the rungs.
    const deadlines = [0, 1, 100_000, 200_000, 400_000, 4_000_000].map((bytes) =>
      streamIdleTimeoutFor(base, bytes)
    );
    expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
    // Zero is the escape hatch that disables the deadline. Scaling it would turn "no deadline" into
    // "no deadline, twice", and a negative one is the same escape hatch spelt differently.
    expect(streamIdleTimeoutFor(0, 4_000_000)).toBe(0);
    expect(streamIdleTimeoutFor(-1, 4_000_000)).toBe(-1);
  });

  it('says what stopped, how far it had got and how long it had been going', () => {
    let now = 0;
    const budget = startGenerationBudget({ timeoutMs: 60_000, maxChars: 100, now: () => now });
    budget.produced(120);
    now = 42_000;

    expect(describeCutoff('openrouter', 'stalled', budget)).toBe(
      'openrouter went quiet mid-answer after 120 characters in 42 seconds; what had arrived was kept'
    );
    expect(describeCutoff('openrouter', 'timeout', budget)).toContain('still writing');
    expect(describeCutoff('openrouter', 'overrun', budget)).toContain('past the output ceiling');
  });
});
