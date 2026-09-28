/**
 * The file tree, one window at a time, and the artifacts produced from it.
 *
 * Reads are windowed and say so in headers the browser can actually see (the CORS allowlist in
 * `server.ts` exposes them): where the window starts and ends, whether it was truncated, and where
 * to resume. A file write re-measures the workspace so the storage ceiling is asked of the disk
 * rather than of a running total that drifts.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { GardenError, decryptJson, encryptJson, sha256, unwrapDataKey } from '@garden/core';
import type { WorkspaceRecord } from '@garden/data';
import { z } from 'zod';
import { FILE_WINDOW_HEADERS } from '../context.js';
import { downloadSignal, sendDownload } from '../download-response.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { recordSecurityEvent } from '../security-events.js';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { registerProjectDirectoryRoutes } from './project-directories.js';

export const registerWorkspaceFileRoutes = (context: RouteContext): void => {
  registerProjectDirectoryRoutes(context);
  const { app, store, masterKey, runner, hostStorageCache, requireRecentStepUp, idempotent } =
    context;
  app.get<{ Params: { workspaceId: string }; Querystring: { path?: string } }>(
    '/v1/workspaces/:workspaceId/files',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      const path = encodeURIComponent(request.query.path ?? 'workspace');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/files?path=${path}`
      });
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/export',
    async (request, reply) => {
      const user = requireUser(request.user);
      await requireRecentStepUp(request, user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      const response = await runner.raw({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/export`
      });
      if (!response.body)
        throw new GardenError('workspace_export_failed', 'Workspace export stream is unavailable');
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'workspace_export',
        outcome: 'started',
        metadata: { workspaceId: workspace.id }
      });
      return reply
        .type('application/gzip')
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          `attachment; filename="garden-workspace-${workspace.id}.tar.gz"`
        )
        .send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
    }
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: { path: string };
  }>('/v1/workspaces/:workspaceId/download', async (request, reply) => {
    const user = requireUser(request.user);
    const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
    if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
    const path = z.string().min(1).max(4096).parse(request.query.path);
    const headers: Record<string, string> = {};
    for (const name of ['range', 'if-range'] as const) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const response = await runner.raw({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      scopes: ['files.read'],
      path: `/v1/workspaces/${workspace.id}/download?${new URLSearchParams({ path })}`,
      headers,
      acceptAnyStatus: true,
      signal: downloadSignal(reply)
    });
    return sendDownload(reply, response);
  });

  app.get<{
    Params: { workspaceId: string };
    Querystring: { path: string; startLine?: string; endLine?: string; maxBytes?: string };
  }>('/v1/workspaces/:workspaceId/file', async (request, reply) => {
    const user = requireUser(request.user);
    const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
    if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
    /*
     * A window, and the numbers describing it.
     *
     * The runner has read line ranges under a byte budget all along, and answers with where the
     * window starts and ends, whether it was cut short and where to resume - which is what a viewer
     * needs to page through a log without pulling the whole file. This route forwarded none of the
     * three parameters and re-exposed none of the headers, so the owner's file pane could only ever
     * ask for everything, and a file past the runner's ceiling was simply an error.
     *
     * `raw` rather than `request`, because the answer is the headers as much as the bytes.
     */
    const window = new URLSearchParams({ path: request.query.path });
    for (const key of ['startLine', 'endLine', 'maxBytes'] as const)
      if (request.query[key] !== undefined) window.set(key, String(request.query[key]));
    const response = await runner.raw({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      scopes: ['files.read'],
      path: `/v1/workspaces/${workspace.id}/file?${window}`
    });
    for (const header of FILE_WINDOW_HEADERS) {
      const value = response.headers.get(header);
      if (value !== null) reply.header(header, value);
    }
    if (!response.body) throw new GardenError('file_unavailable', 'The file stream is unavailable');
    return reply
      .type('application/octet-stream')
      .send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
  });

  app.put<{
    Params: { workspaceId: string };
    Querystring: { path: string; expectSha256?: string; createOnly?: string };
    Body: Buffer;
  }>('/v1/workspaces/:workspaceId/file', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      /**
       * The body is a `Buffer` only for `application/octet-stream`, which is the one content type
       * this file registers a raw parser for. Anything else - `application/json` most obviously -
       * parses to an object whose `byteLength` is `undefined`, and `storageBytes + undefined` is
       * `NaN`, which is not greater than any limit: the guard below passed unconditionally for
       * every body that was not the declared one, and `Uint8Array.from` then turned an array-like
       * JSON object into real bytes on the disk. The type is checked before the size, so the
       * check that exists to stop the disk filling cannot be stepped around by a header.
       */
      if (!Buffer.isBuffer(request.body))
        throw new GardenError('invalid_request', 'Send the file as application/octet-stream', 415);
      if (workspace.storageBytes + request.body.byteLength > workspace.storageLimitBytes)
        throw new GardenError('storage_limit', 'Workspace storage limit reached');
      /*
       * The caller's claim about what it is replacing, checked by the runner under the write's own
       * descriptor. Two people editing the same file - or the owner saving a file the agent is
       * part-way through writing - is the ordinary case on this computer, and without this the
       * later write wins silently: the Files pane discarded work the agent had just done, with
       * nothing anywhere recording that it had. The runner has enforced it all along; this route
       * dropped the parameter on the floor.
       *
       * `raw` with `acceptAnyStatus`, because the refusal is the point. `runner.request` turns any
       * non-2xx into a thrown `Error`, which this API answers as a 500 - so a disagreement the
       * owner can resolve by re-reading the file would have arrived as "the workspace runtime
       * failed", and the sentence explaining what to do next would have been quoted inside a
       * server error. It comes back as its own 409 instead.
       */
      const response = await runner.raw({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.write'],
        path: `/v1/workspaces/${workspace.id}/file?${new URLSearchParams({
          path: request.query.path,
          ...(request.query.expectSha256 ? { expectSha256: request.query.expectSha256 } : {}),
          ...(request.query.createOnly === 'true' ? { createOnly: 'true' } : {})
        })}`,
        method: 'PUT',
        body: Uint8Array.from(request.body).buffer,
        contentType: 'application/octet-stream',
        acceptAnyStatus:
          request.query.expectSha256 !== undefined || request.query.createOnly === 'true'
      });
      if (response.status === 409)
        throw new GardenError(
          request.query.createOnly === 'true' ? 'file_exists' : 'file_changed',
          request.query.createOnly === 'true'
            ? 'A file with this name already exists. Choose another name.'
            : 'This file changed after you read it, so writing it whole would discard that change. Read it again and reapply your edit.',
          409
        );
      if (!response.ok) throw new Error(`Workspace runtime returned ${response.status}`);
      const result = (await response.json()) as unknown;
      const usage = await runner.request<{ storageBytes: number }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/usage`
      });
      await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
      return result;
    });
  });

  /** Re-reads the machine's own total after something on it changed size. */
  const remeasureWorkspace = async (workspace: WorkspaceRecord, userId: string): Promise<void> => {
    const usage = await runner.request<{ storageBytes: number }>({
      workspaceId: workspace.id,
      userId,
      role: 'control',
      scopes: ['files.read'],
      path: `/v1/workspaces/${workspace.id}/usage`
    });
    await store.setWorkspaceStorage(userId, workspace.id, usage.storageBytes);
    hostStorageCache.delete(workspace.id);
  };

  app.delete<{ Params: { workspaceId: string }; Querystring: { path: string } }>(
    '/v1/workspaces/:workspaceId/file',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(request.query.path)}`,
          method: 'DELETE'
        });
        await remeasureWorkspace(workspace, user.id);
        reply.status(204);
        return null;
      });
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { from: string; to: string } }>(
    '/v1/workspaces/:workspaceId/files/rename',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = z
          .object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) })
          .parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        return runner.request<{ path: string }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/files/rename`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      });
    }
  );

  app.post<{ Params: { workspaceId: string }; Body: { path: string } }>(
    '/v1/workspaces/:workspaceId/files/folder',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const input = z.object({ path: z.string().min(1).max(1024) }).parse(request.body);
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        return runner.request<{ path: string }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/files/folder`,
          method: 'POST',
          contentType: 'application/json',
          body: JSON.stringify(input)
        });
      });
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { path: string; name?: string; mimeType?: string; taskId?: string };
  }>('/v1/workspaces/:workspaceId/artifacts', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({
          path: z.string().min(1).max(1024),
          name: z.string().min(1).max(255).optional(),
          mimeType: z.string().min(1).max(160).default('application/octet-stream'),
          taskId: z.string().uuid().optional()
        })
        .parse(request.body);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
      if (input.taskId && !(await store.getTask(user.id, input.taskId)))
        throw new GardenError('task_not_found', 'Task not found');
      const content = await runner.request<Buffer>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(input.path)}`
      });
      if (workspace.storageBytes + content.byteLength > workspace.storageLimitBytes)
        throw new GardenError('storage_limit', 'Artifact version would exceed workspace storage');
      const storageKey = `.garden/artifacts/${randomUUID()}`;
      const digest = sha256(content);
      await runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.write'],
        path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(storageKey)}`,
        method: 'PUT',
        body: Uint8Array.from(content).buffer,
        contentType: 'application/octet-stream'
      });
      const name = input.name ?? input.path.split('/').filter(Boolean).at(-1) ?? 'artifact';
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const artifact = await store.createArtifact({
        userId: user.id,
        workspaceId: workspace.id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        logicalKey: sha256(input.path),
        nameCiphertext: encryptJson({ name }, key, `artifact-name:${workspace.id}`),
        mimeType: input.mimeType,
        sizeBytes: content.byteLength,
        sha256: digest,
        storageKey
      });
      const usage = await runner.request<{ storageBytes: number }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'control',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/usage`
      });
      await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
      return {
        id: artifact.id,
        workspaceId: workspace.id,
        taskId: artifact.task_id ?? null,
        name,
        mimeType: input.mimeType,
        sizeBytes: content.byteLength,
        version: Number(artifact.version),
        sha256: digest,
        createdAt: new Date(String(artifact.created_at)).toISOString()
      };
    });
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/artifacts',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      return (await store.listArtifacts(user.id, workspace.id)).map((artifact) => ({
        id: artifact.id,
        workspaceId: artifact.workspaceId,
        taskId: artifact.taskId,
        name: decryptJson<{ name: string }>(
          artifact.nameCiphertext as Parameters<typeof decryptJson>[0],
          key,
          `artifact-name:${String(artifact.workspaceId)}`
        ).name,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        version: artifact.version,
        sha256: artifact.sha256,
        createdAt: artifact.createdAt
      }));
    }
  );

  app.get<{ Params: { artifactId: string } }>(
    '/v1/artifacts/:artifactId/content',
    async (request, reply) => {
      const user = requireUser(request.user);
      const artifact = await store.getArtifact(user.id, request.params.artifactId);
      if (!artifact) throw new GardenError('not_found', 'Artifact not found');
      const workspace = await store.getWorkspace(user.id, String(artifact.workspaceId));
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
      const response = await runner.raw({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['files.read'],
        path: `/v1/workspaces/${workspace.id}/download?${new URLSearchParams({ path: String(artifact.storageKey), sha256: String(artifact.sha256) })}`,
        headers:
          typeof request.headers.range === 'string'
            ? {
                range: request.headers.range,
                ...(typeof request.headers['if-range'] === 'string'
                  ? { 'if-range': request.headers['if-range'] }
                  : {})
              }
            : {},
        signal: downloadSignal(reply),
        acceptAnyStatus: true
      });
      if (response.status === 409) {
        await response.body?.cancel();
        throw new GardenError('artifact_integrity_failed', 'Artifact integrity check failed');
      }
      if (!response.ok) return sendDownload(reply, response);
      if (!response.body)
        throw new GardenError('file_unavailable', 'The artifact stream is unavailable');
      for (const header of [
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified'
      ]) {
        const value = response.headers.get(header);
        if (value !== null) reply.header(header, value);
      }
      reply.code(response.status).header('cache-control', 'private, no-store');
      const name = decryptJson<{ name: string }>(
        artifact.nameCiphertext as Parameters<typeof decryptJson>[0],
        unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id),
        `artifact-name:${workspace.id}`
      ).name;
      /*
       * Stored data does not get to choose how the browser treats this response.
       *
       * The type came from `publish_artifact`, whose `mimeType` is a free-form string the agent
       * supplies - and the agent takes instructions, in effect, from any page it reads. Replaying
       * it into `reply.type()` with `content-disposition: inline` meant a poisoned page could have
       * the agent save `text/html` with a script in it, which the owner then opened from the Saved
       * results list as a top-level document on this box's own origin. There is no CSP on /v1/ to
       * catch it, so that script ran with the owner's session against every route it can reach:
       * their transcripts, their files, their connectors, and - inside the five-minute step-up
       * window - a device enrollment that registers an attacker's own passkey for good.
       *
       * `nosniff` does not help when the declared type *is* the dangerous one, so the declaration
       * itself is what has to be constrained. Anything not on this list is handed over as bytes to
       * download rather than as a document to run, and the sandbox header is the same belt the
       * preview gateway already wears for agent-authored pages on this origin.
       */
      const declared = String(artifact.mimeType).toLowerCase().split(';', 1)[0]?.trim() ?? '';
      const inlineSafe = new Set([
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'image/avif',
        'application/pdf',
        'text/plain',
        'audio/mpeg',
        'audio/mp4',
        'audio/ogg',
        'audio/wav',
        'video/mp4',
        'video/webm'
      ]);
      const renderInline = inlineSafe.has(declared);
      return reply
        .type(renderInline ? declared : 'application/octet-stream')
        .header('x-content-sha256', String(artifact.sha256))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header(
          'content-disposition',
          `${renderInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
        )
        .send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
    }
  );

  app.delete<{ Params: { artifactId: string } }>(
    '/v1/artifacts/:artifactId',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const artifact = await store.getArtifact(user.id, request.params.artifactId);
        if (!artifact) throw new GardenError('not_found', 'Artifact not found');
        const workspace = await store.getWorkspace(user.id, String(artifact.workspaceId));
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        await runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['files.write'],
          path: `/v1/workspaces/${workspace.id}/file?path=${encodeURIComponent(String(artifact.storageKey))}`,
          method: 'DELETE'
        });
        await store.deleteArtifact(user.id, request.params.artifactId);
        const usage = await runner.request<{ storageBytes: number }>({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'control',
          scopes: ['files.read'],
          path: `/v1/workspaces/${workspace.id}/usage`
        });
        await store.setWorkspaceStorage(user.id, workspace.id, usage.storageBytes);
        return { deleted: true };
      });
    }
  );
};
