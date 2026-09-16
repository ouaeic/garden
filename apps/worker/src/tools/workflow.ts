import { WorkflowRequest } from '@athanor/contracts';
import { z } from 'zod';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { ToolContext } from '../tool-dispatch.js';

export const workflowRequest = (args: Record<string, unknown>): WorkflowRequest =>
  WorkflowRequest.parse(args.options);
export const workflowDescription = () => ({
  options: z.toJSONSchema(WorkflowRequest),
  purpose:
    'Run a project Nextflow pipeline as a durable finite job. Optional local Nextflow and Java installation required. Use for dependency graphs, scatter/gather, stage caches and explicit resume. Use shell jobs for a single long command.',
  execution:
    'process(action=workflow, options={action:start,name,script,configs?,parameters?,network?}). Script/config paths are project files. Relative input parameters resolve from the run directory; use absolute workspace input paths or projectDir in the script. Network defaults off. Config files are executable code and follow the same approval floor as commands. No automatic deadline.',
  progress:
    'Returns workflowId, sessionId, paths and observed stage outcomes. process(wait, sessionIds=[sessionId]) releases this turn until the attempt ends. Status/list only read receipts and bounded trace records; they never launch work. A trace does not know the final number of dynamic tasks.',
  recovery:
    'Resume explicitly with workflowId and optional changed parameters. Completed unchanged stages may be cached; changed inputs or code invalidate their dependents. Keep both the cache and work directories. Lost launch replies are reconciled without repeating a command. Cancel stops the job and children; wait for exit before resuming.',
  verification:
    'Inspect failed stage exit codes and logs. Independently validate final scientific results. Engine completion is not scientific validation.'
});
export async function executeWorkflowTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const request = workflowRequest(call.arguments),
    read = ['list', 'status'].includes(request.action);
  return context.runner.call(
    context.task.workspaceId,
    context.task.id,
    read ? 'files.read' : 'exec',
    `/v1/workspaces/${context.task.workspaceId}/workflows`,
    { request, ...(!read ? { requestId: call.id } : {}) }
  );
}
