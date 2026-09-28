import path from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireScope } from './auth.js';
import { assertUserDataPath, assertOpenedInPlace, resolveInside, workspacePath } from './files.js';
import { execute, type ExecutionOptions } from './execution.js';

const DocumentRequest = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('read'),
      path: z.string().min(1),
      startPage: z.number().int().min(1).max(10_000),
      endPage: z.number().int().min(1).max(10_000),
      maxCharacters: z.number().int().min(1_000).max(200_000)
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      path: z.string().min(1),
      query: z.string().min(1).max(2_000),
      alternatives: z.array(z.string().min(1).max(500)).max(4),
      maxFiles: z.number().int().min(1).max(2_000),
      fileOffset: z.number().int().min(0).max(1_000_000),
      maxResults: z.number().int().min(1).max(50),
      maxPages: z.number().int().min(1).max(10_000)
    })
    .strict()
]);

/** Document reads share the file tools' path rules and cannot expose the runner's private state. */
export function registerDocumentRoutes(
  app: FastifyInstance,
  workspaceRoot: string,
  options: Omit<ExecutionOptions, 'abortSignal' | 'allowSystemPackages'>,
  run: typeof execute = execute
): void {
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/documents',
    async (request, reply) => {
      requireScope(request, 'files.read');
      const body = DocumentRequest.parse(request.body);
      const root = workspacePath(workspaceRoot, request.params.workspaceId);
      const relative = assertUserDataPath(root, body.path);
      const dataRoot =
        relative === 'workspace' || relative.startsWith('workspace/')
          ? 'workspace'
          : '.garden/artifacts';
      const readerPath =
        path.relative(resolveInside(root, dataRoot), resolveInside(root, relative)) || '.';
      const args = [body.action, '--path', readerPath];
      if (body.action === 'read') {
        if (body.endPage < body.startPage) throw new Error('Invalid page range');
        args.push(
          '--start-page',
          String(body.startPage),
          '--end-page',
          String(body.endPage),
          '--max-chars',
          String(body.maxCharacters)
        );
      } else {
        args.push(
          '--query',
          body.query,
          '--max-files',
          String(body.maxFiles),
          '--file-offset',
          String(body.fileOffset),
          '--max-results',
          String(body.maxResults),
          '--max-pages',
          String(body.maxPages),
          ...body.alternatives.map((value) => `--alternative=${value}`)
        );
      }
      const directory = await open(
        resolveInside(root, dataRoot),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      const controller = new AbortController();
      const closed = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', closed);
      try {
        await assertOpenedInPlace(root, resolveInside(root, dataRoot), directory);
        const result = await run(
          root,
          {
            executable: '/usr/local/lib/garden/garden-document',
            args,
            cwd: dataRoot,
            timeoutSeconds: 300,
            maxOutputBytes: 1024 * 1024
          },
          { ...options, abortSignal: controller.signal, allowSystemPackages: false }
        );
        if (result.exitCode !== 0) return result;
        // Native extraction is confined to the data root; returned references retain the public prefix.
        const payload = JSON.parse(result.stdout) as Record<string, unknown>;
        const prefix = (record: Record<string, unknown>) => {
          if (typeof record.path === 'string') record.path = path.posix.join(dataRoot, record.path);
        };
        prefix(payload);
        for (const key of ['results', 'unread', 'partiallyRead']) {
          if (Array.isArray(payload[key]))
            for (const entry of payload[key]) {
              if (entry && typeof entry === 'object') prefix(entry as Record<string, unknown>);
            }
        }
        return { ...result, stdout: JSON.stringify(payload) };
      } finally {
        reply.raw.removeListener('close', closed);
        await directory.close();
      }
    }
  );
}
