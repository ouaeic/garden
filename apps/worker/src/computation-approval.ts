import { ComputationSessionSchema } from '@garden/contracts';
import type { TaskRecord } from '@garden/data';
import type { ModelToolCall } from '@garden/model-gateway';
import type { AgentApprovalRequirement } from './approval-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';
import { computationRequest } from './tools/computation.js';

export async function computationApproval(
  runner: AgentRunnerClient,
  task: TaskRecord,
  call: ModelToolCall,
  context: ApprovalContext
): Promise<AgentApprovalRequirement | null> {
  const body = computationRequest(call.arguments);
  if (['list', 'status'].includes(body.action)) return null;
  if (body.action === 'start') {
    // Startup is a fixed program; the runner refuses it without native filesystem/network isolation.
    if (task.securityMode === 'autonomous') return null;
    return {
      sideEffect: context.taintSources?.length ? 'external_consequential' : 'external_reversible',
      action: `Start ${body.language ?? 'native'} computation`,
      preview: `Start a task-scoped ${body.language ?? 'unspecified'} interpreter in ${body.cwd}. Lifetime: ${body.lifetimeSeconds ?? 3600}s. Filesystem confined and network disabled. Values remain until stopped or expired. A controller or machine failure can lose memory; cells never replay automatically.`
    };
  }
  if (!body.sessionId) throw Error('Computation action requires sessionId');
  const stored = ComputationSessionSchema.parse(
    await runner.call(
      task.workspaceId,
      task.id,
      'files.read',
      `/v1/workspaces/${task.workspaceId}/computation`,
      { action: 'status', sessionId: body.sessionId }
    )
  );
  if (stored.taskId !== task.id || stored.workspaceId !== task.workspaceId)
    throw Error('Computation session ownership mismatch');
  if (['interrupt', 'stop'].includes(body.action)) {
    if (task.securityMode === 'autonomous') return null;
    return {
      sideEffect: 'external_reversible',
      action: `${body.action === 'stop' ? 'Stop' : 'Interrupt'} ${stored.name}`,
      preview: `${body.action === 'stop' ? 'Discard the retained values and stop this interpreter.' : 'Interrupt the current cell; state is preserved only if the interpreter acknowledges it.'} Session ${stored.sessionId}, ${stored.language}, ${stored.cwd}.`
    };
  }
  if (body.action === 'extend') {
    if (!body.lifetimeSeconds) throw Error('Extension requires total lifetimeSeconds');
    const deadline = new Date(
      Date.parse(stored.createdAt) + body.lifetimeSeconds * 1000
    ).toISOString();
    if (task.securityMode === 'autonomous') return null;
    return {
      sideEffect: 'external_reversible',
      action: `Extend ${stored.name}`,
      preview: `Keep this task's retained ${stored.language} session until ${deadline}. Current deadline ${stored.deadlineAt}. The active cell's timeout and existing filesystem/network confinement do not change. Session ${stored.sessionId}, ${stored.cwd}.`
    };
  }
  const classified =
    body.action === 'cell'
      ? approvalRequirement(
          'shell',
          {
            executable: { python: 'python3', javascript: 'node', r: 'Rscript' }[stored.language],
            args: [stored.language === 'python' ? '-c' : '-e', body.code ?? ''],
            cwd: stored.cwd,
            network: false
          },
          task.securityMode,
          context
        )
      : null;
  if (task.securityMode === 'autonomous' && !classified) return null;
  return {
    sideEffect:
      classified?.sideEffect === 'external_consequential' || context.taintSources?.length
        ? 'external_consequential'
        : 'external_reversible',
    action:
      body.action === 'cell'
        ? `Run a ${stored.language} cell in ${stored.name}`
        : `${body.action === 'checkpoint' ? 'Save' : 'Restore'} a JSON computation checkpoint`,
    preview: `${classified?.preview ?? (body.action === 'cell' ? body.code : JSON.stringify({ path: body.path, variables: body.variables }))}\nStored session: ${stored.sessionId}, ${stored.language}, cwd ${stored.cwd}. Filesystem confined; network disabled. Deadline ${stored.deadlineAt}. Each stable cellId executes at most once.`
  };
}
