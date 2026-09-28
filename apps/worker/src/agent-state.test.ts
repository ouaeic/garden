/**
 * `AgentState` under the two things that actually happen to it: it is sealed and reopened, and it is
 * carried across a turn boundary.
 *
 * Wave 7.1 lifted this type out of `agent.ts` and gave every other module the split produced a test
 * file - except this one, which is the most load-bearing data structure in the worker. It is
 * checkpointed mid-step, encrypted whole under the task's data key, and reopened by whichever worker
 * picks the task up next. Nothing asserted that a field survives that, because nothing could: while
 * the type lived beside `AgentWorker` the only way to observe it was to drive a turn, and a turn
 * exercises the dozen fields its own path happens to read.
 *
 * The failure this file exists to catch has no symptom at the moment it happens. A field that does
 * not survive a resume comes back as a default - a counter at zero, a bound reset, a taint gone -
 * and the run carries on looking healthy. It is the shape of defect this program has found more than
 * thirty times, and it is the one shape a resumed turn cannot report on itself.
 *
 * Two nets, deliberately at two levels:
 *
 * - `FULL` is typed `Required<AgentState>`, so adding a field to the interface makes this file stop
 *   compiling until the field is given a value here. That is the only mechanism that can make the
 *   round-trip below exhaustive rather than merely long.
 * - `FIELDS` names the roster, so the same addition also has to be classified below - carried, reset
 *   or dropped at the turn boundary - rather than silently inheriting whichever `startTurnState`
 *   happens to do.
 */
import { decryptJson, encryptJson } from '@garden/core';
import { describe, expect, it } from 'vitest';
import type { AgentState } from './agent-state.js';
import { startTurnState } from './completion.js';

const key = new Uint8Array(32).fill(11);
const taskId = '22222222-2222-4222-8222-222222222222';
const aad = `task-state:${taskId}`;

/**
 * Every field `AgentState` declares, in declaration order.
 *
 * A literal rather than a derivation, because the point of it is to be a list somebody had to edit:
 * a new field on the interface fails the compile above and then fails the classification below until
 * a person has said what a new turn should do with it.
 */
const FIELDS: ReadonlyArray<keyof AgentState> = [
  'memoryOwnerRequest',
  'enabledToolGroups',
  'messages',
  'step',
  'credits',
  'turn',
  'reservationKey',
  'planVersion',
  'contextBrief',
  'compactions',
  'transcriptionRates',
  'toolOutputFloor',
  'openedSkills',
  'mutated',
  'mutatedBeyondProse',
  'answered',
  'repairStep',
  'answerNagged',
  'turnToolResults',
  'finishRejections',
  'deliveryNagged',
  'ownerReasoningEffort',
  'preparedInputTokens',
  'completionNags',
  'approvalRecovery',
  'toolsStarted',
  'idleSteps',
  'repeatedFailures',
  'argumentTruncations',
  'readFileHashes',
  'partialReads',
  'seenCalls',
  'carriedArtifacts',
  'truncatedReplies',
  'frameLossNoted',
  'contextOverflowRepairs',
  'notices',
  'takeoversRaised',
  'unattended',
  'mode',
  'lastStepUsd',
  'spendWarnings',
  'checkpoint',
  'pending',
  'question',
  'browserHandoff',
  'questionsAsked',
  'inFlight',
  'acceptance',
  'acceptanceFailures',
  'acceptanceNagged',
  'acceptanceBaselineRefusals',
  'acceptanceTurn',
  'acceptanceCaveat',
  'selfContinuations',
  'continuationMark',
  'planCoverageNagged',
  'planIsFallback',
  'taint',
  'turnNoveltyBytes',
  'memoryReaches',
  'webToolMode',
  'knownOrigins',
  'knownAddresses',
  'reasoningFloor',
  'compactedAtStep',
  'artifactLedger',
  'pendingNativeInputs',
  'nativeInputApprovals',
  'transcriptionApprovals',
  'mediaApprovals',
  'jobWaitId',
  'codingMissionWaiting',
  'codingMissionReviews',
  'mainModelPreference',
  'projectContextFingerprint',
  'walledProviders',
  'decisionFloorBindings',
  'decisionReceipts'
];

/**
 * A state with every field set, and every value distinguishable from a default.
 *
 * No zeroes, no empty collections and no `false` where the type allows something else: a field that
 * is dropped in transit and a field that comes back as its default are the same observation, so a
 * fixture built out of defaults would prove nothing about either. Nested objects and arrays carry
 * real members for the same reason - a shallow copy that loses the inside of `turnToolResults` reads
 * as a present field.
 */
const FULL: Required<AgentState> = {
  memoryOwnerRequest: 'I prefer concise answers.',
  enabledToolGroups: ['browser', 'documents'],
  mainModelPreference: '[true,"best",""]',
  decisionFloorBindings: { call: 'a'.repeat(64) },
  decisionReceipts: {
    digest: {
      status: 'decided',
      answers: { selected: { type: 'choice', choice: 'yes' } },
      model: 'decision-version',
      modelId: 'openrouter/decision',
      latencyMs: 220,
      costUsd: 0.00001,
      usageCredits: 0.001
    }
  },
  projectContextFingerprint: 'f'.repeat(64),
  walledProviders: ['openrouter'],
  mediaApprovals: { image: { binding: 'a'.repeat(64), modelId: 'test/image' } },
  transcriptionApprovals: {
    'transcription-1': { binding: 'd'.repeat(64), sourceSha256: 'e'.repeat(64), sourceBytes: 4096 }
  },
  nativeInputApprovals: {
    'native-2': {
      modelName: 'Test',
      reference: {
        path: 'workspace/a.wav',
        kind: 'audio',
        mimeType: 'audio/wav',
        bytes: 48,
        sha256: 'a'.repeat(64),
        callId: 'native-2',
        turn: 0,
        modelId: 'test',
        modelBinding: 'c'.repeat(64),
        maxCostUsd: 0.4,
        credentialBinding: 'b'.repeat(64),
        privacyRoute: 'provider_zdr'
      }
    }
  },
  pendingNativeInputs: [
    {
      path: 'workspace/a.wav',
      kind: 'audio',
      mimeType: 'audio/wav',
      bytes: 48,
      sha256: 'a'.repeat(64),
      callId: 'native-1',
      turn: 0,
      modelId: 'test',
      modelBinding: 'c'.repeat(64),
      maxCostUsd: 0.4,
      credentialBinding: 'b'.repeat(64),
      privacyRoute: 'provider_zdr'
    }
  ],
  codingMissionWaiting: true,
  jobWaitId: 'job-wait-fixture',
  codingMissionReviews: { mission: { digest: 'reviewed', generation: 1 } },
  messages: [
    { role: 'system', content: 'GARDEN RUNTIME CONTEXT (dynamic)' },
    { role: 'user', content: 'fix the importer' },
    {
      role: 'assistant',
      content: 'looking',
      reasoning: 'the columns disagree',
      reasoningDetails: [{ type: 'summary', text: 'columns' }],
      toolCalls: [{ id: 'call-1', name: 'shell', arguments: { command: 'pytest' } }],
      cacheBreakpoint: true
    },
    { role: 'tool', content: 'exit 0', toolCallId: 'call-1', images: ['data:image/png;base64,AA'] }
  ],
  step: 17,
  credits: 4_213,
  turn: 3,
  reservationKey: 'usage:22222222:3',
  planVersion: 6,
  contextBrief: {
    sections: [{ from: 1, to: 4, messages: 22, source: 'model', text: 'earlier turns' }],
    condensedMessages: 22
  },
  compactions: 2,
  transcriptionRates: { 'openai/whisper-1': 0.006 },
  toolOutputFloor: 1_200,
  openedSkills: ['code-change', 'deployment'],
  mutated: true,
  mutatedBeyondProse: true,
  answered: true,
  repairStep: true,
  answerNagged: true,
  turnToolResults: {
    'call-1': {
      name: 'shell',
      success: true,
      skipped: false,
      mutating: true,
      briefOnly: false,
      proseOnly: false,
      command: { fingerprint: '["pytest",[],"workspace"]', exitCode: 0 }
    },
    'call-2': { name: 'file_write', success: true, mutating: true, proseOnly: true }
  },
  finishRejections: 2,
  deliveryNagged: true,
  ownerReasoningEffort: 'low',
  preparedInputTokens: 91_400,
  completionNags: 1,
  approvalRecovery: { turn: 7, attempts: 1 },
  toolsStarted: 9,
  idleSteps: 1,
  repeatedFailures: { 'file_patch:conflict': 2 },
  argumentTruncations: 1,
  readFileHashes: { 'workspace/importer.py': 'a1b2c3' },
  partialReads: { 'workspace/importer.py': 4_211 },
  seenCalls: { 'file_read:workspace/importer.py': 'call-1' },
  carriedArtifacts: ['workspace/importer.py', 'pytest -q'],
  truncatedReplies: 1,
  frameLossNoted: true,
  contextOverflowRepairs: 1,
  notices: 2,
  takeoversRaised: ['example.com'],
  unattended: true,
  mode: 'plan',
  lastStepUsd: 0.0412,
  spendWarnings: ['day:2026-08-25'],
  checkpoint: { turn: 3, id: '44444444-4444-4444-8444-444444444444' },
  pending: {
    approvalId: '55555555-5555-4555-8555-555555555555',
    toolCall: { id: 'call-3', name: 'http_request', arguments: { url: 'https://example.com' } },
    handoffOnly: true
  },
  browserHandoff: { vendor: 'test', url: 'https://example.com', reason: 'verification' },
  question: { question: 'which database should this point at?', askedAtStep: 12 },
  questionsAsked: 1,
  inFlight: { toolCallId: 'call-4', tool: 'browser_action', startedAt: '2026-08-25T09:00:00.000Z' },
  acceptance: {
    checks: [
      {
        id: 'check-1',
        kind: 'command',
        label: 'the suite passes',
        executable: 'pytest',
        args: ['-q'],
        cwd: 'workspace',
        expectExit: 0,
        expectStdoutContains: 'passed',
        timeoutSeconds: 900
      },
      {
        id: 'check-2',
        kind: 'artifact',
        label: 'the deck exists',
        path: 'workspace/deck.pptx',
        minBytes: 4_096,
        render: { expectPages: 12, marginPoints: 18 }
      }
    ],
    revisions: 2,
    declaredAtStep: 5
  },
  acceptanceFailures: 1,
  acceptanceNagged: true,
  acceptanceBaselineRefusals: 1,
  acceptanceTurn: 3,
  acceptanceCaveat: 'declared after the work had already started',
  selfContinuations: 1,
  continuationMark: { atStep: 14, writes: 3 },
  planCoverageNagged: true,
  planIsFallback: true,
  taint: { level: 'untrusted', sources: ['https://example.com/page'], sinceStep: 8 },
  turnNoveltyBytes: 412,
  memoryReaches: 2,
  webToolMode: 'in_house',
  knownOrigins: ['example.com'],
  knownAddresses: ['https://example.com/page'],
  reasoningFloor: 'high',
  compactedAtStep: 15,
  artifactLedger: {
    entries: [{ path: 'workspace/src/importer.ts', mode: 'wrote', bytes: 4_812, step: 12 }],
    dropped: 3
  }
};

describe('what a turn is carrying', () => {
  it('names every field the type declares, so a new one has to be classified', () => {
    expect(Object.keys(FULL).sort()).toEqual([...FIELDS].sort());
    expect(FIELDS.length).toBeGreaterThan(0);
  });

  /**
   * The checkpoint path itself: `encryptJson(state, key, 'task-state:<id>')` written by `#checkpoint`
   * and read back by `run` through `decryptJson<AgentState>`. Asserted field by field rather than in
   * one `toEqual`, because the failure that matters names a field and a whole-object diff of a
   * sixty-one-field structure does not.
   */
  it('survives being sealed into a checkpoint and reopened', () => {
    const restored = decryptJson<AgentState>(encryptJson(FULL, key, aad), key, aad);

    for (const field of FIELDS)
      expect({ [field]: restored[field] }).toEqual({ [field]: FULL[field] });
    expect(Object.keys(restored).sort()).toEqual([...FIELDS].sort());
    expect(restored).toEqual(FULL);
  });

  /**
   * The encryption context is part of the guarantee, not decoration.
   *
   * A checkpoint sealed for one task must not open under another task's label even with the right
   * key: the whole state - the trajectory, the taint, the owner's own words - travels in that
   * envelope, and the aad is what says which conversation it belongs to.
   */
  it('refuses to open under a different task', () => {
    const sealed = encryptJson(FULL, key, aad);
    expect(() => decryptJson<AgentState>(sealed, key, 'task-state:66666666')).toThrow();
    expect(() => decryptJson<AgentState>(sealed, new Uint8Array(32).fill(12), aad)).toThrow();
  });

  /**
   * A resume is a checkpoint that has been through the store, so the values have been JSON all the
   * way down and back. Nothing here may rely on a class instance, a `Map`, a `Set`, a `Date` or an
   * `undefined` surviving - each of which reads as "the field is gone" on the other side.
   */
  it('carries nothing that a JSON round trip would quietly change', () => {
    const restored = JSON.parse(JSON.stringify(FULL)) as AgentState;
    expect(restored).toEqual(FULL);
    for (const field of FIELDS) expect(FULL[field]).not.toBeUndefined();
  });
});

describe('what a new turn inherits', () => {
  const next = startTurnState(FULL as unknown as Record<string, unknown>, {
    prompt: 'and now the exporter',
    turn: 4,
    reservationKey: 'usage:22222222:4'
  }) as unknown as AgentState;

  /**
   * The partition, stated as three lists rather than as a set of spot checks.
   *
   * `startTurnState` is the only place that decides what the next turn is entitled to believe, and
   * the comment on it is explicit that what is *not* reset is as load-bearing as what is. A field
   * added to `AgentState` lands in "carried" by default, which is the wrong default for anything
   * that counts something - so this test makes the default visible instead of silent.
   */
  it('resets exactly the fields that were about the last turn', () => {
    const dropped = FIELDS.filter((field) => !(field in next));
    const reset = FIELDS.filter(
      (field) => field in next && JSON.stringify(next[field]) !== JSON.stringify(FULL[field])
    );
    const carried = FIELDS.filter(
      (field) => field in next && JSON.stringify(next[field]) === JSON.stringify(FULL[field])
    );

    expect(dropped).toEqual([
      'frameLossNoted',
      'pending',
      'question',
      'browserHandoff',
      'continuationMark',
      'reasoningFloor',
      'compactedAtStep',
      'artifactLedger',
      'pendingNativeInputs',
      'nativeInputApprovals',
      'transcriptionApprovals',
      'mediaApprovals',
      'jobWaitId',
      'codingMissionWaiting',
      'codingMissionReviews',
      'decisionFloorBindings',
      'decisionReceipts'
    ]);
    expect(reset).toEqual([
      'memoryOwnerRequest',
      // The trajectory gains the owner's new message; everything else here goes back to zero.
      'messages',
      'step',
      'turn',
      'reservationKey',
      'mutated',
      'mutatedBeyondProse',
      'answered',
      'repairStep',
      'answerNagged',
      'turnToolResults',
      'finishRejections',
      'deliveryNagged',
      'completionNags',
      'toolsStarted',
      'idleSteps',
      'repeatedFailures',
      'seenCalls',
      'carriedArtifacts',
      'truncatedReplies',
      'notices',
      'questionsAsked',
      'acceptanceFailures',
      'acceptanceNagged',
      'acceptanceBaselineRefusals',
      'selfContinuations',
      'planCoverageNagged',
      'planIsFallback',
      'turnNoveltyBytes',
      // Per turn like the egress budget above it, and for the same reason: the refusal says "this
      // turn", so a counter that carried would refuse the first reach of every turn afterwards.
      'memoryReaches'
    ]);
    expect(carried).toEqual([
      'enabledToolGroups',
      'credits',
      'planVersion',
      'contextBrief',
      'compactions',
      'transcriptionRates',
      'toolOutputFloor',
      'openedSkills',
      'ownerReasoningEffort',
      'preparedInputTokens',
      'approvalRecovery',
      'argumentTruncations',
      'readFileHashes',
      'partialReads',
      'contextOverflowRepairs',
      'takeoversRaised',
      'unattended',
      // Carried, and it is the one field in this list whose carrying is a promise to the owner
      // rather than bookkeeping: plan mode ends when they end it, not when the turn does.
      'mode',
      'lastStepUsd',
      'spendWarnings',
      'checkpoint',
      'inFlight',
      'acceptance',
      'acceptanceTurn',
      'acceptanceCaveat',
      'taint',
      'webToolMode',
      'knownOrigins',
      'knownAddresses',
      'mainModelPreference',
      'projectContextFingerprint',
      // Carried, because a wall outlives the turn it stopped: the re-route that answers one lands
      // the task on a different provider for its *next* turn, and a list reset in between would
      // send it straight back to the provider that was rate-limiting it. Cleared on the first step
      // that actually produces a response, which is the honest signal that routing is working.
      'walledProviders'
    ]);
    expect(dropped.length + reset.length + carried.length).toBe(FIELDS.length);
  });

  /**
   * The four the comment on `startTurnState` argues for by name, asserted as themselves so a change
   * to any of them has to be argued for again rather than absorbed into a list.
   */
  it('does not launder the taint, the web route, the output floor or the acceptance record', () => {
    expect(next.taint).toEqual(FULL.taint);
    expect(next.webToolMode).toBe('in_house');
    expect(next.toolOutputFloor).toBe(1_200);
    expect(next.acceptance).toEqual(FULL.acceptance);
    expect(next.acceptanceCaveat).toBe(FULL.acceptanceCaveat);
  });

  it('opens the new turn on the owner message with none of the last turn bookkeeping', () => {
    expect(next.messages.at(-1)).toEqual({ role: 'user', content: 'and now the exporter' });
    expect(next.messages).toHaveLength(FULL.messages.length + 1);
    expect(next.step).toBe(0);
    expect(next.turn).toBe(4);
    expect(next.turnToolResults).toEqual({});
    expect(next.turnNoveltyBytes).toBe(0);
    expect(next.memoryReaches).toBe(0);
  });

  /**
   * And the new turn is itself checkpointable, which is the case the API's door actually takes: a
   * follow-up seeds a state, seals it, and hands it to a worker that has never seen this task.
   */
  it('seals and reopens the state a follow-up turn starts from', () => {
    const restored = decryptJson<AgentState>(encryptJson(next, key, aad), key, aad);
    expect(restored).toEqual(next);
  });
});
