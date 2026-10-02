import { MEMORY_PACK_BUDGET_TOKENS } from '@garden/core';
/**
 * The order of the preamble, asserted as an order.
 *
 * `window.ts` was the largest pure move of Wave 7.2 - 407 lines - and it arrived with no test of its
 * own. `assemblePreamble` was exercised only by driving a whole turn through `agent-run.test.ts`,
 * which reads the *contents* of the window and never its arrangement. That is the wrong half. Every
 * line in this file is about where a block sits, because where it sits is what a provider's cache
 * charges for: Wave 3 measured the ordering here at 74.8% -> 76.1% byte-common prefix and -4.5%
 * billable input, and until now the only thing protecting that number was the eval suite's aggregate
 * token count - a figure that moves for a dozen reasons and names none of them.
 *
 * So the assertions here are deliberately about position and identity rather than about text:
 *
 * - the three preamble blocks land in one order, and it is the same order on a fresh turn and on a
 *   resumed one, which is the property `injectMemoryPack` and the brief's move-to-the-end exist for;
 * - a block whose bytes have not changed is written over in place, so the window is byte-identical
 *   rather than merely equal - a splice that moved everything behind it by one would satisfy a
 *   contents test and re-bill the whole prompt;
 * - the two blocks the header calls frozen are ranked and clocked against `task.createdAt`, so they
 *   do not rewrite themselves mid-run;
 * - the plan and the runtime block go at the tail, which is the opposite decision and is argued for
 *   in the file at length.
 */
import { WEB_TOOL_DISCLOSURE, type WebToolPlan } from '@garden/contracts';
import {
  encryptBytes,
  encryptJson,
  ownerBlockAad,
  userMemoryAad,
  userMemoryKey
} from '@garden/core';
import type {
  DataStore,
  MemoryCandidateRecord,
  MemoryPackRecord,
  OwnerBlockRecord,
  TaskPlanRecord,
  TaskRecord,
  WorkspaceMemoryRecord,
  WorkspaceRecord,
  WorkspaceSkillRecord
} from '@garden/data';
import type { ModelMessage } from '@garden/model-gateway';
import { describe, expect, it, vi } from 'vitest';
import type { AgentState, AgentWorkerConfig } from './agent-state.js';
import {
  BASE_PROMPT_MARKER,
  CONDENSED_HISTORY_MARKER,
  OWNER_BLOCK_MARKER,
  RUNTIME_CONTEXT_MARKER
} from './context.js';
import { MEMORY_PACK_MARKER, memoryItemAad, memoryPackBudgetTokens } from './memory-runtime.js';
import { spillOverflow } from './output-spill.js';
import type { AgentRunnerClient } from './runner-client.js';
import { WORKSPACE_BRIEF_MARKER } from './turn-bounds.js';
import {
  assemblePreamble,
  refreshActivePlan,
  refreshRuntimeContext,
  type WindowDeps
} from './window.js';

const key = new Uint8Array(32).fill(9);
/** The box's master key, from which the owner tier's key is derived rather than stored. */
const boxMasterKey = Buffer.alloc(32, 7);
const KNOWLEDGE_MARKER = 'CURATED ENCRYPTED KNOWLEDGE';
const PLAN_MARKER = 'ACTIVE USER-VISIBLE PLAN';
/*
 * Opens with the real marker, because one block in this window is now positioned relative to the
 * contract rather than relative to the end of the preamble. A stand-in string would have put the
 * owner block at index 0 in this file and at index 1 in production - the fixture agreeing with
 * itself and disagreeing with the product, which is the shape of test that passes while the
 * arrangement it is about is wrong.
 */
const BASE_PROMPT = `${BASE_PROMPT_MARKER}\nBASE SYSTEM PROMPT`;

const workspaceId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

const task = {
  id: taskId,
  userId,
  workspaceId,
  securityMode: 'balanced',
  createdAt: '2026-08-01T00:00:00.000Z'
} as unknown as TaskRecord;

const workspace = {
  id: workspaceId,
  userId,
  name: 'daily',
  securityMode: 'balanced'
} as unknown as WorkspaceRecord;

interface Probe {
  deps: WindowDeps;
  /** What the runner answers for `workspace/GARDEN.md`; `null` makes the read fail. */
  brief: string | null;
  memories: WorkspaceMemoryRecord[];
  /** The owner's own block, or nothing written yet. */
  block: OwnerBlockRecord | null;
  /** Set to make reading the block throw, which is the "an aid, not a precondition" path. */
  blockFails: boolean;
  skills: WorkspaceSkillRecord[];
  /** Set to make the memory store throw, which is the "memory is an aid, not a precondition" path. */
  packFails: boolean;
  /** What the fusion query answers with, which is what ends up rendered into the pack. */
  candidates: MemoryCandidateRecord[];
  plan: TaskPlanRecord | null;
  readonly events: Array<{ kind: string }>;
  readonly recallQueries: unknown[];
}

const memory = (id: string, target: 'workspace' | 'user', content: string): WorkspaceMemoryRecord =>
  ({
    id,
    userId,
    workspaceId,
    target,
    contentCiphertext: encryptJson({ content }, key, `workspace-memory:${workspaceId}`),
    validUntil: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }) as WorkspaceMemoryRecord;

/**
 * A row of the owner tier, sealed the way the product seals one.
 *
 * Deliberately not the same shape as `memory` above: a different key, a different AAD and no
 * workspace id. A fixture that sealed this under the workspace key would be measuring a row this
 * product cannot produce, and would pass whether or not the preamble had learned the second scope.
 */
const ownerMemory = (id: string, content: string): WorkspaceMemoryRecord =>
  ({
    id,
    userId,
    workspaceId: null,
    target: 'user',
    keyScope: 'user',
    contentCiphertext: encryptJson(
      { content },
      userMemoryKey(boxMasterKey, userId),
      userMemoryAad(userId)
    ),
    validUntil: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }) as WorkspaceMemoryRecord;

/**
 * The owner's block, sealed the way the product seals it: bytes rather than a JSON document, under
 * the key derived from the master key and the user, with the context that names that user.
 *
 * Bytes because the byte bound is a CHECK on the ciphertext length, which is only the plaintext
 * length while nothing has been wrapped around it. A fixture that sealed a `{ text }` object would
 * be measuring a row this product cannot write.
 */
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

/** One row the fusion query can return, sealed the way the item layer seals them. */
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

const skill = (id: string, name: string, description: string): WorkspaceSkillRecord =>
  ({
    id,
    userId,
    workspaceId,
    nameHash: name,
    documentCiphertext: encryptJson({ name, description }, key, `workspace-skill:${workspaceId}`),
    version: 1,
    enabled: true,
    status: 'active',
    pinned: false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z'
  }) as WorkspaceSkillRecord;

const probe = (): Probe => {
  const state: Probe = {
    brief: null,
    memories: [],
    block: null,
    blockFails: false,
    skills: [],
    packFails: false,
    candidates: [],
    plan: null,
    events: [],
    recallQueries: [],
    deps: undefined as unknown as WindowDeps
  };
  const packs = new Map<string, MemoryPackRecord>();
  state.deps = {
    config: { PREVIEW_BASE_URL: 'https://preview.invalid' } as unknown as AgentWorkerConfig,
    masterKey: boxMasterKey,
    runner: {
      readFile: async (_workspaceId: string, _taskId: string, path: string) => {
        if (state.brief === null) throw new Error(`no such file: ${path}`);
        return state.brief;
      }
    } as unknown as AgentRunnerClient,
    store: {
      listWorkspaceMemories: async () => state.memories,
      readOwnerBlock: async () => {
        if (state.blockFails) throw new Error('owner block unavailable');
        return state.block;
      },
      curateWorkspaceSkills: async () => undefined,
      listWorkspaceSkills: async () => state.skills,
      getMemoryPack: async (id: string) => packs.get(id) ?? null,
      saveMemoryPack: async (input: {
        taskId: string;
        workspaceId: string;
        bodyCiphertext: unknown;
        sha256: string;
        itemIds: string[];
        tokensEst: number;
      }) => {
        const record = {
          ...input,
          briefVersion: null,
          itemIds: [...input.itemIds],
          createdAt: '2026-08-01T00:00:00.000Z'
        } as unknown as MemoryPackRecord;
        packs.set(input.taskId, record);
        return record;
      },
      recallMemoryCandidates: async (input: unknown) => {
        state.recallQueries.push(input);
        if (state.packFails) throw new Error('memory store unavailable');
        return state.candidates;
      },
      appendTaskEvent: async (input: { kind: string }) => {
        state.events.push({ kind: input.kind });
        return { id: 'event' };
      },
      getLatestTaskPlan: async () => state.plan,
      createTaskPlan: async (input: { taskId: string }) => {
        const record = {
          id: 'plan-1',
          taskId: input.taskId,
          version: 1,
          parentVersion: null,
          branchName: 'Main',
          stepsCiphertext: encryptJson(
            { steps: [{ id: 's1', title: 'Inspect', status: 'in_progress' }], branchName: 'Main' },
            key,
            `task-plan:${taskId}`
          ),
          createdBy: 'agent',
          createdAt: '2026-08-01T00:00:00.000Z'
        } as TaskPlanRecord;
        state.plan = record;
        return record;
      }
    } as unknown as DataStore
  };
  return state;
};

const freshState = (): AgentState => ({
  messages: [
    { role: 'system', content: BASE_PROMPT },
    { role: 'user', content: 'fix the importer' }
  ],
  step: 0,
  credits: 0
});

/** What each message in the window is, by the marker that identifies it. */
const shape = (messages: ModelMessage[]): string[] =>
  messages.map((message) => {
    if (message.role !== 'system') return `${message.role}`;
    if (message.content.startsWith(OWNER_BLOCK_MARKER)) return 'owner';
    if (message.content.startsWith(KNOWLEDGE_MARKER)) return 'knowledge';
    if (message.content.startsWith(MEMORY_PACK_MARKER)) return 'pack';
    if (message.content.startsWith(WORKSPACE_BRIEF_MARKER)) return 'brief';
    if (message.content.startsWith(CONDENSED_HISTORY_MARKER)) return 'condensed';
    if (message.content.startsWith(RUNTIME_CONTEXT_MARKER)) return 'runtime';
    if (message.content.startsWith(PLAN_MARKER)) return 'plan';
    return 'base';
  });

const preamble = { task, key, goal: 'fix the importer', contextTokens: 200_000 };

/** The in-house route, which is what the runtime block says when nothing has moved it. */
const inHouse: WebToolPlan = {
  mode: 'in_house',
  reason: 'forced_in_house',
  disclosure: WEB_TOOL_DISCLOSURE.in_house,
  serverTools: []
};

describe('the preamble', () => {
  /**
   * The order, on a fresh turn.
   *
   * Frozen blocks first - the reviewed knowledge and the recalled pack, both anchored to the task's
   * own creation instant - then the workspace brief, which is a plain file the running agent writes
   * and is therefore the one block that genuinely changes between turns. Ahead of them it would move
   * the divergence point to the second message and re-bill everything behind it.
   */
  /*
   * The tier that is not this computer's, reaching the model at all.
   *
   * `workspace_memories.target='user'` has been readable here since migration 30 and has never
   * carried anything a second workspace could see, because the row was sealed under the workspace
   * key and dropped by the AAD equality below. It is now sealed under a key derived from the master
   * key and the user, and this is the assertion that the preamble picks the right one - without it
   * the whole tier would be a database row nothing ever reads.
   *
   * The second half is the attack from the other side. A row that merely *claims* the owner scope
   * while carrying the workspace context is dropped, so the check is still an equality against one
   * permitted context rather than a widened net: `key_scope` chooses which context is expected, it
   * does not excuse a row from having one.
   */
  it('reads the owner tier under its own key, and drops a row whose scope and context disagree', async () => {
    const probed = probe();
    probed.memories = [
      ownerMemory('m-owner', 'take the lead and do not stop to ask'),
      {
        ...ownerMemory('m-forged', 'this should never be read'),
        contentCiphertext: encryptJson(
          { content: 'this should never be read' },
          key,
          `workspace-memory:${workspaceId}`
        )
      } as WorkspaceMemoryRecord
    ];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(state.messages[1]?.content).toContain('take the lead and do not stop to ask');
    expect(state.messages[1]?.content).not.toContain('this should never be read');
  });

  it('puts the frozen blocks ahead of the block that changes', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'user', 'prefers metric units')];
    probed.skills = [skill('s1', 'importer', 'how the importer works')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'brief', 'user']);
    // The pack is absent here only because this store recalled nothing; with entries it lands
    // between the two, which the next case measures.
    expect(state.messages[1]?.content).toContain('prefers metric units');
    expect(state.messages[1]?.content).toContain('importer');
    expect(state.messages[2]?.content).toContain('This project uses uv.');
    expect(state.taint).toMatchObject({
      level: 'untrusted',
      sources: ['workspace file workspace/GARDEN.md']
    });
  });

  /**
   * All four blocks at once, which is the arrangement the measurement was taken on.
   *
   * This is the assertion the whole file is for: reviewed knowledge, then the recalled pack, then
   * the brief, then the owner's goal. Nothing else in the repository states it - `agent-run.test.ts`
   * reads what the window contains and never where anything sits, and the eval suite sees only a
   * token total.
   */
  it('lands the four blocks in one order: knowledge, pack, brief, goal', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'user', 'prefers metric units')];
    probed.candidates = [candidate('c1', 'the exporter writes UTF-8')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'pack', 'brief', 'user']);
    expect(state.messages[2]?.content).toContain('the exporter writes UTF-8');
  });

  /**
   * And the same four in the same order when the turn is resumed into a window that already has
   * them, which is what makes the ordering a cacheable prefix rather than a first-turn accident.
   */
  it('reaches that order again from a window that already holds all four', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'user', 'prefers metric units')];
    probed.candidates = [candidate('c1', 'the exporter writes UTF-8')];
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    const before = state.messages.map((message) => message.content);

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'pack', 'brief', 'user']);
    expect(state.messages.map((message) => message.content)).toEqual(before);
  });

  /**
   * The same order on a resumed turn, which is the case the brief's move-to-the-end exists for.
   *
   * `injectMemoryPack` removes and re-adds at the end of the leading system run, so a resume whose
   * window already held a brief would otherwise get the pack *after* it - and the window's shape
   * would depend on which turn it was, which is exactly what a cached prefix cannot survive.
   */
  it('reaches the same order from a window that already holds a brief', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    const state = freshState();
    state.messages.splice(1, 0, {
      role: 'system',
      content: `${WORKSPACE_BRIEF_MARKER}\nstale placement`
    });
    expect(shape(state.messages)).toEqual(['base', 'brief', 'user']);

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'brief', 'user']);
  });

  /**
   * An unchanged block leaves the window byte-identical, not merely equal.
   *
   * The knowledge block is written over where it sits and the brief is written over where it sits
   * once it is already last. Removing and re-inserting either would move every message behind it by
   * one - a change no contents assertion can see and every cache can.
   */
  it('rewrites nothing when a second assembly finds the same facts', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'workspace', 'the importer reads three columns')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });
    const before = state.messages.map((message) => message.content);
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(state.messages.map((message) => message.content)).toEqual(before);
    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'brief', 'user']);
  });

  /**
   * Both frozen blocks are ranked and clocked against the task's own start, not the wall clock.
   *
   * The header on the knowledge block says "frozen for this run" and the pack is persisted as
   * rendered bytes for the same reason. Reading it off the recall query is the only place the claim
   * is observable without waiting for a day to pass.
   */
  it('removes expired owner-managed facts when resuming instead of reviving their opening validity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
    try {
      const probed = probe(),
        state = freshState();
      const record = memory('expiring', 'workspace', 'Temporary access is permitted');
      record.contentCiphertext = encryptJson(
        { content: 'Temporary access is permitted', validUntil: '2026-08-02T00:00:00Z' },
        key,
        `workspace-memory:${workspaceId}`
      );
      probed.memories = [record];
      await assemblePreamble(probed.deps, { ...preamble, state });
      expect(
        state.messages.some((message) => message.content.includes('Temporary access is permitted'))
      ).toBe(false);
      record.contentCiphertext = encryptJson(
        { content: 'Temporary access is permitted', validUntil: '2999-01-01T00:00:00Z' },
        key,
        `workspace-memory:${workspaceId}`
      );
      await assemblePreamble(probed.deps, { ...preamble, state });
      expect(
        state.messages.some((message) => message.content.includes('Temporary access is permitted'))
      ).toBe(true);
      record.contentCiphertext = encryptJson(
        { content: 'Temporary access is permitted', validUntil: '2026-08-02T00:00:00Z' },
        key,
        `workspace-memory:${workspaceId}`
      );
      await assemblePreamble(probed.deps, { ...preamble, state });
      expect(
        state.messages.some((message) => message.content.includes('Temporary access is permitted'))
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps ranking stable while checking validity at the time of resumption', async () => {
    const probed = probe();
    const state = freshState();

    const before = Date.now();
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(probed.recallQueries).toHaveLength(1);
    const query = probed.recallQueries[0] as { now: Date; asOf: Date; budgetTokens: number };
    expect(query.now.toISOString()).toBe(task.createdAt);
    expect(query.asOf.getTime()).toBeGreaterThanOrEqual(before);
    expect(query.asOf.getTime()).toBeLessThanOrEqual(Date.now());
    // The pack's share of the lead model's window - a share with a ceiling on it, which is why
    // this reads the helper rather than restating the arithmetic.
    expect(query.budgetTokens).toBe(MEMORY_PACK_BUDGET_TOKENS);
    expect(memoryPackBudgetTokens(4_096)).toBeLessThan(memoryPackBudgetTokens(200_000));
  });

  /**
   * Memory is an aid, not a precondition. A store that cannot be read writes a warning the owner can
   * see and leaves the rest of the preamble intact.
   */
  it('starts the task without a pack when memory cannot be read', async () => {
    const probed = probe();
    probed.packFails = true;
    probed.brief = 'This project uses uv.';
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(probed.events).toEqual([{ kind: 'warning' }, { kind: 'provenance' }]);
    expect(shape(state.messages)).toEqual(['base', 'brief', 'user']);
  });

  /** A workspace with no brief file contributes no block, rather than an empty one. */
  it('leaves no brief block when there is no brief', async () => {
    const probed = probe();
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'user']);
  });

  /** And a brief that has been deleted since the last turn is taken back out of the window. */
  it('removes a brief block once the file is gone', async () => {
    const probed = probe();
    probed.brief = 'This project uses uv.';
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    expect(shape(state.messages)).toContain('brief');

    probed.brief = null;
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'user']);
  });

  /**
   * The condensed brief is carried in two places on purpose, and a resumed state that has the
   * sections but not the message would otherwise continue with no record of the condensed work.
   * It is republished directly after the goal, which is where compaction keeps it.
   */
  it('republishes a condensed history that a resume arrived without', async () => {
    const probed = probe();
    const state = freshState();
    state.contextBrief = {
      sections: [{ from: 1, to: 3, messages: 12, source: 'model', text: 'earlier work' }],
      condensedMessages: 12
    };

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'user', 'condensed']);
    expect(state.messages.at(-1)?.content).toContain('earlier work');
  });

  /** Written once. A second assembly must not stack a second copy on the same window. */
  it('does not republish a condensed history that is already there', async () => {
    const probed = probe();
    const state = freshState();
    state.contextBrief = {
      sections: [{ from: 1, to: 3, messages: 12, source: 'model', text: 'earlier work' }],
      condensedMessages: 12
    };

    await assemblePreamble(probed.deps, { ...preamble, state });
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages).filter((entry) => entry === 'condensed')).toHaveLength(1);
  });

  /**
   * The skill index is ordered by something reading a skill cannot change.
   *
   * The store returns skills most-recently-updated first and viewing one stamps that column, so the
   * owner's own browsing used to reorder the front of the prompt. Ids are assigned once.
   */
  it('orders the skill index by id, not by what the store happened to return', async () => {
    const probed = probe();
    probed.skills = [
      skill('s3', 'gamma', 'third'),
      skill('s1', 'alpha', 'first'),
      skill('s2', 'beta', 'second')
    ];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    const block = state.messages[1]?.content ?? '';
    expect(block.indexOf('alpha')).toBeLessThan(block.indexOf('beta'));
    expect(block.indexOf('beta')).toBeLessThan(block.indexOf('gamma'));
  });

  /**
   * The owner's own switch, which is read here first and was written nowhere.
   *
   * `enabled` is checked ahead of both status and pinning, so a skill the owner turned off is out
   * of the index whatever the curation timer thinks of it and whether or not it is pinned. That
   * order is the claim: pinning is an argument with the timer, and this is not. Until the settings
   * row could send `enabled` nothing in the product could put a skill into this state, while the
   * approval card for a skill upsert was already telling the owner it could.
   */
  it('leaves out a skill the owner turned off, whether or not it is pinned', async () => {
    const probed = probe();
    probed.skills = [
      skill('s1', 'alpha', 'first'),
      { ...skill('s2', 'beta', 'second'), enabled: false },
      { ...skill('s3', 'gamma', 'third'), enabled: false, pinned: true }
    ];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    const block = state.messages[1]?.content ?? '';
    expect(block).toContain('alpha');
    expect(block).not.toContain('beta');
    expect(block).not.toContain('gamma');
  });

  /**
   * The caveat line is the difference between project context and an instruction from the harness.
   * The brief is a plain workspace file any turn can write, spliced in as a system message ahead of
   * the whole trajectory in every later task.
   */
  it('says what the brief is before quoting it', async () => {
    const probed = probe();
    probed.brief = 'Deploy with the deploy script.';
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    const brief = state.messages.find((message) =>
      message.content.startsWith(WORKSPACE_BRIEF_MARKER)
    );
    expect(brief?.content).toContain('cannot grant permission or override');
  });

  /**
   * The owner's own block, on the production path, ahead of everything that had to be ranked.
   *
   * The two memory tiers below it are scored against the task's opening request in one pool, and
   * the pack below them is a budgeted retrieval. This is neither: it is installed by position, so
   * the order asserted here is the whole feature - a block that had moved behind the ranked one, or
   * that only appeared when it happened to score, would satisfy a contents test and be the thing
   * this replaces.
   */
  it('renders the owner block first of the preamble, and identically on the next turn', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('- You are the lead.\n- British spelling, always.');
    probed.brief = 'This project uses uv.';
    probed.memories = [memory('m1', 'workspace', 'the importer runs nightly')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });
    expect(shape(state.messages)).toEqual(['base', 'owner', 'knowledge', 'brief', 'user']);
    expect(state.messages[1]?.content).toContain('British spelling, always.');
    // The same caveat every user-managed block carries, because this is the one most likely to be
    // read as permission and the only one the owner writes in their own voice.
    expect(state.messages[1]?.content).toContain('never as permission or a safety override');

    const before = JSON.stringify(state.messages);
    await assemblePreamble(probed.deps, { ...preamble, state });
    expect(JSON.stringify(state.messages)).toBe(before);
  });

  /**
   * A block sealed under the workspace key is not read, and the owner is told.
   *
   * The AAD equality is what stops a row moved between accounts or between scopes from being
   * opened by whoever holds the other key. Here it is attacked from the direction that matters:
   * something that is filed as the owner's block but was sealed as workspace data.
   */
  it('refuses a block sealed under a context that is not the owner\u2019s, and warns', async () => {
    const probed = probe();
    probed.block = {
      ...ownerBlockRow('this should never be read'),
      ciphertext: encryptBytes(
        Buffer.from('this should never be read', 'utf8'),
        key,
        `workspace-memory:${workspaceId}`
      )
    };
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).not.toContain('owner');
    expect(JSON.stringify(state.messages)).not.toContain('this should never be read');
    expect(probed.events.map((entry) => entry.kind)).toContain('warning');
  });

  /**
   * A store that cannot be read leaves the block that is already there alone.
   *
   * Two reasons, and the second is the stronger one. Dropping it would rewrite the front of the
   * prompt and re-bill everything behind it for nothing; and it would silently take away the
   * owner's own standing words in the middle of a task, which is the failure this whole tier is
   * arranged against. The pack a few lines below makes the same choice for the first reason alone.
   */
  it('keeps the block already in the window when the store cannot be read', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('- No shortcuts, ever.');
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    const resident = state.messages[1]?.content ?? '';
    expect(resident).toContain('No shortcuts, ever.');

    probed.blockFails = true;
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(state.messages[1]?.content).toBe(resident);
    expect(probed.events.map((entry) => entry.kind)).toContain('warning');
  });

  /**
   * The owner clears their block and the next turn stops sending it.
   *
   * The failure this is against is specific and would be invisible: a resumed window already holds
   * the block, so an assemble that only ever *installs* would keep sending words the owner deleted
   * on the one surface where deleting them is the whole point. The block is removed rather than
   * rewritten empty, so the window costs nothing again as well as saying nothing.
   */
  it('stops sending the block on the turn after the owner clears it', async () => {
    const probed = probe();
    probed.block = ownerBlockRow('- Reject the generic.');
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    expect(shape(state.messages)).toContain('owner');

    probed.block = null;
    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).not.toContain('owner');
    expect(JSON.stringify(state.messages)).not.toContain('Reject the generic');
    expect(JSON.stringify(state.messages)).not.toContain(OWNER_BLOCK_MARKER);
  });

  /** Nothing written is nothing sent: an owner who has typed no block pays no resident bytes. */
  it('sends nothing at all when the owner has written nothing', async () => {
    const probed = probe();
    probed.memories = [memory('m1', 'workspace', 'the importer runs nightly')];
    const state = freshState();

    await assemblePreamble(probed.deps, { ...preamble, state });

    expect(shape(state.messages)).toEqual(['base', 'knowledge', 'user']);
    expect(JSON.stringify(state.messages)).not.toContain(OWNER_BLOCK_MARKER);
  });
});

describe('the runtime block', () => {
  it('sits at the tail, and only ever once', async () => {
    const probed = probe();
    const state = freshState();
    const input = {
      workspace,
      task,
      state,
      timeZone: 'Europe/Berlin',
      toolchainSummary: 'libreoffice',
      machineSummary: '',
      unattended: false,
      webPlan: inHouse
    };

    refreshRuntimeContext(probed.deps, input);
    expect(shape(state.messages)).toEqual(['base', 'user', 'runtime']);

    state.messages.push({ role: 'assistant', content: 'working' });
    refreshRuntimeContext(probed.deps, input);
    expect(shape(state.messages)).toEqual(['base', 'user', 'assistant', 'runtime']);
    expect(shape(state.messages).filter((entry) => entry === 'runtime')).toHaveLength(1);
  });

  /**
   * A step that changes nothing writes nothing. The block is dynamic, so it is the one preamble-ish
   * message that is allowed to move - but an identical re-push would still be an array mutation, and
   * the file says a step that changes nothing should also write nothing.
   */
  it('leaves the window alone when the block already says this', async () => {
    const probed = probe();
    const state = freshState();
    const input = {
      workspace,
      task,
      state,
      timeZone: 'UTC',
      toolchainSummary: '',
      machineSummary: '',
      unattended: false,
      webPlan: inHouse
    };

    refreshRuntimeContext(probed.deps, input);
    const written = state.messages.at(-1);
    refreshRuntimeContext(probed.deps, input);

    expect(state.messages.at(-1)).toBe(written);
    expect(state.messages).toHaveLength(3);
  });

  /** An unattended run is told so, because it changes what the run is for. */
  it('says when nobody is watching', async () => {
    const probed = probe();
    const state = freshState();
    refreshRuntimeContext(probed.deps, {
      workspace,
      task,
      state,
      timeZone: 'UTC',
      toolchainSummary: '',
      machineSummary: '',
      unattended: true,
      webPlan: inHouse
    });

    expect(state.messages.at(-1)?.content).toContain('A schedule started this run');
  });
});

describe('the active plan', () => {
  /**
   * Pushed at the tail rather than written in place, and the file argues the measurement: a
   * republish diverges at the tail as it stood a few steps ago instead of just behind the goal.
   */
  it('replaces a persisted generic scaffold with the owner plan at the tail', async () => {
    const probed = probe();
    const state = freshState();
    state.planIsFallback = true;
    state.messages.push({ role: 'system', content: `${PLAN_MARKER} v1 (Main).\n1. [pending] old` });
    state.messages.push({ role: 'assistant', content: 'working' });
    probed.plan = {
      id: 'plan-1',
      taskId,
      version: 2,
      parentVersion: 1,
      branchName: 'Main',
      stepsCiphertext: encryptJson(
        { steps: [{ id: 's1', title: 'Rewrite the importer', status: 'in_progress' }] },
        key,
        `task-plan:${taskId}`
      ),
      createdBy: 'user',
      createdAt: '2026-08-01T00:00:00.000Z'
    };

    const changed = await refreshActivePlan(probed.deps, task, key, state);

    expect(changed).toBe(true);
    expect(shape(state.messages)).toEqual(['base', 'user', 'assistant', 'plan']);
    expect(state.messages.at(-1)?.content).toContain('Rewrite the importer');
    expect(state.planVersion).toBe(2);
    expect(state.planIsFallback).toBe(false);
  });

  it('writes nothing when the window already holds this version', async () => {
    const probed = probe();
    const state = freshState();
    probed.plan = {
      id: 'plan-1',
      taskId,
      version: 2,
      parentVersion: null,
      branchName: 'Main',
      stepsCiphertext: encryptJson({ steps: [] }, key, `task-plan:${taskId}`),
      createdBy: 'user',
      createdAt: '2026-08-01T00:00:00.000Z'
    };
    await refreshActivePlan(probed.deps, task, key, state);
    const written = state.messages.at(-1);

    const changed = await refreshActivePlan(probed.deps, task, key, state);

    expect(changed).toBe(false);
    expect(state.messages.at(-1)).toBe(written);
  });

  /** A plan sealed for a different task is refused rather than read. */
  it('refuses a plan sealed under another task', async () => {
    const probed = probe();
    const state = freshState();
    probed.plan = {
      id: 'plan-1',
      taskId,
      version: 1,
      parentVersion: null,
      branchName: 'Main',
      stepsCiphertext: encryptJson({ steps: [] }, key, 'task-plan:99999999'),
      createdBy: 'user',
      createdAt: '2026-08-01T00:00:00.000Z'
    };

    await expect(refreshActivePlan(probed.deps, task, key, state)).rejects.toThrow(
      /encryption context/i
    );
  });

  /** With nothing published and no fallback asked for, the window stays as it was. */
  it('does not invent a plan unless it is asked to', async () => {
    const probed = probe();
    const state = freshState();

    expect(await refreshActivePlan(probed.deps, task, key, state)).toBe(false);
    expect(shape(state.messages)).toEqual(['base', 'user']);

    expect(await refreshActivePlan(probed.deps, task, key, state, true)).toBe(true);
    expect(state.planIsFallback).toBe(true);
    expect(shape(state.messages)).toEqual(['base', 'user', 'plan']);
  });
});

/**
 * The two things this file hands the rest of the turn that are not a message.
 *
 * Both are wiring rather than arrangement, and both are here because a mechanism nobody reaches is
 * this programme's most-repeated finding: `spillOverflow` is a no-op until `assemblePreamble` has
 * named the runner, and `spendLine` says nothing until `refreshRuntimeContext` has passed the
 * money. A unit test on either would pass with the call site deleted.
 */
describe('what the preamble registers besides blocks', () => {
  it('names the turn’s overflow writer, so a cut result has somewhere to go', async () => {
    const probed = probe();
    const state = freshState();
    const writes: string[] = [];
    (probed.deps as { runner: AgentRunnerClient }).runner = {
      readFile: async () => {
        throw new Error('no brief');
      },
      writeFile: async (_workspaceId: string, _taskId: string, path: string) => {
        writes.push(path);
        return { ok: true };
      }
    } as unknown as AgentRunnerClient;

    // Before the preamble there is no writer, and nothing is claimed.
    expect(await spillOverflow(task, state, 'x'.repeat(30_000), false)).toBeNull();
    await assemblePreamble(probed.deps, { ...preamble, state });
    const parked = await spillOverflow(task, state, 'x'.repeat(30_000), false);
    expect(parked).not.toBeNull();
    expect(writes).toEqual([parked]);
  });

  it('keeps two turns’ writers apart, because one worker runs several tasks', async () => {
    const first = probe();
    const second = probe();
    const firstWrites: string[] = [];
    const secondWrites: string[] = [];
    const runner = (into: string[]): AgentRunnerClient =>
      ({
        readFile: async () => {
          throw new Error('no brief');
        },
        writeFile: async (_workspaceId: string, _taskId: string, path: string) => {
          into.push(path);
          return { ok: true };
        }
      }) as unknown as AgentRunnerClient;
    (first.deps as { runner: AgentRunnerClient }).runner = runner(firstWrites);
    (second.deps as { runner: AgentRunnerClient }).runner = runner(secondWrites);
    const stateA = freshState();
    const stateB = freshState();
    await assemblePreamble(first.deps, { ...preamble, state: stateA });
    await assemblePreamble(second.deps, { ...preamble, state: stateB });

    await spillOverflow(task, stateA, 'a'.repeat(30_000), false);
    expect(firstWrites).toHaveLength(1);
    expect(secondWrites).toHaveLength(0);
  });

  it('passes the money into the runtime block, and only past the share', () => {
    const probed = probe();
    const cheap = freshState();
    const input = {
      workspace,
      task: { ...task, maxComputeCredits: 20 } as unknown as TaskRecord,
      timeZone: 'UTC',
      toolchainSummary: '',
      machineSummary: '',
      unattended: false,
      webPlan: inHouse
    };
    refreshRuntimeContext(probed.deps, { ...input, state: cheap });
    expect(cheap.messages.at(-1)?.content).not.toContain('Compute budget');

    const spent = freshState();
    spent.credits = 15;
    refreshRuntimeContext(probed.deps, { ...input, state: spent });
    const line = spent.messages.at(-1)?.content ?? '';
    expect(line.startsWith(RUNTIME_CONTEXT_MARKER)).toBe(true);
    expect(line).toContain('Compute budget: about 15 of 20 credits spent');
    expect(line).toContain(', 5 left');
  });
});

/** Specific owner guidance wins; every supported filename remains readable. */
describe('which brief the window reads', () => {
  const withFiles = (files: Record<string, string>): Probe => {
    const probed = probe();
    (probed.deps as { runner: AgentRunnerClient }).runner = {
      readFile: async (_workspaceId: string, _taskId: string, path: string) => {
        const found = files[path];
        if (found === undefined) throw new Error(`no such file: ${path}`);
        return found;
      }
    } as unknown as AgentRunnerClient;
    return probed;
  };

  const briefText = async (files: Record<string, string>): Promise<string> => {
    const probed = withFiles(files);
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    const brief = state.messages.find((message) => message.content.includes('BRIEF'));
    return brief?.content ?? state.messages.map((message) => message.content).join('\n');
  };

  it('reads GARDEN.md first when every supported brief exists', async () => {
    const text = await briefText({
      'workspace/GARDEN.md': 'Use the garden project workflow.',
      'workspace/OPEN_CLOUD.md': 'Compatibility workflow.',
      'workspace/AGENTS.md': 'Shared repository workflow.'
    });
    expect(text).toContain('Use the garden project workflow.');
    expect(text).not.toContain('Compatibility workflow.');
    expect(text).not.toContain('Shared repository workflow.');
  });

  it('reads AGENTS.md when it is the only brief the workspace has', async () => {
    expect(
      await briefText({ 'workspace/AGENTS.md': 'Run the tests with pnpm, never npm.' })
    ).toContain('Run the tests with pnpm, never npm.');
  });

  it("keeps the owner's own GARDEN.md ahead of a shared AGENTS.md", async () => {
    const text = await briefText({
      'workspace/GARDEN.md': 'This project uses uv.',
      'workspace/AGENTS.md': 'Run the tests with pnpm, never npm.'
    });
    expect(text).toContain('This project uses uv.');
    expect(text).not.toContain('Run the tests with pnpm, never npm.');
  });

  it('keeps the older OPEN_CLOUD.md ahead of AGENTS.md too, so a box that has one does not change under it', async () => {
    const text = await briefText({
      'workspace/OPEN_CLOUD.md': 'The staging key lives in 1Password.',
      'workspace/AGENTS.md': 'Run the tests with pnpm, never npm.'
    });
    expect(text).toContain('The staging key lives in 1Password.');
    expect(text).not.toContain('Run the tests with pnpm, never npm.');
  });

  it('carries on with no brief at all when the workspace has none of the supported files', async () => {
    const probed = withFiles({});
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state });
    expect(shape(state.messages)).not.toContain('brief');
  });
});

/**
 * The reserved share, and it is the difference between a label and a promise.
 *
 * Settings prints an owner-tier row as "About you, everywhere" (`apps/web/src/settings-facts.ts`).
 * Migration 70 made the first half of that true - the row leaves the workspace it was typed in and
 * survives its deletion - and the second half was still false, because the row then had to win a
 * relevance contest against every workspace row that happened to share a word with the request. It
 * never did. A fact about a person cannot be retrieved by relevance to a request that never
 * mentions the person, and nothing caps how many workspace rows an agent may write.
 *
 * The cost is measured here rather than asserted: the same fixture is rendered with and without the
 * owner rows present, so what the reserve displaces is a subtraction the case performs, not a claim
 * its comment makes. And the two totals are pinned at the literal numbers the block cost before -
 * thirty-two items and 16,000 characters - because reading them from `window.ts`'s own constants
 * would pass unchanged on the day somebody raised them, which is exactly the regression "adds no
 * resident bytes" is a claim about.
 */
describe('the owner tier inside the reviewed block', () => {
  const goal = 'fix the flaky importer retry in the ingest pipeline';
  /** Sentences with nothing in them the request could match, which is what a person-fact is. */
  const ownerRows = (count: number): WorkspaceMemoryRecord[] =>
    Array.from({ length: count }, (_, index) =>
      ownerMemory(`owner-${index}`, `You are the lead; do not stop to ask (${index}).`)
    );
  /** And rows that match it on five of its six terms, which is what a workspace row looks like. */
  const workspaceRows = (count: number): WorkspaceMemoryRecord[] =>
    Array.from({ length: count }, (_, index) =>
      memory(
        `ws-${index}`,
        'workspace',
        `The flaky importer retry in the ingest pipeline is fixed by step ${index}.`
      )
    );

  const rendered = async (
    owner: number,
    workspace: number
  ): Promise<{ owner: number; workspace: number; characters: number }> => {
    const probed = probe();
    probed.memories = [...ownerRows(owner), ...workspaceRows(workspace)];
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state, goal });
    const block =
      state.messages.find((message) => message.content.startsWith(KNOWLEDGE_MARKER))?.content ?? '';
    const rows = block.split('\n').filter((line) => line.startsWith('- '));
    return {
      owner: rows.filter((line) => line.includes('do not stop to ask')).length,
      workspace: rows.filter((line) => line.includes('is fixed by step')).length,
      characters: rows.reduce((total, line) => total + line.length - 2, 0)
    };
  };

  /**
   * Sixteen rows against sixty that match, which is the shape the tier was losing in.
   *
   * On the build before this one every one of the sixteen was gone: the ranker scores a matching
   * workspace row at about 16.6 and a person-fact at about 2.2, the request has thirty-two seats,
   * and sixty rows were queuing for them. This case therefore fails on that build rather than
   * merely reading differently.
   */
  it('keeps every owner row against sixty workspace rows that match the request', async () => {
    expect(await rendered(16, 60)).toMatchObject({ owner: 16, workspace: 16 });
  });

  /**
   * What it costs, subtracted rather than asserted.
   *
   * The same sixty workspace rows are rendered with the owner tier empty and with it full, and the
   * difference is the price: sixteen matching workspace rows displaced, every one of them ranked
   * below sixteen others that still arrive, and every one still reachable in one call through
   * `memory(action=list)`. The rows that took their place have no second door at all.
   */
  it('displaces exactly the sixteen workspace rows the reserve is the size of', async () => {
    const empty = await rendered(0, 60);
    const full = await rendered(16, 60);
    expect(empty).toMatchObject({ owner: 0, workspace: 32 });
    expect(empty.workspace - full.workspace).toBe(16);
    expect(full.owner + full.workspace).toBe(empty.owner + empty.workspace);
  });

  /**
   * A reserve, not an allocation: three rows take three seats and hand back the other thirteen.
   *
   * This is the case a fixed split passes and a reserve has to earn. The measured content of this
   * tier is single figures (`OWNER_MEMORY_MAX_ROWS` carries the reading it came from), so the state
   * this case describes is the ordinary one and the case above it is the bound.
   */
  it('costs the workspace tier nothing it does not use', async () => {
    expect(await rendered(3, 60)).toMatchObject({ owner: 3, workspace: 29 });
    expect(await rendered(0, 60)).toMatchObject({ owner: 0, workspace: 32 });
  });

  /**
   * And the block is no larger than it was, on both axes it is bounded on.
   *
   * The reserve comes out of the shared budget rather than beside it, so a full owner tier and a
   * full workspace tier still render inside the thirty-two items and 16,000 characters the one
   * pool spent. Resident bytes are the axis this product is measured on; a fix that bought reach
   * by growing the prompt would be a trade nobody agreed to.
   */
  it('adds no resident bytes, with both tiers over their own budgets', async () => {
    const probed = probe();
    probed.memories = [
      ...Array.from({ length: 16 }, (_, index) =>
        ownerMemory(`owner-${index}`, `${'o'.repeat(374)}${index % 10}`)
      ),
      ...Array.from({ length: 40 }, (_, index) =>
        memory(
          `ws-${index}`,
          'workspace',
          `flaky importer retry ingest pipeline ${'w'.repeat(663)}${index % 10}`
        )
      )
    ];
    const state = freshState();
    await assemblePreamble(probed.deps, { ...preamble, state, goal });
    const block =
      state.messages.find((message) => message.content.startsWith(KNOWLEDGE_MARKER))?.content ?? '';
    // The two fixtures only, because the same block also carries the skill index and the built-in
    // catalogue, and those are not what either memory budget is spent on.
    const rows = block
      .split('\n')
      .filter((line) => line.startsWith('- o') || line.startsWith('- flaky importer retry'));
    expect(rows.filter((line) => line.startsWith('- o')).length).toBe(16);
    expect(rows.length).toBeLessThanOrEqual(32);
    expect(rows.reduce((total, line) => total + line.length - 2, 0)).toBeLessThanOrEqual(16_000);
    // And the character budget is the one that binds here, not the item count - so this case is
    // measuring the axis it names rather than passing on the other one.
    expect(rows.length).toBeLessThan(32);
  });
});
