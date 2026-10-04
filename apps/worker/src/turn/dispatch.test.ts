/**
 * The order the batch loop asks its two questions in, which is a bound and not a detail.
 *
 * The approval floor's destructive rule frees a delete strictly inside `CHECKPOINT_CONTENT` because
 * a rewind puts it back, and it learns whether this turn HAS a rewind from `ApprovalContext.undoPoint`
 * - fed from `AgentState.checkpoint`, written by `#ensureTurnUndoPoint`. Taken one gate later,
 * inside `turn/execute-call.ts`, the undo point would leave the floor answering a question about a
 * fact nobody had established yet on the first non-exempt call of a turn. The cost would be one
 * card for a turn whose opening act was itself a recoverable delete, while the identical delete two
 * calls later would be free: a verdict decided by position in the batch.
 *
 * Asserted here rather than on `approvalRequirement`, because the rule was never the thing in doubt.
 * What is in doubt is the sequencing, and the sequencing lives in `dispatchToolCalls`.
 *
 * The floor stub throws once it has recorded what it was shown. That is deliberate: everything past
 * the floor is the execution path, which needs a store, a lease, a cancellation watch and a runner,
 * and none of it can change what the floor was already handed. The throw stops the batch exactly
 * where the question has been answered.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ModelRelease, WebToolPlan } from '@garden/contracts';
import type { TaskRecord } from '@garden/data';
import type { ModelResponse, ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from '../agent-state.js';
import { agentToolsFor, approvalRequirement } from '../tools.js';
import { specialistToolNames } from '../tool-catalogue.js';
import { CHECKPOINT_EXEMPT_TOOLS, PARALLEL_SAFE_TOOLS } from '../turn-bounds.js';
import { isMutatingToolCall } from '../write-classification.js';
import { dispatchToolCalls, PLAN_MODE_PERMITTED, type TurnDispatchDeps } from './dispatch.js';
import type { TurnRun } from './claim.js';
import { projectOperation } from '../project-updates.js';

const task = { id: 'task-1', workspaceId: 'ws-1', securityMode: 'autonomous' } as TaskRecord;
const key = new Uint8Array(32);

it('answers invalid project-update arguments and continues the turn without executing the rejected action', async () => {
  const invalid = {
    id: 'invalid-prepare',
    name: 'project_update',
    arguments: {
      action: 'prepare',
      options: { title: 'Analysis', update: { paths: ['results.json'] } }
    }
  };
  const next = {
    id: 'read-source',
    name: 'parallel_web_read',
    arguments: { urls: ['https://source.example/page'] }
  };
  const state = { messages: [], turn: 3, toolsStarted: 0 } as unknown as AgentState;
  const recordToolFailure = vi.fn();
  const execute = vi.fn();
  const parkTaskForApproval = vi.fn();
  const floor = vi.fn(async (_memo: unknown, current: TaskRecord, call: ModelToolCall) => {
    if (call.name === 'project_update') projectOperation(current, call);
    return approvalRequirement(call.name, call.arguments, 'autonomous', {
      taintSources: ['workspace/file']
    });
  });
  const deps = {
    store: { appendTaskEvent: vi.fn(async () => ({})), parkTaskForApproval },
    config: {},
    resume: { ensureTurnUndoPoint: async () => {}, recordToolFailure, execute },
    approvalForCallOnce: floor
  } as unknown as TurnDispatchDeps;
  expect(
    await dispatchToolCalls(
      deps,
      { ...task, projectId: task.id },
      key,
      state,
      { toolCalls: [invalid, next] } as unknown as ModelResponse,
      { model: {}, catalog: [], webPlan: {} } as unknown as TurnRun,
      { maxOutputTokens: 1024, turn: 3 },
      { honorUserControl: async () => false, refreshActivePlan: async () => false }
    )
  ).toBe('done');
  expect(recordToolFailure).toHaveBeenCalledOnce();
  expect(recordToolFailure.mock.calls[0]?.[3]).toEqual(invalid);
  expect(String(recordToolFailure.mock.calls[0]?.[4])).toContain('title');
  expect(floor).toHaveBeenCalledTimes(2);
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]).toMatchObject({ toolCallId: next.id });
  expect(state.toolsStarted).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  expect(parkTaskForApproval).not.toHaveBeenCalled();
});

it('answers an unverified Autonomous read without running it, parking the owner or marking it as executed', async () => {
  const call = {
    id: 'read',
    name: 'parallel_web_read',
    arguments: { urls: ['https://source.example/page'] }
  };
  const state = { messages: [], turn: 3, toolsStarted: 0 } as unknown as AgentState;
  const appendTaskEvent = vi.fn(async () => ({}));
  const parkTaskForApproval = vi.fn();
  const executeTool = vi.fn();
  const deps = {
    store: { appendTaskEvent, parkTaskForApproval },
    config: {},
    resume: { ensureTurnUndoPoint: async () => {}, executeTool },
    approvalForCallOnce: async () =>
      approvalRequirement(call.name, call.arguments, 'autonomous', {
        taintSources: ['workspace/file']
      })
  } as unknown as TurnDispatchDeps;
  expect(
    await dispatchToolCalls(
      deps,
      task,
      key,
      state,
      { toolCalls: [call] } as unknown as ModelResponse,
      { model: {}, catalog: [], webPlan: {} } as unknown as TurnRun,
      { maxOutputTokens: 1024, turn: 3 },
      { honorUserControl: async () => false, refreshActivePlan: async () => false }
    )
  ).toBe('done');
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]).toMatchObject({ role: 'tool', toolCallId: 'read' });
  expect(state.messages[0]?.content).toContain('Not executed:');
  expect(state.seenCalls ?? {}).toEqual({});
  expect(state.toolsStarted).toBe(0);
  expect(appendTaskEvent).toHaveBeenCalledOnce();
  expect(executeTool).not.toHaveBeenCalled();
  expect(parkTaskForApproval).not.toHaveBeenCalled();
});

const toolCall = (name: string, args: Record<string, unknown>): ModelToolCall =>
  ({ id: `call-${name}`, name, arguments: args }) as ModelToolCall;

/** Stopped at the floor, which is where the only question this file asks has been answered. */
class AskedTheFloor extends Error {}

interface Seen {
  /** The turn's undo point as the floor was shown it, or undefined if it had not been taken. */
  checkpoint: AgentState['checkpoint'];
  order: string[];
}

/**
 * One batch through the real `dispatchToolCalls`, with the two deps this file is about recorded.
 *
 * `ensureTurnUndoPoint` is the worker's own, spelled the way `AgentWorker` spells it: exempt tools
 * are refused outright, and a runner that refuses the checkpoint still writes `{ turn, id: null }`
 * so the turn does not retry it before every later call.
 */
const dispatch = async (
  calls: readonly ModelToolCall[],
  checkpointResult: 'taken' | 'refused'
): Promise<Seen> => {
  const seen: Seen = { checkpoint: undefined, order: [] };
  const state = { messages: [], turn: 3, toolsStarted: 0 } as unknown as AgentState;
  const exempt = new Set(['files_list', 'file_read', 'notify']);
  const deps = {
    store: {} as TurnDispatchDeps['store'],
    config: {} as TurnDispatchDeps['config'],
    acceptance: {} as TurnDispatchDeps['acceptance'],
    resume: {
      ensureTurnUndoPoint: async (
        _task: TaskRecord,
        _key: Uint8Array,
        agentState: AgentState,
        tool: string
      ) => {
        if (exempt.has(tool) || agentState.checkpoint?.turn === (agentState.turn ?? 0)) return;
        seen.order.push(`undo:${tool}`);
        agentState.checkpoint =
          checkpointResult === 'taken'
            ? { turn: agentState.turn ?? 0, id: 'checkpoint-3', uncovered: [] }
            : { turn: agentState.turn ?? 0, id: null };
      }
    } as unknown as TurnDispatchDeps['resume'],
    approvalForCallOnce: async (
      _memo: unknown,
      _task: TaskRecord,
      call: ModelToolCall,
      agentState?: AgentState
    ) => {
      seen.order.push(`floor:${call.name}`);
      seen.checkpoint = agentState?.checkpoint;
      throw new AskedTheFloor(call.name);
    },
    runToolCallsTogether: async () => undefined,
    recordToolResult: async () => undefined,
    compactContext: (async () => undefined) as unknown as TurnDispatchDeps['compactContext'],
    sendNotice: async () => undefined,
    askUser: async () => false
  } as unknown as TurnDispatchDeps;

  await dispatchToolCalls(
    deps,
    task,
    key,
    state,
    { toolCalls: calls } as ModelResponse,
    { model: {} as ModelRelease, catalog: [], webPlan: {} as WebToolPlan } as unknown as TurnRun,
    { maxOutputTokens: 1024, turn: 3 },
    { honorUserControl: async () => false, refreshActivePlan: async () => false }
  ).catch((error: unknown) => {
    if (!(error instanceof AskedTheFloor)) throw error;
  });
  return seen;
};

describe('the undo point and the floor, in that order', () => {
  const remove = toolCall('shell', { executable: 'rm', args: ['-rf', 'dist'] });

  it('takes the turn’s undo point before it asks the floor about the first call', async () => {
    const seen = await dispatch([remove], 'taken');

    expect(seen.order).toEqual(['undo:shell', 'floor:shell']);
    expect(seen.checkpoint).toEqual({ turn: 3, id: 'checkpoint-3', uncovered: [] });
    /*
     * And that the fact is the one the rule spends. This is the whole saving: `rm -rf dist` is
     * strictly inside `CHECKPOINT_CONTENT`, carded in balanced before the location rule existed,
     * and free after it - but only on a turn that has a rewind. Asked of the context the floor was
     * actually handed rather than of one written here.
     */
    expect(
      approvalRequirement('shell', remove.arguments, 'autonomous', {
        undoPoint: {
          id: seen.checkpoint?.id ?? null,
          ...(seen.checkpoint?.uncovered ? { uncovered: seen.checkpoint.uncovered } : {})
        }
      })
    ).toBeNull();
  });

  /*
   * The fail-closed direction, which the ordering must not trade away. `#ensureTurnUndoPoint`
   * catches `CheckpointRefusedError` - a workspace over `CHECKPOINT_MAX_FILES`, a full host disk -
   * tells the owner this turn has no undo point and lets the work carry on. The floor must see that
   * refusal, not the same absence it would see before anybody had tried.
   */
  it('shows the floor a refusal when the checkpoint could not be taken', async () => {
    const seen = await dispatch([remove], 'refused');

    expect(seen.order).toEqual(['undo:shell', 'floor:shell']);
    expect(seen.checkpoint).toEqual({ turn: 3, id: null });
    expect(
      approvalRequirement('shell', remove.arguments, 'autonomous', {
        undoPoint: {
          id: seen.checkpoint?.id ?? null,
          ...(seen.checkpoint?.uncovered ? { uncovered: seen.checkpoint.uncovered } : {})
        }
      })
    ).toMatchObject({ sideEffect: 'external_consequential' });
  });

  /*
   * And a turn that only reads still costs nothing, which is the reason the undo point was lazy in
   * the first place. The exemption lives inside `#ensureTurnUndoPoint`, so moving the call earlier
   * moves the exemption with it.
   */
  it('costs a read nothing', async () => {
    const seen = await dispatch([toolCall('files_list', { path: 'workspace' })], 'taken');

    expect(seen.order).toEqual(['floor:files_list']);
    expect(seen.checkpoint).toBeUndefined();
  });
});

/**
 * Plan mode: what the harness refuses while the owner has not yet approved the approach, and the
 * two things about it that are properties rather than behaviour.
 *
 * The mode is enforced here and described nowhere the model can read. That is what makes it cost
 * nothing at the head of the cached prefix, and it is also what makes these tests the whole of the
 * specification: there is no sentence in the catalogue for a reviewer to check the behaviour
 * against, so the behaviour has to be checked against the sets it is derived from.
 *
 * Driven through the real `dispatchToolCalls`, like the block above, and stopped at the same place:
 * a permitted call reaches the floor and the floor throws, which is exactly the evidence wanted -
 * "this call got past plan mode" is what reaching the floor means.
 */
const planDispatch = async (
  calls: readonly ModelToolCall[],
  mode: AgentState['mode'],
  state: AgentState = { messages: [], turn: 3, toolsStarted: 0 } as unknown as AgentState
): Promise<{ order: string[]; refusals: Record<string, string>; state: AgentState }> => {
  const order: string[] = [];
  const refusals: Record<string, string> = {};
  // Deleted rather than set to undefined for the absent case: `exactOptionalPropertyTypes` is on,
  // and an absent field is what a state written before this one existed actually carries.
  if (mode === undefined) delete state.mode;
  else state.mode = mode;
  const deps = {
    // Enough store for the timeline writes the harness-answered calls make on their way through.
    store: { appendTaskEvent: async () => undefined } as unknown as TurnDispatchDeps['store'],
    config: {} as TurnDispatchDeps['config'],
    acceptance: {} as TurnDispatchDeps['acceptance'],
    resume: {
      ensureTurnUndoPoint: async () => undefined
    } as unknown as TurnDispatchDeps['resume'],
    approvalForCallOnce: async (_memo: unknown, _task: TaskRecord, call: ModelToolCall) => {
      order.push(`floor:${call.name}`);
      throw new AskedTheFloor(call.name);
    },
    // Recorded rather than run, because a run of permitted reads is still a run of calls that got
    // past the gate - which is the thing being measured.
    runToolCallsTogether: async (
      _task: TaskRecord,
      _key: Uint8Array,
      _state: AgentState,
      run: readonly ModelToolCall[]
    ) => {
      for (const call of run) order.push(`ran:${call.name}`);
    },
    recordToolResult: async (
      _task: TaskRecord,
      _key: Uint8Array,
      _state: AgentState,
      call: ModelToolCall,
      result: unknown
    ) => {
      order.push(`answered:${call.name}`);
      const reason = (result as { reason?: unknown })?.reason;
      refusals[call.name] = typeof reason === 'string' ? reason : '';
    },
    compactContext: (async () => undefined) as unknown as TurnDispatchDeps['compactContext'],
    sendNotice: async (_t: TaskRecord, _k: Uint8Array, _s: AgentState, call: ModelToolCall) => {
      order.push(`notified:${call.name}`);
    },
    askUser: async (_t: TaskRecord, _k: Uint8Array, _s: AgentState, call: ModelToolCall) => {
      order.push(`asked:${call.name}`);
      return false;
    }
  } as unknown as TurnDispatchDeps;

  await dispatchToolCalls(
    deps,
    task,
    key,
    state,
    { toolCalls: calls } as ModelResponse,
    { model: {} as ModelRelease, catalog: [], webPlan: {} as WebToolPlan } as unknown as TurnRun,
    { maxOutputTokens: 1024, turn: 3 },
    { honorUserControl: async () => false, refreshActivePlan: async () => false }
  ).catch((error: unknown) => {
    if (!(error instanceof AskedTheFloor)) throw error;
  });
  return { order, refusals, state };
};

/**
 * One call of every shape the mode exists to stop, each named with the act it stands for. Written
 * as acts rather than as tool names on purpose: the question a reviewer has is "can plan mode still
 * do this to my computer", and a list of names cannot be read that way.
 */
const changingActs: ReadonlyArray<readonly [string, ModelToolCall]> = [
  ['delete a directory', toolCall('shell', { executable: 'rm', args: ['-rf', 'dist'] })],
  ['list a directory through the shell', toolCall('shell', { executable: 'ls', args: ['-la'] })],
  ['run an unrecognised script', toolCall('shell', { executable: './deploy.sh', args: [] })],
  ['replace a file', toolCall('file_write', { path: 'src/a.ts', content: 'x' })],
  ['patch a file', toolCall('file_patch', { patches: [{ path: 'src/a.ts' }] })],
  ['click a control in the browser', toolCall('browser_action', { action: 'click' })],
  ['navigate the browser', toolCall('browser_action', { action: 'navigate', url: 'https://x' })],
  ['type on the desktop', toolCall('desktop_action', { action: 'type', text: 'yes' })],
  ['launch an application', toolCall('desktop_launch', { executable: 'Mail' })],
  ['publish a preview', toolCall('publish_preview', { reach: 'public', path: 'site' })],
  ['put a file in the chat', toolCall('publish_artifact', { path: 'out.pdf' })],
  ['send through a connector', toolCall('connector_action', { action: 'mail.send' })],
  ['start a coding agent', toolCall('coding_agent', { action: 'start' })],
  ['create a schedule', toolCall('schedule', { action: 'create' })],
  ['save a skill', toolCall('skill', { action: 'upsert', name: 'deploy' })],
  ['write to memory', toolCall('memory', { action: 'write' })],
  ['start a process', toolCall('process', { action: 'start' })],
  ['generate media on the bill', toolCall('generate_media', { kind: 'image' })],
  ['transcribe a recording on the bill', toolCall('audio_read', { path: 'a.m4a' })],
  ['print a PDF into the workspace', toolCall('print_pdf', { path: 'out.pdf' })],
  // Neither of these looks like a change and both were measured being one. A compiler writes -
  // `cargo check` left sixteen paths on a crate with no build script at all - and declaring an
  // acceptance record runs the harness's red baseline, which executes the owner's own build or test
  // command. `REPEATABLE_TOOLS_THAT_WRITE` catches the first and `isMutatingToolCall` the second,
  // and the set is the conjunction precisely so that neither has to be thought of.
  ['run a compiler', toolCall('code_diagnostics', { language: 'auto' })],
  ['declare acceptance, which runs the baseline', toolCall('set_acceptance', { checks: [] })]
];

describe('plan mode, enforced at dispatch and described nowhere', () => {
  it('answers every act that would change this computer, and runs none of them', async () => {
    for (const [act, call] of changingActs) {
      const { order, refusals } = await planDispatch([call], 'plan');

      expect(order, act).toEqual([`answered:${call.name}`]);
      // The refusal has to be actionable, not merely negative: it names the mode, says nothing
      // changed, and says what to do with the step instead. A model given only "no" re-proposes.
      expect(refusals[call.name], act).toContain('Plan mode');
      expect(refusals[call.name], act).toContain('nothing changed');
      expect(refusals[call.name], act).toContain('set_plan');
    }
  });

  /*
   * The non-vacuity half, and the half that decides whether the mode is usable at all. Every
   * assertion above passes on a gate that refuses everything, and a plan mode that cannot read is a
   * plan mode that plans out of memory.
   */
  it('still lets the turn read, search, delegate, ask and finish', async () => {
    for (const call of [
      toolCall('file_read', { path: 'src/a.ts' }),
      toolCall('files_list', { path: 'src' }),
      toolCall('code_search', { query: 'dispatch' }),
      toolCall('repo_overview', {}),
      toolCall('web_search', { query: 'plan mode' }),
      toolCall('parallel_web_read', { urls: ['https://x'] }),
      toolCall('document_read', { path: 'a.pdf' }),
      toolCall('image_read', { path: 'a.png' }),
      toolCall('browser_snapshot', {}),
      toolCall('session_search', { query: 'x' }),
      toolCall('memory_recall', { query: 'x' }),
      toolCall('delegate', { missions: [{ name: 'a', instruction: 'read' }] }),
      toolCall('set_plan', { steps: ['Read the brief'] })
    ]) {
      const { order } = await planDispatch([call], 'plan');

      expect(order, call.name).not.toContain(`answered:${call.name}`);
    }
    // The two the harness answers itself, which is why they never reach the floor: a plan mode the
    // agent cannot ask a question from guesses, and one it cannot finish from never delivers.
    expect((await planDispatch([toolCall('ask', { question: 'Which?' })], 'plan')).order).toEqual([
      'asked:ask'
    ]);
    expect((await planDispatch([toolCall('notify', { message: 'x' })], 'plan')).order).toEqual([
      'notified:notify'
    ]);
  });

  /*
   * THE COUNTER-DIRECTION, and the one this whole shape was chosen for. The mode is off unless the
   * owner turned it on, and a task that never enters it must be indistinguishable from a task
   * running against the code before the gate existed.
   *
   * Measured rather than argued: the same mixed batch is driven three ways and the recorded order
   * has to be identical. `undefined` is what every persisted state written before this field
   * existed carries, and it is the reading a resumed conversation gets.
   */
  it('is off by default, and changes nothing for a turn that never enters it', async () => {
    const batch = [
      toolCall('shell', { executable: 'rm', args: ['-rf', 'dist'] }),
      toolCall('file_read', { path: 'src/a.ts' })
    ];
    const off = await planDispatch(batch, undefined);
    const act = await planDispatch(batch, 'act');
    const on = await planDispatch(batch, 'plan');

    // The delete goes to the floor and the batch stops there, exactly as it did before the gate
    // existed. `undefined` and `'act'` are the same run, which is the whole of the claim.
    expect(off.order).toEqual(['floor:shell']);
    expect(act.order).toEqual(off.order);
    // And in plan mode the delete is answered instead, and the read behind it still gets its turn -
    // a refusal ends the call, not the batch.
    expect(on.order).toEqual(['answered:shell', 'floor:file_read']);
  });

  /*
   * LEAVING PLAN MODE IS NOT THE MODEL'S TO DO, which is the claim that makes the mode worth
   * anything. It is not enforced by the refusal's wording; it is enforced by there being no tool on
   * the wire that writes `state.mode`, and by the mode being read from the persisted state rather
   * than re-derived per step.
   *
   * Driven rather than asserted: every tool the lead is offered is proposed inside plan mode, and
   * the mode has to still read `plan` at the end of the batch. A tool that could write it - now, or
   * one added later - fails here whether or not anybody thought of it.
   */
  it('cannot be left by anything the model can call', async () => {
    const calls = agentToolsFor().map((tool) => toolCall(tool.name, {}));
    expect(calls.length).toBeGreaterThan(20);

    for (const call of calls) {
      const { state } = await planDispatch([call], 'plan');

      expect(state.mode, call.name).toBe('plan');
    }
  });

  /*
   * And it survives the three things every other bound in `AgentState` has to survive. The state is
   * persisted by `encryptJson(state, …)` and reloaded by claim.ts - "const savedState =
   * task.agentStateCiphertext ? decryptJson<AgentState>(task.agentStateCiphertext, key) : null" -
   * so what a park, a resume and a worker restart all do to the mode is precisely what JSON does to
   * it. That is what is driven here; it is not a test of the store.
   */
  it('survives the JSON round trip a park, a resume and a restart all put it through', async () => {
    const parked = (await planDispatch([toolCall('ask', { question: 'Which?' })], 'plan')).state;
    const reloaded = JSON.parse(JSON.stringify(parked)) as AgentState;

    expect(reloaded.mode).toBe('plan');
    const { order } = await planDispatch(
      [toolCall('file_write', { path: 'a', content: 'b' })],
      reloaded.mode,
      reloaded
    );
    expect(order).toEqual(['answered:file_write']);
  });

  /*
   * AND THE SENTENCE HAS TO BE TRUE OF THE SET IT DESCRIBES. This is the one sentence in the mode a
   * model reads on every refused call, and it must not end "nothing that reaches outside", which is
   * false of four names the set permits: `web_search` and `parallel_web_read` read the web,
   * `delegate` opens another window on it, and `notify` reaches the owner's phone.
   *
   * Worth a test rather than a careful comment because the cost is behavioural, not cosmetic:
   * `notify` and `ask` are the two channels this mode leaves the model, and a model told nothing
   * reaches outside will not reach for the one of them that is not a hard stop. The four names are
   * read off the permitted set in the same assertion, so the sentence cannot be left standing over
   * a set that has moved.
   */
  it('does not claim nothing reaches outside, because four permitted tools do', async () => {
    for (const name of ['web_search', 'parallel_web_read', 'delegate', 'notify'])
      expect(PLAN_MODE_PERMITTED.has(name), `${name} reaches outside and is permitted`).toBe(true);

    const { refusals } = await planDispatch(
      [toolCall('file_write', { path: 'a', content: 'b' })],
      'plan'
    );

    expect(refusals.file_write).toContain('reaches out of this computer');
    expect(refusals.file_write).toContain('messaging the user');
    // The claim that was withdrawn, named so that restoring it fails here.
    expect(refusals.file_write).not.toContain('nothing that reaches outside');
  });
});

/**
 * The permitted set as a derivation, which is the only thing standing between this mode and the
 * defect that took `file_patch` straight through the specialist's read-only fence.
 *
 * These do not drive the loop. They hold the set against the classifiers it is built from, so that
 * a tool added to the catalogue, or moved between those classifiers, cannot quietly widen what plan
 * mode allows.
 */
describe('what plan mode permits, derived rather than listed', () => {
  it('permits nothing the harness itself classifies as a change', () => {
    expect(PLAN_MODE_PERMITTED.size).toBeGreaterThan(0);
    for (const name of PLAN_MODE_PERMITTED)
      expect(isMutatingToolCall(name), `${name} is classified as a change`).toBe(false);
  });

  it('permits nothing the checkpoint rule says needs an undo point', () => {
    // The basis, stated as the containment it is: the two names added by hand are the whole of what
    // this set has that the checkpoint rule does not, so a reader checks the addition, not the set.
    for (const name of PLAN_MODE_PERMITTED)
      expect(
        CHECKPOINT_EXEMPT_TOOLS.has(name) || ['ask', 'delegate'].includes(name),
        `${name} is neither checkpoint-exempt nor one of the two added by name`
      ).toBe(true);
    /*
     * And the other direction, which is where the two derivations disagree and where the stricter
     * one has to win. `set_acceptance` is the entire difference: it needs no undo point of its own,
     * which is why it sits in that set, and declaring a record runs the red baseline - the owner's
     * build or test command, on the owner's computer - which is why `isMutatingToolCall` calls it a
     * change and why plan mode refuses it. Named, so that a future edit which makes the two sets
     * agree has to come past this assertion and say which way it made them agree.
     */
    const exemptButRefused = [...CHECKPOINT_EXEMPT_TOOLS].filter(
      (name) => !PLAN_MODE_PERMITTED.has(name)
    );
    expect(exemptButRefused).toEqual(['set_acceptance']);
    expect(isMutatingToolCall('set_acceptance')).toBe(true);
  });

  /*
   * `delegate`'s third proof. It is on neither basis set - a mission is not repeatable and there is
   * nothing on the computer for a checkpoint to hold - and it is permitted because every tool a
   * specialist can reach is itself inside the fence. That is derived in tool-catalogue.test.ts and
   * it is re-derived here against THIS set, because the two could drift: a name added to the
   * specialist's surface that plan mode does not permit would mean a delegated mission doing, in
   * another window, exactly what the lead was refused.
   */
  it('lets delegate in only while every tool a specialist can reach is permitted here too', () => {
    expect(PLAN_MODE_PERMITTED.has('delegate')).toBe(true);
    for (const name of specialistToolNames)
      expect(PLAN_MODE_PERMITTED.has(name), `a specialist can reach ${name}`).toBe(true);
  });

  /*
   * The redundancy the gate deliberately does not lean on. The gate sits in front of the parallel
   * run, so a mutating call cannot be smuggled into a run - but the run would also have refused it,
   * because `PARALLEL_SAFE_TOOLS` is a strict subset of this set. Asserted so that the redundancy
   * is a fact rather than a coincidence nobody is watching.
   */
  it('is a superset of everything a parallel run may contain', () => {
    expect(PARALLEL_SAFE_TOOLS.size).toBeGreaterThan(0);
    for (const name of PARALLEL_SAFE_TOOLS) expect(PLAN_MODE_PERMITTED.has(name)).toBe(true);
  });

  /*
   * And what it refuses, named, because these four are the ones a future edit reaches for. `shell`
   * is the whole reason this mode is enforcement and not advice: `isMutatingToolCall` treats an
   * unrecognised executable with no script as a check - right for the completion clock, where a
   * mislabelled write costs a second check, and wrong here, where it would let plan mode deploy.
   */
  it('refuses the shell, the browser, the writers and the publishers', () => {
    for (const name of [
      'shell',
      'browser_action',
      // Refused with `browser_action` and not with the reads, which surprises a reader: it only
      // reads the page. It is absent from `REPEATABLE_TOOLS`, so the checkpoint rule never made it
      // exempt, and the derivation is taken at its word rather than widened by hand. Pinned because
      // the comment on the set says so, and a comment nothing holds is how that sentence goes stale.
      'read_elements',
      'desktop_action',
      'file_write',
      'file_patch',
      'publish_preview',
      'publish_artifact',
      'connector_action',
      'coding_agent',
      'audio_read'
    ])
      expect(PLAN_MODE_PERMITTED.has(name), name).toBe(false);
    expect(isMutatingToolCall('shell', { executable: './deploy.sh' })).toBe(false);
  });
});
