import { runJobWaitLoop } from './job-waits.js';
import { createServer } from 'node:http';
import {
  assertMasterKeyOpensDatabase,
  createDatabase,
  DataStore,
  migrateDatabase
} from '@athanor/data';
import { deriveServiceSecret, resolveDataMasterKey } from '@athanor/core';
import { buildLabel } from '@athanor/contracts';
import { AgentWorker } from './agent.js';
import { buildIdentity } from './build-identity.js';
import { loadConfig } from './config.js';
import { failureFields } from './failure-record.js';
import { runLeaseLoops, type WorkerCounters } from './lease.js';
import { workerLogger } from './log.js';
import { runMediaJobLoop } from './media-jobs.js';
import { runCodingMissionLoop } from './coding-mission-loop.js';

const config = loadConfig();
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  ...(config.DATABASE_DRIVER === 'postgres'
    ? { url: config.DATABASE_URL }
    : { pglitePath: config.PGLITE_PATH })
});
await migrateDatabase(database);
const store = new DataStore(database);
const keyRelease = await resolveDataMasterKey(config);
await assertMasterKeyOpensDatabase(database, keyRelease.key);
const worker = new AgentWorker(
  store,
  config,
  keyRelease.key,
  config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(keyRelease.key, 'runner-capabilities'),
  workerLogger
);
let running = true;
const mediaShutdown = new AbortController();
const codingMissionShutdown = new AbortController();
const codingMissionLoop = runCodingMissionLoop({
  store,
  runnerBaseUrl: config.WORKSPACE_RUNNER_URL,
  runnerSecret:
    config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(keyRelease.key, 'runner-capabilities'),
  signal: codingMissionShutdown.signal,
  onError: (error) =>
    workerLogger.error('worker.coding_mission_recovery_failed', failureFields(error))
});
const jobWaitShutdown = new AbortController();
const jobWaitLoop = runJobWaitLoop({
  store,
  masterKey: keyRelease.key,
  runnerBaseUrl: config.WORKSPACE_RUNNER_URL,
  runnerSecret:
    config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(keyRelease.key, 'runner-capabilities'),
  signal: jobWaitShutdown.signal,
  onError: (error) => workerLogger.error('worker.job_wait_recovery_failed', failureFields(error))
});
const mediaLoop = runMediaJobLoop({
  store,
  masterKey: keyRelease.key,
  runnerBaseUrl: config.WORKSPACE_RUNNER_URL,
  runnerSecret:
    config.RUNNER_SHARED_SECRET ?? deriveServiceSecret(keyRelease.key, 'runner-capabilities'),
  workerId: config.WORKER_ID,
  signal: mediaShutdown.signal,
  onError: (error) => workerLogger.error('worker.media_poll_failed', failureFields(error))
});
const counters: WorkerCounters = { active: 0, completed: 0, failed: 0, leaseErrors: 0 };
const health = createServer((request, response) => {
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4');
    response.end(
      `athanor_worker_active ${counters.active}\nathanor_worker_concurrency ${config.WORKER_CONCURRENCY}\nathanor_worker_completed_total ${counters.completed}\nathanor_worker_failed_total ${counters.failed}\nathanor_worker_lease_errors_total ${counters.leaseErrors}\n`
    );
  } else {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, service: 'worker' }));
  }
});
health.listen(config.WORKER_HEALTH_PORT, config.WORKER_HEALTH_HOST);

const shutdown = () => {
  running = false;
  mediaShutdown.abort();
  codingMissionShutdown.abort();
  jobWaitShutdown.abort();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Said once when leasing starts failing and once when it recovers, not every poll: at
// WORKER_POLL_MS a database outage would otherwise write thousands of identical lines into the
// journal and bury the first one, which is the only line that says when it began.
let leaseHealthy = true;
const reportLeaseHealth = (healthy: boolean, error?: unknown): void => {
  if (healthy === leaseHealthy) return;
  leaseHealthy = healthy;
  // The thrown message used to be on this line. A driver quotes back whatever it was handed, so a
  // connection that dropped mid-statement published a piece of it - the code and the frames say the
  // same thing about the box without ever being about the owner.
  if (healthy) workerLogger.info('worker.lease_recovered');
  else workerLogger.error('worker.lease_failed', failureFields(error));
};

// When each in-flight attempt was handed out, so the line a failure writes can say how long it ran.
// Kept here because the lease is what starts that clock: this is the only place that sees both the
// moment a task was taken and the moment it came back. An attempt that finishes clears its own
// entry and a failed one is cleared by the reporter below, so nothing accumulates across a run.
const startedAt = new Map<string, number>();

// Proof that starting up finished. Everything above this line can hang rather than fail - the
// master key, the migration, the health socket - and a worker that never reached the queue looks
// exactly like one whose queue is empty: both say nothing at all. One line, and then silence until
// something happens.
//
// It carries the build because this is the line a restart puts a fresh timestamp on, which makes it
// the one place in the journal where "which code is this box running" is answered next to "since
// when" - the two halves of every question that starts with an update.
workerLogger.info('worker.ready', {
  workerId: config.WORKER_ID,
  concurrency: config.WORKER_CONCURRENCY,
  driver: config.DATABASE_DRIVER,
  build: buildLabel(buildIdentity())
});

await runLeaseLoops({
  concurrency: config.WORKER_CONCURRENCY,
  pollMs: config.WORKER_POLL_MS,
  counters,
  onLeaseHealth: reportLeaseHealth,
  running: () => running,
  lease: () => store.leaseNextTask(config.WORKER_ID, 120),
  run: async (task) => {
    startedAt.set(task.id, Date.now());
    await worker.run(task);
    startedAt.delete(task.id);
  },
  fail: async (task, error) => {
    const began = startedAt.get(task.id);
    startedAt.delete(task.id);
    await worker.fail(task, error, began === undefined ? undefined : Date.now() - began);
  },
  /*
   * Waits on the write rather than on the clock, which is what every announcement into the queue
   * has been for.
   *
   * The API's embedded worker has waited this way for a while; this loop - the one a box with a
   * postgres database actually runs, as athanor@worker.service - slept a flat interval and heard
   * none of it. So a conversation queued behind a running turn became leasable the instant that
   * turn let go and then sat out the rest of a poll before anyone looked, at exactly the moment
   * the owner is watching one answer finish and the next begin. `waitForQueuedTask` returns on the
   * signal or on the interval, whichever comes first, and a subscription that could not be set up
   * leaves the interval doing precisely what it does today - so the worst case here is the
   * behaviour this replaces.
   */
  idle: (milliseconds) => store.waitForQueuedTask(milliseconds)
});

mediaShutdown.abort();
await Promise.all([mediaLoop, codingMissionLoop, jobWaitLoop]);
await new Promise<void>((resolve) => health.close(() => resolve()));
await database.close();
