import { describe, expect, it, vi } from 'vitest';
import { decryptJson, encryptJson } from '@garden/core';
import type { TaskPlanRecord } from '@garden/data';
import type { ToolContext } from '../tool-dispatch.js';
import { executePlanTool } from './plan.js';

describe('sealed plan output intent', () => {
  const fixture = () => {
    const key = Buffer.alloc(32, 3);
    let current: TaskPlanRecord | null = null;
    let direction: { id: string; createdAt: string } | undefined;
    const event = vi.fn<
      (input: { payloadCiphertext: Parameters<typeof decryptJson>[0] }) => Promise<{ id: string }>
    >(async () => ({ id: 'event' }));
    const create = vi.fn(async (input: Partial<TaskPlanRecord>) => {
      current = {
        ...input,
        id: 'plan',
        version: (current?.version ?? 0) + 1,
        createdAt: new Date().toISOString()
      } as TaskPlanRecord;
      return current;
    });
    const context = {
      task: {
        id: 'task',
        userId: 'owner',
        workspaceId: 'workspace',
        promptCiphertext: encryptJson({ prompt: 'The owner brief' }, key, 'task-prompt:workspace')
      },
      key,
      state: { messages: [], step: 1, credits: 0 },
      store: {
        getLatestTaskPlan: async () => current,
        listTaskEvents: async () => (direction ? [direction] : []),
        setGeneratedTaskTitle: async () => false,
        createTaskPlan: create,
        appendTaskEvent: event
      }
    } as unknown as ToolContext;
    return {
      context,
      key,
      create,
      event,
      plan: () => current!,
      direction: (id: string, createdAt: string) => {
        direction = { id, createdAt };
      }
    };
  };
  it('preserves output intent through normal progress edits and records it for the owner', async () => {
    const { context, key, plan, event } = fixture();
    const outputs = [
      { kind: 'app', title: 'Maze game', directories: ['maze'], delivery: 'preview' }
    ];
    await executePlanTool(context, {
      id: 'declare',
      name: 'set_plan',
      arguments: { steps: ['Build', 'Verify'], outputs }
    });
    await executePlanTool(context, {
      id: 'advance',
      name: 'set_plan',
      arguments: {
        steps: [
          { title: 'Build', status: 'completed' },
          { title: 'Verify', status: 'in_progress' }
        ]
      }
    });
    const content = decryptJson<{ outputs: unknown; steps: Array<{ status: string }> }>(
      plan().stepsCiphertext,
      key,
      'task-plan:task'
    );
    expect(content.outputs).toEqual(outputs);
    expect(content.steps.map((step) => step.status)).toEqual(['completed', 'in_progress']);
    expect(event).toHaveBeenCalledTimes(2);
    const recorded = event.mock.calls.at(-1)?.[0];
    expect(recorded).toBeDefined();
    expect(
      decryptJson<{ payload: { outputs: unknown } }>(
        recorded!.payloadCiphertext,
        key,
        'task-event:task'
      ).payload.outputs
    ).toEqual(outputs);
  });
  it('seals the typed acknowledgment with its direction and clears obsolete output intent on steering', async () => {
    const fixtureState = fixture();
    fixtureState.direction('first', new Date(0).toISOString());
    const report = {
      title: 'App build',
      acknowledgment: 'I will build the requested app.',
      blocks: []
    };
    await executePlanTool(fixtureState.context, {
      id: 'one',
      name: 'set_plan',
      arguments: {
        steps: [{ title: 'Build', status: 'completed' }],
        outputs: [{ kind: 'app', title: 'App' }],
        presentation: report
      }
    });
    fixtureState.direction('second', new Date(Date.now() + 1000).toISOString());
    const next = {
      title: 'Research notes',
      acknowledgment: 'I will research the new direction.',
      blocks: []
    };
    await executePlanTool(fixtureState.context, {
      id: 'two',
      name: 'set_plan',
      arguments: { steps: ['Build'], presentation: next }
    });
    const sealed = decryptJson<{
      presentation: { directionEventId: string; content: unknown };
      outputs?: unknown;
      steps: Array<{ status: string }>;
    }>(fixtureState.plan().stepsCiphertext, fixtureState.key, 'task-plan:task');
    expect(sealed.presentation).toEqual({ directionEventId: 'second', content: next });
    expect(sealed.outputs).toBeUndefined();
    expect(sealed.steps[0]?.status).toBe('pending');
    await executePlanTool(fixtureState.context, {
      id: 'three',
      name: 'set_plan',
      arguments: { steps: [{ title: 'Build', status: 'in_progress' }] }
    });
    expect(
      decryptJson<{ presentation: unknown }>(
        fixtureState.plan().stepsCiphertext,
        fixtureState.key,
        'task-plan:task'
      ).presentation
    ).toEqual(sealed.presentation);
  });
  it('rejects external and escaped output paths before any plan write', async () => {
    const { context, create } = fixture();
    for (const path of ['../outside', '/etc/passwd', 'https://untrusted.test/result']) {
      await expect(
        executePlanTool(context, {
          id: 'declare',
          name: 'set_plan',
          arguments: {
            steps: ['Build'],
            outputs: [{ kind: 'document', title: 'Report', files: [path] }]
          }
        })
      ).rejects.toThrow();
    }
    expect(create).not.toHaveBeenCalled();
  });
});
