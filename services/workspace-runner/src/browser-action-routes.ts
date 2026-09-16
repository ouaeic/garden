import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BrowserAction } from '@athanor/contracts';
import type { BrowserManager } from './browser.js';
import { BrowserActionJournal, type BrowserActionProgress } from './browser-action-journal.js';
import { requireScope } from './auth.js';
import { workspacePath, ensureWorkspace } from './files.js';
import { assertHostStorageWrite, type HostStorage } from './host-storage.js';

/** Whether a browser action, or any step of a batch, writes a file into the workspace. */
const writesWorkspaceFile = (action: BrowserAction): boolean =>
  action.type === 'batch'
    ? action.actions.some((step) => step.type === 'screenshot')
    : action.type === 'screenshot';

export function registerBrowserActionRoutes(
  app: FastifyInstance,
  workspaceRoot: string,
  browser: Pick<BrowserManager, 'act'>,
  secret: string,
  probeHostStorage: (root: string) => Promise<HostStorage>
) {
  const browserJournal = new BrowserActionJournal(secret);
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/action',
    async (request) => {
      requireScope(request, 'browser.control');
      const root = workspacePath(workspaceRoot, request.params.workspaceId);
      await ensureWorkspace(root);
      const envelope = z
        .object({
          requestId: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional()
        })
        .passthrough()
        .parse(request.body);
      const { requestId, ...input } = envelope;
      const action = BrowserAction.parse(input);
      // A screenshot is a workspace write wearing an action's name, so it is held to what the
      // print route is held to: the write scope, and a host disk with room for the file.
      if (writesWorkspaceFile(action)) requireScope(request, 'files.write');
      if (requestId || writesWorkspaceFile(action))
        await assertHostStorageWrite(root, requestId ? 1024 * 1024 : 0, probeHostStorage);
      const perform = (progress?: BrowserActionProgress) =>
        browser.act(
          request.params.workspaceId,
          root,
          action,
          request.capability.role === 'user' ? 'user' : 'agent',
          request.capability.scopes.includes('browser.consequential'),
          request.capability.role === 'agent' ? request.capability.sub : null,
          progress
        );
      return requestId
        ? browserJournal.run(
            root,
            `${request.capability.role}:${request.capability.sub}`,
            requestId,
            action,
            perform
          )
        : perform();
    }
  );

  app.get<{ Params: { workspaceId: string; requestId: string } }>(
    '/v1/workspaces/:workspaceId/browser/receipts/:requestId',
    async (request) => {
      requireScope(request, 'browser.read');
      const root = workspacePath(workspaceRoot, request.params.workspaceId);
      return {
        receipt: await browserJournal.read(
          root,
          `${request.capability.role}:${request.capability.sub}`,
          request.params.requestId
        )
      };
    }
  );
}
