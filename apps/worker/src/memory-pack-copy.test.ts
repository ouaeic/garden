/**
 * The one way giving a fork its parent's memory pack fails silently.
 *
 * `openStoredPack` is an equality against `memoryPackAad(taskId)`, so a row pointed at a second
 * task - aliased, rather than re-encrypted under that task's own context - is refused, returns null,
 * and the fork re-ranks. Nothing is thrown and nothing is logged; the pack simply comes back fresh,
 * which is the behaviour the copy exists to remove. That is why `copyMemoryPack` decrypts and
 * re-encrypts, and why the assertions here are about the CONTEXT of the row as much as its bytes.
 *
 * `reused` is asserted by name here because the call site in `window.ts` cannot: it injects the pack
 * and never sees the flag. The window's own proof is the count of fusion queries and the AAD on the
 * stored row; this is the same property said in one word.
 */
import { encryptJson } from '@garden/core';
import type { MemoryPackRecord } from '@garden/data';
import { describe, expect, it } from 'vitest';
import {
  buildTaskMemoryPack,
  copyMemoryPack,
  memoryPackAad,
  type MemoryPackStore
} from './memory-runtime.js';

const dataKey = new Uint8Array(32).fill(9);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const rootId = '44444444-4444-4444-8444-444444444444';
const forkId = '55555555-5555-4555-8555-555555555555';
const BODY = 'RECALLED MEMORY\n- the importer batches at 500 rows';

const packRow = (taskId: string, aadTaskId: string): MemoryPackRecord => ({
  taskId,
  workspaceId,
  briefVersion: 'resident-excerpts-v1:1500',
  bodyCiphertext: encryptJson({ body: BODY }, dataKey, memoryPackAad(aadTaskId)),
  sha256: 'sha-of-the-parent-body',
  itemIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
  tokensEst: 24,
  createdAt: '2026-08-01T00:00:00.000Z'
});

/** First-writer-wins, the way `mem.pack` is, plus a count of what was asked of the ranking. */
const store = (
  seed: ReadonlyArray<[string, MemoryPackRecord]> = []
): MemoryPackStore & { rows: Map<string, MemoryPackRecord>; recalls: number } => {
  const rows = new Map<string, MemoryPackRecord>(seed);
  const self = {
    rows,
    recalls: 0,
    getMemoryPack: async (taskId: string) => rows.get(taskId) ?? null,
    saveMemoryPack: async (input: {
      taskId: string;
      workspaceId: string;
      bodyCiphertext: ReturnType<typeof encryptJson>;
      sha256: string;
      itemIds: readonly string[];
      tokensEst: number;
      briefVersion?: string | null;
    }) => {
      const existing = rows.get(input.taskId);
      if (existing) return existing;
      const record: MemoryPackRecord = {
        ...input,
        briefVersion: input.briefVersion ?? null,
        itemIds: [...input.itemIds],
        createdAt: '2026-08-02T00:00:00.000Z'
      };
      rows.set(input.taskId, record);
      return record;
    },
    recallMemoryCandidates: async () => {
      self.recalls += 1;
      return [];
    }
  };
  return self as unknown as MemoryPackStore & {
    rows: Map<string, MemoryPackRecord>;
    recalls: number;
  };
};

const buildFork = (backing: MemoryPackStore): Promise<{ body: string; reused: boolean }> =>
  buildTaskMemoryPack({
    store: backing,
    taskId: forkId,
    workspaceId,
    dataKey,
    query: 'Retry the preceding user request.',
    clockAnchor: new Date('2026-08-02T00:00:00.000Z'),
    inheritFromTaskId: rootId
  });

describe('a fork taking its parent pack', () => {
  it('reports the bytes as reused and seals them under the fork own context', async () => {
    const backing = store([[rootId, packRow(rootId, rootId)]]);

    const pack = await buildFork(backing);

    expect(pack.reused).toBe(true);
    expect(pack.body).toBe(BODY);
    expect(backing.recalls).toBe(0);
    expect(backing.rows.get(forkId)?.bodyCiphertext.aad).toBe(memoryPackAad(forkId));
  });

  /**
   * The alias, written out as a fixture because it is the failure that looks like success: a row
   * standing at the fork's key carrying the parent's context. Nothing refuses to store it and
   * nothing refuses to read it - `openStoredPack` simply says null, and the pack comes back fresh.
   */
  it('refuses a row that stands at the fork key carrying the parent context', async () => {
    const backing = store([[forkId, packRow(forkId, rootId)]]);

    const pack = await buildFork(backing);

    expect(pack.reused).toBe(false);
    expect(backing.recalls).toBe(1);
  });

  /** A parent with no row of its own - a branch that never ran - leaves the fork to rank. */
  it('leaves the fork to rank when there is nothing to copy', async () => {
    const backing = store();

    expect(
      await copyMemoryPack({
        store: backing,
        fromTaskId: rootId,
        toTaskId: forkId,
        workspaceId,
        dataKey
      })
    ).toBeNull();
    expect((await buildFork(backing)).reused).toBe(false);
    expect(backing.recalls).toBe(1);
  });

  /** A retry's model budget remains binding even when a larger parent pack is cached. */
  it('rebuilds a parent pack when the fork has a smaller budget', async () => {
    const backing = store([[rootId, packRow(rootId, rootId)]]);

    const pack = await buildTaskMemoryPack({
      store: backing,
      taskId: forkId,
      workspaceId,
      dataKey,
      query: 'Retry the preceding user request.',
      clockAnchor: new Date('2026-08-02T00:00:00.000Z'),
      inheritFromTaskId: rootId,
      // A third of what the parent's row already spends, which is a fork moving to a small window.
      budgetTokens: 8
    });

    expect(pack.reused).toBe(false);
    expect(pack.itemIds).toHaveLength(0);
    expect(backing.recalls).toBe(1);
  });

  /**
   * The fork's OWN row wins over its parent's, which is the ordering that keeps this safe on a
   * second turn: by then the fork has bytes a provider may have cached, and the parent's are no
   * longer the ones to send.
   */
  it('prefers a pack the fork has already saved over its parent', async () => {
    const backing = store([
      [rootId, packRow(rootId, rootId)],
      [forkId, packRow(forkId, forkId)]
    ]);
    backing.rows.set(forkId, {
      ...packRow(forkId, forkId),
      bodyCiphertext: encryptJson({ body: 'ALREADY SENT' }, dataKey, memoryPackAad(forkId))
    });

    const pack = await buildFork(backing);

    expect(pack.reused).toBe(true);
    expect(pack.body).toBe('ALREADY SENT');
  });
});
