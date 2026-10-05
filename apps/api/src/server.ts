import { registerProjectUpdateRoutes } from './routes/project-updates.js';
/**
 * One server, assembled.
 *
 * Routes, hooks and background sweeps live in their own modules - `http/` for the plumbing every
 * request crosses, `routes/` for the groups, `maintenance/` for the passes that run without a
 * caller - and this file is the assembly: build the context, build the helpers, hang the hooks, register the groups,
 * and say how the whole thing stops.
 *
 * Two orderings here are load-bearing rather than tidy.
 *
 * Fastify snapshots hooks per route as the route is registered, so `registerAuthHooks` MUST run
 * before every `registerXRoutes` call below it. The workspace pre-handler it installs answers "is
 * this the owner's own computer" for every route carrying a `workspaceId`, reads included, and it
 * is the layer that protects a route whose handler forgets to ask. A group moved above this line
 * loses it, and - measured, not assumed - no test in this package fails when it does.
 *
 * `createServerSupport` runs before the maintenance factories because the scheduler dispatches
 * against the same model list and the same spend ceiling a person's request would, and the whole
 * point of one shared helper is that an unattended run cannot be cheaper to authorise than an
 * attended one.
 */

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { AgentWorker, runCodingMissionLoop } from '@garden/worker';
import { runMediaJobLoop } from '@garden/worker/media-jobs';
import { registerAuthRoutes } from './auth-routes.js';
import type { ApiConfig } from './config.js';
import {
  createApiContext,
  embeddedWorkerShutdownGraceMs,
  FILE_WINDOW_HEADERS,
  type ApiOverrides,
  type ApiServices
} from './context.js';
import { createStepUpGuard, registerAuthHooks } from './http/auth-hook.js';
import { registerErrorHandler } from './http/errors.js';
import { createIdempotentOperation } from './http/idempotency.js';
import { registerMetrics } from './http/metrics.js';
import type { RouteContext, ServerBase, SupportedContext } from './http/server-context.js';
import { errorFields } from './log.js';
import { createApprovalSweep } from './maintenance/approvals.js';
import { createAttemptLimitSweep } from './maintenance/attempts.js';
import { runNameBackfill } from './maintenance/name-backfill.js';
import { createProviderWallMaintenance } from './maintenance/provider-walls.js';
import { createScheduleDispatch } from './maintenance/schedule-dispatch.js';
import { createMaintenanceSweep } from './maintenance/sweep.js';
import { createQuestionDefaultSweep } from './maintenance/question-defaults.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerMoveRoutes } from './routes/moves.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMediaJobRoutes } from './routes/media-jobs.js';
import { registerComputationRoutes } from './routes/computation.js';
import { registerDebuggerRoutes } from './routes/debugger.js';
import { registerNativeAuthorizationRoutes } from './routes/native-authorization.js';
import { registerCodingMissionRoutes } from './routes/coding-missions.js';
import { registerModelRoutes, seedModelCatalog } from './routes/models.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerPreviewRoutes } from './routes/previews.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerRelayRoutes } from './routes/relay.js';
import { registerRunnerProxyRoutes } from './routes/runner-proxy.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { createServerSupport } from './routes/support.js';
import { registerTaskDiagnosticRoutes } from './routes/task-diagnostics.js';
import { registerTaskEventRoutes } from './routes/task-events.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTaskPresentationRoutes } from './routes/task-presentation.js';
import { registerTrajectoryRoutes } from './routes/trajectory.js';
import { registerTranscriptionRoutes } from './routes/transcriptions.js';
import { registerVoiceRoutes } from './routes/voice.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerWorkspaceFileRoutes } from './routes/workspace-files.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { startTaskTitler } from './task-titles.js';

/**
 * Re-exported from `./context.js` because `server.test.ts` imports two of them from this module,
 * and nothing outside this package has been checked for the same imports. The shim goes when those
 * imports name `./context.js` directly.
 */
export {
  idempotencyRequestHash,
  isAddressLiteral,
  UNREADABLE_AGENT_MESSAGE,
  UNREADABLE_MEMORY_ITEM
} from './context.js';
export type { ApiOverrides, ApiServices } from './context.js';

export const buildServer = async (
  config: ApiConfig,
  overrides: ApiOverrides = {}
): Promise<ApiServices> => {
  /**
   * Everything one server decides once - its stores, keys, caches and response builders - built
   * in a fixed order. Held as a named object rather than inlined because it is the argument every
   * route group takes.
   */
  const context = await createApiContext(config, overrides);
  const {
    log,
    app,
    previewApp,
    database,
    store,
    masterKey,
    runnerSharedSecret,
    sessionSigningKey,
    relay
  } = context;
  /**
   * The context plus the two things it was built from. Everything below takes this or a widening
   * of it, which is what lets a route group be moved without rewriting its body.
   */
  const base: ServerBase = { ...context, config, overrides };

  await runNameBackfill(base);
  const requireRecentStepUp = createStepUpGuard(base);
  const idempotent = createIdempotentOperation(base);
  await seedModelCatalog(base);
  let embeddedWorkerRunning = false;
  /**
   * Shutdown used to set the loop's flag and immediately close the database, so a turn that was
   * mid-write - appending an event, settling usage, saving agent state - lost its connection under
   * it and the task was left leased and half-recorded. Closing now waits for the turn to land.
   *
   * `stopEmbeddedWorker` is the other half: without it the loop would sit out its whole poll
   * interval before noticing the flag, and every restart would pay that on an idle box.
   */
  let stopEmbeddedWorker = (): void => undefined;
  const embeddedWorkerStopped = new Promise<void>((resolve) => {
    stopEmbeddedWorker = resolve;
  });
  let embeddedWorkerLoop: Promise<void> = Promise.resolve();
  let mediaJobLoop: Promise<void> = Promise.resolve();
  let codingMissionLoop: Promise<void> = Promise.resolve();
  const mediaJobShutdown = new AbortController();
  const codingMissionShutdown = new AbortController();
  if (config.EMBEDDED_WORKER ?? config.DATABASE_DRIVER === 'pglite') {
    const embeddedWorker = new AgentWorker(store, config, masterKey, runnerSharedSecret, log);
    embeddedWorkerRunning = true;
    codingMissionLoop = runCodingMissionLoop({
      store,
      runnerBaseUrl: config.WORKSPACE_RUNNER_URL,
      runnerSecret: runnerSharedSecret,
      signal: codingMissionShutdown.signal,
      onError: (error) => log.error('worker.coding_mission_recovery_failed', errorFields(error))
    });
    mediaJobLoop = runMediaJobLoop({
      store,
      masterKey,
      runnerBaseUrl: config.WORKSPACE_RUNNER_URL,
      runnerSecret: runnerSharedSecret,
      workerId: config.WORKER_ID,
      signal: mediaJobShutdown.signal,
      onError: (error) => log.error('worker.media_poll_failed', errorFields(error))
    });
    /**
     * Pickup waits on the write, not on a clock: `waitForQueuedTask` returns the moment a task is
     * queued and otherwise after the poll interval, so a send is picked up in milliseconds instead
     * of costing the owner up to a full poll before the model is even called. The interval remains
     * as the floor for anything that becomes leasable without a signal - an expired lease.
     */
    embeddedWorkerLoop = (async () => {
      while (embeddedWorkerRunning) {
        let leased: Awaited<ReturnType<typeof store.leaseNextTask>> = null;
        try {
          leased = await store.leaseNextTask(config.WORKER_ID, 120);
        } catch (error) {
          // The embedded worker shares the API's process, so an unreachable store must not end the
          // server with it.
          if (embeddedWorkerRunning) log.error('worker.poll_failed', errorFields(error));
        }
        if (!leased) {
          await Promise.race([
            store.waitForQueuedTask(config.WORKER_POLL_MS),
            embeddedWorkerStopped
          ]);
          continue;
        }
        try {
          await embeddedWorker.run(leased);
        } catch (error) {
          log.warn('worker.task_failed', { taskId: leased.id, ...errorFields(error) });
          await embeddedWorker.fail(leased, error).catch((cause: unknown) => {
            log.error('worker.fail_failed', { taskId: leased.id, ...errorFields(cause) });
          });
        }
      }
    })();
  }
  await app.register(cookie, { secret: sessionSigningKey, hook: 'onRequest' });
  await app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true,
    /*
     * A response header a browser cannot read is a header that was not sent. The windowed file read
     * answers with where the window starts and ends, whether it was truncated and where to resume,
     * and a cross-origin client - which is every web client here, the app being served from
     * `PUBLIC_APP_URL` and the API from its own - sees none of them without this list.
     */
    exposedHeaders: [...FILE_WINDOW_HEADERS]
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  );
  app.decorateRequest('user', null);
  app.decorateRequest('apiToken', null);

  const support = createServerSupport(base);
  const maintenanceContext: SupportedContext = { ...base, ...support };
  const schedules = createScheduleDispatch(maintenanceContext);
  const providerWallMaintenance = createProviderWallMaintenance(maintenanceContext);
  const routes: RouteContext = {
    ...maintenanceContext,
    requireRecentStepUp,
    idempotent,
    resumeTasksWaitingOnAProvider: providerWallMaintenance.resumeTasksWaitingOnAProvider
  };
  const { maintain, maintenanceTimer } = createMaintenanceSweep(maintenanceContext, {
    sweepExpiredApprovals: createApprovalSweep(maintenanceContext),
    failTasksAtAttemptLimit: createAttemptLimitSweep(maintenanceContext),
    recoverStrandedScheduledTasks: schedules.recoverStrandedScheduledTasks,
    retryProviderWalls: providerWallMaintenance.retryProviderWalls,
    answerLapsedQuestions: createQuestionDefaultSweep(routes)
  });

  /*
   * Hooks first, and this is not a style choice: Fastify decides a route's hooks when the route is
   * registered, so anything below `registerAuthHooks` is guarded and anything above it is not.
   */
  registerErrorHandler(base);
  registerAuthHooks(base);
  registerMetrics(base);
  await registerVoiceRoutes(routes);
  registerAuthRoutes(app, store, config);
  registerHealthRoutes(routes);
  registerAccountRoutes(routes);
  registerNotificationRoutes(routes);
  registerDraftRoutes(routes);
  registerApprovalRoutes(routes);
  registerMoveRoutes(routes);
  registerPrivacyRoutes(routes);
  registerUsageRoutes(routes);
  registerScheduleRoutes(routes);
  registerDeviceRoutes(routes);
  registerRelayRoutes(routes);
  registerPreviewRoutes(routes);
  registerConnectorRoutes(routes);
  registerBootstrapRoutes(routes);
  registerSearchRoutes(routes);
  registerWorkspaceRoutes(routes);
  registerWorkspaceFileRoutes(routes);
  registerSnapshotRoutes(routes);
  registerKnowledgeRoutes(routes);
  registerRunnerProxyRoutes(routes);
  registerModelRoutes(routes);
  registerProviderRoutes(routes);
  registerMediaRoutes(routes);
  registerMediaJobRoutes(routes);
  registerComputationRoutes(routes);
  registerDebuggerRoutes(routes);
  registerNativeAuthorizationRoutes(routes);
  registerCodingMissionRoutes(routes);
  registerTranscriptionRoutes(routes);
  registerTaskRoutes(routes);
  registerProjectRoutes(routes);
  registerProjectUpdateRoutes(routes);
  registerTaskPresentationRoutes(routes);
  registerTrajectoryRoutes(routes);
  registerTaskEventRoutes(routes);
  registerTaskDiagnosticRoutes(routes);
  registerShareRoutes(routes);

  /**
   * Started last, so nothing it might touch is still being built, and stopped first below.
   *
   * The interval is long because the answer itself is what wakes this: it is the safety net for a
   * dropped notification listener and for the backlog a restart leaves behind, not the schedule.
   */
  const titler = startTaskTitler(
    { store, masterKey, log, complete: support.titleCompletion },
    5 * 60_000
  );

  app.addHook('onClose', async () => {
    mediaJobShutdown.abort();
    codingMissionShutdown.abort();
    await Promise.all([mediaJobLoop, codingMissionLoop]);
    embeddedWorkerRunning = false;
    stopEmbeddedWorker();
    clearInterval(maintenanceTimer);
    clearInterval(schedules.schedulerTimer);
    /**
     * Stopped before the worker is drained, not after. The titler wakes on an answer, and the last
     * thing a draining worker does is produce one - so leaving it running through the drain is
     * asking it to start a provider call at the exact moment the process is trying to leave.
     */
    await titler.stop();
    /**
     * The turn in flight finishes against a live database rather than being cut off mid-write -
     * but only for so long. A turn can legitimately run for many minutes, and a restart that waited
     * for one would be killed by the service manager well before it finished. Past the grace the
     * task simply keeps its lease, which is what leases are for: the next process to come up takes
     * it back when that lease expires.
     */
    await Promise.race([
      embeddedWorkerLoop,
      new Promise<void>((resolve) => setTimeout(resolve, embeddedWorkerShutdownGraceMs).unref())
    ]);
    // Only the connection: the settings file is untouched, so a restart comes back on the relay if
    // that is what the owner asked for.
    relay.close();
    await previewApp.close();
    await database.close();
  });
  return {
    app,
    previewApp,
    store,
    database,
    relay,
    runMaintenance: maintain,
    runScheduler: schedules.dispatchDueSchedule
  };
};
