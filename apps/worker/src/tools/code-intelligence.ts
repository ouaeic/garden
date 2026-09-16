import { CodeIntelligenceRequest } from '@athanor/contracts';
import { z } from 'zod';
import type { ModelToolCall } from '@athanor/model-gateway';
import type { ToolContext } from '../tool-dispatch.js';

export async function executeCodeIntelligenceTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const optionsSchema = CodeIntelligenceRequest.pick({
    root: true,
    line: true,
    column: true,
    newName: true
  });
  if (call.arguments.action === 'describe')
    return {
      languages: { typescript: 'TypeScript and JavaScript', python: 'Python' },
      options: z.toJSONSchema(optionsSchema),
      actions: {
        start:
          'Start the bundled language server for path under the task permission mode. Sessions are task-scoped and expire when idle.',
        status: 'Read the session for path without launching anything.',
        stop: 'Stop the session for path.',
        diagnostics: 'Read native typed diagnostics for file path.',
        definition: 'Find the symbol definition at one-based line and UTF-16 column.',
        references: 'Find source-linked references at line and column.',
        hover: 'Read type and documentation at line and column.',
        symbols: 'Read the structural outline of file path.',
        implementation: 'Find implementations at line and column.',
        type_definition: 'Find type definitions at line and column.',
        code_actions: 'Preview available fixes at line and column; commands are never executed.',
        rename:
          'Preview source-linked rename edits to newName with source hashes; no files are changed.'
      },
      examples: [
        { action: 'start', language: 'python', path: 'workspace/project' },
        {
          action: 'definition',
          language: 'python',
          path: 'workspace/project/main.py',
          options: { root: 'workspace/project', line: 1, column: 5 }
        }
      ]
    };
  const options = optionsSchema.parse(call.arguments.options ?? {});
  const lifecycle = ['start', 'stop', 'status'].includes(String(call.arguments.action));
  const request = CodeIntelligenceRequest.parse({
    ...options,
    action: call.arguments.action,
    language: call.arguments.language,
    root: lifecycle
      ? typeof call.arguments.path === 'string'
        ? call.arguments.path
        : 'workspace'
      : options.root,
    ...(!lifecycle && typeof call.arguments.path === 'string' ? { path: call.arguments.path } : {})
  });
  return context.runner.call(
    context.task.workspaceId,
    context.task.id,
    request.action === 'start' || request.action === 'stop' ? 'exec' : 'files.read',
    `/v1/workspaces/${context.task.workspaceId}/code-intelligence`,
    request
  );
}
