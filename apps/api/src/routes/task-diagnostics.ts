import { registerPrivateDiagnosticRoutes } from './private-diagnostics.js';
import { Readable } from 'node:stream';
import { GardenError, createDiagnosticProjector, decryptJson, unwrapDataKey } from '@garden/core';
import { revealedTaskEvent } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export function registerTaskDiagnosticRoutes(context: RouteContext): void {
  registerPrivateDiagnosticRoutes(context);
  const { app, store, masterKey } = context;
  app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/diagnostics',
    async (request, reply) => {
      const user = requireUser(request.user);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Conversation not found', 404);
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found', 404);
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const projector = createDiagnosticProjector();
      // Fix the event boundary before streaming so active work cannot make this download endless.
      const throughSequence = (await store.listRecentTaskEvents(task.id, 1)).nextCursor;
      let checkpoint: unknown;
      try {
        checkpoint = task.agentStateCiphertext
          ? decryptJson(task.agentStateCiphertext, key, `task-state:${task.id}`)
          : {};
      } catch {
        checkpoint = undefined;
      }
      const header = projector.header(task, checkpoint, throughSequence);
      const document = async function* (): AsyncGenerator<string> {
        let lastSequence = 0,
          events = 0,
          unreadableEvents = 0,
          complete = true;
        try {
          yield `${JSON.stringify(header)}\n`;
          while (lastSequence < throughSequence) {
            if (reply.raw.destroyed) return;
            if (!(await store.getWorkspace(user.id, task.workspaceId))) {
              complete = false;
              break;
            }
            const page = await store.listTaskEventPage(task.id, {
              after: lastSequence,
              limit: 100
            });
            const records = page.events.filter((row) => row.sequence <= throughSequence);
            if (!records.length) break;
            for (const row of records) {
              if (row.sequence <= lastSequence) throw new Error('Non-monotonic event page');
              if (row.sequence !== lastSequence + 1) complete = false;
              let payload: unknown,
                unreadable = false;
              try {
                payload = revealedTaskEvent(
                  row.summary,
                  row.payloadCiphertext
                    ? decryptJson(row.payloadCiphertext, key, `task-event:${task.id}`)
                    : undefined
                ).payload;
              } catch {
                unreadable = true;
              }
              yield `${JSON.stringify(projector.event(row, payload, unreadable))}\n`;
              lastSequence = row.sequence;
              events++;
              if (unreadable) unreadableEvents++;
            }
          }
        } catch {
          complete = false;
        } finally {
          key.fill(0);
        }
        yield `${JSON.stringify({
          type: 'footer',
          events,
          unreadableEvents,
          lastSequence,
          complete: complete && lastSequence === throughSequence
        })}\n`;
      };
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', 'attachment; filename="garden-diagnostic.ndjson"')
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(Readable.from(document()));
    }
  );
}
