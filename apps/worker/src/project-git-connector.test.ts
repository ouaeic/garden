import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ToolContext } from './tool-dispatch.js';
import { executeConnectorTool } from './tools/connectors.js';
import { executeProjectGitConnector } from './project-git-connector.js';
import { approvalRequirement } from './approval-policy.js';

it('uses a stable project-bound transfer identity and leaves pushes inside the approval floor', async () => {
  const task = { id: randomUUID(), workspaceId: randomUUID(), projectId: randomUUID() };
  const invoke = vi.fn(async () => ({ state: 'running' }));
  const context = { task, state: { turn: 3 }, runner: { call: invoke } } as unknown as ToolContext;
  const connectorId = randomUUID();
  const input = {
    action: 'github_git_push' as const,
    repositoryId: randomUUID(),
    revisionId: randomUUID(),
    owner: 'owner',
    repository: 'source',
    branch: 'release',
    commit: 'a'.repeat(40),
    expectedHead: 'b'.repeat(40)
  };
  const call = {
    id: 'stable-call',
    name: 'connector_action',
    arguments: { connectorId, action: input.action, input }
  };
  for (const mode of ['autonomous', 'balanced', 'review'] as const) {
    const card = approvalRequirement(call.name, call.arguments, mode);
    expect(card?.sideEffect).toBe('external_reversible');
    expect(card?.preview).toContain(input.commit);
    expect(card?.preview).toContain(input.expectedHead);
    expect(card?.preview).toContain(input.branch);
  }
  const first = await executeProjectGitConnector(
    context,
    call,
    connectorId,
    { token: 'private-token' },
    input
  );
  await executeProjectGitConnector(context, call, connectorId, { token: 'private-token' }, input);
  expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);
  expect(invoke).toHaveBeenCalledWith(
    task.workspaceId,
    task.id,
    'project.git.push',
    expect.stringContaining(task.projectId),
    expect.objectContaining({
      action: 'start',
      credential: 'private-token',
      input: expect.objectContaining({
        requestId: expect.any(String) as unknown,
        connectorId,
        commit: input.commit
      }) as unknown
    })
  );
  expect(JSON.stringify(first)).not.toContain('private-token');
  await expect(
    executeProjectGitConnector(
      { ...context, task: { ...task, parentMissionId: randomUUID() } } as ToolContext,
      call,
      connectorId,
      { token: 'private-token' },
      input
    )
  ).rejects.toThrow('project conversation');
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('refuses disabled connections before opening their credentials or executing a call', async () => {
  const invoke = vi.fn();
  const context = {
    task: { userId: randomUUID() },
    store: { getConnector: async () => ({ enabled: false }) },
    runner: { call: invoke }
  } as unknown as ToolContext;
  await expect(
    executeConnectorTool(context, {
      id: 'disabled',
      name: 'connector_action',
      arguments: { connectorId: randomUUID(), action: 'github_git_fetch', input: {} }
    })
  ).rejects.toThrow('unavailable');
  expect(invoke).not.toHaveBeenCalled();
});
