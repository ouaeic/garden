import { workflowDescription } from './workflow.js';
import { debuggerDescription } from './debugger.js';
import { ComputationRequest } from '@athanor/contracts';
import { z } from 'zod';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { ToolContext } from '../tool-dispatch.js';

export function computationRequest(args: Record<string, unknown>): ComputationRequest {
  return ComputationRequest.parse({
    ...z.record(z.string(), z.unknown()).parse(args.options ?? {}),
    ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {})
  });
}
export async function executeComputationTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  if (call.arguments.action === 'describe')
    return {
      terminal:
        'shell pty=true allocates an interactive terminal with combined stdout/stderr. It uses the same sandbox, job supervision and approval floor. process write sends exact input (include a newline to submit); resize takes options.columns/rows. Poll before writing. Use a human computer handoff for private credentials. Wait only after all input is supplied.',
      debugger: debuggerDescription(),
      workflow: workflowDescription(),
      options: z.toJSONSchema(ComputationRequest),
      actions: {
        start:
          'Start an approved task-scoped Python, R or JavaScript interpreter with explicit lifetimeSeconds. Filesystem confined, network disabled; use governed tools for downloads/installations. Requires the native sandbox. R also requires jsonlite; rLibraryPaths may name its workspace library directories.',
        cell: 'Execute code in the retained session. Use a unique stable cellId; retries never replay an accepted cell. Values remain server-side. Results return quickly or as a running handle; status reads cached outputs without executing code. Declare inputs as workspace file paths to capture bounded pre-execution hashes (include dependency lockfiles). Receipts include source/request hashes, interpreter identity and the previous cell; they do not capture all dependencies or freeze files.',
        list: 'List this task’s sessions.',
        status: 'Read cached session state, variables and latest cell receipt.',
        interrupt:
          'Interrupt the active cell. Acknowledged interrupts retain values; otherwise the interpreter is stopped and state is reported lost.',
        stop: 'End the session and discard in-memory values.',
        checkpoint:
          'Save selected JSON-serializable variables to a new workspace path. R preserves data vectors, matrices, data frames, factors and their attributes as typed JSON. No pickle, RDS or arbitrary serialization hooks.',
        restore:
          'Restore an explicit JSON checkpoint into an idle session of the same language; source cells are never replayed.'
      },
      examples: [
        {
          action: 'compute',
          options: {
            action: 'start',
            language: 'python',
            name: 'Expression analysis',
            lifetimeSeconds: 86400
          }
        },
        {
          action: 'compute',
          sessionId: '<sessionId>',
          options: { action: 'cell', cellId: 'summary-1', code: 'values = [2,3,5]\nsum(values)' }
        },
        { action: 'compute', sessionId: '<sessionId>', options: { action: 'status' } },
        {
          action: 'compute',
          sessionId: '<sessionId>',
          options: {
            action: 'cell',
            cellId: 'plot-1',
            code: "garden.plot({title:'Counts',points:[[0,2],[1,3],[2,5]]})"
          }
        }
      ],
      plots:
        'Python: return a matplotlib Figure as the last expression for a PNG (when matplotlib is installed). R: visible final values print, and default plotting devices produce PNGs. Variable inspection lists names without forcing delayed or active bindings. JavaScript: garden.plot({title,xLabel,yLabel,points:[[x,y],...]}) produces a safe SVG artifact. Artifacts are source-linked; no HTML or tool bridge runs inside the session.',
      continuity:
        'Values survive cells and turns until the declared deadline. Cancellation or explicit stop ends the session. Runner restart loses memory and never replays cells; use explicit file checkpoints for recovery.'
    };
  const body = computationRequest(call.arguments);
  return context.runner.call(
    context.task.workspaceId,
    context.task.id,
    ['list', 'status'].includes(body.action) ? 'files.read' : 'exec',
    `/v1/workspaces/${context.task.workspaceId}/computation`,
    body
  );
}
