import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@garden/data';
import type { AgentRunnerClient } from './runner-client.js';
import { workflowApproval } from './workflow-approval.js';
import * as Policy from './approval-policy.js';
import { executeToolCall, type ToolContext } from './tool-dispatch.js';
import { isMutatingToolCall } from './write-classification.js';
const task = {
  id: 'task',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  securityMode: 'autonomous'
} as TaskRecord;
const id = '11111111-1111-4111-8111-111111111112';
const stored = {
  ownerTaskId: task.id,
  workspaceId: task.workspaceId,
  name: 'Read counts',
  script: 'workspace/count.nf',
  configs: ['workspace/resources.config'],
  parameters: { sample: 'a' },
  network: false
};
afterEach(() => vi.restoreAllMocks());
describe('workflow discovery and execution floor', () => {
  it('discovers a schema without execution and dispatches stable mutations separately from reads', async () => {
    const call = vi.fn(async () => ({})),
      context = { task, runner: { call } } as unknown as ToolContext;
    expect(
      await executeToolCall(context, {
        id: 'describe',
        name: 'process',
        arguments: { action: 'describe' }
      })
    ).toMatchObject({ workflow: { options: expect.any(Object) as unknown } });
    expect(call).not.toHaveBeenCalled();
    for (const action of ['list', 'status', 'start', 'resume', 'cancel']) {
      const options =
        action === 'start'
          ? { action, name: 'counts', script: 'count.nf' }
          : action === 'list'
            ? { action }
            : { action, workflowId: id };
      await executeToolCall(context, {
        id: `request-${action}`,
        name: 'process',
        arguments: { action: 'workflow', options }
      });
      const read = ['list', 'status'].includes(action);
      expect(call).toHaveBeenLastCalledWith(
        task.workspaceId,
        task.id,
        read ? 'files.read' : 'exec',
        `/v1/workspaces/${task.workspaceId}/workflows`,
        expect.objectContaining({
          request: expect.objectContaining({ action }) as unknown,
          ...(!read ? { requestId: `request-${action}` } : {})
        }) as unknown
      );
      expect(isMutatingToolCall('process', { action: 'workflow', options })).toBe(!read);
    }
  });
  it.each(['review', 'balanced', 'autonomous'] as const)(
    'does not bypass resolution in %s',
    (mode) => {
      expect(
        Policy.approvalRequirement(
          'process',
          { action: 'workflow', options: { action: 'start' } },
          mode
        )
      ).toMatchObject({ sideEffect: 'external_consequential' });
      expect(
        Policy.approvalRequirement(
          'process',
          { action: 'workflow', options: { action: 'status' } },
          mode
        )
      ).toBeNull();
    }
  );
  it('classifies the stored pipeline and refuses a forged owner', async () => {
    const call = vi.fn(async () => stored),
      runner = { call } as unknown as AgentRunnerClient,
      classified = vi.spyOn(Policy, 'approvalRequirement');
    const request = {
      id: 'resume',
      name: 'process',
      arguments: {
        action: 'workflow',
        options: { action: 'resume', workflowId: id, parameters: { sample: 'b' } }
      }
    };
    const result = await workflowApproval(runner, task, request, {});
    expect(result).toMatchObject({ action: 'Resume Read counts' });
    expect(classified).toHaveBeenCalledWith(
      'shell',
      expect.objectContaining({
        executable: '/usr/bin/env',
        network: false,
        args: expect.arrayContaining([
          'workspace/count.nf',
          'workspace/resources.config',
          '{"sample":"b"}'
        ]) as unknown
      }) as unknown,
      'autonomous',
      {}
    );
    call.mockResolvedValueOnce({ ...stored, ownerTaskId: 'other' });
    await expect(workflowApproval(runner, task, request, {})).rejects.toThrow('ownership');
    expect(classified).toHaveBeenCalledTimes(1);
  });
});
