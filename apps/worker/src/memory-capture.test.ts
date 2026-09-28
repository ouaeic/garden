/**
 * The write path a finished turn runs, and the one question it is the only place able to answer.
 *
 * `memory-runtime.test.ts` pins `recordMemoryPackOutcome` itself: given a pack, a request and what
 * the turn produced, which entries come back cited. What it cannot pin is that anything ever hands
 * those three things over - and that is precisely the shape of the defect this wave closed. The
 * column existed, the formula read it, the store's writer took the flag, and no caller passed it.
 * A test that only exercises the callee would have been green through all nine waves of that.
 */
import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  encryptJson,
  renderMemoryPack,
  type EncryptedEnvelope,
  type MemoryPackEntry
} from '@garden/core';
import type { DataStore, MemoryPackRecord, TaskRecord } from '@garden/data';
import type { ModelMessage } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import type { CompletionVerification } from './completion.js';
import { captureMemory, type MemoryCaptureDeps } from './memory-capture.js';
import { memoryPackAad } from './memory-runtime.js';

const dataKey = Buffer.alloc(32, 7);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

const RATE_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SEND_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RATE_BODY = 'The renewal rate on the brochure job is 4.25 per cent for the current term.';

const packEntry = (id: string, title: string, body: string): MemoryPackEntry => ({
  id,
  kind: 'fact',
  trust: 'stated',
  observedAt: '2026-07-01T00:00:00.000Z',
  validFrom: '2026-07-01T00:00:00.000Z',
  validTo: null,
  title,
  tags: [],
  body
});

const rendered = renderMemoryPack([
  packEntry(RATE_ID, 'brochure renewal rate', RATE_BODY),
  packEntry(
    SEND_ID,
    'the last brochure send',
    'The last brochure send was held back until every font came back embedded.'
  )
]);

interface CaptureProbe {
  readonly deps: MemoryCaptureDeps;
  readonly uses: Array<{ itemIds: readonly string[]; cited?: boolean; outcome?: string }>;
  readonly warnings: string[];
  /** Every timeline line this write path emitted, sealed exactly as the store would hold it. */
  readonly events: Array<{ kind: string; payloadCiphertext: EncryptedEnvelope }>;
  /** Every citation the write path filed from a memory to the tool call that justified it. */
  readonly citedCalls: Array<{ itemId: string; calls: { toolCallId: string; eventId: string }[] }>;
}

const probe = (): CaptureProbe => {
  const uses: CaptureProbe['uses'] = [];
  const warnings: string[] = [];
  const events: CaptureProbe['events'] = [];
  const citedCalls: CaptureProbe['citedCalls'] = [];
  const pack: MemoryPackRecord = {
    taskId,
    workspaceId,
    briefVersion: null,
    bodyCiphertext: encryptJson({ body: rendered.body }, dataKey, memoryPackAad(taskId)),
    sha256: rendered.sha256,
    itemIds: [...rendered.itemIds],
    tokensEst: rendered.tokensEst,
    createdAt: '2026-07-31T00:00:00.000Z'
  };
  const store = {
    createMemoryItem: async (input: { id?: string }) => ({ id: input.id ?? 'item' }),
    createMemorySource: async () => ({ id: 'source' }),
    attachMemoryEvidence: async () => 0,
    attachMemoryCitedCalls: async (
      itemId: string,
      calls: readonly { toolCallId: string; eventId: string }[]
    ) => {
      citedCalls.push({ itemId, calls: calls.map((call) => ({ ...call })) });
      return calls.length;
    },
    observeMemoryFactCandidate: async () => undefined,
    promoteMemoryFactCandidates: async () => [],
    recordMemoryDeadEnds: async () => ({ recorded: [], retired: [] }),
    getMemoryPack: async () => pack,
    recordMemoryUse: async (input: {
      itemIds: readonly string[];
      cited?: boolean;
      outcome?: string;
    }) => {
      uses.push(input);
      return input.itemIds.length;
    },
    consolidateMemory: async () => undefined,
    // The failure channel, and the reason every case below asserts on it. A memory write must
    // never fail a verified turn, so `captureMemory` catches everything and reports it as a
    // timeline warning - which means a test that only checks "it did not throw" checks nothing at
    // all, and would have passed with the whole write path broken.
    appendTaskEvent: async (input: { kind: string; payloadCiphertext: EncryptedEnvelope }) => {
      warnings.push(input.kind);
      events.push(input);
      return { id: 'event' };
    }
  } as unknown as DataStore;
  return { deps: { store, memoryConsolidatedAt: new Map() }, uses, warnings, events, citedCalls };
};

/** What the owner would read on the timeline, out of the sealed payload the store holds. */
const summaries = (capture: CaptureProbe, kind: string): string[] =>
  capture.events
    .filter((entry) => entry.kind === kind)
    .map(
      (entry) =>
        decryptJson<{ summary: string }>(entry.payloadCiphertext, dataKey, `task-event:${taskId}`)
          .summary
    );

const task = {
  id: taskId,
  userId,
  workspaceId,
  status: 'running',
  modelId: 'vendor/model',
  privacyRoute: 'provider_zdr'
} as unknown as TaskRecord;

const state = (messages: ModelMessage[]): AgentState =>
  ({ messages, step: 3, credits: 1 }) as unknown as AgentState;

const conversational = (): CompletionVerification =>
  ({
    status: 'not_applicable',
    evidence: [],
    remainingRisks: []
  }) as unknown as CompletionVerification;

describe('what a finished turn tells the store about the memory it was given', () => {
  it('cites the entry the answer quoted, and grades the rest ungraded', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'What rate are we renewing the brochure job at?' },
        { role: 'assistant', content: RATE_BODY }
      ]),
      {
        summary: 'Answered from what the workspace already remembered.',
        verification: conversational()
      }
    );
    expect(capture.warnings).toEqual([]);
    // The wire. Before this wave both production callers of `recordMemoryUse` left `cited` out, so
    // `mem.item.cited_count` was zero in every workspace that had ever run and a fifth of the
    // salience score was a constant for every row in the pool.
    expect(capture.uses).toEqual([
      { workspaceId, itemIds: [RATE_ID], taskId, cited: true, outcome: 'ok' },
      { workspaceId, itemIds: [SEND_ID], taskId, cited: false, outcome: 'unknown' }
    ]);
  });

  /**
   * The id the completion contract produced and the memory boundary threw away.
   *
   * `completion.ts` makes a `finish` cite the `toolCallId` of the call that justifies each claim,
   * and `tool-recording.ts` writes that call's raw untruncated result into `task_events`. Both ends
   * of the edge existed for as long as both files have; this line - `evidence.map(item =>
   * item.claim)` - dropped the id one step before storage, so garden computed the pointer into the
   * only part of the tool-output tier worth keeping and discarded it on every verified turn.
   *
   * The assertion is on the WIRE to the store rather than on the shape of the argument, because the
   * argument was never the defect: a claim mapped out of an evidence item is a perfectly good
   * `verifiedClaims`, and it stayed one. What was missing was a second call, and this is it.
   */
  it('keeps the tool call a finish cited, resolved against what the harness actually ran', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      {
        messages: [
          { role: 'user', content: 'Did the certificate renew?' },
          { role: 'assistant', content: 'It renewed.' }
        ],
        step: 3,
        credits: 1,
        turnToolResults: {
          'call-1': { name: 'shell', success: true, eventId: 'event-77' },
          // Ran, recorded, and not cited. The reach is over what a finish named, never over what a
          // turn happened to do, and a citation table that collected every call would be the
          // enumerable tier this design refuses.
          'call-2': { name: 'file_read', success: true, eventId: 'event-78' }
        }
      } as unknown as AgentState,
      {
        summary: 'Renewed the certificate.',
        verification: {
          status: 'verified',
          evidence: [
            { claim: 'the serial changed', source: 'tool_result', toolCallId: 'call-1' },
            /*
             * The forgery, in the same call as the real one.
             *
             * `call-9` is an id no tool call in this turn carries. It resolves to nothing in the
             * harness's own ledger and is dropped here, which is why nothing downstream has to ask
             * whether a stored citation was ever real - and why the model cannot name a timeline
             * row it was not handed.
             */
            { claim: 'and the gateway reloaded', source: 'tool_result', toolCallId: 'call-9' }
          ],
          remainingRisks: []
        } as unknown as CompletionVerification
      }
    );

    expect(capture.warnings).toEqual([]);
    expect(capture.citedCalls).toHaveLength(1);
    expect(typeof capture.citedCalls[0]?.itemId).toBe('string');
    expect(capture.citedCalls[0]?.calls).toEqual([{ toolCallId: 'call-1', eventId: 'event-77' }]);
  });

  it('counts a procedure the harness followed, which no answer would ever quote', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'Is the brochure ready to send?' },
        { role: 'assistant', content: 'Everything checks out.' }
      ]),
      {
        summary: 'Checked the brochure.',
        verification: conversational(),
        verifiedCommands: [
          {
            label: 'fonts',
            executable: 'echo',
            args: ['The', 'last', 'brochure', 'send', 'was', 'held', 'back'],
            cwd: '/workspace'
          }
        ]
      } as never
    );
    expect(capture.warnings).toEqual([]);
    expect(capture.uses[0]).toMatchObject({ itemIds: [SEND_ID], cited: true });
  });

  /**
   * The cap that would eat a brief in silence.
   *
   * `recordTurnEpisode` keeps the first eight six-kilobyte chunks of each part and drops the rest.
   * On the owner's real corpus - 675 turns, 233,064 characters, 11 projects, 49 active days, on the
   * strict owner-turn filter - the widest single turn is 14,625 characters against 48,000 bytes per
   * part, so it has never fired and 100.0% of what the owner typed reached a source row. The 197 of
   * 3,950 (5.0%) and 34.6 MB of 59.9 MB (57.7%) this comment used to state were measured on a
   * corpus that counted machine-written text as the owner's, and are void.
   *
   * The cap is right and is unchanged, and a bound that has not fired yet is not a bound that
   * cannot. What was wrong is that nothing said so when it did, so the owner could search memory
   * for a constraint they had definitely written and be told, truthfully and uselessly, that
   * nothing matched. That is what this describe block holds in place.
   */
  describe('saying what the verbatim cap refused', () => {
    const oversized = 'The brief. '.padEnd(60_000, 'y');

    it('says how much of an oversized turn is searchable in the conversation only', async () => {
      const capture = probe();
      await captureMemory(
        capture.deps,
        task,
        dataKey,
        state([
          { role: 'user', content: oversized },
          { role: 'assistant', content: 'Read it.' }
        ]),
        { summary: 'Read the brief.', verification: conversational() }
      );
      // Never a warning: the turn WAS recorded, and "this turn was not recorded in memory" is the
      // sentence that must stay reserved for when it was not.
      expect(capture.warnings).not.toContain('warning');
      expect(summaries(capture, 'status')).toEqual([
        'Stored the first 8 parts of this turn verbatim; 2 further parts are searchable in the conversation but not in memory'
      ]);
    });

    it('stays quiet on a turn that fitted, which is 95% of them', async () => {
      const capture = probe();
      await captureMemory(
        capture.deps,
        task,
        dataKey,
        state([
          { role: 'user', content: 'What rate are we renewing the brochure job at?' },
          { role: 'assistant', content: RATE_BODY }
        ]),
        { summary: 'Answered.', verification: conversational() }
      );
      expect(summaries(capture, 'status')).toEqual([]);
    });
  });

  it('grades nothing at all on a turn the harness stopped', async () => {
    const capture = probe();
    await captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'What rate are we renewing the brochure job at?' },
        { role: 'assistant', content: RATE_BODY }
      ]),
      { summary: 'Ran out of steps.', verification: conversational(), interrupted: true }
    );
    expect(capture.warnings).toEqual([]);
    expect(capture.uses).toEqual([]);
  });
});

/*
 * The nightly proposer's production call site, after the deletion.
 *
 * `captureMemory` used to make one model call a day here, hung off the consolidation cadence, and
 * `docs/design/memory2/RULES.md` records what retired it. The removal is asserted where it can
 * fail rather than by the absence of a symbol: the store this turn is handed throws on all three
 * of the reads that were the nightly route's and nobody else's, and `captureMemory` catches
 * everything and reports it as a timeline warning - so a call site put back does not fail to
 * compile somewhere else, it turns this green case red with the warning in hand.
 *
 * The consolidation beside it is the positive control, in both directions: the cadence still
 * fires, exactly once, and a second turn inside the same day does not fire it again. Without it
 * this case would pass against a `captureMemory` that had stopped doing anything at all.
 */
describe('what the daily cadence spends now', () => {
  const finish = async (capture: CaptureProbe) =>
    captureMemory(
      capture.deps,
      task,
      dataKey,
      state([
        { role: 'user', content: 'Never stop to ask me for permission.' },
        { role: 'assistant', content: 'Understood.' }
      ]),
      { summary: 'Carried on.', verification: conversational() }
    );

  it('consolidates the workspace once a day and takes none of the nightly route', async () => {
    const capture = probe();
    let consolidated = 0;
    Object.assign(capture.deps.store, {
      consolidateMemory: async () => {
        consolidated += 1;
      },
      claimMemoryProposalRun: async () => {
        throw new Error('the day must not be claimed');
      },
      countMemoryFactProposals: async () => {
        throw new Error('there is no queue left to count');
      },
      listMemoryProposalSources: async () => {
        throw new Error("the day's sources must not be read");
      }
    });

    await finish(capture);
    expect(consolidated).toBe(1);
    expect(capture.warnings).toEqual([]);
    expect(summaries(capture, 'status')).toEqual([]);

    // The cadence, not a second pass: the claim is taken before the await and held in the worker.
    await finish(capture);
    expect(consolidated).toBe(1);
    expect(capture.warnings).toEqual([]);
  });
});
