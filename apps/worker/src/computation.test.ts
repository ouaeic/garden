import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@athanor/data';
import type { AgentRunnerClient } from './runner-client.js';
import { computationApproval } from './computation-approval.js';
import * as ApprovalPolicy from './approval-policy.js';
import { approvalRequirement } from './approval-policy.js';
import { executeToolCall, type ToolContext } from './tool-dispatch.js';
import { isMutatingToolCall } from './write-classification.js';
const task = {
  id: 'task',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  securityMode: 'autonomous'
} as TaskRecord;
const stored = {
  sessionId: 'kernel-11111111-1111-4111-8111-111111111111',
  taskId: task.id,
  workspaceId: task.workspaceId,
  name: 'Analysis',
  language: 'python',
  cwd: 'workspace/analysis',
  state: 'idle',
  createdAt: '2026-09-06T10:00:00.000Z',
  deadlineAt: '2026-09-07T10:00:00.000Z',
  stateRetained: true,
  variables: []
};
afterEach(() => vi.restoreAllMocks());
describe('native computation authority and discovery', () => {
  it('discovers controls without launching a process and uses read scopes for cached state', async () => {
    const call = vi.fn(async () => ({}));
    const context = { task, runner: { call } } as unknown as ToolContext;
    expect(
      await executeToolCall(context, {
        id: 'describe',
        name: 'process',
        arguments: { action: 'describe' }
      })
    ).toMatchObject({
      options: { properties: { cellId: expect.any(Object) as unknown } },
      actions: { checkpoint: expect.any(String) as unknown }
    });
    expect(call).not.toHaveBeenCalled();
    for (const action of ['status', 'list', 'start', 'cell', 'checkpoint', 'extend', 'stop']) {
      await executeToolCall(context, {
        id: action,
        name: 'process',
        arguments: { action: 'compute', sessionId: stored.sessionId, options: { action } }
      });
      expect(call).toHaveBeenLastCalledWith(
        task.workspaceId,
        task.id,
        ['list', 'status'].includes(action) ? 'files.read' : 'exec',
        `/v1/workspaces/${task.workspaceId}/computation`,
        { action, sessionId: stored.sessionId, cwd: 'workspace' }
      );
      expect(isMutatingToolCall('process', { action: 'compute', options: { action } })).toBe(
        !['list', 'status'].includes(action)
      );
    }
    expect(isMutatingToolCall('process', { action: 'describe' })).toBe(false);
  });
  it.each(['review', 'balanced', 'autonomous'] as const)(
    'never bypasses the stored-session floor in %s mode',
    (mode) => {
      expect(
        approvalRequirement(
          'process',
          { action: 'compute', options: { action: 'cell', code: '42' } },
          mode
        )
      ).toMatchObject({ sideEffect: 'external_consequential' });
      expect(approvalRequirement('process', { action: 'describe' }, mode)).toBeNull();
      expect(
        approvalRequirement('process', { action: 'compute', options: { action: 'status' } }, mode)
      ).toBeNull();
    }
  );
  it('classifies the real stored interpreter and cwd and rejects forged session ownership', async () => {
    const call = vi.fn(async () => stored),
      runner = { call } as unknown as AgentRunnerClient;
    const classification = vi.spyOn(ApprovalPolicy, 'approvalRequirement');
    const result = await computationApproval(
      runner,
      task,
      {
        id: 'cell',
        name: 'process',
        arguments: {
          action: 'compute',
          sessionId: stored.sessionId,
          options: {
            action: 'cell',
            cellId: 'cell',
            language: 'javascript',
            cwd: 'workspace/forged',
            code: 'print(42)'
          }
        }
      },
      {}
    );
    expect(classification).toHaveBeenCalledWith(
      'shell',
      {
        executable: 'python3',
        args: ['-c', 'print(42)'],
        cwd: 'workspace/analysis',
        network: false
      },
      'autonomous',
      {}
    );
    expect(result).toMatchObject({ action: 'Run a python cell in Analysis' });
    expect(result?.preview).toContain('workspace/analysis');
    expect(result?.preview).not.toContain('workspace/forged');
    expect(call).toHaveBeenCalledExactlyOnceWith(
      task.workspaceId,
      task.id,
      'files.read',
      `/v1/workspaces/${task.workspaceId}/computation`,
      { action: 'status', sessionId: stored.sessionId }
    );
    call.mockResolvedValue({ ...stored, taskId: 'other' });
    await expect(
      computationApproval(
        runner,
        task,
        {
          id: 'bad',
          name: 'process',
          arguments: {
            action: 'compute',
            sessionId: stored.sessionId,
            options: { action: 'cell', code: '42' }
          }
        },
        {}
      )
    ).rejects.toThrow('ownership mismatch');
  });
  it('classifies R code using the stored R interpreter and keeps extension in the ownership floor', async () => {
    const runner = {
      call: vi.fn(async () => ({ ...stored, language: 'r' }))
    } as unknown as AgentRunnerClient;
    const classify = vi.spyOn(ApprovalPolicy, 'approvalRequirement');
    await computationApproval(
      runner,
      task,
      {
        id: 'r',
        name: 'process',
        arguments: {
          action: 'compute',
          sessionId: stored.sessionId,
          options: { action: 'cell', cellId: 'one', code: 'sum(c(2,3,5))' }
        }
      },
      {}
    );
    expect(classify).toHaveBeenCalledWith(
      'shell',
      expect.objectContaining({ executable: 'Rscript', args: ['-e', 'sum(c(2,3,5))'] }),
      'autonomous',
      {}
    );
    const result = await computationApproval(
      runner,
      task,
      {
        id: 'extend',
        name: 'process',
        arguments: {
          action: 'compute',
          sessionId: stored.sessionId,
          options: { action: 'extend', lifetimeSeconds: 172800 }
        }
      },
      {}
    );
    expect(result).toMatchObject({ sideEffect: 'external_reversible', action: 'Extend Analysis' });
    expect(result?.preview).toContain('2026-09-08T10:00:00.000Z');
    expect(result?.preview).toContain(stored.sessionId);
  });
  it('requires launch approval even in autonomous mode and preserves taint strength', async () => {
    const runner = { call: vi.fn() } as unknown as AgentRunnerClient;
    const call = {
      id: 'start',
      name: 'process',
      arguments: { action: 'compute', options: { action: 'start', language: 'python' } }
    };
    expect(await computationApproval(runner, task, call, {})).toMatchObject({
      sideEffect: 'external_reversible'
    });
    expect(await computationApproval(runner, task, call, { taintSources: ['web'] })).toMatchObject({
      sideEffect: 'external_consequential'
    });
  });
});
