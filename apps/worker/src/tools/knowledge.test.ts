import { describe, expect, it } from 'vitest';
import { type ModelToolCall } from '@garden/model-gateway';
import { executeKnowledgeTool } from './knowledge.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The reach, driven through the arm that ships it rather than through the helper it calls.
 *
 * `memory-runtime.test.ts` proves the per-turn budget and the window test against
 * `reachMemoryEvidence` directly. That leaves the wiring unproven, and the wiring is where this
 * repository keeps finding the defect: the arm could stop passing `state.messages`, or stop
 * spending the budget, or stop calling the reach at all, and every one of those cases would stay
 * green. `session_search` grew an `id` argument rather than a tool of its own - a new tool is
 * resident bytes in every request and a second concept to choose between - so this is also the only
 * place that proves the argument reaches the branch.
 */
const reach = async (
  id: string,
  window: string,
  spent = 0
): Promise<{ result?: unknown; error?: string; asked: string[]; spent: number }> => {
  const asked: string[] = [];
  const state = { messages: [{ role: 'assistant', content: window }], memoryReaches: spent };
  const context = {
    task: { workspaceId: 'ws-1', id: 'task-1', userId: 'user-1' },
    key: Buffer.alloc(32),
    state,
    store: {
      // The four the reach dereferences. An id may name a source or an item, so both are asked.
      getMemoryItem: async () => null,
      listMemoryEvidence: async () => [],
      listMemoryCitedCalls: async () => [],
      listMemorySourceWindow: async (workspaceId: string) => {
        asked.push(`listMemorySourceWindow:${workspaceId}`);
        return [];
      }
    }
  } as unknown as ToolContext;
  const call = {
    id: 'call-1',
    name: 'session_search',
    arguments: { id }
  } as unknown as ModelToolCall;
  try {
    return { result: await executeKnowledgeTool(context, call), asked, spent: state.memoryReaches };
  } catch (error) {
    return { error: (error as Error).message, asked, spent: state.memoryReaches };
  }
};

const shown = '9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

describe('reaching a stored result the conversation was given', () => {
  it('asks the store for the window behind an id this turn was actually shown', async () => {
    // The store here holds nothing, so the reach ends in a refusal either way. What separates the
    // two cases is whether the store was consulted at all, and that is the wiring: the arm has to
    // hand `state.messages` and the workspace to the reach for the shown id to get that far.
    const { asked } = await reach(shown, `one result: ${shown}`);
    expect(asked).toContain('listMemorySourceWindow:ws-1');
  });

  it('refuses an id the conversation never carried, and asks the store nothing', async () => {
    // The window is the bound on what may be reached. A refusal that still queried would let a
    // guessed id probe what exists, which is the whole reason the test is on the window and not on
    // the id's shape.
    const { asked, error } = await reach(shown, 'nothing with an id in it');
    expect(error).toMatch(/Reach only an id this conversation was given/);
    expect(asked).toEqual([]);
  });

  it('refuses a well-formed id once the turn has spent its reaches', async () => {
    // Charged after success, so a refusal costs nothing - but an exhausted turn refuses even the
    // id it was legitimately shown, or the budget bounds nothing.
    const { error, asked } = await reach(shown, `one result: ${shown}`, 99);
    expect(error).toMatch(/limit for one turn/);
    expect(asked).toEqual([]);
  });
});
