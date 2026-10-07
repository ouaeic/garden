/**
 * The auto-approver, driven through the real loop against the fixture stub.
 *
 * Driven under balanced, the mode in which a push still cards; autonomous approves it outright.
 *
 * Three claims, each of which the harness has to make good on rather than the shim: that an
 * approver answering every card puts the turn back in and the approved call actually runs; that
 * with nobody answering the same turn parks, which is the product and the committed behaviour; and
 * that a parked QUESTION is left parked, because an auto-approver is not an auto-owner.
 *
 * The shapes are borrowed from `evals/fixtures.ts` rather than restated, so what is asserted here
 * is the difference the approver makes to a turn the suite already measures. The push fixture's
 * own script never finishes - it re-proposes the push on every call, which under an approver would
 * be a card per step until the ceiling - so a finish is appended after the approved call, which
 * is the turn a real model takes once its push has gone through.
 */
import { describe, expect, it } from 'vitest';

import { fixtures } from '../fixtures.js';
import { runFixture, type Fixture, type ModelTurn } from '../harness.js';

const fixtureNamed = (id: string): Fixture => {
  const found = fixtures.find((fixture) => fixture.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};

/** The push fixture, finishing once the push has run. See the header. */
const pushThenFinish = (arm: Pick<Fixture, 'securityMode' | 'autoApprove'>): Fixture => {
  const base = fixtureNamed('refusal-git-push-stops-for-the-owner');
  const finish: ModelTurn = { text: 'Fixed the typo and pushed it.' };
  return {
    ...base,
    id: `approver-${base.id}`,
    ...arm,
    model: (context) => (context.index >= 2 ? finish : base.model(context)),
    expect: {}
  };
};

describe('the auto-approver', () => {
  it('answers the card, re-enters the turn, and the approved call runs', async () => {
    const outcome = await runFixture(
      pushThenFinish({ securityMode: 'balanced', autoApprove: true })
    );
    expect(outcome.error).toBeNull();
    // One card: the push. Answered once, and the turn went on to finish rather than park.
    expect(outcome.approvalsRaised).toBe(1);
    expect(outcome.approvalsAutoAnswered).toBe(1);
    expect(outcome.autoApproveCapReached).toBe(false);
    expect(outcome.status).not.toBe('awaiting_user');
    // The approved call actually ran: the production resume writes `approval_resolved` immediately
    // before executing it, records the shell's result as the loop's own dispatch would, and the
    // command reached the runner. (`tools` reads `tool_started`, which the resume path does not
    // write - the call was started on the previous entry - so the result is the evidence here.)
    expect(
      outcome.events.some(
        (event) =>
          event.kind === 'approval_resolved' &&
          (event.payload as { decision?: unknown }).decision === 'approved'
      )
    ).toBe(true);
    expect(
      outcome.events.some(
        (event) => event.kind === 'tool_result' && event.summary.startsWith('shell')
      )
    ).toBe(true);
    expect(outcome.commandsRun).toBeGreaterThanOrEqual(1);
    // Every event of both entries is on the outcome, in order: the card, then its resolution.
    const kinds = outcome.events.map((event) => event.kind);
    expect(kinds.indexOf('approval_requested')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('approval_resolved')).toBeGreaterThan(kinds.indexOf('approval_requested'));
  }, 60_000);

  it('with nobody answering, the same turn parks on the card - the committed behaviour', async () => {
    const outcome = await runFixture(pushThenFinish({ securityMode: 'balanced' }));
    expect(outcome.error).toBeNull();
    expect(outcome.approvalsRaised).toBe(1);
    expect(outcome.approvalsAutoAnswered).toBe(0);
    expect(outcome.status).toBe('awaiting_user');
    expect(outcome.commandsRun).toBe(0);
    expect(
      outcome.events.some(
        (event) => event.kind === 'tool_result' && event.summary.startsWith('shell')
      )
    ).toBe(false);
    expect(outcome.events.some((event) => event.kind === 'approval_resolved')).toBe(false);
  }, 60_000);

  it('keeps the whole run within the step ceiling, re-entries included', async () => {
    /*
     * A model that proposes the push on every call, under a ceiling of 4. A step that cards does
     * not complete, so without the harness bounding re-entry by its own call count this made 5
     * model calls while the row said 4. Every answered card ran its push, and the turn's last
     * step is the one that asks for the answer, so the run ends inside the ceiling.
     */
    const base = fixtureNamed('refusal-git-push-stops-for-the-owner');
    const outcome = await runFixture({
      ...base,
      id: `approver-push-on-every-call`,
      securityMode: 'balanced',
      autoApprove: true,
      maxSteps: 4,
      model: (context) => ({
        calls: [
          {
            id: `call-${String(context.index + 1)}`,
            name: 'shell',
            args: { executable: 'git', args: ['push', 'origin', 'main'] }
          }
        ]
      }),
      expect: {}
    });
    expect(outcome.error).toBeNull();
    expect(outcome.modelCalls).toBeGreaterThan(1);
    expect(outcome.modelCalls).toBeLessThanOrEqual(4);
    expect(outcome.approvalsAutoAnswered).toBeGreaterThan(0);
    expect(outcome.commandsRun).toBe(outcome.approvalsAutoAnswered);
    expect(outcome.status).not.toBe('awaiting_user');
  }, 60_000);

  it('counts a request the provider refused against the ceiling too', async () => {
    /*
     * The same model under a ceiling of 3, with the provider answering the opening request 503.
     * The loop retries the request; no step number ever records the refused one, so a bound read
     * off steps - or off how many times the turn was put back in - would let the run make a
     * fourth call. The bound is the harness's own count of every request that left the process:
     * refused (1), carded (2), answered and carded again (3), and there the ceiling is spent, one
     * card left standing. Reverting the guard to a re-entry count makes this 4.
     */
    const base = fixtureNamed('refusal-git-push-stops-for-the-owner');
    const outcome = await runFixture({
      ...base,
      id: `approver-push-after-a-refused-request`,
      securityMode: 'balanced',
      autoApprove: true,
      maxSteps: 3,
      runner: { ...base.runner, providerFailures: [503] },
      model: (context) => ({
        calls: [
          {
            id: `call-${String(context.index + 1)}`,
            name: 'shell',
            args: { executable: 'git', args: ['push', 'origin', 'main'] }
          }
        ]
      }),
      expect: {}
    });
    expect(outcome.error).toBeNull();
    expect(outcome.modelCalls).toBe(3);
    expect(outcome.approvalsRaised).toBe(2);
    expect(outcome.approvalsAutoAnswered).toBe(1);
    expect(outcome.commandsRun).toBe(1);
    expect(outcome.autoApproveCapReached).toBe(true);
    expect(outcome.status).toBe('awaiting_user');
  }, 60_000);

  it('does not answer a parked question', async () => {
    const base = fixtureNamed('ambiguous-a-real-blocker-parks-the-conversation');
    const outcome = await runFixture({
      ...base,
      id: `approver-${base.id}`,
      securityMode: 'autonomous',
      autoApprove: true,
      expect: {}
    });
    expect(outcome.error).toBeNull();
    // A question raises no card, so there is nothing an approver may answer: the run stays parked
    // exactly as the fixture measures it, and the model was not called a third time.
    expect(outcome.approvalsRaised).toBe(0);
    expect(outcome.approvalsAutoAnswered).toBe(0);
    expect(outcome.status).toBe('awaiting_user');
    expect(outcome.modelCalls).toBe(2);
  }, 60_000);

  it('leaves every offline default where it was: balanced, nobody answering', async () => {
    const base = fixtureNamed('refusal-git-push-stops-for-the-owner');
    const outcome = await runFixture(base);
    expect(outcome.status).toBe('awaiting_user');
    expect(outcome.approvalsAutoAnswered).toBe(0);
    expect(outcome.autoApproveCapReached).toBe(false);
  }, 60_000);
});
