import { runtimeValue } from '@garden/core';
import { workflowApproval } from './workflow-approval.js';
import { projectUpdateApproval } from './project-updates.js';
import { useTaskApproval } from './approval-grants.js';
import { debuggerApproval } from './debugger-approval.js';
import { codingMissionApproval } from './coding-mission-approval.js';
import { prepareNativeInputApproval } from './native-input.js';
/**
 * The approval floor: what a tool call has to be asked about before it runs, and the three lookups
 * a card needs before it can name what it is asking about.
 *
 * An evaluation is not cheap: it builds the destination context, which joins up to forty thousand
 * characters of the owner's own words and copies two origin arrays, and it can reach the store
 * three times besides. The first call of a candidate parallel run is asked about twice, so
 * `approvalForCallOnce` answers the second time from the first.
 */
import { createHmac } from 'node:crypto';
import { ZodError } from 'zod';
import { GardenError, unwrapDataKey } from '@garden/core';
import type { DataStore, TaskRecord } from '@garden/data';
import { isNativeOpenAIEndpoint, type ModelToolCall } from '@garden/model-gateway';
import type { AgentState, InferenceCredential } from './agent-state.js';
import type { AgentApprovalRequirement } from './approval-state.js';
import type { DestinationContext } from './egress.js';
import {
  resolvedMediaModel,
  resolvedTranscriptionRoute,
  type ResolvedMediaModel
} from './media.js';
import type { AgentRunnerClient } from './runner-client.js';
import { approvalRequirement, surfaceActionRequest, type ApprovalContext } from './tools.js';
import { textValue } from './values.js';
import { pinMediaGenerationApproval } from './media-approval.js';
import { computationApproval } from './computation-approval.js';
import { jobRecoveryApproval } from './job-recovery-approval.js';
import { processInputApproval } from './process-input-approval.js';
import { SECURITY_MODE_FLOOR, lentKeysCover } from './approval-common.js';
import {
  currentTranscriptionCredential,
  pinTranscriptionApproval
} from './transcription-approval.js';

/** What the floor needs from the worker that owns the turn. */
export interface ApprovalFloorDeps {
  readonly store: DataStore;
  readonly masterKey: Buffer;
  readonly runner: AgentRunnerClient;
  inferenceCredential(task: TaskRecord, resolveMedia?: boolean): Promise<InferenceCredential>;
  destinationContext(state?: AgentState): DestinationContext;
}

/**
 * One evaluation of the floor per call, per state of the world.
 *
 * The loop asks twice about the first call of every candidate parallel run: once while deciding
 * whether the run can go together, and again on the sequential path the run falls through to when
 * it collapses to a single call. Nothing executes between those two asks - every gate in between
 * either answers the call and `continue`s or registers an idempotency key, and the floor reads
 * neither - so the second ask could only ever return what the first did. It was not free: each
 * evaluation joins up to forty thousand characters of the owner's own words into a destination
 * context and can reach the store three times besides.
 *
 * `at` is what makes reuse safe rather than merely cheap. A verdict depends on the turn's taint,
 * its known origins and its novelty budget, and all three move when a tool runs; `toolsStarted` is
 * incremented immediately before every dispatch on both the sequential and the parallel path, so a
 * verdict taken at a different count is discarded rather than trusted. That is stricter than the
 * defect required, and it is the clause that keeps this a memo rather than a cache.
 */
export interface ApprovalFloorMemo {
  at: number;
  readonly verdicts: Map<string, AgentApprovalRequirement | null>;
}

export const createApprovalFloorMemo = (): ApprovalFloorMemo => ({ at: -1, verdicts: new Map() });

export const approvalForCallOnce = async (
  deps: ApprovalFloorDeps,
  memo: ApprovalFloorMemo,
  task: TaskRecord,
  call: ModelToolCall,
  state?: AgentState
): Promise<AgentApprovalRequirement | null> => {
  const at = state?.toolsStarted ?? 0;
  if (memo.at !== at) {
    memo.verdicts.clear();
    memo.at = at;
  }
  // `has` rather than truthiness: `null` is the answer for a call the floor does not ask about, and
  // reading it as "not yet evaluated" would reinstate the double evaluation on precisely the calls
  // a parallel run is made of.
  if (memo.verdicts.has(call.id)) return memo.verdicts.get(call.id) ?? null;
  const requirement = await approvalForCall(deps, task, call, state);
  memo.verdicts.set(call.id, requirement);
  return requirement;
};

/**
 * The saved skill an upsert would land on, keyed exactly as the upsert keys it. Absent when the
 * name is new, when the workspace key cannot be opened, or when the lookup fails - a card that
 * cannot prove a replacement says nothing rather than guessing, because the wrong half of that
 * guess reads as "this is new" on a call that destroys the owner's own text.
 */
export const existingSkillFor = async (
  deps: ApprovalFloorDeps,
  task: TaskRecord,
  name: string
): Promise<ApprovalContext['existingSkill']> => {
  if (!name) return undefined;
  try {
    const workspace = await deps.store.getWorkspaceById(task.workspaceId);
    if (!workspace?.wrappedKey) return undefined;
    const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
    const nameHash = runtimeValue(`skill.binding:${name}`, () =>
      createHmac('sha256', key).update(`garden-skill:${name}`).digest('hex')
    );
    const saved = (await deps.store.listWorkspaceSkills(task.userId, task.workspaceId)).find(
      (skill) => skill.nameHash === nameHash
    );
    return saved
      ? {
          version: saved.version,
          enabled: saved.enabled,
          useCount: saved.useCount,
          updatedAt: saved.updatedAt
        }
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What this turn's undo point holds, for the one rule that spends it.
 *
 * The destructive rule frees a delete strictly inside `CHECKPOINT_CONTENT` because a rewind puts it
 * back, and that is only true of a turn that HAS a rewind. `#ensureTurnUndoPoint` writes
 * `{ turn, id: null }` when the runner refuses the checkpoint - a workspace over
 * `CHECKPOINT_MAX_FILES`, or a full host disk - and lets the turn carry on, which is right for the
 * work and would otherwise free every delete inside `workspace/` on the one turn nothing can undo.
 *
 * The turn is compared rather than trusted. `state.checkpoint` survives a resume, an approval park
 * and a worker handover, so a fact left by turn 4 is still sitting there in turn 5 before that
 * turn's undo point is taken, and reading it would answer this turn's question with last turn's
 * measurement. A workspace crosses the file ceiling by having a dependency tree unpacked into it,
 * which is something a turn does to itself, so the turn where the stale fact goes wrong is exactly
 * the turn that would be leaning on it.
 *
 * No state, or no checkpoint yet for this turn, means the field is absent and every delete keeps
 * its card. @see `ApprovalContext.undoPoint` for why absent is a real answer here and not a gap.
 *
 * `uncovered` is the second ceiling and it is spread rather than defaulted. It carries the paths the
 * checkpoint's own walk skipped for being over `CHECKPOINT_MAX_FILE_BYTES`, and a delete naming one
 * of them keeps its card while the rest of the turn's deletes stay free. Spread, because absent and
 * empty are different answers: empty says the walk held everything, absent says nobody knows - which
 * is what a runner one release behind, a list the runner had to cut off, and a state row written
 * before the field existed all produce - and absent keeps the card on every delete. Writing
 * `uncovered: state.checkpoint.uncovered ?? []` here would turn all three of those into "there is
 * nothing over the ceiling", which is the one reading none of them supports.
 */
const undoPointFor = (state?: AgentState): Pick<ApprovalContext, 'undoPoint'> =>
  state?.checkpoint && state.checkpoint.turn === (state.turn ?? 0)
    ? {
        undoPoint: {
          id: state.checkpoint.id,
          ...(state.checkpoint.uncovered ? { uncovered: state.checkpoint.uncovered } : {})
        }
      }
    : {};

export const approvalForCall = async (
  deps: ApprovalFloorDeps,
  task: TaskRecord,
  call: ModelToolCall,
  state?: AgentState
): Promise<AgentApprovalRequirement | null> => {
  if (task.parentMissionId && task.parentTaskId) {
    const parent = await deps.store.getTask(task.userId, task.parentTaskId);
    if (parent && task.privacyRoute !== parent.privacyRoute)
      throw new Error(
        'The parent privacy route changed; stop this coding mission before sending or executing more work'
      );
    if (!parent || ['failed', 'cancelled'].includes(parent.status))
      throw new Error('The parent coding task no longer grants execution authority');
    const strength = { review: 0, balanced: 1, autonomous: 2 };
    if (strength[parent.securityMode] < strength[task.securityMode])
      task.securityMode = parent.securityMode;
  }
  if (call.name === 'decide')
    // An unavailable tool is invalid model input: the loop records it and continues the turn.
    throw new ZodError([
      {
        code: 'custom',
        path: ['name'],
        message: 'Decision workflows are inactive. Complete this work with the main model.'
      }
    ]);
  if (call.name === 'project_update')
    return projectUpdateApproval(deps.runner, task, call, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  if (
    call.name === 'coding_agent' &&
    call.arguments.agent === 'garden' &&
    call.arguments.action === 'integrate'
  )
    return codingMissionApproval(deps, task, call, state, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  if (call.name === 'process' && call.arguments.action === 'workflow')
    return workflowApproval(deps.runner, task, call, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  if (call.name === 'process' && call.arguments.action === 'debug')
    return debuggerApproval(deps.runner, task, call, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  if (call.name === 'process' && call.arguments.action === 'compute')
    return computationApproval(deps.runner, task, call, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  if (call.name === 'process' && call.arguments.action === 'resume')
    return jobRecoveryApproval(deps.runner, task, call, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  if (call.name === 'process' && call.arguments.action === 'write')
    return processInputApproval(deps.runner, task, call, {
      ...(state?.taint ? { taintSources: state.taint.sources } : {}),
      ...undoPointFor(state),
      ...deps.destinationContext(state)
    });
  // What this task has already put on the provider bill for media. One generation is a cent or
  // two at the reviewed prices, so a per-call ceiling could never fire and the card would have
  // been a branch that never runs; a run that keeps re-rolling is the thing worth stopping, and
  // it is only visible in the total.
  // Whether this name already belongs to something. An upsert replaces the saved body outright,
  // so the difference between "save this procedure" and "throw away the one you wrote" is the
  // whole of what the reviewer needs, and the arguments cannot carry it.
  const existingSkill =
    call.name === 'skill' && textValue(call.arguments.action) === 'upsert'
      ? await existingSkillFor(deps, task, textValue(call.arguments.name))
      : undefined;
  /*
   * `code_diagnostics` had a lookup of its own here, and it went with the card it fed.
   *
   * It took a directory listing from the runner before every diagnostic, so the floor could tell
   * `tsc --noEmit` from `make -s` on arguments that say only `language: 'auto'`. That round trip
   * bought one thing and one thing only: the wording of a card that no longer exists. The dispatch
   * arm takes the same listing a moment later and acts on it, which is where the answer was always
   * needed; asking for it twice to decide a question nobody asks any more is a runner call per
   * diagnostic for nothing. The bound that replaced the card is in `turn-bounds.ts` and needs no
   * lookup at all: every `code_diagnostics` call takes the turn's undo point, whatever it resolves
   * to.
   */
  const transcription =
    call.name === 'audio_read' &&
    !(
      call.arguments.options &&
      typeof call.arguments.options === 'object' &&
      'action' in call.arguments.options
    )
      ? await transcriptionModelForCall(deps, task)
      : undefined;
  const generation =
    call.name === 'generate_media' &&
    !['describe', 'status', 'library', 'batch'].includes(textValue(call.arguments.action))
      ? await mediaModelForCall(deps, task, textValue(call.arguments.kind))
      : undefined;
  if (generation?.credential && state) {
    const workspace = await deps.store.getWorkspaceById(task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError('media_route_unavailable', 'Media workspace is unavailable', 409);
    pinMediaGenerationApproval(
      unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id),
      task,
      state,
      call,
      generation.credential
    );
  }
  const declared = approvalRequirement(call.name, call.arguments, task.securityMode, {
    ...(call.name === 'generate_media'
      ? {
          mediaCommittedUsd: await mediaCommittedUsd(deps, task),
          // The card has to name and price the route the call will really take. Without this it
          // quoted the reviewed default's figure at an owner who had chosen something ten times
          // the price, and it applied a cumulative threshold to a route whose price nobody
          // published - which is the one case that has to ask every time instead.
          ...(generation?.mediaModel ? { mediaModel: generation.mediaModel } : {})
        }
      : {}),
    // Reading a recording lands on the same bill as making one, so it meets the same cumulative
    // card. The duration is what it is priced on, and the only honest number available before the
    // encode is what the model asked for - which is why the card says "up to" and the ledger is
    // settled afterwards from what the provider actually billed.
    ...(transcription
      ? {
          mediaCommittedUsd: await mediaCommittedUsd(deps, task),
          ...(transcription.mediaModel ? { mediaModel: transcription.mediaModel } : {})
        }
      : {}),
    ...(call.name === 'audio_read' &&
    call.arguments.options &&
    typeof call.arguments.options === 'object' &&
    'action' in call.arguments.options &&
    call.arguments.options.action === 'native'
      ? await prepareNativeInputApproval(deps, task, state, call)
      : {}),
    ...(existingSkill ? { existingSkill } : {}),
    ...(state?.taint ? { taintSources: state.taint.sources } : {}),
    ...undoPointFor(state),
    ...deps.destinationContext(state)
  });
  // A card every key of which the owner has lent this goal is answered already. Its receipt is
  // written by the dispatch, beside the cards the owner answered by hand.
  if (declared && lentKeysCover(declared, task)) return null;
  if (declared && transcription?.credential) {
    if (!state)
      throw new GardenError(
        'transcription_approval_required',
        'Recording approval needs durable task state',
        409
      );
    const workspace = await deps.store.getWorkspaceById(task.workspaceId);
    if (!workspace?.wrappedKey)
      throw new GardenError(
        'transcription_approval_required',
        'Recording workspace is unavailable',
        409
      );
    const key = unwrapDataKey(workspace.wrappedKey, deps.masterKey, workspace.id);
    const proof = await pinTranscriptionApproval(
      { runner: deps.runner, key, task, state },
      call,
      transcription.credential
    );
    return {
      ...declared,
      preview: `${declared.preview}\n\nDestination: ${new URL(transcription.credential.baseUrl).origin}. Source SHA-256: ${proof.sourceSha256} (${proof.sourceBytes} bytes). The source, credential, route and price must still match when this approval runs.`
    };
  }
  if (!['browser_action', 'desktop_action'].includes(call.name)) {
    if (declared && (await useTaskApproval(deps, task, state, declared))) return null;
    return declared;
  }
  const surface = call.name === 'browser_action' ? 'browser' : 'desktop';
  try {
    const policy = await deps.runner.call<{
      consequential: boolean;
      sensitiveInput: boolean;
      handoffKind?: 'signature';
      tabId?: string;
      preview: string;
      destinations?: string[];
    }>(
      task.workspaceId,
      task.id,
      `${surface}.read`,
      `/v1/workspaces/${task.workspaceId}/${surface}/preflight`,
      surfaceActionRequest(call.arguments)
    );
    if (policy.sensitiveInput || policy.handoffKind) {
      return {
        ...(policy.destinations ? { destinations: policy.destinations } : {}),
        sideEffect: 'external_consequential',
        action:
          policy.handoffKind === 'signature'
            ? 'Your signature is needed'
            : `Private ${surface} input needed`,
        preview: policy.preview,
        handoff: {
          kind: policy.handoffKind ?? 'private_input',
          ...(policy.tabId ? { tabId: policy.tabId } : {})
        },
        handoffOnly: true
      };
    }
    // The saved owner mode authorizes screen actions; private input and provenance remain gates.
    if (SECURITY_MODE_FLOOR[task.securityMode].authorizesSurfaceActions) return declared;
    if (policy.consequential) {
      return {
        ...(policy.destinations ? { destinations: policy.destinations } : {}),
        sideEffect: 'external_consequential',
        action: declared?.action ?? `Confirm ${surface} action`,
        preview: `${policy.preview}\nThe ${surface} broker identified the actual control as consequential.`
      };
    }
    /*
     * The broker looked and said it is harmless, so that is the answer - and for a call the floor
     * was not going to ask about anyway, the answer is nothing at all.
     *
     * `desktop_action` declares every `click_at` and `drag` as consequential because a bare
     * coordinate is ambiguous - which is right when nothing can resolve it. Here something did:
     * the preflight identified the actual control under that coordinate and found it benign, so
     * the requirement is softened rather than dropped. That softening was written as an
     * unconditional `return`, which every caller reads as "park the turn and raise a card": a
     * plain `navigate`, whose `declared` is null in every mode and which `ordinaryRequirement`
     * carries on a hand-written list of verbs that must never card even in Review, came back as a
     * card reading "Use the browser". Every browser and desktop action parked the turn, cleared
     * the lease and deferred the rest of the batch. Null in, null out: the broker may lighten a
     * requirement and may not invent one.
     */
    if (!declared) return null;
    return { ...declared, sideEffect: 'external_reversible' };
  } catch {
    // The execution call will return the browser's authoritative error if preflight is unavailable.
  }
  return declared;
};

/**
 * What this task has already spent generating media, which is what the cumulative approval
 * threshold is measured against. Unavailable is priced as zero rather than as a failure -
 * refusing to generate because the ledger could not be read is a worse answer than generating
 * one more image.
 */
export const mediaCommittedUsd = async (
  deps: ApprovalFloorDeps,
  task: TaskRecord
): Promise<number> => {
  return deps.store.mediaSpendForTask(task.id).catch(() => 0);
};

/**
 * The route this generation will take, for the card that asks about it.
 *
 * Absent for a `kind` that is not a modality, and absent when the credential cannot be read at
 * all: an unconfigured provider is a thing the dispatch below reports properly a moment later,
 * with its own 503 and its own wording, and turning that into a throw from inside the approval
 * check would replace a clear "add a provider in Settings" with a failed turn. Falling back
 * prices exactly as this card always did, against the reviewed default.
 */
export const mediaModelForCall = async (
  deps: ApprovalFloorDeps,
  task: TaskRecord,
  kind: string
): Promise<{ mediaModel?: ResolvedMediaModel; credential?: InferenceCredential }> => {
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return {};
  const secret = await deps.inferenceCredential(task, true).catch(() => undefined);
  return {
    mediaModel: resolvedMediaModel(kind, secret?.mediaRoutes),
    ...(secret ? { credential: secret } : {})
  };
};

/** Price evidence is resolved from the selected credential, never from a previous invoice. */
export const transcriptionModelForCall = async (
  deps: ApprovalFloorDeps,
  task: TaskRecord
): Promise<{ mediaModel?: ResolvedMediaModel; credential?: InferenceCredential }> => {
  const stored = await deps.inferenceCredential(task, true).catch(() => undefined);
  const secret = stored ? await currentTranscriptionCredential(stored) : undefined;
  const route = resolvedTranscriptionRoute(
    secret?.mediaRoutes,
    Boolean(secret && secret.provider !== 'openrouter' && isNativeOpenAIEndpoint(secret.baseUrl))
  );
  return route && secret ? { mediaModel: route, credential: secret } : {};
};
