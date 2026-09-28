import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@garden/data';
import type { AgentRunnerClient } from './runner-client.js';
import { debuggerApproval } from './debugger-approval.js';
import { approvalRequirement } from './approval-policy.js';
import { executeToolCall, type ToolContext } from './tool-dispatch.js';
import { isMutatingToolCall } from './write-classification.js';
const task = { id: 'task', workspaceId: 'workspace', securityMode: 'autonomous' } as TaskRecord;
const stored = {
  sessionId: 'debug-11111111-1111-4111-8111-111111111111',
  taskId: task.id,
  workspaceId: task.workspaceId,
  language: 'python',
  program: 'workspace/main.py',
  cwd: 'workspace',
  state: 'stopped',
  stopEpoch: 2,
  createdAt: '2026-09-06',
  deadlineAt: '2026-09-06',
  updatedAt: '2026-09-06',
  frames: [],
  variables: [],
  excludedFrames: 0,
  reason: 'breakpoint',
  output: '',
  note: null
};
describe('native debugger authority', () => {
  it('discovers the bounded contract without execution and reads status without execution scope', async () => {
    const call = vi.fn(async () => stored),
      context = { task, runner: { call }, consequentialApproved: false } as unknown as ToolContext;
    expect(
      await executeToolCall(context, {
        id: 'd',
        name: 'process',
        arguments: { action: 'describe' }
      })
    ).toMatchObject({
      debugger: { options: { properties: { epoch: expect.any(Object) as unknown } } }
    });
    expect(call).not.toHaveBeenCalled();
    await executeToolCall(context, {
      id: 's',
      name: 'process',
      arguments: { action: 'debug', sessionId: stored.sessionId, options: { action: 'status' } }
    });
    expect(call).toHaveBeenLastCalledWith(
      task.workspaceId,
      task.id,
      'files.read',
      `/v1/workspaces/${task.workspaceId}/debugger`,
      expect.objectContaining({ action: 'status' }) as unknown
    );
    expect(isMutatingToolCall('process', { action: 'debug', options: { action: 'status' } })).toBe(
      false
    );
    await expect(
      executeToolCall(context, {
        id: 'e',
        name: 'process',
        arguments: {
          action: 'debug',
          sessionId: stored.sessionId,
          options: { action: 'evaluate', epoch: 2, frameId: 1, expression: 'answer' }
        }
      })
    ).rejects.toThrow('explicit approval');
    expect(call).toHaveBeenCalledOnce();
  });
  it.each(['review', 'balanced', 'autonomous'] as const)(
    'requires live execution and inspection approval in %s mode',
    async (mode) => {
      const runner = { call: vi.fn(async () => stored) } as unknown as AgentRunnerClient;
      for (const action of [
        'variables',
        'evaluate',
        'continue',
        'next',
        'stepIn',
        'stepOut',
        'stop',
        'breakpoints'
      ]) {
        const options = {
          action,
          epoch: 2,
          frameId: 1,
          variablesReference: 2,
          expression: 'answer',
          path: 'workspace/main.py',
          breakpoints: [{ line: 2, condition: 'f()' }]
        };
        const call = {
          id: action,
          name: 'process',
          arguments: { action: 'debug', sessionId: stored.sessionId, options }
        };
        expect(approvalRequirement('process', call.arguments, mode)).toMatchObject({
          sideEffect: 'external_consequential'
        });
        expect(
          await debuggerApproval(runner, { ...task, securityMode: mode }, call, {})
        ).toMatchObject({ sideEffect: 'external_consequential' });
      }
    }
  );
  it('uses runner-stored program identity and refuses another task’s session', async () => {
    const call = vi.fn(async () => stored),
      runner = { call } as unknown as AgentRunnerClient;
    const request = {
      id: 'e',
      name: 'process',
      arguments: {
        action: 'debug',
        sessionId: stored.sessionId,
        options: {
          action: 'evaluate',
          epoch: 2,
          frameId: 1,
          expression: 'answer',
          program: 'forged.py',
          cwd: 'workspace/forged'
        }
      }
    };
    const approval = await debuggerApproval(runner, task, request, {});
    expect(approval?.preview).toContain('workspace/main.py');
    expect(approval?.preview).not.toContain('forged');
    call.mockResolvedValue({ ...stored, taskId: 'other' });
    await expect(debuggerApproval(runner, task, request, {})).rejects.toThrow('ownership mismatch');
  });
});
