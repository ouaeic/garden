import { WorkflowStart } from '@athanor/contracts';
import { z } from 'zod';
import type { TaskRecord } from '@athanor/data';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { AgentApprovalRequirement } from './approval-state.js';
import type { AgentRunnerClient } from './runner-client.js';
import { approvalRequirement, type ApprovalContext } from './approval-policy.js';
import { workflowRequest } from './tools/workflow.js';

const Stored = WorkflowStart.omit({ action: true }).extend({
  ownerTaskId: z.string(),
  workspaceId: z.string()
});
export async function workflowApproval(
  runner: AgentRunnerClient,
  task: TaskRecord,
  call: ModelToolCall,
  context: ApprovalContext
): Promise<AgentApprovalRequirement | null> {
  const body = workflowRequest(call.arguments);
  if (body.action === 'list' || body.action === 'status') return null;
  const spec =
    body.action === 'start'
      ? body
      : Stored.parse(
          await runner.call(
            task.workspaceId,
            task.id,
            'files.read',
            `/v1/workspaces/${task.workspaceId}/workflows/${body.workflowId}/plan`
          )
        );
  if (
    'ownerTaskId' in spec &&
    (spec.ownerTaskId !== task.id || spec.workspaceId !== task.workspaceId)
  )
    throw new Error('Workflow ownership mismatch');
  if (body.action === 'cancel')
    return {
      sideEffect: 'external_reversible',
      action: `Stop ${spec.name}`,
      preview:
        'Stop this workflow and its child processes. Completed files and cached stages remain available.'
    };
  const parameters =
    body.action === 'resume' ? { ...spec.parameters, ...body.parameters } : spec.parameters;
  const classified = approvalRequirement(
    'shell',
    {
      executable: '/usr/bin/env',
      args: [
        'NXF_DISABLE_CHECK_LATEST=true',
        '/usr/local/bin/nextflow',
        'run',
        spec.script,
        ...spec.configs.flatMap((config) => ['-c', config]),
        '-params',
        JSON.stringify(parameters)
      ],
      cwd: 'workspace',
      network: spec.network
    },
    task.securityMode,
    context
  );
  return {
    sideEffect:
      classified?.sideEffect === 'external_consequential' || context.taintSources?.length
        ? 'external_consequential'
        : 'external_reversible',
    action: `${body.action === 'resume' ? 'Resume' : 'Start'} ${spec.name}`,
    preview:
      `Run ${spec.script} as a durable workflow with ${spec.network ? 'network access' : 'network disabled'}. ${body.action === 'resume' ? 'Reuse eligible cached stages.' : 'Record stage outcomes and retain work files.'} ${spec.configs.length} explicit configuration files; ${Object.keys(parameters).length} parameters.`.trim()
  };
}
