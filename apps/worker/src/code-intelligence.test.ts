import { describe, expect, it, vi } from 'vitest';
import { approvalRequirement } from './approval-policy.js';
import { executeToolCall, type ToolContext } from './tool-dispatch.js';
import { agentTools } from './tool-catalogue.js';
import { isMutatingToolCall } from './write-classification.js';

describe('native language-tool authority and dispatch', () => {
  it.each(['review', 'balanced'] as const)(
    'requires explicit native launch approval in %s mode while read actions remain reads',
    (mode) => {
      expect(
        approvalRequirement('code_diagnostics', { action: 'start', language: 'python' }, mode)
      ).toMatchObject({ sideEffect: 'external_reversible' });
      for (const action of ['status', 'definition', 'references', 'diagnostics', 'rename']) {
        expect(
          approvalRequirement('code_diagnostics', { action, language: 'python' }, mode)
        ).toBeNull();
        expect(isMutatingToolCall('code_diagnostics', { action })).toBe(false);
      }
    }
  );
  it('exposes the native tool and sends only action-appropriate capability scope through real dispatch', async () => {
    const tool = agentTools.find((entry) => entry.name === 'code_diagnostics');
    expect(tool).toBeDefined();
    const call = vi.fn(async () => ({ running: true }));
    const context = {
      task: { id: 'task', workspaceId: 'workspace' },
      state: { messages: [], step: 0, credits: 0 },
      runner: { call }
    } as unknown as ToolContext;
    const description = await executeToolCall(context, {
      id: 'help',
      name: 'code_diagnostics',
      arguments: { action: 'describe' }
    });
    expect(description).toMatchObject({
      languages: { python: 'Python' },
      actions: { rename: expect.stringContaining('no files') as unknown },
      options: {
        properties: { line: expect.any(Object) as unknown, newName: expect.any(Object) as unknown }
      }
    });
    expect(call).not.toHaveBeenCalled();
    for (const action of ['start', 'diagnostics', 'rename', 'stop']) {
      await executeToolCall(context, {
        id: action,
        name: 'code_diagnostics',
        arguments: { action, language: 'typescript' }
      });
      expect(call).toHaveBeenLastCalledWith(
        'workspace',
        'task',
        action === 'start' || action === 'stop' ? 'exec' : 'files.read',
        '/v1/workspaces/workspace/code-intelligence',
        { action, language: 'typescript', root: 'workspace' }
      );
    }
    await expect(
      executeToolCall(context, {
        id: 'bad',
        name: 'code_diagnostics',
        arguments: { action: 'executeCommand', language: 'python', command: 'curl evil' }
      })
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(4);
  });
});
