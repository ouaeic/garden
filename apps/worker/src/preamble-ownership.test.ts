/**
 * Rows a worker writes to the owner's conversation before it has asked whether the task is still
 * its own.
 *
 * `honorUserControl`'s ownership arm is deliberately silent once it fires: a worker that has lost
 * the task stands down without narrating it, because two workers both explaining themselves on one
 * timeline is worse than one of them leaving quietly. That decision is undone by anything written
 * *before* the question is first asked.
 *
 * The preamble in `agent.ts`'s `run` writes events - the web-route disclosure and, on a task with a
 * stale contract, a warning about the saved context - so `run` calls the imported
 * `honorUserControl_` directly, immediately after `state.turnToolResults ??= {};` and above the
 * first write. Otherwise a worker whose task had been resumed by another would put two rows on the
 * owner's conversation before discovering that none of this was its work any more. The list below
 * is measured from the source and is exact, so a write creeping back in above the question makes
 * this test red on the day it lands.
 *
 * Read from the source rather than from a driven turn on purpose. The failure is an *ordering* in
 * one method - which statement comes before which - and a turn-level probe can only observe it by
 * arranging for a task to be stolen at exactly the right instant, which measures the arrangement at
 * least as much as it measures the program.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./agent.ts', import.meta.url)), 'utf8').split(
  '\n'
);

/** One-based line numbers, so a failure can be read against the file without arithmetic. */
const lineOf = (needle: string, from = 0): number => {
  const index = source.findIndex((line, at) => at >= from && line.includes(needle));
  if (index < 0) throw new Error(`anchor not found in agent.ts: ${needle}`);
  return index + 1;
};

/**
 * Every timeline write in `run` that happens before the ownership question is asked at all.
 *
 * Bounded by the first mention of `honorUserControl` of any kind after `run` opens - the hoisted
 * direct call today, and the closure's own definition if that call is ever removed. Written that way
 * on purpose: deleting the hoist does not quietly move the bound with it, it moves the bound *down*
 * past both writes and turns this red, which is the failure this file exists to catch.
 */
const writesBeforeOwnershipIsAskable = (): string[] => {
  const start = lineOf('  async run(task: TaskRecord): Promise<void> {');
  const end = lineOf('honorUserControl', start);
  const found: string[] = [];
  for (let line = start; line < end; line += 1) {
    if (!source[line - 1]?.includes('await event(')) continue;
    // The kind and the summary are on the same line for a single-line call and two lines down for
    // the wrapped form; both shapes appear here.
    const window = source.slice(line - 1, line + 6).join(' ');
    const kind = /'(status|warning|plan|assistant_message|approval_resolved|completed)'/.exec(
      window
    );
    found.push(`${line}: ${kind?.[1] ?? 'unknown'}`);
  }
  return found;
};

describe('what a worker says before it knows the task is still its own', () => {
  /**
   * The set is empty and stays empty.
   *
   * The bound is the *definition* of `honorUserControl` rather than its first call, which is
   * deliberately conservative: the hoisted question calls the imported `honorUserControl_`
   * directly, above the closure, so the region this walks is strictly larger than the region that
   * is genuinely unguarded. A write that lands in it fails here even though the check above it
   * would in fact have caught the disowned case - which is the right way round for a test whose
   * failure mode is a row on somebody else's conversation.
   */
  it('writes nothing before the ownership question is asked', () => {
    expect(writesBeforeOwnershipIsAskable()).toEqual([]);
  });

  /**
   * And the question is genuinely asked up there, rather than the writes having merely moved down.
   *
   * Without this, deleting the hoisted call and the two `event(...)` writes together would leave
   * the test above green while restoring the defect for the next row somebody adds.
   */
  it('asks it above the preamble, not merely below the last write', () => {
    const start = lineOf('  async run(task: TaskRecord): Promise<void> {');
    const asked = lineOf('if (await honorUserControl_(', start);
    const closure = lineOf('const honorUserControl = async', start);
    expect(asked).toBeGreaterThan(start);
    expect(asked).toBeLessThan(closure);
  });

  /**
   * Nothing above the ownership question may be a message in the owner's own reading of the
   * conversation, which is the stronger form of the same statement: a `status` row is a line in the
   * activity list and an `assistant_message` is the agent speaking.
   */
  it('does not put words in the agent’s voice before asking', () => {
    expect(
      writesBeforeOwnershipIsAskable().some((entry) => entry.endsWith(': assistant_message'))
    ).toBe(false);
  });
});
