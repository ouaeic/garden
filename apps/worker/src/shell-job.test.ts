import { describe, expect, it, vi } from 'vitest';
import { approvalRequirement } from './approval-policy.js';
import { checkpointInvocation, shellJobExecution } from './shell-job.js';
import { executeWorkspaceTool } from './tools/workspace.js';
import type { ToolContext } from './tool-dispatch.js';
import {
  approvalForCallOnce,
  createApprovalFloorMemo,
  type ApprovalFloorDeps
} from './approval-floor.js';
import type { TaskRecord } from '@garden/data';

const base = {
  executable: 'python3',
  args: ['analysis.py'],
  background: true,
  job: 'Genome analysis'
};

describe('finite job execution and approval floor', () => {
  it('reviews the runner’s stored recovery command once and ignores model-supplied replacements', async () => {
    const lookup = vi.fn(async () => ({
      name: 'Stored job',
      deadlineAt: '2026-09-08T00:00:00.000Z',
      checkpointResume: { executable: 'rm', args: ['-rf', '~/.ssh'] }
    }));
    const deps = {
      runner: { call: lookup },
      destinationContext: () => ({
        knownOrigins: [],
        knownAddresses: [],
        ownerText: '',
        selfOrigins: [],
        spentNoveltyBytes: 0
      })
    } as unknown as ApprovalFloorDeps;
    const task = {
      id: 'task-1',
      workspaceId: 'workspace-1',
      securityMode: 'balanced'
    } as TaskRecord;
    const call = {
      id: 'resume-1',
      name: 'process',
      arguments: { action: 'resume', sessionId: 'job-1', executable: 'echo', args: ['harmless'] }
    };
    const memo = createApprovalFloorMemo();
    const decision = await approvalForCallOnce(deps, memo, task, call);
    expect(decision?.sideEffect).toBe('external_consequential');
    expect(decision?.preview).toContain('~/.ssh');
    expect(decision?.preview).not.toContain('harmless');
    await approvalForCallOnce(deps, memo, task, call);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      'workspace-1',
      'task-1',
      'exec',
      '/v1/workspaces/workspace-1/processes/job-1/recovery'
    );
  });
  it('maps the same recovery command reviewed by the floor into the real workspace dispatch', async () => {
    const args = {
      ...base,
      cwd: 'workspace/project',
      network: true,
      checkpointResumeCommand: 'python3 analysis.py --resume checkpoint.json'
    };
    const call = vi.fn(async (_workspace: string, _task: string, _scope: string, route: string) =>
      route.endsWith('/usage') ? { storageBytes: 1 } : { sessionId: 'job-1', status: 'running' }
    );
    const context = {
      task: { id: 'task-1', userId: 'owner-1', workspaceId: 'workspace-1' },
      state: { step: 0 },
      runner: { call },
      store: { setWorkspaceStorage: vi.fn() }
    } as unknown as ToolContext;
    await executeWorkspaceTool(context, { id: 'call-1', name: 'shell', arguments: args });
    expect(call).toHaveBeenCalledWith(
      'workspace-1',
      'task-1',
      'exec',
      '/v1/workspaces/workspace-1/processes/start',
      expect.objectContaining({
        job: 'Genome analysis',
        checkpointResume: checkpointInvocation(args)
      })
    );
    const sent = call.mock.calls[0] as unknown[];
    expect(sent[4]).not.toHaveProperty('checkpointResumeCommand');
    expect(sent[4]).not.toHaveProperty('background');
  });

  it.each(['review', 'balanced', 'autonomous'] as const)(
    'preserves the strongest floor of both initial and recovery commands in %s mode',
    (mode) => {
      const destructiveRecovery = approvalRequirement(
        'shell',
        { ...base, checkpointResumeCommand: 'rm -rf ~/.ssh' },
        mode
      );
      expect(destructiveRecovery?.sideEffect).toBe('external_consequential');
      expect(destructiveRecovery?.preview).toContain('rm -rf ~/.ssh');
      const destructiveInitial = approvalRequirement(
        'shell',
        {
          ...base,
          executable: 'rm',
          args: ['-rf', '~/.ssh'],
          checkpointResumeCommand: 'python3 analysis.py --resume checkpoint.json'
        },
        mode
      );
      expect(destructiveInitial?.sideEffect).toBe('external_consequential');
      expect(destructiveInitial?.preview).toContain('checkpoint.json');
    }
  );

  it('requires approval for deferred recovery even when the commands are ordinary', () => {
    expect(approvalRequirement('shell', base, 'autonomous')).toBeNull();
    const args = {
      ...base,
      checkpointResumeCommand: 'python3 analysis.py --resume checkpoint.json'
    };
    expect(approvalRequirement('shell', args, 'autonomous')).toMatchObject({
      sideEffect: 'external_reversible'
    });
    expect(
      approvalRequirement('shell', args, 'autonomous', { taintSources: ['page'] })?.sideEffect
    ).toBe('external_consequential');
  });

  it('rejects a raw runner recovery object and ambiguous or foreground finite jobs', () => {
    expect(() =>
      shellJobExecution({
        ...base,
        checkpointResume: { executable: 'rm', args: ['-rf', '~/.ssh'] }
      })
    ).toThrow('checkpointResumeCommand');
    expect(() => shellJobExecution({ ...base, background: false })).toThrow('background=true');
    expect(() => shellJobExecution({ ...base, service: 'server' })).toThrow(
      'cannot also be a service'
    );
    expect(() =>
      shellJobExecution({
        executable: 'python3',
        background: true,
        checkpointResumeCommand: 'echo unreviewed'
      })
    ).toThrow('requires a finite job');
  });
});
