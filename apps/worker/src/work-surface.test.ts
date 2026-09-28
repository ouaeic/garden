import { describe, expect, it, vi } from 'vitest';
import { encryptJson } from '@garden/core';
import type { ToolContext } from './tool-dispatch.js';
import { describeWorkSurface, validateWorkSurface } from './work-surface.js';

function fixture() {
  const key = Buffer.alloc(32, 7);
  const receipt = {
    id: 'receipt',
    taskId: 'task',
    kind: 'tool_result',
    payloadCiphertext: encryptJson(
      {
        __gardenEventVersion: 1,
        payload: { toolCallId: 'measured', result: { samples: [{ seconds: 12.5 }] } }
      },
      key,
      'task-event:task'
    )
  };
  const get = vi.fn(async () => [receipt]);
  const context = {
    task: { id: 'task', userId: 'owner', workspaceId: 'workspace' },
    key,
    state: { turnToolResults: { measured: { eventId: 'receipt' } } },
    store: {
      listTaskEvidenceByIds: get,
      getArtifact: async () => ({ taskId: 'other', workspaceId: 'workspace' })
    }
  } as unknown as ToolContext;
  const content = {
    title: 'Analysis timings',
    acknowledgment: 'I will compare the recorded runtimes.',
    blocks: [
      {
        kind: 'chart',
        title: 'Runtime',
        unit: 'seconds',
        points: [
          { label: 'Sample A', value: { toolCallId: 'measured', pointer: '/samples/0/seconds' } }
        ]
      }
    ]
  };
  return { context, receipt, get, content };
}
describe('task-native reporting authority', () => {
  it('discovers the actual schema and resolves measured numeric values from sealed same-task receipts', async () => {
    expect(describeWorkSurface().presentation.properties).toHaveProperty('blocks');
    const { context, content, get } = fixture();
    const report = await validateWorkSurface(context, content, 'direction');
    expect(report).toEqual({ directionEventId: 'direction', content });
    expect(get).toHaveBeenCalledWith('task', ['receipt']);
  });
  it('rejects unknown calls, foreign task receipts and nonnumeric chart selectors', async () => {
    const { context, receipt, content } = fixture();
    content.blocks[0]!.points[0]!.value.toolCallId = 'invented';
    await expect(validateWorkSurface(context, content, 'direction')).rejects.toThrow(
      'No recorded result'
    );
    content.blocks[0]!.points[0]!.value.toolCallId = 'measured';
    receipt.taskId = 'other';
    await expect(validateWorkSurface(context, content, 'direction')).rejects.toThrow('unavailable');
    receipt.taskId = 'task';
    content.blocks[0]!.points[0]!.value.pointer = '/samples/0';
    await expect(validateWorkSurface(context, content, 'direction')).rejects.toThrow(
      'finite numeric'
    );
  });
  it('refuses mismatched tables, executable extras and unrelated artifact IDs before publishing a report', async () => {
    const { context } = fixture();
    const base = { title: 'Work', acknowledgment: 'I will use the recorded evidence.' };
    await expect(
      validateWorkSurface(
        context,
        {
          ...base,
          blocks: [
            { kind: 'table', title: 'Comparison', columns: ['A', 'B'], rows: [{ cells: ['A'] }] }
          ]
        },
        'direction'
      )
    ).rejects.toThrow('column count');
    await expect(
      validateWorkSurface(
        context,
        { ...base, html: '<script>bad()</script>', blocks: [] },
        'direction'
      )
    ).rejects.toThrow('Unrecognized');
    await expect(
      validateWorkSurface(
        context,
        {
          ...base,
          blocks: [{ kind: 'result', title: 'Report', result: { kind: 'artifact', id: 'foreign' } }]
        },
        'direction'
      )
    ).rejects.toThrow('belong to this task');
  });
});
