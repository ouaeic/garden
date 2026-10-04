/** Retry forks share valid context and encryption-safe cached packs without borrowing authority. */
import { encryptBytes, encryptJson, ownerBlockAad, userMemoryKey } from '@garden/core';
import type {
  DataStore,
  MemoryCandidateRecord,
  MemoryPackRecord,
  OwnerBlockRecord,
  TaskPlanRecord,
  TaskRecord,
  WorkspaceMemoryRecord
} from '@garden/data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import { BASE_PROMPT_MARKER, OWNER_BLOCK_MARKER } from './context.js';
import { memoryItemAad, memoryPackAad } from './memory-runtime.js';
import type { AgentRunnerClient } from './runner-client.js';
import { assemblePreamble, type WindowDeps } from './window.js';

const key = new Uint8Array(32).fill(9);
const boxMasterKey = Buffer.alloc(32, 7);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';
const rootId = '44444444-4444-4444-8444-444444444444';
const forkId = '55555555-5555-4555-8555-555555555555';
const strangerId = '66666666-6666-4666-8666-666666666666';
const staleRootId = '77777777-7777-4777-8777-777777777777';
const foreignRootId = '88888888-8888-4888-8888-888888888888';
const otherWorkspaceId = '99999999-9999-4999-8999-999999999999';
/** The middle and the end of a two-deep retry chain, for the one case depth 1 cannot express. */
const retryOnceId = 'aaaaaaaa-1111-4111-8111-111111111111';
const retryTwiceId = 'aaaaaaaa-2222-4222-8222-222222222222';

const BASE_PROMPT = `${BASE_PROMPT_MARKER}\nBASE SYSTEM PROMPT`;
const ROOT_GOAL = 'fix the importer that drops rows on a large CSV';
/** What the API writes as a retry's prompt: the last user message before the point rewound to. */
const RETRY_GOAL = 'the nightly schedule still reports success after it fails';
/** What the API writes as a branch's prompt, verbatim. It is a query about nothing, and that is why
 * a branch must not be made to look like its parent - the fix for that sentence is not this one. */
const BRANCH_GOAL = 'Continue from this conversation branch.';
/**
 * What an owner writes when they edit the FIRST message: a different subject, on purpose. This is
 * the text the whole `edit` arm turns on - they rewrote the question because they wanted a different
 * answer, and retrieval must answer the new one.
 */
const EDIT_GOAL = 'set up the staging deploy from the release branch instead';

/**
 * The instant this file is run at, and every fixture timestamp is placed against it.
 *
 * `forkCacheAnchor` now refuses a family root older than an hour, because past a provider's prefix
 * cache TTL the inheritance buys a cache entry that has already gone while still costing freshness.
 * That makes wall-clock distance from NOW a fact these cases are about, so the clock is pinned.
 */
const NOW = '2026-08-02T09:00:00.000Z';

const taskRow = (input: {
  id: string;
  createdAt: string;
  prompt: string;
  parentTaskId?: string;
  forkKind?: TaskRecord['forkKind'];
  /**
   * The workspace this row BELONGS to and the one its prompt is SEALED for, where they are not this
   * one. Separate knobs on purpose: the guard under test compares a sealed-for label against a
   * workspace id, and a fixture that moved both together could not tell the two spellings apart.
   */
  workspaceId?: string;
  promptWorkspaceId?: string;
}): TaskRecord =>
  ({
    id: input.id,
    userId,
    workspaceId: input.workspaceId ?? workspaceId,
    parentTaskId: input.parentTaskId ?? null,
    forkKind: input.forkKind ?? null,
    securityMode: 'standard',
    createdAt: input.createdAt,
    promptCiphertext: encryptJson(
      { prompt: input.prompt },
      key,
      `task-prompt:${input.promptWorkspaceId ?? workspaceId}`
    )
  }) as unknown as TaskRecord;

/**
 * The root and its retry, twenty-five minutes apart and both inside the anchor's hour.
 *
 * The gap is load-bearing: one memory row expires inside it (`m-window` below), so a fork that
 * clocked itself rather than its parent DROPS a row the parent carried and the byte equality goes
 * red. A fixture whose two tasks shared a creation instant would let a fork that ignored the
 * anchoring pass. A day's gap is past the age ceiling, so the day is `staleRoot` below, the case
 * that must NOT inherit.
 */
const root = taskRow({ id: rootId, createdAt: '2026-08-02T08:30:00.000Z', prompt: ROOT_GOAL });
const retry = taskRow({
  id: forkId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: RETRY_GOAL,
  parentTaskId: rootId,
  forkKind: 'retry'
});
const branch = taskRow({
  id: forkId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: BRANCH_GOAL,
  parentTaskId: rootId,
  forkKind: 'branch'
});
/** An edit of the first message: no inherited trajectory, and a request about something else. */
const edited = taskRow({
  id: forkId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: EDIT_GOAL,
  parentTaskId: rootId,
  forkKind: 'edit'
});
/** Thirty-three hours old at NOW, which is past the anchor ceiling by a wide margin. */
const staleRoot = taskRow({
  id: staleRootId,
  createdAt: '2026-08-01T00:00:00.000Z',
  prompt: ROOT_GOAL
});
const retryOfStale = taskRow({
  id: forkId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: RETRY_GOAL,
  parentTaskId: staleRootId,
  forkKind: 'retry'
});
/**
 * Recent enough to inherit, and it belongs to a DIFFERENT workspace of the same owner.
 *
 * Reachable at all because the walk looks a parent up by user id (`getTask(task.userId, next)`) and
 * not by workspace. Its prompt is sealed for its own workspace, which is consistent - the row is
 * not corrupt, it is simply not this fork's to open.
 */
const foreignRoot = taskRow({
  id: foreignRootId,
  createdAt: '2026-08-02T08:30:00.000Z',
  prompt: ROOT_GOAL,
  workspaceId: otherWorkspaceId,
  promptWorkspaceId: otherWorkspaceId
});
const retryOfForeign = taskRow({
  id: forkId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: RETRY_GOAL,
  parentTaskId: foreignRootId,
  forkKind: 'retry'
});
/**
 * A retry of a retry, both inside the ceiling. The family the whole rule is transitive for.
 *
 * The instants matter twice over: `retryTwice` is 25 minutes from the ROOT, so the ceiling admits
 * it, and 15 from its immediate parent - a chain that measured the gap to the parent rather than to
 * the root would admit a family that had drifted arbitrarily far from the bytes it claims to match.
 */
const retryOnce = taskRow({
  id: retryOnceId,
  createdAt: '2026-08-02T08:40:00.000Z',
  prompt: RETRY_GOAL,
  parentTaskId: rootId,
  forkKind: 'retry'
});
const retryTwice = taskRow({
  id: retryTwiceId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: RETRY_GOAL,
  parentTaskId: retryOnceId,
  forkKind: 'retry'
});
/** A second task of the owner's own, forked from nothing. */
const stranger = taskRow({
  id: strangerId,
  createdAt: '2026-08-02T08:55:00.000Z',
  prompt: RETRY_GOAL
});

const memory = (id: string, content: string, validUntil: string | null): WorkspaceMemoryRecord =>
  ({
    id,
    userId,
    workspaceId,
    target: 'workspace',
    contentCiphertext: encryptJson(
      { content, ...(validUntil ? { validUntil } : {}) },
      key,
      `workspace-memory:${workspaceId}`
    ),
    validUntil,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }) as WorkspaceMemoryRecord;

const ownerBlockRow = (text: string): OwnerBlockRecord => ({
  userId,
  ciphertext: encryptBytes(
    Buffer.from(text, 'utf8'),
    userMemoryKey(boxMasterKey, userId),
    ownerBlockAad(userId)
  ),
  contentBytes: Buffer.byteLength(text, 'utf8'),
  version: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z'
});

const candidate = (id: string, body: string): MemoryCandidateRecord => ({
  id,
  layer: 'item',
  kind: 'fact',
  trust: 'stated',
  status: 'active',
  observedAt: '2026-07-01T00:00:00.000Z',
  validFrom: '2026-07-01T00:00:00.000Z',
  validTo: null,
  subjectKey: null,
  predicate: null,
  tokensEst: 20,
  score: 1,
  documentCiphertext: encryptJson({ body }, key, memoryItemAad(workspaceId))
});

const importerFact = candidate(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'the importer batches at 500 rows'
);
const scheduleFact = candidate(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'the nightly schedule runs at 03:15'
);
/** Written by the parent's own later turns, which is why asking the store twice is not free. */
const laterFact = candidate(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  'the importer was moved behind a feature flag on 2 August'
);

interface Probe {
  deps: WindowDeps;
  block: OwnerBlockRecord | null;
  readonly packs: Map<string, MemoryPackRecord>;
  readonly recallQueries: unknown[];
  readonly taskReads: string[];
  /**
   * Which task's pack row was asked for, in order. It is the only thing that can tell the ROOT's
   * bytes from the IMMEDIATE PARENT's: a copy carries `sha256` across unchanged, so at depth 2 the
   * two answers are byte-identical and only the read says which row they came from.
   */
  readonly packReads: string[];
}

/**
 * The store this preamble is built over.
 *
 * `recallMemoryCandidates` deliberately answers the SECOND call with a row the first call did not
 * carry. A real store moves under a task - the parent's own turns write to it, and `renderMemoryPack`
 * orders what it is given, so a reordered answer alone would render the same bytes. A bytes-only
 * assertion over a store that answers identically forever is a proof that re-ranking a fork is
 * harmless, which is the opposite of what is being claimed.
 */
const probe = (): Probe => {
  const packs = new Map<string, MemoryPackRecord>();
  const recallQueries: unknown[] = [];
  const taskReads: string[] = [];
  const packReads: string[] = [];
  const tasks = new Map<string, TaskRecord>([
    [rootId, root],
    [staleRootId, staleRoot],
    [foreignRootId, foreignRoot],
    [retryOnceId, retryOnce]
  ]);
  const state: Probe = {
    block: null,
    packs,
    recallQueries,
    taskReads,
    packReads,
    deps: undefined as unknown as WindowDeps
  };
  state.deps = {
    config: { PREVIEW_BASE_URL: 'https://preview.invalid' } as unknown as AgentWorkerConfig,
    masterKey: boxMasterKey,
    runner: {
      readFile: async () => {
        throw new Error('no workspace brief');
      }
    } as unknown as AgentRunnerClient,
    store: {
      getTask: async (_userId: string, id: string) => {
        taskReads.push(id);
        return tasks.get(id) ?? null;
      },
      listWorkspaceMemories: async () => [
        memory('m-importer', 'the importer times out on files above 200 MB', null),
        memory('m-schedule', 'the nightly schedule reports success on a failed run', null),
        // Active at the root's instant (08:30) and at the stale root's, expired at every fork's
        // (08:55). This is the lever that makes the byte equality below mean the anchoring and not
        // luck, and it is the same lever the age-ceiling arm reads in the other direction.
        memory('m-window', 'the maintenance window closes at 08:45', '2026-08-02T08:45:00.000Z')
      ],
      readOwnerBlock: async () => state.block,
      curateWorkspaceSkills: async () => undefined,
      listWorkspaceSkills: async () => [],
      getMemoryPack: async (id: string) => {
        packReads.push(id);
        return packs.get(id) ?? null;
      },
      saveMemoryPack: async (input: {
        taskId: string;
        workspaceId: string;
        bodyCiphertext: unknown;
        sha256: string;
        itemIds: string[];
        tokensEst: number;
        briefVersion?: string | null;
      }) => {
        const existing = packs.get(input.taskId);
        if (existing) return existing;
        const record = {
          ...input,
          briefVersion: input.briefVersion ?? null,
          itemIds: [...input.itemIds],
          createdAt: '2026-08-01T00:00:00.000Z'
        } as unknown as MemoryPackRecord;
        packs.set(input.taskId, record);
        return record;
      },
      recallMemoryCandidates: async (input: unknown) => {
        recallQueries.push(input);
        return recallQueries.length === 1
          ? [importerFact, scheduleFact]
          : [importerFact, scheduleFact, laterFact];
      },
      appendTaskEvent: async () => ({ id: 'event' }),
      getLatestTaskPlan: async () => null,
      createTaskPlan: async (input: { taskId: string }) =>
        ({ id: 'plan-1', taskId: input.taskId }) as unknown as TaskPlanRecord
    } as unknown as DataStore
  };
  return state;
};

const openingState = (goal: string): AgentState =>
  ({
    messages: [
      { role: 'system', content: BASE_PROMPT },
      { role: 'user', content: goal }
    ],
    step: 0,
    credits: 0
  }) as unknown as AgentState;

/**
 * The window a fork opens with, built the way `routes/trajectory.ts` builds it: the parent's system
 * messages first, then the messages that were inherited, then the trajectory instruction at the
 * end. Anything less than this measures a preamble no fork ever has.
 */
const forkedState = (parent: AgentState, goal: string): AgentState =>
  ({
    messages: [
      ...parent.messages.filter((message) => message.role === 'system'),
      { role: 'user', content: goal },
      {
        role: 'system',
        content:
          'CONVERSATION TRAJECTORY: This is a new, independent path through the conversation.'
      }
    ],
    step: 0,
    credits: 0
  }) as unknown as AgentState;

/** The bytes ahead of everything: the leading run of system messages, and nothing after it. */
const leadingSystemRun = (state: AgentState): string => {
  const run: string[] = [];
  for (const message of state.messages) {
    if (message.role !== 'system') break;
    run.push(message.content);
  }
  return run.join('\u0000');
};

/**
 * Builds a family root's window, which is the prefix every case below is measured against.
 *
 * Parameterised because two of the cases need a root at a different instant: the age ceiling is a
 * statement about how far the root is from NOW, so a helper that could only build one root could
 * not express the case the ceiling exists for.
 */
const buildRoot = async (probed: Probe, task: TaskRecord = root): Promise<AgentState> => {
  const state = openingState(ROOT_GOAL);
  await assemblePreamble(probed.deps, {
    task,
    key,
    state,
    goal: ROOT_GOAL,
    contextTokens: 200_000
  });
  return state;
};

/** The row that is active at a root's instant and expired at every fork's. */
const EXPIRING_ROW = 'the maintenance window closes at 08:45';

describe('a fork and the prefix it was forked out of', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * THE ARM THAT MATTERS MOST, and it is written first for that reason.
   *
   * The owner's block is installed by POSITION from live storage rather than by score, precisely
   * because no request names who the owner is. It must therefore keep changing the prefix when the
   * owner changes it - a preamble frozen to whatever the parent sent would satisfy every other case
   * in this file while silently telling the model an out-of-date fact about the person using it.
   */
  it('does not carry an owner block the owner has edited since the parent ran', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays, reviews on Mondays.');
    const parent = await buildRoot(probed);

    probed.block = ownerBlockRow('Dan. Ships on Tuesdays now, and reviews the same day.');
    const fork = forkedState(parent, RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retry,
      key,
      state: fork,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    expect(leadingSystemRun(fork)).not.toBe(leadingSystemRun(parent));
    const forkBlock = fork.messages.find((message) =>
      message.content.startsWith(OWNER_BLOCK_MARKER)
    );
    expect(forkBlock?.content).toContain('Ships on Tuesdays now');
  });

  /**
   * The equality, and the two assertions that stop it saturating.
   *
   * Bytes alone would pass on a store that answers the fusion query identically twice; this fixture
   * answers it differently, and asserts the query was asked once in total. The stored row is then
   * checked for the FORK's own encryption context, which is the failure a copy hides behind: an
   * aliased row is refused by `openStoredPack`, returns null, and re-ranks looking fixed.
   */
  it('emits the parent leading system run byte for byte on a retry, without re-ranking', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed);

    const fork = forkedState(parent, RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retry,
      key,
      state: fork,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    expect(leadingSystemRun(fork)).toBe(leadingSystemRun(parent));
    // One fusion query across both windows: the fork took the parent's rendered bytes rather than
    // asking again. This is `reused === true` observed at the production call site, where the
    // returned pack is not in the caller's hands.
    expect(probed.recallQueries).toHaveLength(1);
    const copied = probed.packs.get(forkId);
    expect(copied?.sha256).toBe(probed.packs.get(rootId)?.sha256);
    // The row is the fork's own, not the parent's under a second name.
    expect(copied?.bodyCiphertext.aad).toBe(memoryPackAad(forkId));
    expect(copied?.bodyCiphertext.aad).not.toBe(memoryPackAad(rootId));
  });

  /**
   * A branch is a road somewhere else and keeps its own ranking, which is what makes the equality
   * above a property of retries rather than of forks. Widen the rule to `branch` and this goes red.
   */
  it('lets a branch rank against its own text', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed);

    const fork = forkedState(parent, BRANCH_GOAL);
    await assemblePreamble(probed.deps, {
      task: branch,
      key,
      state: fork,
      goal: BRANCH_GOAL,
      contextTokens: 200_000
    });

    expect(leadingSystemRun(fork)).not.toBe(leadingSystemRun(parent));
    // It asked the store for itself, which is the whole of what "its own text" means here.
    expect(probed.recallQueries).toHaveLength(2);
    expect(probed.packs.get(forkId)?.sha256).not.toBe(probed.packs.get(rootId)?.sha256);
  });

  /**
   * A task nobody forked ranks against its own request and its own clock, and takes no read to
   * find that out. The second half is the cheap half of the bound: the walk costs one primary-key
   * read per link, and an ordinary task must not pay for a rule it is not subject to.
   */
  it('leaves a task with no parent ranking against its own request, and reads no other task', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed);

    const own = openingState(RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: stranger,
      key,
      state: own,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    expect(leadingSystemRun(own)).not.toBe(leadingSystemRun(parent));
    expect(probed.taskReads).toEqual([]);
  });

  /**
   * THE AGE CEILING, read through the harm it exists to stop rather than through the number.
   *
   * The clock the fork inherits is what decides temporal admissibility, so inheriting one from last
   * year tells the model facts the owner's own `validUntil` retired months ago. The ceiling is the
   * provider's prefix cache TTL: past about an hour there is no cached prefix left to hit, so the
   * inheritance buys nothing and is paid for entirely in staleness. This root is thirty-three hours
   * old, and the assertion is not only "different bytes" but the specific expired row being gone -
   * different bytes alone would pass on any change that moved a single character.
   */
  it('refuses a family root older than the anchor ceiling, and drops the row it had let expire', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed, staleRoot);

    const fork = forkedState(parent, RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retryOfStale,
      key,
      state: fork,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    // Neither a parent nor its retry may revive an expired owner fact.
    expect(leadingSystemRun(parent)).not.toContain(EXPIRING_ROW);
    expect(leadingSystemRun(fork)).not.not.toContain(EXPIRING_ROW);
    expect(leadingSystemRun(fork)).not.toBe(leadingSystemRun(parent));
    // It walked to the ancestor and then refused it, rather than never looking.
    expect(probed.taskReads).toEqual([staleRootId]);
    // And the pack is refused with the clock, so the fork does not rank against one question while
    // carrying bytes packed for another.
    expect(probed.recallQueries).toHaveLength(2);
    expect(probed.packs.get(forkId)?.sha256).not.toBe(probed.packs.get(staleRootId)?.sha256);
  });

  /**
   * An edit ranks against the request the owner has just written, not the one they threw away.
   *
   * `edit` inherited for one release and was taken back out. An edit of the FIRST message writes
   * `agentStateCiphertext: null` in `routes/trajectory.ts`, so the fork carries no inherited
   * trajectory at all: its whole window is the NEW request, and inheriting would have ranked the
   * knowledge block and packed the memory pack against the question the owner deliberately
   * replaced. This is the behaviour the build lane itself flagged as uncertain, so it is written
   * down here as a decision rather than left as the one thing nothing tests. Widen
   * `cachePrefixTaskId` back to `edit` and this goes red.
   */
  it('lets an edit rank against the text the owner replaced the request with', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed);

    const fork = forkedState(parent, EDIT_GOAL);
    await assemblePreamble(probed.deps, {
      task: edited,
      key,
      state: fork,
      goal: EDIT_GOAL,
      contextTokens: 200_000
    });

    expect(leadingSystemRun(fork)).not.toBe(leadingSystemRun(parent));
    // Its own fusion query, against its own text, and its own pack row.
    expect(probed.recallQueries).toHaveLength(2);
    expect(probed.packs.get(forkId)?.sha256).not.toBe(probed.packs.get(rootId)?.sha256);
    // No ancestor read at all: an edit is not subject to the rule, so it must not pay for it.
    expect(probed.taskReads).toEqual([]);
  });

  /**
   * The guard on the ancestor's encryption context, checked against the workspace whose key is in
   * hand rather than against the label the ancestor's own row carries.
   *
   * `key` is this fork's workspace data key, so that workspace is the only one whose rows this code
   * is entitled to open. Comparing a row's AAD to a workspace id read off that SAME row is close to
   * a tautology; comparing it to `task.workspaceId` is the check the house makes everywhere else
   * (`tools/scheduling.ts:30`, `api/src/task-titles.ts:187`).
   *
   * WHAT THIS FIXTURE MANUFACTURES, said plainly: the foreign ancestor's prompt is sealed under the
   * SAME data key as the fork's. In production it would be sealed under its own workspace's key, so
   * a mis-aimed guard is caught a line later when `decryptJson` throws and the fallback runs - which
   * is why the divergence was never exploitable. Holding the key constant is the only fixture under
   * which the two spellings of the check disagree, so it is what makes the line a bound that can be
   * observed rather than one that merely reads like one. Point the comparison back at
   * `anchor.workspaceId` and this goes red.
   *
   * Measured against a task with NO parent rather than against the ancestor's own window: the
   * ancestor is in another workspace, so building its preamble would drop every workspace-sealed row
   * for a reason that has nothing to do with this guard. `stranger` shares the fork's instant and the
   * fork's request, so a fork that fell back correctly emits exactly its bytes. Two probes because
   * the fixture's fusion query deliberately answers differently on its second call.
   *
   * AND THE PACK COPY, which this arm did not reach and could not have: the fixture never built the
   * foreign ancestor's own window, so no pack row existed at `foreignRootId`, the ungated copy
   * returned null for want of a row, and the fork re-ranked for a reason that had nothing to do with
   * the guard. Ungating the copy left this arm green. The ancestor's window is therefore built FIRST
   * in both probes - in the baseline too, so the two still take the fusion query the same number of
   * times and the byte equality above still means what it says - and the pack sha is asserted
   * against it. `copyMemoryPack` carries `sha256` across unchanged, so a copy that happened is a sha
   * that matches, and that is the assertion.
   */
  it('refuses an ancestor prompt sealed for another workspace, and the pack copy with it', async () => {
    const unforked = probe();
    unforked.block = ownerBlockRow('Dan. Ships on Fridays.');
    await buildRoot(unforked, foreignRoot);
    const own = openingState(RETRY_GOAL);
    await assemblePreamble(unforked.deps, {
      task: stranger,
      key,
      state: own,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    await buildRoot(probed, foreignRoot);
    const fork = openingState(RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retryOfForeign,
      key,
      state: fork,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    // It walked to the ancestor and then refused it, rather than never looking.
    expect(probed.taskReads).toEqual([foreignRootId]);
    // And having refused it, it is indistinguishable from a task that was never forked at all.
    expect(leadingSystemRun(fork)).toBe(leadingSystemRun(own));
    expect(leadingSystemRun(fork)).not.not.toContain(EXPIRING_ROW);
    // The refusal reaches the pack. There IS a row to copy here, so this is a refusal and not an
    // absence: the fork's bytes are its own and the copy never happened.
    expect(probed.packs.get(foreignRootId)).toBeDefined();
    expect(probed.packs.get(forkId)?.sha256).not.toBe(probed.packs.get(foreignRootId)?.sha256);
  });

  /**
   * DEPTH 2, which every other case in this file is silent about, and the one place the two halves
   * of `forkCacheAnchor`'s answer are visibly different things.
   *
   * The goal and the clock come from the family ROOT after the transitive walk; `inheritFromTaskId`
   * is the IMMEDIATE PARENT, one link. At depth 1 those are the same task and no fixture can tell
   * them apart. Here they are not, and the tree has decided in favour of the parent: its row was
   * itself a copy of the root's, so the bytes are the same bytes and it is one read nearer.
   *
   * That decision is pinned on the READ and not on the bytes, because `copyMemoryPack` carries
   * `sha256` across unchanged - the root's pack, the parent's pack and this fork's pack all have
   * the same sha, so a sha assertion would be green whichever row was copied. Return `anchor.id`
   * from `inheritFromTaskId` and `packReads` changes while every byte stays put.
   *
   * One fusion query across three tasks is the other half: a family that re-ranked at any link
   * would ask again, and the fixture answers the second call differently on purpose.
   */
  it('anchors a retry of a retry on the family root, and copies the pack from its immediate parent', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed);

    const once = forkedState(parent, RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retryOnce,
      key,
      state: once,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });
    expect(leadingSystemRun(once)).toBe(leadingSystemRun(parent));

    const before = probed.packReads.length;
    const twice = forkedState(parent, RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retryTwice,
      key,
      state: twice,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    // The root's valid bytes are reusable across the retry chain.
    expect(leadingSystemRun(twice)).toBe(leadingSystemRun(parent));
    expect(leadingSystemRun(twice)).not.toContain(EXPIRING_ROW);
    // The walk went all the way to the root rather than stopping at the parent it reads the pack
    // from, and it stopped there rather than asking a fourth time.
    expect(probed.taskReads).toEqual([rootId, retryOnceId, rootId]);
    // One ranking for the whole family.
    expect(probed.recallQueries).toHaveLength(1);
    // Its own row first, then the row it copies: the IMMEDIATE PARENT's, not the root's.
    expect(probed.packReads.slice(before)).toEqual([retryTwiceId, retryOnceId]);
    expect(probed.packs.get(retryTwiceId)?.sha256).toBe(probed.packs.get(rootId)?.sha256);
    expect(probed.packs.get(retryTwiceId)?.bodyCiphertext.aad).toBe(memoryPackAad(retryTwiceId));
  });

  /** Family age is measured between task creation times, independently of evidence expiry. */
  it('holds a retry preamble across a turn taken after the root would have aged out', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('Dan. Ships on Fridays.');
    const parent = await buildRoot(probed);

    const fork = forkedState(parent, RETRY_GOAL);
    await assemblePreamble(probed.deps, {
      task: retry,
      key,
      state: fork,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });
    const firstTurn = leadingSystemRun(fork);
    // The inheritance is live on turn one, so this arm is about holding something rather than
    // about two ways of producing nothing.
    expect(firstTurn).not.toContain(EXPIRING_ROW);
    expect(firstTurn).toBe(leadingSystemRun(parent));

    // Two hours later, on the same run's next turn. Nothing about either task has changed.
    vi.setSystemTime(new Date('2026-08-02T11:00:00.000Z'));
    await assemblePreamble(probed.deps, {
      task: retry,
      key,
      state: fork,
      goal: RETRY_GOAL,
      contextTokens: 200_000
    });

    expect(leadingSystemRun(fork)).toBe(firstTurn);
  });
});
