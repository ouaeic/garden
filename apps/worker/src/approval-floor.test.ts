import { describe, expect, it, vi } from 'vitest';
import { wrapDataKey } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import type { DestinationContext } from './egress.js';
import {
  approvalForCallOnce,
  transcriptionModelForCall,
  createApprovalFloorMemo,
  type ApprovalFloorDeps
} from './approval-floor.js';
import type { AgentRunnerClient } from './runner-client.js';

const task = {
  id: 'task-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  securityMode: 'balanced'
} as unknown as TaskRecord;

const call = (id: string, name: string, args: Record<string, unknown> = {}): ModelToolCall =>
  ({ id, name, arguments: args }) as unknown as ModelToolCall;

/**
 * A floor that counts what an evaluation costs.
 *
 * `destinationContext` is the right thing to count: every evaluation builds one, and building one
 * joins up to forty thousand characters of the owner's own words and copies two origin arrays. It
 * is also the dependency that made the duplicate worth fixing rather than merely noticing.
 */
const countingFloor = (): { deps: ApprovalFloorDeps; evaluations: () => number } => {
  let evaluations = 0;
  const deps: ApprovalFloorDeps = {
    store: {} as DataStore,
    masterKey: Buffer.alloc(32, 1),
    runner: {} as AgentRunnerClient,
    inferenceCredential: async () => {
      throw new Error('no credential is needed to evaluate a read');
    },
    destinationContext: (): DestinationContext => {
      evaluations += 1;
      return {
        knownOrigins: [],
        knownAddresses: [],
        ownerText: '',
        selfOrigins: [],
        spentNoveltyBytes: 0
      };
    }
  };
  return { deps, evaluations: () => evaluations };
};

describe('the approval floor is evaluated once per call', () => {
  const surfaceCases = [
    ['browser_action', { action: 'click', selector: '#apply' }],
    ['browser_action', { action: 'upload', selector: '#cv', paths: ['workspace/cv.pdf'] }],
    ['browser_action', { action: 'press', key: 'Enter' }],
    ['browser_action', { action: 'click_at', x: 10, y: 20 }],
    ['browser_action', { action: 'dialog', response: 'accept' }],
    ['browser_action', { action: 'batch', actions: [{ action: 'click', selector: '#submit' }] }],
    ['desktop_action', { action: 'invoke', nodeId: 'submit' }],
    ['desktop_action', { action: 'click_at', x: 10, y: 20 }]
  ] as const;

  it.each(surfaceCases)('honors owner-selected Autonomous for %s %j', async (name, args) => {
    const deps = { ...countingFloor().deps };
    const preflight = vi.fn(async () => ({
      consequential: true,
      sensitiveInput: false,
      preview: 'Submit application'
    }));
    deps.runner = { call: preflight } as unknown as AgentRunnerClient;
    const proposal = call('surface', name, args);
    for (const securityMode of ['autonomous', 'balanced', 'review'] as const) {
      const result = await approvalForCallOnce(
        deps,
        createApprovalFloorMemo(),
        { ...task, securityMode },
        proposal
      );
      if (securityMode === 'autonomous') expect(result).toBeNull();
      else expect(result?.sideEffect).toBe('external_consequential');
    }
    expect(preflight).toHaveBeenCalledTimes(3);
  });

  it.each(['browser_action', 'desktop_action'])(
    'keeps private input a handoff in Autonomous for %s',
    async (name) => {
      const deps = { ...countingFloor().deps };
      deps.runner = {
        call: async () => ({ consequential: true, sensitiveInput: true, preview: 'Password' })
      } as unknown as AgentRunnerClient;
      const result = await approvalForCallOnce(
        deps,
        createApprovalFloorMemo(),
        { ...task, securityMode: 'autonomous' },
        call('secret', name, { action: 'type', selector: '#password', text: 'private' })
      );
      expect(result).toMatchObject({ handoffOnly: true, sideEffect: 'external_consequential' });
      expect(result?.preview).not.toContain('text:');
    }
  );

  it.each(['browser_action', 'desktop_action'])(
    'hands a recognized signature to the owner in Autonomous for %s',
    async (name) => {
      const deps = { ...countingFloor().deps };
      deps.runner = {
        call: async () => ({
          consequential: true,
          sensitiveInput: false,
          handoffKind: 'signature',
          tabId: 'signing-tab',
          preview: 'Sign employment agreement'
        })
      } as unknown as AgentRunnerClient;
      const result = await approvalForCallOnce(
        deps,
        createApprovalFloorMemo(),
        { ...task, securityMode: 'autonomous' },
        call('signature', name, { action: 'click', selector: '#sign' })
      );
      expect(result).toMatchObject({
        handoffOnly: true,
        handoff: { kind: 'signature', tabId: 'signing-tab' },
        action: 'Your signature is needed'
      });
    }
  );

  it('applies a parent mode downgrade before authorizing a mission browser action', async () => {
    const deps = { ...countingFloor().deps };
    deps.store = { getTask: async () => ({ ...task, status: 'running' }) } as unknown as DataStore;
    deps.runner = {
      call: async () => ({ consequential: true, sensitiveInput: false, preview: 'Submit' })
    } as unknown as AgentRunnerClient;
    const child = {
      ...task,
      securityMode: 'autonomous' as const,
      parentMissionId: 'mission',
      parentTaskId: task.id
    };
    const result = await approvalForCallOnce(
      deps,
      createApprovalFloorMemo(),
      child,
      call('submit', 'browser_action', { action: 'click', selector: '#submit' })
    );
    expect(result?.sideEffect).toBe('external_consequential');
    expect(child.securityMode).toBe('balanced');
  });

  it('describes the actual browser upload destination without substituting the agent explanation', async () => {
    const { deps: base } = countingFloor();
    const runner = {
      call: async () => ({
        consequential: true,
        sensitiveInput: false,
        preview: 'Attach workspace file workspace/cv.pdf\nWebsite: https://careers.example:8443',
        destinations: ['https://careers.example:8443']
      })
    } as unknown as AgentRunnerClient;
    const deps = { ...base, runner };
    const card = await approvalForCallOnce(
      deps,
      createApprovalFloorMemo(),
      task,
      call('upload', 'browser_action', {
        action: 'upload',
        selector: '#cv',
        paths: ['workspace/cv.pdf']
      }),
      { messages: [], toolsStarted: 0 } as unknown as AgentState
    );
    expect(card).toMatchObject({
      sideEffect: 'external_consequential',
      destinations: ['https://careers.example:8443']
    });
    expect(card?.preview).toContain('Website: https://careers.example:8443');
    expect(card?.preview).not.toContain('The agent stated no reason');
  });
  /*
   * The loop asks twice about the first call of every candidate parallel run: once while choosing
   * the run, and again on the sequential path the run falls through to when it collapses to one
   * call. Both asks are reproduced here in the order the loop makes them, with nothing between,
   * because nothing between them in the loop starts a tool either.
   */
  it('answers the second ask about one call from the first evaluation', async () => {
    const { deps, evaluations } = countingFloor();
    const memo = createApprovalFloorMemo();
    const state = { messages: [], toolsStarted: 0 } as unknown as AgentState;
    const read = call('call-1', 'file_read', { path: 'workspace/notes.md' });

    const chosen = await approvalForCallOnce(deps, memo, task, read, state);
    const sequential = await approvalForCallOnce(deps, memo, task, read, state);

    expect(chosen).toBeNull();
    expect(sequential).toBeNull();
    expect(evaluations()).toBe(1);
  });

  it('still answers each call of a run separately', async () => {
    const { deps, evaluations } = countingFloor();
    const memo = createApprovalFloorMemo();
    const state = { messages: [], toolsStarted: 0 } as unknown as AgentState;

    await approvalForCallOnce(deps, memo, task, call('call-1', 'file_read', { path: 'a' }), state);
    await approvalForCallOnce(deps, memo, task, call('call-2', 'file_read', { path: 'b' }), state);
    await approvalForCallOnce(deps, memo, task, call('call-1', 'file_read', { path: 'a' }), state);

    // Two calls, two verdicts - and the third ask is the first call again, which is the collapse
    // this exists to make free. A memo that held one entry would have lost it when call-2 arrived,
    // which is the shape the first draft of this fix had.
    expect(evaluations()).toBe(2);
  });

  it('re-evaluates once a tool has run, because taint moves the answer', async () => {
    const { deps, evaluations } = countingFloor();
    const memo = createApprovalFloorMemo();
    const state = { messages: [], toolsStarted: 0 } as unknown as AgentState;
    const read = call('call-1', 'file_read', { path: 'workspace/notes.md' });

    await approvalForCallOnce(deps, memo, task, read, state);
    // What the loop does immediately before every dispatch, on both the sequential and the
    // parallel path. A verdict taken before a tool ran says nothing about the turn after it.
    state.toolsStarted = 1;
    await approvalForCallOnce(deps, memo, task, read, state);

    expect(evaluations()).toBe(2);
  });
});

/*
 * The lookup this floor used to do before every diagnostic, and no longer does.
 *
 * A `code_diagnostics` call carries `language: 'auto'` and settles nothing, so the removed approval
 * card could not tell `tsc --noEmit` from `make -s` on the arguments. It bought the answer with a
 * directory listing taken here, from the runner, before every call. The card is gone and so is the
 * round trip - which is the second saving, and the one nobody would have noticed: the dispatch arm
 * takes the same listing a moment later and acts on it, so this one was a runner call per
 * diagnostic spent entirely on the wording of a question.
 *
 * Both halves are asserted, because "the card is gone" and "the lookup is gone" fail differently.
 * A floor that still asks costs the owner a click; a floor that still looks costs a round trip on
 * every diagnostic and shows up as nothing at all.
 */
describe('what the floor no longer has to look up before a diagnostic runs', () => {
  const listing = (entries: string[], seen: string[] = [], fail = false): ApprovalFloorDeps => ({
    store: {} as DataStore,
    masterKey: Buffer.alloc(32, 1),
    runner: {
      call: async (_workspaceId: string, _taskId: string, scope: string) => {
        seen.push(scope);
        if (fail) throw new Error('the runner is not answering');
        return { entries: entries.map((name) => ({ name })) };
      }
    } as unknown as AgentRunnerClient,
    inferenceCredential: async () => {
      throw new Error('no credential is needed to judge a diagnostic');
    },
    destinationContext: (): DestinationContext => ({
      knownOrigins: [],
      knownAddresses: [],
      ownerText: '',
      selfOrigins: [],
      spentNoveltyBytes: 0
    })
  });

  const judge = async (
    entries: string[],
    args: Record<string, unknown> = {},
    seen: string[] = [],
    fail = false
  ) =>
    approvalForCallOnce(
      listing(entries, seen, fail),
      createApprovalFloorMemo(),
      task,
      call('call-1', 'code_diagnostics', { path: 'workspace/cloned', ...args }),
      { messages: [], toolsStarted: 0 } as unknown as AgentState
    );

  /*
   * The owner's own Rust project against the owner's own TypeScript project, driven through the
   * real listing so the two calls genuinely differ - identical arguments, one marker file apart,
   * which is the only place in the product where that difference was ever visible. The Rust one
   * used to cost a card and the TypeScript one did not, and the difference is measured here rather
   * than argued: `evals/cards` counts the same pair over a whole trajectory.
   */
  it('charges a Cargo.toml exactly what it charges a package.json, which is nothing', async () => {
    expect(await judge(['Cargo.toml', 'src'])).toBeNull();
    expect(await judge(['package.json', 'tsconfig.json'])).toBeNull();
    expect(await judge(['go.mod', 'main.go'])).toBeNull();
    expect(await judge(['Makefile', 'main.c'])).toBeNull();
    expect(await judge(['notes.md'])).toBeNull();
  });

  /*
   * The saving, asserted as an absence of a runner call rather than as a comment claiming one.
   * `files.read` here was the listing; nothing else in this floor reaches the runner for a
   * diagnostic, so an empty scope list is the whole statement.
   */
  it('reaches the runner not at all, where it used to take a listing before every call', async () => {
    const seen: string[] = [];
    expect(await judge(['Cargo.toml', 'src'], {}, seen)).toBeNull();
    expect(seen).toEqual([]);
  });

  /*
   * The old branch failed closed: a listing it could not take became a card, on the reasoning that
   * unknown must not read as safe. With nothing to be unknown about, a runner that is not answering
   * costs the diagnostic nothing here - it is the dispatch arm's error to report, once, in its own
   * words.
   */
  it('does not invent a card out of a runner that is not answering', async () => {
    expect(await judge([], {}, [], true)).toBeNull();
  });

  /*
   * `language` is the one argument the model chooses freely, and it used to be the one worth asking
   * about twice: it could neither walk past the card nor invent one. Now it decides only which
   * command the dispatch arm runs, and this floor has no opinion about any of them.
   */
  it('has no opinion about the language the call names, whichever it names', async () => {
    expect(await judge(['package.json', 'tsconfig.json'], { language: 'go' })).toBeNull();
    expect(await judge(['Makefile', 'main.c'], { language: 'ruby' })).toBeNull();
  });
});

/*
 * The undo point the destructive rule spends, measured through the floor the worker actually calls.
 *
 * `approvalRequirement` is pure - no filesystem, no runner - so the only place the difference
 * between "this turn can be rewound" and "this turn cannot" can enter is the context this file
 * builds. Pinning it on `approvalRequirement` alone would prove the rule and not the wiring, which
 * is the defect this tree has shipped four times; every assertion here goes through
 * `approvalForCallOnce`.
 *
 * `rm -rf dist` is the row to pin it with because it is the whole saving: strictly inside
 * `CHECKPOINT_CONTENT`, carded in balanced before the location rule existed, and free after it -
 * but only ever honestly free on a turn that has an undo point.
 */
describe('what the floor tells the destructive rule about this turn’s undo point', () => {
  const state = (fields: Partial<AgentState>): AgentState =>
    ({ messages: [], toolsStarted: 0, turn: 3, ...fields }) as unknown as AgentState;
  const remove = call('call-rm', 'shell', { executable: 'rm', args: ['-rf', 'dist'] });
  const ask = (agentState?: AgentState) =>
    approvalForCallOnce(countingFloor().deps, createApprovalFloorMemo(), task, remove, agentState);

  it('drops the card for a delete this turn can undo by itself', async () => {
    await expect(
      ask(state({ checkpoint: { turn: 3, id: 'checkpoint-3', uncovered: [] } }))
    ).resolves.toBeNull();
  });

  /*
   * The second ceiling, wired the same way and through the same call.
   *
   * `CHECKPOINT_MAX_FILE_BYTES` makes the runner's scan record a file over 2 GiB as uncovered and
   * walk past it, so a delete of one is strictly inside `CHECKPOINT_CONTENT` and is restored by
   * nothing. The paths are carried on `AgentState.checkpoint.uncovered`; `undoPointFor` spreads
   * them onto the context, and a set that is not known is spread as nothing rather than as empty.
   *
   * Both directions, because a blanket would satisfy the first: one oversize file in a workspace
   * must card the delete that reaches it and leave `rm -rf dist` alone.
   */
  it('carries which files the checkpoint walked past, and only cards the ones it reaches', async () => {
    const held = (uncovered: readonly string[]) =>
      state({ checkpoint: { turn: 3, id: 'checkpoint-3', uncovered } });
    const weights = call('call-weights', 'shell', {
      executable: 'rm',
      args: ['workspace/model.gguf']
    });
    const askFor = (agentState: AgentState, which = remove) =>
      approvalForCallOnce(countingFloor().deps, createApprovalFloorMemo(), task, which, agentState);

    await expect(askFor(held(['workspace/model.gguf']), weights)).resolves.toMatchObject({
      sideEffect: 'external_consequential'
    });
    await expect(askFor(held(['workspace/model.gguf']))).resolves.toBeNull();
    await expect(askFor(held([]), weights)).resolves.toBeNull();
  });

  /*
   * Every way the fact can be missing, and all of them card. The refusal is the one that matters
   * most: `#ensureTurnUndoPoint` catches `CheckpointRefusedError` - a workspace over
   * `CHECKPOINT_MAX_FILES`, or a full host disk - writes `{ turn, id: null }`, tells the owner the
   * turn has no undo point and lets the work carry on. Without this, that is the turn on which
   * every delete inside `workspace/` becomes free.
   *
   * The stale row is not hypothetical either: `state.checkpoint` is persisted and survives a
   * resume, an approval park and a worker handover, so turn 2's answer is sitting in state
   * throughout turn 3 until turn 3 takes its own.
   */
  it('keeps it wherever the turn cannot be shown to have one', async () => {
    for (const [why, agentState] of [
      ['the runner refused the checkpoint', state({ checkpoint: { turn: 3, id: null } })],
      [
        'the fact belongs to an earlier turn',
        state({ checkpoint: { turn: 2, id: 'checkpoint-2', uncovered: [] } })
      ],
      /*
       * A good checkpoint whose uncovered set nobody established: a runner one release behind this
       * worker, a list the runner had to cut off, or a state row written before the field existed.
       * The id is fine and what the walk skipped is not known, so every delete keeps its card - the
       * one reading of "unknown" that does not free a delete nothing restores.
       */
      ['the uncovered set is not known', state({ checkpoint: { turn: 3, id: 'checkpoint-3' } })],
      ['this turn has not taken one yet', state({})],
      ['there is no state at all', undefined]
    ] as const)
      await expect(ask(agentState), why).resolves.toMatchObject({
        sideEffect: 'external_consequential'
      });
  });
});

describe('transcription floor price authority', () => {
  const route = {
    id: 'openai/transcribe',
    providerModelId: 'gpt-4o-transcribe',
    displayName: 'Transcription',
    provider: 'openai',
    apiProtocol: 'openai',
    modality: 'transcription',
    usdPerImage: null,
    usdPerMillionCharacters: null,
    usdPerMinute: null,
    priceSource: 'provider',
    recommendationTags: [],
    updatedAt: '2026-09-06T00:00:00.000Z',
    pricing: [
      { billable: 'input_tokens', unit: 'token', costUsd: 0.0000025 },
      { billable: 'output_tokens', unit: 'token', costUsd: 0.00001 }
    ]
  } as const;
  it('ties native model limits to the actual credential endpoint', async () => {
    const { deps } = countingFloor();
    const secret = {
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test',
      mediaRoutes: { transcription: route }
    };
    deps.inferenceCredential = async () =>
      secret as unknown as Awaited<ReturnType<ApprovalFloorDeps['inferenceCredential']>>;
    expect(
      (await transcriptionModelForCall(deps, task)).mediaModel?.transcriptionBound?.reservationUsd
    ).toBeCloseTo(0.06);
    secret.baseUrl = 'https://unverified.example/v1';
    expect(
      (await transcriptionModelForCall(deps, task)).mediaModel?.transcriptionBound
    ).toBeUndefined();
    secret.baseUrl = 'https://api.openai.com/v1';
    secret.provider = 'openrouter';
    expect(
      (await transcriptionModelForCall(deps, task)).mediaModel?.transcriptionBound
    ).toBeUndefined();
  });
});

describe('recording approval source and destination binding', () => {
  it('pins a cheap external reading at the common floor and requires its real source receipt', async () => {
    const counted = countingFloor();
    const key = Buffer.alloc(32, 9);
    const deps = { ...counted.deps };
    const inspect = vi.fn(async () => ({ sourceSha256: 'b'.repeat(64), sourceBytes: 500 }));
    deps.runner = { inspectAudioSource: inspect } as unknown as AgentRunnerClient;
    deps.store = {
      mediaSpendForTask: async () => 0,
      getWorkspaceById: async () => ({
        id: task.workspaceId,
        wrappedKey: wrapDataKey(key, deps.masterKey, task.workspaceId)
      })
    } as unknown as DataStore;
    deps.inferenceCredential = async () => ({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'fixture',
      enforceZeroDataRetention: true,
      mediaRoutes: {
        transcription: {
          id: 'openai/whisper-1',
          providerModelId: 'whisper-1',
          provider: 'openai',
          displayName: 'Whisper',
          apiProtocol: 'openai',
          modality: 'transcription',
          usdPerImage: null,
          usdPerMillionCharacters: null,
          usdPerMinute: 0.006,
          priceSource: 'provider',
          pricing: [{ billable: 'input_audio', unit: 'minute', costUsd: 0.006 }],
          zeroDataRetentionAvailable: true,
          recommendationTags: [],
          updatedAt: '2026-09-06T00:00:00.000Z'
        }
      }
    });
    const state = { messages: [], turn: 1 } as unknown as AgentState;
    const request = call('external-source', 'audio_read', {
      path: 'workspace/private.ogg',
      endSeconds: 1,
      options: { privacyRoute: 'external' }
    });
    const card = await approvalForCallOnce(deps, createApprovalFloorMemo(), task, request, state);
    expect(card?.sideEffect).toBe('external_reversible');
    expect(card?.preview).toContain('https://api.openai.com');
    expect(card?.preview).toContain('b'.repeat(64));
    expect(card?.preview).toContain('500 bytes');
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      task.workspaceId,
      task.id,
      'workspace/private.ogg'
    );
    expect(state.transcriptionApprovals?.[request.id]).toMatchObject({
      sourceSha256: 'b'.repeat(64),
      sourceBytes: 500
    });
    expect(state.transcriptionApprovals?.[request.id]?.binding).toMatch(/^[0-9a-f]{64}$/);
    inspect.mockResolvedValue({ sourceSha256: '', sourceBytes: 0 });
    await expect(
      approvalForCallOnce(
        deps,
        createApprovalFloorMemo(),
        task,
        { ...request, id: 'unverified' },
        state
      )
    ).rejects.toMatchObject({ code: 'transcription_source_unverified' });
  });
});

describe('the keys an owner lends, at the floor', () => {
  const publish = call('publish', 'publish_preview', {
    label: 'site',
    port: '5173',
    reach: 'public'
  });

  it('answers a card whose every key this goal holds, and only that goal', async () => {
    const { deps } = countingFloor();
    const lent = { ...task, lentKeys: ['publish'] } as TaskRecord;
    const kept = { ...task, lentKeys: ['rules'] } as TaskRecord;
    expect(await approvalForCallOnce(deps, createApprovalFloorMemo(), lent, publish)).toBeNull();
    expect(await approvalForCallOnce(deps, createApprovalFloorMemo(), kept, publish)).toMatchObject(
      { sideEffect: 'external_consequential' }
    );
  });
});
