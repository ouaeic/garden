/**
 * One request that answers everything a client needs to draw its first screen.
 *
 * It exists so a cold start is one round-trip rather than nine, and so the answers cannot
 * disagree with each other: the model list, the spend, the search route and the conversation page
 * are all read inside it.
 */

import { decryptJson, unwrapDataKey } from '@garden/core';
import { projectResponse } from '@garden/data';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { workspaceResponse } from '../context.js';
import type { HostStorage } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { currentPeriod, serverLimits } from '../plans.js';
import { withTaskDeliveryStatus } from '../task-delivery-status.js';

export const registerBootstrapRoutes = (context: RouteContext): void => {
  const {
    app,
    store,
    database,
    masterKey,
    cachedHostStorage,
    privateTaskResponse,
    privateScheduleResponse,
    providerSpend,
    planUsage,
    requiresZeroDataRetention,
    modelsForUser,
    webSearchRouteFor,
    ensurePrimaryWorkspace,
    relay,
    config
  } = context;
  app.get('/v1/bootstrap', async (request, reply) => {
    const user = requireUser(request.user);
    const { start: periodStart, end: periodEnd } = currentPeriod();
    // Keys and drafts are read together so private execution roots need no per-project queries.
    const openDrafts = async () =>
      (await store.listOwnerMessageDrafts(user.id)).flatMap((row) => {
        try {
          const key = unwrapDataKey(row.wrappedKey, masterKey, row.workspaceId);
          const opened = row.bodyCiphertext
            ? decryptJson<{
                body: string;
                controls?: {
                  modelId: string;
                  reasoningEffort: string;
                  privacyRoute: string;
                  spendCap: string;
                };
                attachments?: Array<{
                  path: string;
                  name: string;
                  sizeBytes: number;
                  mimeType: string;
                }>;
              }>(row.bodyCiphertext, key)
            : { body: '', attachments: [] };
          return [
            {
              workspaceId: row.workspaceId,
              taskId: row.taskId,
              body: opened.body,
              ...(opened.controls ? { controls: opened.controls } : {}),
              attachments: opened.attachments ?? [],
              updatedAt: row.updatedAt,
              revision: row.revision
            }
          ];
        } catch {
          return [];
        }
      });
    const workspacesRead = ensurePrimaryWorkspace(user);
    const [
      workspaces,
      workspaceMetadata,
      projects,
      tasks,
      schedules,
      models,
      providerCredential,
      usage,
      drafts,
      enforceZeroDataRetention,
      webSearch,
      spend,
      plan
    ] = await Promise.all([
      workspacesRead,
      store.listWorkspaceMetadata(user.id),
      store.listProjects(user.id),
      store.listTaskPage(user.id),
      store.listTaskSchedules(user.id),
      modelsForUser(user),
      store.primaryInferenceCredential(user.id),
      store.usageTotals(user.id, periodStart, periodEnd),
      openDrafts(),
      requiresZeroDataRetention(user.id),
      webSearchRouteFor(user.id),
      providerSpend(user.id),
      planUsage(user.id)
    ]);
    const metadata = new Map(workspaceMetadata.map((workspace) => [workspace.id, workspace]));
    const hostStorage = new Map(
      workspaces
        .map((workspace) => [workspace.id, cachedHostStorage(workspace)] as const)
        .filter((entry): entry is readonly [string, HostStorage & { storageBytes: number }] =>
          Boolean(entry[1])
        )
    );
    const response = {
      user,
      projects: projects.projects.map((project) => projectResponse(project, masterKey, false)),
      projectsCursor: projects.nextCursor,
      drafts,
      workspaces: workspaces.map((workspace) =>
        workspaceResponse(
          {
            ...workspace,
            storageBytes: hostStorage.get(workspace.id)?.storageBytes ?? workspace.storageBytes
          },
          hostStorage.get(workspace.id)
        )
      ),
      tasks: await Promise.all(
        (await withTaskDeliveryStatus(database, user.id, tasks.tasks)).map((task) =>
          privateTaskResponse(task, metadata.get(task.workspaceId))
        )
      ),
      /** Where GET /v1/tasks resumes from, so the sidebar can reach past this first page. */
      tasksCursor: tasks.nextCursor,
      /** How many runs each schedule above really has, which is not how many of them fitted. */
      scheduleRunCounts: tasks.scheduleRunCounts,
      schedules: await Promise.all(
        schedules.map((schedule) =>
          privateScheduleResponse(schedule, metadata.get(schedule.workspaceId))
        )
      ),
      // Bootstrap gates initial rendering, so it carries only picker identity and capabilities.
      // Full model metadata remains available from /v1/models and to the server-side router.
      models: models.map((model) => ({
        id: model.id,
        providerModelId: model.providerModelId,
        displayName: model.displayName,
        ...(model.connectionLabel ? { connectionLabel: model.connectionLabel } : {}),
        // Kept although no screen reads it: it is how "this box exposes only hosted routes" is
        // checked at the surface the client actually receives, and a boundary that can only be
        // asserted server-side is one nobody notices breaking.
        provider: model.provider,
        recommendationTags: model.recommendationTags,
        availability: model.availability,
        privacyRoute: model.privacyRoute,
        modalities: model.modalities,
        ...(model.nativeInputPricing &&
        model.modalities.some((kind) => kind === 'audio' || kind === 'video')
          ? { nativeInputPricing: model.nativeInputPricing }
          : {}),
        ...(model.reasoning ? { reasoning: model.reasoning } : {})
      })),
      instance: {
        mode: 'self_hosted',
        providerConfigured: Boolean(
          providerCredential?.status === 'active' ||
          config.AI_API_KEY ||
          config.OPENROUTER_API_KEY ||
          (config.AI_PROVIDER === 'openai-compatible' && config.AI_DEFAULT_MODEL)
        ),
        enforceZeroDataRetention,
        /**
         * Where a web search on this box is answered, so the client can say "this query leaves the
         * computer" beside the box it is typed in without asking again.
         */
        webSearch
      },
      computer: {
        cpuPercent: Math.max(
          0,
          Math.min(100, Math.round(((loadavg()[0] ?? 0) / Math.max(1, cpus().length)) * 100))
        ),
        memoryUsedBytes: Math.max(0, totalmem() - freemem()),
        memoryTotalBytes: totalmem()
      },
      legal: {
        applicationLicense: 'AGPL-3.0-only',
        sourceUrl: config.PUBLIC_SOURCE_URL ?? null,
        privacyUrl: config.PUBLIC_PRIVACY_URL ?? null
      },
      usage: {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        consumedCredits: usage.settled,
        reservedCredits: usage.reserved,
        storageBytes: workspaces.reduce((sum, workspace) => sum + workspace.storageBytes, 0),
        storageLimitBytes: serverLimits.storageBytes,
        providerSpend: spend,
        plan: plan
      }
    };
    reply.header('x-garden-preview-base-url', config.PREVIEW_BASE_URL);
    const relayPreviewOrigin = relay.publicPreviewOrigin();
    if (relayPreviewOrigin) reply.header('x-garden-relay-preview-origin', relayPreviewOrigin);
    return response;
  });
};
