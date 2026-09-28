import { DebuggerRequest } from '@garden/contracts';
import { z } from 'zod';
import type { ModelToolCall } from '@garden/model-gateway';
import type { ToolContext } from '../tool-dispatch.js';
export function debuggerRequest(args: Record<string, unknown>): DebuggerRequest {
  return DebuggerRequest.parse({
    ...z.record(z.string(), z.unknown()).parse(args.options ?? {}),
    ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {})
  });
}
export function debuggerDescription(): unknown {
  return {
    options: z.toJSONSchema(DebuggerRequest),
    usage:
      'Use process action=debug with these options. Fixed Python and JavaScript adapters launch a workspace program under the native sandbox with network disabled. No PID/port attach, arbitrary adapter, terminal reverse requests, or external source reads.',
    lifecycle:
      'Launch has an explicit lifetimeSeconds. Breakpoints may be included at launch or replaced by file. The session is owned by this task; restart loses runtime state and never replays execution.',
    inspection:
      'status and list read cached state only. At stopped state use its current stopEpoch as epoch: stack yields source-linked frame IDs; scopes yields variable references. Variables and evaluate execute live representations or expressions and require explicit approval. References expire on resume; refresh status after continue, next, stepIn or stepOut. Stop ends the program.',
    example: {
      action: 'debug',
      options: {
        action: 'launch',
        language: 'python',
        program: 'workspace/main.py',
        breakpoints: [{ line: 12 }],
        lifetimeSeconds: 600
      }
    }
  };
}
export async function executeDebuggerTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const body = debuggerRequest(call.arguments);
  if (
    !['list', 'status', 'stack', 'scopes'].includes(body.action) &&
    !context.consequentialApproved
  )
    throw Error('Live debug operations require explicit approval');
  return context.runner.call(
    context.task.workspaceId,
    context.task.id,
    ['list', 'status'].includes(body.action) ? 'files.read' : 'exec',
    `/v1/workspaces/${context.task.workspaceId}/debugger`,
    body
  );
}
