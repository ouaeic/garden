/**
 * A schedule whose previous run is still going, and what the next occurrence does about it.
 *
 * The previous behaviour was to start another one. `leaseDueTaskSchedule` selects on due-ness alone
 * and `materializeTaskSchedule` never asks what the last run is doing, so an interval watcher slower
 * than its own interval multiplied itself: two runs, then three, each holding a compute reservation,
 * each spending the owner's provider account on the same instruction over the same files, with the
 * schedule row reading healthy the whole time.
 *
 * Driven through `runScheduler`, which is `dispatchDueSchedule` itself, so the skip is exercised
 * where the scheduler actually runs it. The count of rows in `tasks` is the assertion that matters -
 * a policy that logged a skip and materialised anyway would pass every other check in this file.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiConfig } from '../config.js';
import { buildServer } from '../server.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

const MODEL = 'openrouter/test/overlap';

const modelRow = () => ({
  id: MODEL,
  providerModelId: 'test/overlap',
  displayName: 'Overlap Test',
  provider: 'openrouter',
  revision: 'openrouter-live',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'MIT',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 200_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools'],
  usageClass: 'medium',
  recommendationTags: [],
  measuredQuality: 0.7,
  measuredLatencyMs: 900,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 3,
  metadataSource: 'measured',
  updatedAt: new Date().toISOString()
});

interface Harness {
  scheduleId: string;
  userId: string;
  /** Makes the schedule due at a fresh instant and runs one scheduler poll. */
  dispatch: (minutesAgo: number) => Promise<void>;
  schedule: () => Promise<{ enabled: boolean; lastErrorCode: string | null; lastTaskId: string }>;
  /** Every conversation this schedule has created, newest first. */
  runs: () => Promise<Array<{ id: string; status: string }>>;
  /** Ends the run in flight the way a finished turn does. */
  finish: (taskId: string) => Promise<void>;
  /** Ages the run in flight so it reads as stuck rather than as working. */
  age: (taskId: string, hours: number) => Promise<void>;
  /** The decrypted summaries the owner would read on one conversation. */
  summaries: (taskId: string) => Promise<string[]>;
  /** What the run ledger says about each run this schedule started. */
  ledger: () => Promise<Array<{ taskId: string; outcome: string; errorCode: string | null }>>;
  /** The owner pressing Run now, through the route the button calls. */
  runNow: () => Promise<{ status: number; code: string | null }>;
  /** One scheduler poll and nothing else, so what made the schedule due stays the test's own. */
  poll: () => Promise<void>;
}

const buildHarness = async (): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-schedule-overlap-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
  );

  const config: ApiConfig = {
    DEPLOYMENT_MODE: 'development',
    MODEL_CATALOG_SCOPE: 'reviewed_open_weight',
    CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
    ATHANOR_STATE_PATH: directory,
    RELAY_STATE_DIR: join(directory, 'relay'),
    RELAY_LOCAL_HOST: '127.0.0.1',
    RELAY_LOCAL_PORT: 443,
    RELAY_LOCAL_HTTP_PORT: 80,
    RELAY_LOCAL_PREVIEW_PORT: 8443,
    REGISTRATION_BOOTSTRAP_TOKEN: 'schedule-overlap-token-with-20-chars',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 4133,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 4433,
    RESERVED_PREVIEW_PORTS: '4133,4433',
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: Buffer.alloc(32, 19).toString('base64'),
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'athanor Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'schedule-overlap-worker',
    EMBEDDED_WORKER: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_MS: 60_000,
    // Driven by hand below; a timer firing behind an assertion would consume the occurrence the
    // next line is about.
    SCHEDULER_POLL_MS: 600_000,
    TASK_MAX_STEPS: 3,
    TASK_MAX_SELF_CONTINUATIONS: 0,
    SECURITY_EVENT_RETENTION_DAYS: 30,
    LOG_LEVEL: 'silent',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    AI_PROVIDER: 'openrouter',
    AI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    AI_REQUIRE_ZDR: true,
    AI_FORCE_INHOUSE_WEB: false,
    ALLOW_INSECURE_PROVIDER_URLS: false,
    CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
    PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
  };

  const { app, previewApp, database, store, runScheduler } = await buildServer(config);
  disposers.push(async () => {
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });
  await store.upsertModels([modelRow()]);

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  const userId = me.json<{ user: { id: string } }>().user.id;

  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'schedule-overlap-workspace' },
    payload: { name: 'Watcher' }
  });
  if (created.statusCode !== 200) throw new Error(`workspace: ${created.body}`);
  const workspaceId = created.json<{ id: string }>().id;
  // A dispatch defers rather than runs while the computer is still coming up, which would make
  // every assertion below about the workspace instead of the overlap.
  await store.updateWorkspaceStatus(workspaceId, 'running');

  const schedule = await app.inject({
    method: 'POST',
    url: '/v1/schedules',
    headers: { cookie, 'idempotency-key': 'schedule-overlap-schedule' },
    payload: {
      workspaceId,
      prompt: 'Watch the overnight queue',
      modelId: MODEL,
      // The shortest interval this software offers, which is the setting that invites the defect.
      spec: { kind: 'interval', everyMinutes: 15 }
    }
  });
  if (schedule.statusCode !== 201) throw new Error(`schedule: ${schedule.body}`);
  const scheduleId = schedule.json<{ id: string }>().id;
  let runKey = 0;

  return {
    scheduleId,
    userId,
    dispatch: async (minutesAgo) => {
      /*
       * A distinct `scheduled_for` per run, because `task_schedule_runs` is keyed on
       * `(schedule_id, scheduled_for)` - two runs claiming the same instant would be one row.
       */
      await database.query(
        `UPDATE task_schedules
         SET next_run_at=NOW() - ($2 * INTERVAL '1 minute'), lease_owner=NULL, lease_expires_at=NULL
         WHERE id=$1`,
        [scheduleId, minutesAgo]
      );
      await runScheduler();
    },
    schedule: async () => {
      const record = await store.getTaskSchedule(userId, scheduleId);
      if (!record) throw new Error('the schedule disappeared');
      return {
        enabled: record.enabled,
        lastErrorCode: record.lastErrorCode,
        lastTaskId: String(record.lastTaskId)
      };
    },
    runs: async () => {
      const result = await database.query<{ id: string; status: string }>(
        'SELECT id, status FROM tasks WHERE schedule_id=$1 ORDER BY created_at DESC, id',
        [scheduleId]
      );
      return result.rows.map((row) => ({ id: String(row.id), status: String(row.status) }));
    },
    finish: async (taskId) => {
      await database.query(
        "UPDATE tasks SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1",
        [taskId]
      );
    },
    age: async (taskId, hours) => {
      await database.query(
        `UPDATE tasks SET updated_at=NOW() - ($2 * INTERVAL '1 hour') WHERE id=$1`,
        [taskId, hours]
      );
    },
    ledger: async () => {
      const result = await database.query<{
        task_id: string;
        outcome: string;
        error_code: string | null;
      }>(
        'SELECT task_id, outcome, error_code FROM task_schedule_runs WHERE schedule_id=$1 ORDER BY scheduled_for',
        [scheduleId]
      );
      return result.rows.map((row) => ({
        taskId: row.task_id,
        outcome: row.outcome,
        errorCode: row.error_code
      }));
    },
    poll: async () => {
      await runScheduler();
    },
    runNow: async () => {
      runKey += 1;
      const response = await app.inject({
        method: 'POST',
        url: `/v1/schedules/${scheduleId}/run`,
        headers: { cookie, 'idempotency-key': `schedule-overlap-run-${runKey}` },
        payload: {}
      });
      const body = response.json<{ error?: { code?: string } }>();
      return { status: response.statusCode, code: body.error?.code ?? null };
    },
    summaries: async (taskId) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/tasks/${taskId}/events`,
        headers: { cookie }
      });
      const body = response.json<
        Array<{ summary?: string }> | { events?: Array<{ summary?: string }> }
      >();
      const events = Array.isArray(body) ? body : (body.events ?? []);
      return events.map((event) => event.summary ?? '');
    }
  };
};

describe('a schedule whose previous run has not finished', () => {
  /**
   * The bound. Delete the `inFlight` block in `dispatchOneDueSchedule` and this goes red on the run
   * count: three occurrences produce three conversations rather than one, which is what the
   * dispatcher did before - three compute reservations and three model turns on one instruction.
   */
  test('skips the occurrence instead of starting a second copy of itself', async () => {
    const harness = await buildHarness();

    await harness.dispatch(45);
    const first = await harness.runs();
    await harness.dispatch(30);
    await harness.dispatch(15);
    const after = await harness.runs();
    const settled = await harness.schedule();

    // The first occurrence ran and is still in flight. `promoteScheduledTask` leaves it `queued`
    // because the workspace is already running, and `queued` is a run that is going to cost money.
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe('queued');
    // Two more occurrences came due and neither of them created anything.
    expect(after.map((run) => run.id)).toEqual(first.map((run) => run.id));
    expect(settled.enabled).toBe(true);
    expect(settled.lastErrorCode).toBe('previous_run_active');
  });

  /**
   * The counter-direction, and the one that would be worse to get wrong: a policy that skipped
   * whenever the schedule had ever run would silence every schedule on this box permanently after
   * its first occurrence. The run finishes and the very next occurrence starts a new conversation.
   */
  test('runs again as soon as the previous run has finished', async () => {
    const harness = await buildHarness();

    await harness.dispatch(45);
    const [first] = await harness.runs();
    await harness.dispatch(30);
    const blocked = await harness.runs();
    await harness.finish(String(first?.id));
    await harness.dispatch(15);
    const released = await harness.runs();
    const settled = await harness.schedule();

    expect(blocked).toHaveLength(1);
    expect(released).toHaveLength(2);
    // The skip left its code on the row; a run that then succeeded clears it, so the schedule does
    // not go on reading "last run failed" for a skip that has been resolved.
    expect(settled.lastErrorCode).toBeNull();
    expect(settled.enabled).toBe(true);
  });

  /**
   * The other end of the bound: skipping forever is a schedule that has been silently switched off,
   * which is the failure this policy would otherwise introduce. A run nothing has touched for more
   * than `OVERLAP_SKIP_STUCK_SECONDS` stops the schedule and says so on the conversation that is
   * blocking it.
   */
  test('pauses and tells the owner when the run in flight is stuck', async () => {
    const harness = await buildHarness();

    await harness.dispatch(45);
    const [first] = await harness.runs();
    await harness.age(String(first?.id), 25);
    await harness.dispatch(30);
    const settled = await harness.schedule();
    const summaries = await harness.summaries(String(first?.id));

    expect(settled.enabled).toBe(false);
    expect(await harness.runs()).toHaveLength(1);
    /*
     * And the run that is blocking is NOT recorded as failed. It queued, it is still open, and the
     * owner can go and read it - which is why the pause goes through
     * `pauseTaskScheduleWithReason` rather than through `failMaterializedTaskSchedule`, whose
     * second statement would have stamped `outcome='failed'` onto a conversation that is working.
     */
    expect(await harness.ledger()).toEqual([
      { taskId: String(first?.id), outcome: 'queued', errorCode: null }
    ]);
    const notice = summaries.find((summary) => summary.includes('paused'));
    expect(notice, summaries.join(' | ')).toBeDefined();
    expect(notice).toContain('open for more than a day');
  });

  /**
   * And its counter-direction, which is the case that decides whether the threshold is a threshold
   * or a hair trigger. A run that has been open for hours - an approval card raised in the evening
   * and answered the next morning is the ordinary shape of this - is skipped and not paused.
   */
  test('does not pause a schedule whose run is merely slow', async () => {
    const harness = await buildHarness();

    await harness.dispatch(45);
    const [first] = await harness.runs();
    await harness.age(String(first?.id), 23);
    await harness.dispatch(30);
    const settled = await harness.schedule();

    expect(settled.enabled).toBe(true);
    expect(settled.lastErrorCode).toBe('previous_run_active');
    expect(await harness.runs()).toHaveLength(1);
  });

  /**
   * The owner pressing Run now is not a clock, and the policy above was answering them as though
   * they were.
   *
   * `run` set `next_run_at` to now and returned 200. The very next poll leased the schedule, found
   * the previous run open, and deferred it - so nothing started, and five minutes later the row
   * carried `previous_run_active`, which the web client renders as "last run failed" for a run that
   * did not fail and did not happen. An owner who asks for a run is entitled to a run or to a
   * sentence, and this is the sentence: at the button, where they are looking, naming the
   * conversation that is in the way.
   *
   * Delete the `action === 'run'` block in `routes/schedules.ts` and this goes red twice - on the
   * 200 and on the code - while the run count stays at one, which is the silence exactly.
   */
  test('refuses an owner-initiated run while the previous one is open, at the button', async () => {
    const harness = await buildHarness();

    await harness.dispatch(45);
    const before = await harness.schedule();
    const refused = await harness.runNow();
    const after = await harness.schedule();

    expect(refused.status).toBe(409);
    expect(refused.code).toBe('previous_run_active');
    // Nothing was created and nothing was armed: the refusal is the whole answer.
    expect(await harness.runs()).toHaveLength(1);
    // And the schedule is untouched - not disabled, and not stamped with a failure code for a run
    // that was refused rather than attempted. The five-minute-later false failure is the thing this
    // replaced, so the row must not carry it now either.
    expect(after.enabled).toBe(true);
    expect(after.lastErrorCode).toBe(before.lastErrorCode);
  });

  /**
   * The counter-direction, and the one that decides whether this is a refusal or a broken button: a
   * schedule whose previous run has ended runs on demand, immediately, without waiting for its own
   * clock. It is also how an owner deliberately gets a second run - end the first, then ask again -
   * which is why the refusal above is not a cap on how often a schedule may be run by hand.
   */
  test('runs on demand as soon as the previous run has ended', async () => {
    const harness = await buildHarness();

    await harness.dispatch(45);
    const [first] = await harness.runs();
    expect((await harness.runNow()).status).toBe(409);
    await harness.finish(String(first?.id));
    const accepted = await harness.runNow();
    // `run` is what armed it - this poll does not touch `next_run_at`, so a second conversation
    // below is proof the route made the schedule due and not the harness.
    await harness.poll();

    expect(accepted.status).toBe(200);
    expect(await harness.runs()).toHaveLength(2);
  });
});
