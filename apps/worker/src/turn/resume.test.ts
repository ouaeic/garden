/**
 * The approved call that must not run after all, and the one thing it is judged on.
 *
 * `resumeParkedTurn` runs a call the lead proposed without passing through `dispatchToolCalls`:
 * the card was raised in one turn, the owner answered it out of band, and the call is resumed here
 * by id rather than re-proposed. Every gate in the batch loop is therefore skipped, which is right
 * for the eight it was already past - and wrong for one that can be turned on while the card is
 * unanswered. It is not the only line in the worker that reaches `execute`, and the other two are
 * named here so a reader does not go looking: a handoff turn runs `set_plan` in handoff.ts and
 * denies every other name in as many words, and a specialist runs its own calls through
 * `executeToolCall` in delegate.ts. Both are already inside the fence - `set_plan` is on the
 * permitted set, and dispatch.test.ts holds every specialist tool inside it - so neither needs a
 * gate of its own.
 *
 * Plan mode is that one. A plan-mode turn CAN park on a card, which the first draft of this file
 * said it could not: `parallel_web_read` is permitted and `approvalRequirement` cards it on a novel
 * destination once the turn has read untrusted content, in all three security modes. What it cannot
 * park on is a card this branch would refuse, because the gate answers a refused tool long before
 * the floor is asked. So what walks in here is the owner approving a card and then putting the
 * conversation into plan mode. Both orders end here, at a branch that used to run the call.
 *
 * Driven through the real `resumeParkedTurn` with a real approval hash, because the whole point is
 * that the approval genuinely covers the call: an approval that did not match would be refused two
 * lines above by a rule that already existed, and a test built on one would prove nothing.
 */
import { describe, expect, it } from 'vitest';
import type { ModelRelease, WebToolPlan } from '@athanor/contracts';
import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentState } from '../agent-state.js';
import { decryptJson } from '@athanor/core';
import { approvalPreviewHash } from '../approval-state.js';
import { resumeParkedTurn, type TurnResumeDeps } from './resume.js';

const task = { id: 'task-1', workspaceId: 'ws-1', securityMode: 'balanced' } as TaskRecord;
const key = new Uint8Array(32).fill(7);

interface Seen {
  executed: string[];
  /** `kind: summary`, decrypted, because the row's own summary column is a generic label. */
  events: string[];
  results: Array<{ tool: string; content: string }>;
}

/**
 * One parked approval settled, with the two things this file is about recorded: whether the call
 * ran, and what the model and the owner were told if it did not.
 */
const resume = async (
  call: ModelToolCall,
  mode: AgentState['mode'],
  /**
   * Whether the card was a handoff rather than an action to run: the owner did it themselves on
   * their own screen, and settling it executes nothing. Absent is the ordinary approval.
   */
  handoffOnly = false
): Promise<{ seen: Seen; state: AgentState }> => {
  const seen: Seen = { executed: [], events: [], results: [] };
  const state = {
    messages: [],
    step: 2,
    turn: 1,
    mode,
    pending: { approvalId: 'approval-1', toolCall: call, ...(handoffOnly ? { handoffOnly } : {}) }
  } as unknown as AgentState;
  const deps = {
    store: {
      // Approved, in date, and covering exactly these arguments. Nothing weaker would isolate the
      // mode: the argument-drift refusal above this branch would answer first.
      getApproval: async () => ({
        status: 'approved',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        previewHash: approvalPreviewHash(key, call.name, call.arguments)
      }),
      appendTaskEvent: async () => undefined,
      updateTask: async () => undefined
    },
    config: { WORKER_ID: 'worker-1' },
    ensureTurnUndoPoint: async () => undefined,
    checkpoint: async () => undefined,
    withLeaseRenewal: async <T>(_task: TaskRecord, body: () => Promise<T>) => body(),
    withCancellationWatch: async <T>(_task: TaskRecord, body: () => Promise<T>) => body(),
    execute: async (_task: TaskRecord, executed: ModelToolCall) => {
      seen.executed.push(executed.name);
      return { ok: true };
    },
    recordToolResult: async () => undefined,
    recordToolFailure: async () => undefined
  } as unknown as TurnResumeDeps;

  /*
   * The event recorder is reached through `tool-recording.ts`, which writes through the store - so
   * the row is read back off the call the store was given rather than from a second stub. The
   * summary column is deliberately a generic label there ("Encrypted warning event"); the sentence
   * the owner reads is inside the payload, so that is what is decrypted and asserted on. A test
   * that read the column would pass on a row that said nothing.
   */
  const store = deps.store as unknown as {
    appendTaskEvent: (input: {
      kind: string;
      payloadCiphertext: Parameters<typeof decryptJson>[0];
    }) => Promise<void>;
  };
  store.appendTaskEvent = async (input) => {
    const body = decryptJson<{ summary: string }>(input.payloadCiphertext, key);
    seen.events.push(`${input.kind}: ${body.summary}`);
  };

  const parked = await resumeParkedTurn(
    deps,
    task,
    key,
    state,
    { model: {} as ModelRelease, catalog: [], webPlan: {} as WebToolPlan },
    async () => false
  );
  expect(parked).toBe(false);
  for (const message of state.messages)
    if (message.role === 'tool')
      seen.results.push({ tool: call.name, content: String(message.content) });
  return { seen, state };
};

describe('an approved call resumed into plan mode', () => {
  const remove = {
    id: 'call-shell',
    name: 'shell',
    arguments: { executable: 'rm', args: ['-rf', 'dist'] }
  } as ModelToolCall;

  it('does not run, and says so to the model and to the owner', async () => {
    const { seen } = await resume(remove, 'plan');

    expect(seen.executed).toEqual([]);
    // The owner has to be told: they approved something and it did not happen, and no other line in
    // the conversation would account for that.
    expect(seen.events.join(' | ')).toContain('plan mode after this action was approved');
    // And the model has to be told what to do with it instead, like every other refusal in the loop.
    expect(seen.results[0]?.content).toContain('nothing changed');
    expect(seen.results[0]?.content).toContain('Fold it into the plan');
  });

  /*
   * THE COUNTER-DIRECTION. The refusal has to be about the mode and nothing else: an ordinary
   * approval, which is every approval this product has ever resumed, still runs. `undefined` is
   * what every state written before the field existed carries.
   */
  it('runs exactly as before when the conversation is not in plan mode', async () => {
    for (const mode of [undefined, 'act' as const]) {
      const { seen, state } = await resume(remove, mode);

      expect(seen.executed, String(mode)).toEqual(['shell']);
      expect(seen.events.join(' | '), String(mode)).toContain('Approved action resumed');
      expect(state.step).toBe(3);
    }
  });

  /*
   * And a call plan mode permits is not refused by it, which is what keeps the branch about the
   * mode rather than about resuming. It does arise from a card: the floor asks about a read that
   * has a far end, so a `parallel_web_read` proposed inside plan mode is carded, approved, and
   * resumed straight past this branch. `file_read` stands in for it here because it is the plainest
   * member of the permitted set and cards for nothing; the assertion is about the branch reading
   * the set rather than about which tool the floor stops.
   */
  it('still resumes a call plan mode would have permitted anyway', async () => {
    const read = {
      id: 'call-read',
      name: 'file_read',
      arguments: { path: 'a.ts' }
    } as ModelToolCall;
    const { seen } = await resume(read, 'plan');

    expect(seen.executed).toEqual(['file_read']);
  });

  /*
   * AND THE ONE CASE WHERE REFUSING WOULD BE THE LIE. A handoff card is settled by the owner doing
   * the thing themselves - signing in, typing a value they will not give the agent - and settling it
   * here runs nothing at all. The refusal's own words are "it was not run and nothing changed",
   * which over a handoff is false in both halves: the action happened, on the owner's screen, and
   * the computer moved. So a handoff resumed into plan mode gets the handoff sentence, and the model
   * is told to go and look rather than told there is nothing to look at.
   *
   * `desktop_action` is used because it is refused by the mode - it is on neither basis set - so
   * without the `!handoffOnly` conjunct this case takes the refusal branch, which is what makes the
   * assertion about that conjunct rather than about the permitted set.
   */
  it('tells the model to look at the machine when a handoff is settled in plan mode', async () => {
    const handoff = {
      id: 'call-desktop',
      name: 'desktop_action',
      arguments: { action: 'type', text: '' }
    } as ModelToolCall;
    const { seen } = await resume(handoff, 'plan', true);

    // Nothing runs on a handoff in either mode: the owner already did it.
    expect(seen.executed).toEqual([]);
    expect(seen.results[0]?.content).toContain('completed or reviewed the secure computer handoff');
    expect(seen.results[0]?.content).not.toContain('nothing changed');
    // And the owner is not warned that their approval was thrown away, because it was not.
    expect(seen.events.join(' | ')).not.toContain('plan mode after this action was approved');
  });
});
