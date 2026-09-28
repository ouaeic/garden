import { Readable } from 'node:stream';
import { DiagnosticCaptureControl } from '@garden/contracts';
import {
  GardenError,
  decryptJson,
  diagnosticCipherHash,
  diagnosticPlainHash,
  diagnosticRecordAad,
  DIAGNOSTIC_EMPTY_HASH,
  PrivateDiagnosticBody,
  unwrapDataKey
} from '@garden/core';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';

export function registerPrivateDiagnosticRoutes({
  app,
  store,
  masterKey,
  idempotent
}: RouteContext) {
  app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/diagnostic-capture',
    async (request, reply) => {
      const user = requireUser(request.user);
      if (!(await store.getTask(user.id, request.params.taskId)))
        throw new GardenError('task_not_found', 'Conversation not found', 404);
      return reply.header('cache-control', 'private, no-store').send({
        capture: (await store.diagnostics.get(user.id, request.params.taskId))?.status ?? null
      });
    }
  );
  app.post<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/diagnostic-capture',
    async (request, reply) => {
      const user = requireUser(request.user);
      const { id, action } = DiagnosticCaptureControl.parse(request.body);
      return idempotent(
        request,
        reply,
        user,
        async () => ({
          capture: await store.diagnostics.control(user.id, request.params.taskId, id, action)
        }),
        { databaseOnly: true }
      );
    }
  );
  app.get<{ Params: { taskId: string; id: string } }>(
    '/v1/tasks/:taskId/diagnostic-capture/:id/export',
    async (request, reply) => {
      const user = requireUser(request.user);
      const capture = await store.diagnostics.get(user.id, request.params.taskId);
      if (!capture || capture.status.id !== request.params.id)
        throw new GardenError('diagnostic_not_found', 'Recording not found', 404);
      const workspace = await store.getWorkspace(user.id, capture.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found', 404);
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const header = {
        type: 'private_capture',
        format: 'garden-private-diagnostic',
        version: 1,
        id: capture.status.id,
        taskId: capture.taskId,
        workspaceId: capture.workspaceId,
        status: capture.status,
        through: capture.status.records
      };
      const document = async function* (): AsyncGenerator<string> {
        let sequence = 0,
          cipherHash = DIAGNOSTIC_EMPTY_HASH,
          plainHash = DIAGNOSTIC_EMPTY_HASH,
          complete = true;
        try {
          yield `${JSON.stringify(header)}\n`;
          while (sequence < header.through) {
            if (reply.raw.destroyed) return;
            if (!(await store.getWorkspace(user.id, capture.workspaceId))) {
              complete = false;
              break;
            }
            const rows = await store.diagnostics.page(
              user.id,
              capture.taskId,
              header.id,
              sequence,
              header.through
            );
            if (!rows.length) {
              complete = false;
              break;
            }
            for (const row of rows) {
              const aad = diagnosticRecordAad(header.id, row.sequence, cipherHash);
              if (
                row.sequence !== sequence + 1 ||
                row.previousHash !== cipherHash ||
                row.envelope.aad !== aad ||
                diagnosticCipherHash(row.envelope) !== row.hash
              )
                throw new Error('Corrupt private recording');
              const body = PrivateDiagnosticBody.parse(decryptJson(row.envelope, key, aad));
              const hash = diagnosticPlainHash(row.sequence, plainHash, body);
              yield `${JSON.stringify({ type: 'record', sequence: row.sequence, previousHash: plainHash, hash, body })}\n`;
              sequence = row.sequence;
              cipherHash = row.hash;
              plainHash = hash;
            }
          }
        } catch {
          complete = false;
        } finally {
          key.fill(0);
        }
        yield `${JSON.stringify({
          type: 'footer',
          records: sequence,
          hash: plainHash,
          complete: complete && sequence === header.through && cipherHash === capture.lastHash
        })}\n`;
      };
      const stream = Readable.from(document());
      stream.once('close', () => key.fill(0));
      reply.raw.once('close', () => {
        stream.destroy();
        key.fill(0);
      });
      return reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', 'attachment; filename="garden-private-diagnostic.ndjson"')
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(stream);
    }
  );
}
