import { CodeIntelligenceRequest } from '@garden/contracts';
import { z } from 'zod';
import type { ModelToolCall } from '@garden/model-gateway';
import type { ToolContext } from '../tool-dispatch.js';
import { recordArtifactWrite } from '../context.js';

export async function executeCodeIntelligenceTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const optionsSchema = CodeIntelligenceRequest.pick({
    root: true,
    line: true,
    column: true,
    newName: true,
    previewId: true,
    paths: true
  });
  if (call.arguments.action === 'describe')
    return {
      languages: {
        typescript: 'TypeScript and JavaScript',
        python: 'Python',
        r: 'R, using the locally installed languageserver package'
      },
      installation: {
        r: 'Install R with the system package tool if missing. Building CRAN dependencies may also need make, C/C++ compilers and libxml2/libuv headers (Debian/Ubuntu: build-essential libxml2-dev libuv1-dev; ICU headers can avoid a bundled ICU build). In the agent shell, use R --vanilla --slave -e to create Sys.getenv("R_LIBS_USER") and install.packages("languageserver", repos="https://cloud.r-project.org", lib=Sys.getenv("R_LIBS_USER")). Installation follows the task permission mode; no hosted account is required.'
      },
      options: z.toJSONSchema(optionsSchema),
      actions: {
        start:
          'Start native code analysis for path under the task permission mode. Sessions are task-scoped and expire when idle.',
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
        apply:
          'Apply a checked preview using its previewId and exact paths. Changed files are refused; per-file receipts are retained across retries.',
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
  const result = await context.runner.call(
    context.task.workspaceId,
    context.task.id,
    request.action === 'apply'
      ? 'files.write'
      : request.action === 'start' || request.action === 'stop'
        ? 'exec'
        : 'files.read',
    `/v1/workspaces/${context.task.workspaceId}/code-intelligence`,
    request
  );
  if (request.action === 'apply') {
    const receipt = z
      .object({
        files: z.array(z.object({ path: z.string(), status: z.string(), sizeBytes: z.number() }))
      })
      .parse(result);
    for (const file of receipt.files) {
      if (file.status !== 'applied') continue;
      context.state.artifactLedger = recordArtifactWrite(context.state.artifactLedger, {
        path: file.path,
        mode: 'edited',
        bytes: file.sizeBytes,
        step: context.state.step
      });
    }
    try {
      const usage = await context.runner.call<{ storageBytes: number }>(
        context.task.workspaceId,
        context.task.id,
        'files.read',
        `/v1/workspaces/${context.task.workspaceId}/usage`
      );
      await context.store.setWorkspaceStorage(
        context.task.userId,
        context.task.workspaceId,
        usage.storageBytes
      );
    } catch {
      return {
        ...(result as object),
        warning: 'Storage accounting could not refresh; the edit receipts remain valid.'
      };
    }
  }
  return result;
}
