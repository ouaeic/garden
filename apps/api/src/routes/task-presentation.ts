import { TaskPresentation, deliveryFilePath, mediaDeliveryState } from '@garden/contracts';
import type { Artifact } from '@garden/contracts';
import { GardenError, decryptJson, unwrapDataKey } from '@garden/core';
import { TaskEvidenceReader, PresentationAvailability } from '../task-evidence.js';
import { downloadSignal, sendDownload } from '../download-response.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import {
  buildTaskPresentation,
  taskDeliveryFiles,
  taskPreviewIds,
  taskSourceFiles,
  plannedOutputPaths
} from '../task-presentation.js';

export const registerTaskPresentationRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    database,
    masterKey,
    runner,
    privateTaskPlanResponse,
    workspacePreviewResponse
  } = context;
  const evidenceReader = new TaskEvidenceReader(database);
  const availabilityCache = new PresentationAvailability();
  app.get<{ Params: { taskId: string } }>(
    '/v1/tasks/:taskId/presentation',
    async (request, reply) => {
      const user = requireUser(request.user);
      const task = await store.getTask(user.id, request.params.taskId);
      if (!task) throw new GardenError('task_not_found', 'Task not found');
      const workspace = await store.getWorkspace(user.id, task.workspaceId);
      if (!workspace?.wrappedKey)
        throw new GardenError('workspace_not_found', 'Workspace not found');
      const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
      const execution = await store.getProjectExecution(user.id, task.id);
      const sourceWorkspace =
        execution?.status === 'ready' && execution.sourceWorkspaceId !== workspace.id
          ? await store.getWorkspace(user.id, execution.sourceWorkspaceId)
          : null;
      const sourceKey = sourceWorkspace?.wrappedKey
        ? unwrapDataKey(sourceWorkspace.wrappedKey, masterKey, sourceWorkspace.id)
        : null;
      const [evidence, planRecord, storedArtifacts, storedPreviews, jobRows] = await Promise.all([
        evidenceReader.read(task.id, key),
        store.getLatestTaskPlan(task.id),
        Promise.all([
          store.listArtifacts(user.id, workspace.id, task.id, 129),
          sourceWorkspace ? store.listArtifacts(user.id, sourceWorkspace.id, task.id, 129) : []
        ]).then((rows) =>
          rows.flat().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        ),
        Promise.all([
          store.listWorkspacePreviews(user.id, workspace.id),
          sourceWorkspace ? store.listWorkspacePreviews(user.id, sourceWorkspace.id) : []
        ]).then((rows) => rows.flat()),
        database.query<{ status: string; output_path: string | null }>(
          `SELECT status,output_path FROM (SELECT DISTINCT ON(output_path) status,output_path,created_at FROM provider_media_jobs WHERE user_id=$1 AND task_id=$2 ORDER BY output_path,created_at DESC) latest ORDER BY created_at DESC LIMIT 100`,
          [user.id, task.id]
        )
      ]);
      const { events } = evidence;
      const plan = planRecord ? await privateTaskPlanResponse(planRecord, workspace) : null;
      const intended = plannedOutputPaths(plan?.outputs);
      const mediaDelivery = mediaDeliveryState(
        jobRows.rows.map((row) => ({
          status: row.status,
          outputPath: row.output_path
        }))
      );
      const pendingMedia = new Set(
        mediaDelivery.pending.map((job) => deliveryFilePath(job.outputPath))
      );
      const artifactRows = storedArtifacts
        .filter((artifact) => artifact.taskId === task.id)
        .slice(0, 128);
      const artifacts: Artifact[] = artifactRows.map((artifact) => ({
        id: String(artifact.id),
        workspaceId: String(artifact.workspaceId),
        taskId: task.id,
        name: decryptJson<{ name: string }>(
          artifact.nameCiphertext as Parameters<typeof decryptJson>[0],
          artifact.workspaceId === sourceWorkspace?.id && sourceKey ? sourceKey : key,
          `artifact-name:${String(artifact.workspaceId)}`
        ).name,
        mimeType: String(artifact.mimeType),
        sizeBytes: Number(artifact.sizeBytes),
        version: Number(artifact.version),
        sha256: String(artifact.sha256),
        createdAt: String(artifact.createdAt)
      }));
      const previewIds = taskPreviewIds(events);
      const previews = storedPreviews
        .filter((p) => previewIds.has(p.id))
        .map((p) => workspacePreviewResponse(p));
      const previewAvailability = new Map<string, 'ready' | 'unavailable' | 'unknown'>();
      const files = new Map<
        string,
        { status: 'ready' | 'unavailable' | 'unknown'; sizeBytes?: number }
      >();
      const checks: Array<() => Promise<void>> = [];
      for (const preview of previews) {
        const previewWorkspace =
          preview.workspaceId === sourceWorkspace?.id ? sourceWorkspace : workspace;
        if (!['running', 'hibernated'].includes(previewWorkspace.status)) {
          previewAvailability.set(preview.id, 'unavailable');
          continue;
        }
        if (
          preview.status !== 'active' ||
          (preview.expiresAt && Date.parse(preview.expiresAt) <= Date.now())
        )
          continue;
        const cacheKey = `preview:${preview.id}:${preview.updatedAt}:${preview.lastAccessedAt}`;
        const cached = availabilityCache.get(cacheKey);
        if (cached) {
          previewAvailability.set(preview.id, cached.status);
          continue;
        }
        if (checks.length >= 8) continue;
        checks.push(async () => {
          const observed = await availabilityCache.check(cacheKey, async () => {
            try {
              const result = await runner.request<{ available: boolean }>({
                workspaceId: preview.workspaceId,
                userId: user.id,
                role: 'user',
                scopes: [`preview:${preview.port}`],
                path: `/v1/workspaces/${preview.workspaceId}/preview-check/${preview.port}`,
                timeoutMs: 2_000
              });
              return { status: result.available ? 'ready' : 'unavailable' };
            } catch {
              return { status: 'unknown' };
            }
          });
          previewAvailability.set(preview.id, observed.status);
        });
      }
      const deliveryFiles = taskDeliveryFiles(events);
      for (const path of intended.paths) if (!deliveryFiles.has(path)) deliveryFiles.set(path, []);
      for (const [path, receipts] of deliveryFiles) {
        if (pendingMedia.has(path)) {
          files.set(path, { status: 'unknown' });
          continue;
        }
        const cacheKey = `file:${workspace.id}:${path}:${receipts.at(-1)}`;
        const cached = availabilityCache.get(cacheKey);
        if (cached) {
          files.set(path, cached);
          continue;
        }
        if (checks.length >= 8) continue;
        checks.push(async () => {
          const observed = await availabilityCache.check(cacheKey, async () => {
            try {
              const response = await runner.raw({
                workspaceId: workspace.id,
                userId: user.id,
                role: 'user',
                scopes: ['files.read'],
                path: `/v1/workspaces/${workspace.id}/file?${new URLSearchParams({ path, maxBytes: '1' })}`,
                timeoutMs: 2_000,
                acceptAnyStatus: true
              });
              const length = response.headers.get('x-file-bytes');
              const sizeBytes = length === null ? undefined : Number(length);
              await response.body?.cancel();
              return {
                status: response.ok
                  ? 'ready'
                  : [400, 403, 404].includes(response.status)
                    ? 'unavailable'
                    : 'unknown',
                ...(sizeBytes !== undefined && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
                  ? { sizeBytes }
                  : {})
              };
            } catch {
              return { status: 'unknown' };
            }
          });
          files.set(path, observed);
        });
      }
      // A task with many outputs must not monopolise the runner while the owner opens its result.
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, checks.length) }, async () => {
          while (next < checks.length) {
            const check = checks[next++];
            if (check) await check();
          }
        })
      );
      const presentation = buildTaskPresentation({
        taskId: task.id,
        workspaceId: workspace.id,
        ...(sourceWorkspace ? { sourceWorkspaceId: sourceWorkspace.id } : {}),
        taskStatus: task.status,
        events,
        plan,
        artifacts,
        artifactSourceKeys: new Map(
          artifactRows
            .filter(
              (artifact) =>
                typeof artifact.logicalKey === 'string' &&
                artifact.logicalKey !== 'null' &&
                artifact.logicalKey.length > 0
            )
            .map((artifact) => [
              String(artifact.id),
              `${String(artifact.workspaceId)}:${String(artifact.logicalKey)}`
            ])
        ),
        previews,
        previewAvailability,
        files
      });
      presentation.eventCursor = evidence.cursor;
      if (jobRows.rows.length) presentation.delivery = mediaDelivery.summary;
      for (const result of presentation.results)
        if (result.path && pendingMedia.has(result.path)) {
          result.downloadUrl = null;
          result.detail =
            'Media is generating. Its download will appear when the provider job finishes.';
        }
      presentation.coverage = evidence.coverage;
      if (storedArtifacts.length > 128)
        presentation.coverage = { ...evidence.coverage, scope: 'recent', resultLimitReached: true };
      const sources = taskSourceFiles(events);
      for (const path of intended.paths) if (!sources.has(path)) sources.set(path, []);
      if ((sources.size > 1 || intended.directories.length) && sources.size <= 1_000)
        presentation.sourceBundle = {
          downloadUrl: `/v1/tasks/${encodeURIComponent(task.id)}/bundle`,
          fileCount: intended.directories.length ? null : sources.size,
          scope: intended.directories.length ? 'declared_directories' : 'recorded_files',
          ...(intended.directories.length ? { directories: intended.directories } : {})
        };
      reply.header('cache-control', 'private, no-store');
      return TaskPresentation.parse(presentation);
    }
  );

  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/bundle', async (request, reply) => {
    const user = requireUser(request.user);
    const task = await store.getTask(user.id, request.params.taskId);
    if (!task) throw new GardenError('task_not_found', 'Task not found');
    const workspace = await store.getWorkspace(user.id, task.workspaceId);
    if (!workspace?.wrappedKey) throw new GardenError('workspace_not_found', 'Workspace not found');
    const key = unwrapDataKey(workspace.wrappedKey, masterKey, workspace.id);
    const { events } = await evidenceReader.read(task.id, key);
    const planRecord = await store.getLatestTaskPlan(task.id);
    const plan = planRecord ? await privateTaskPlanResponse(planRecord, workspace) : null;
    const intended = plannedOutputPaths(plan?.outputs);
    const paths = [...new Set([...taskSourceFiles(events).keys(), ...intended.paths])];
    const instructions = plan?.outputs
      ?.flatMap((output) =>
        output.run
          ? [`${output.title}\nFrom the extracted project directory:\n${output.run.command}`]
          : []
      )
      .join('\n\n');
    if ((!paths.length && !intended.directories.length) || paths.length > 1_000)
      throw new GardenError(
        'bundle_unavailable',
        'No bounded set of source files is recorded for this task',
        404
      );
    const response = await runner.raw({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'user',
      scopes: ['files.read'],
      path: `/v1/workspaces/${workspace.id}/bundle`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        paths,
        ...(intended.directories.length ? { directories: intended.directories } : {}),
        ...(instructions ? { instructions } : {})
      }),
      signal: downloadSignal(reply),
      acceptAnyStatus: true
    });
    return sendDownload(reply, response);
  });
};
