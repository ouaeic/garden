/**
 * The five-minute pass, and the promise that two of them never overlap.
 *
 * Each step is contained on its own: an unhandled rejection here would reach Node's default
 * handler and take the whole API down, and a database blip during cleanup should not cost the
 * metering pass or the two sweeps that release held credits.
 */

import { recoverProjectExecutions } from '../project-execution.js';
import type { SupportedContext } from '../http/server-context.js';
import { errorFields } from '../log.js';

/** The passes one sweep chains, each owned by its own file in this directory. */
export interface MaintenanceSweeps {
  sweepExpiredApprovals: () => Promise<number>;
  failTasksAtAttemptLimit: () => Promise<number>;
  recoverStrandedScheduledTasks: () => Promise<number>;
  retryProviderWalls: () => Promise<number>;
}

export const createMaintenanceSweep = (context: SupportedContext, sweeps: MaintenanceSweeps) => {
  const {
    sweepExpiredApprovals,
    failTasksAtAttemptLimit,
    recoverStrandedScheduledTasks,
    retryProviderWalls
  } = sweeps;
  const { log, store, meterWorkspace, config } = context;
  let maintenanceRun: Promise<void> | null = null;
  /**
   * Each step is contained on its own: an unhandled rejection here would reach Node's default
   * handler and take the whole API down, and a database blip during cleanup should not cost the
   * metering pass or the two sweeps that release held credits. Nothing in here throws, which is
   * what lets the sweeps chain safely.
   */
  const sweepOnce = async (): Promise<void> => {
    const started = performance.now();
    const step = async (event: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        log.error(event, errorFields(error));
      }
    };
    await step('maintenance.project_preparation_failed', () => recoverProjectExecutions(context));
    await step('maintenance.cleanup_failed', () =>
      store.cleanupExpired(config.SECURITY_EVENT_RETENTION_DAYS)
    );
    await step('maintenance.approval_sweep_failed', sweepExpiredApprovals);
    await step('maintenance.attempt_limit_sweep_failed', failTasksAtAttemptLimit);
    await step('maintenance.schedule_recovery_failed', recoverStrandedScheduledTasks);
    await step('maintenance.provider_wall_retry_failed', retryProviderWalls);
    await step('maintenance.metering_failed', async () => {
      const running = await store.listRunningWorkspaces();
      await Promise.all(running.map(meterWorkspace));
    });
    log.debug('maintenance.swept', { durationMs: Math.round(performance.now() - started) });
  };
  /** Sweeps never overlap: a caller that arrives mid-sweep waits and then gets a fresh one. */
  const maintain = (): Promise<void> => {
    const run = (maintenanceRun ?? Promise.resolve()).then(sweepOnce);
    maintenanceRun = run;
    void run.finally(() => {
      if (maintenanceRun === run) maintenanceRun = null;
    });
    return run;
  };
  void maintain();
  const maintenanceTimer = setInterval(() => {
    // A sweep that is still running skips the tick rather than queueing behind itself, so a
    // wedged runner cannot accumulate a backlog of waiting sweeps.
    if (!maintenanceRun) void maintain();
  }, 5 * 60_000);
  maintenanceTimer.unref();

  return { maintain, maintenanceTimer };
};
