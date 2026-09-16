/**
 * A schedule pinned to a model that is not there any more, and how it stops.
 *
 * The previous behaviour was to take the `model_unavailable` arm, advance `next_run_at`, and do it
 * again on the next occurrence - weekly, forever, with nothing counting and nothing escalating. The
 * two tests that matter here pull in opposite directions: a withdrawn route has to stop the
 * schedule and say so, and a run that merely failed once must not, because a paused schedule needs
 * a person to start it again and a failing one does not.
 *
 * Driven through `runScheduler`, which is `dispatchDueSchedule` itself, so the counting and the
 * pause are exercised where the scheduler actually runs them rather than through a helper.
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

const MODEL = 'openrouter/test/withdrawn-soon';

const modelRow = (availability: 'available' | 'unavailable') => ({
  id: MODEL,
  providerModelId: 'test/withdrawn-soon',
  displayName: 'Withdrawn Soon',
  provider: 'openrouter',
  revision: 'openrouter-live',
  availability,
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
  /** Puts the model back in, or takes it away the way a provider withdrawal does. */
  withdraw: (gone: boolean) => Promise<void>;
  /** Makes the schedule due at a fresh instant and runs one scheduler poll. */
  dispatch: (minutesAgo: number) => Promise<void>;
  schedule: () => Promise<{ enabled: boolean; lastErrorCode: string | null; lastTaskId: string }>;
  /** The decrypted summaries the owner would read on the conversation this run created. */
  summaries: (taskId: string) => Promise<string[]>;
  /** Turns the schedule back on the way the owner does, through the real route. */
  resume: () => Promise<number>;
}

const buildHarness = async (): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-schedule-pause-'));
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
    REGISTRATION_BOOTSTRAP_TOKEN: 'schedule-pause-token-with-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 4132,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 4432,
    RESERVED_PREVIEW_PORTS: '4132,4432',
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: Buffer.alloc(32, 17).toString('base64'),
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'athanor Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'schedule-pause-worker',
    EMBEDDED_WORKER: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_MS: 60_000,
    // The poll is driven by hand below; a timer firing behind an assertion would consume the
    // occurrence the next line is about.
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
  await store.upsertModels([modelRow('available')]);

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  const userId = me.json<{ user: { id: string } }>().user.id;

  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'schedule-pause-workspace' },
    payload: { name: 'Watcher' }
  });
  if (created.statusCode !== 200) throw new Error(`workspace: ${created.body}`);
  const workspaceId = created.json<{ id: string }>().id;
  // A dispatch defers rather than fails while the computer is still coming up, which would make
  // every assertion below about the workspace instead of the model.
  await store.updateWorkspaceStatus(workspaceId, 'running');

  const schedule = await app.inject({
    method: 'POST',
    url: '/v1/schedules',
    headers: { cookie, 'idempotency-key': 'schedule-pause-schedule' },
    payload: {
      workspaceId,
      prompt: 'Read the overnight mail',
      modelId: MODEL,
      spec: { kind: 'interval', everyMinutes: 15 }
    }
  });
  if (schedule.statusCode !== 201) throw new Error(`schedule: ${schedule.body}`);
  const scheduleId = schedule.json<{ id: string }>().id;
  let resumeKey = 0;

  return {
    scheduleId,
    userId,
    withdraw: async (gone) => {
      await store.upsertModels([modelRow(gone ? 'unavailable' : 'available')]);
    },
    dispatch: async (minutesAgo) => {
      /*
       * The previous run ends before the next occurrence comes due, which is what a box does and
       * what this suite has to assume to be about the model at all.
       *
       * Without it the overlap policy in `dispatchOneDueSchedule` takes every occurrence after the
       * first successful one - correctly: a run left `queued` forever is a run still in flight, and
       * a schedule does not start a second copy of itself beside it. Two cases in this file then
       * read `previous_run_active` where they expect a verdict about the model, which is the
       * overlap policy working rather than the model logic failing. Measured: without these two
       * statements, 'does not pause a schedule that failed once and then ran' and 'leaves a
       * schedule alone while its model is available' both go red on `lastErrorCode`.
       */
      await database.query(
        `UPDATE tasks SET status='completed', completed_at=NOW(), updated_at=NOW()
         WHERE schedule_id=$1 AND status NOT IN ('completed','failed','cancelled')`,
        [scheduleId]
      );
      /*
       * A distinct `scheduled_for` per run, because `task_schedule_runs` is keyed on
       * `(schedule_id, scheduled_for)` - two runs claiming the same instant would be one row, and
       * the streak this suite is about is counted over those rows.
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
    },
    resume: async () => {
      resumeKey += 1;
      const response = await app.inject({
        method: 'POST',
        url: `/v1/schedules/${scheduleId}/resume`,
        headers: { cookie, 'idempotency-key': `schedule-pause-resume-${resumeKey}` },
        payload: {}
      });
      return response.statusCode;
    }
  };
};

describe('a schedule pinned to a withdrawn model', () => {
  /**
   * The bound. Delete the pause block in `dispatchOneDueSchedule` and this goes red on `enabled`:
   * the schedule stays on and keeps failing on every occurrence, which is what it did before.
   */
  test('pauses at the threshold and tells the owner which model went away', async () => {
    const harness = await buildHarness();
    await harness.withdraw(true);

    await harness.dispatch(30);
    const afterOne = await harness.schedule();
    await harness.dispatch(20);
    const afterTwo = await harness.schedule();
    await harness.dispatch(10);
    const afterThree = await harness.schedule();

    // Two failures are not enough on their own: the threshold is a threshold and not a hair
    // trigger, and a schedule still enabled here is the difference from the test below.
    expect([afterOne.enabled, afterTwo.enabled]).toEqual([true, true]);
    expect(afterThree.enabled).toBe(false);
    expect(afterThree.lastErrorCode).toBe('model_unavailable');

    const summaries = await harness.summaries(afterThree.lastTaskId);
    const notice = summaries.find((summary) => summary.includes(MODEL));
    expect(notice, summaries.join(' | ')).toBeDefined();
    expect(notice).toContain('paused');
  });

  /**
   * The counter-direction, and the one that would be worse to get wrong. A model that was missing
   * for one occurrence and came back - a catalogue flattened by the registry, a ZDR feed that did
   * not answer - must not cost the owner a watcher that then needs a human to restart it.
   *
   * Four dispatches, one success in the middle: the streak restarts behind it, so the two failures
   * that follow are two and not three.
   */
  test('does not pause a schedule that failed once and then ran', async () => {
    const harness = await buildHarness();

    await harness.withdraw(true);
    await harness.dispatch(40);
    await harness.withdraw(false);
    await harness.dispatch(30);
    await harness.withdraw(true);
    await harness.dispatch(20);
    await harness.dispatch(10);

    const settled = await harness.schedule();
    expect(settled.enabled).toBe(true);
    expect(settled.lastErrorCode).toBe('model_unavailable');
  });

  /**
   * The resume, which is the case the derived streak got wrong and nothing here could see.
   *
   * The count used to be read out of `task_schedule_runs`, and `setTaskScheduleEnabled` does not
   * touch that table, so the three failures that paused the schedule were still its three newest
   * rows the moment the owner turned it back on. Measured before the counter existed: paused after
   * three, resumed, then re-paused by ONE further failure. That is the same threshold reading as one
   * for exactly the owner who has just decided to try again, in exactly the minutes when the
   * transients `MODEL_UNAVAILABLE_PAUSE_AFTER` names are most likely to still be going.
   *
   * Delete `consecutive_failures=0` from `setTaskScheduleEnabled` and this goes red on the second
   * `enabled`, while every test above stays green - which is why the resume needed a case of its
   * own rather than an extra assertion on one of them.
   *
   * What it does NOT pin is which of the two writes clears the streak. The schedule here is paused
   * before it is resumed, so the dispatcher's own `setTaskScheduleEnabled(..., false, ...)` has
   * already zeroed the counter and the resume-side reset is measurably a no-op on this path -
   * measured: reset on disable only and this case is still green. The last case in this file is the
   * one that holds the enable side.
   */
  test('gives a resumed schedule its full patience back', async () => {
    const harness = await buildHarness();
    await harness.withdraw(true);

    await harness.dispatch(50);
    await harness.dispatch(40);
    await harness.dispatch(30);
    const paused = await harness.schedule();
    const resumeStatus = await harness.resume();
    await harness.dispatch(20);
    const afterOneMore = await harness.schedule();

    expect(paused.enabled).toBe(false);
    expect(resumeStatus).toBe(200);
    // Still failing, and still on: one failure after a resume is one, not the fourth of three.
    expect(afterOneMore.enabled).toBe(true);
    expect(afterOneMore.lastErrorCode).toBe('model_unavailable');
  });

  /**
   * The counter-direction on the resumed schedule. Patience restored is not patience removed: three
   * failures after a resume still pause it, so the reset gives the threshold back rather than
   * turning the pause off.
   */
  test('still pauses a resumed schedule after three fresh failures', async () => {
    const harness = await buildHarness();
    await harness.withdraw(true);

    await harness.dispatch(70);
    await harness.dispatch(60);
    await harness.dispatch(50);
    expect((await harness.schedule()).enabled).toBe(false);
    expect(await harness.resume()).toBe(200);

    await harness.dispatch(40);
    await harness.dispatch(30);
    expect((await harness.schedule()).enabled).toBe(true);
    await harness.dispatch(20);

    expect((await harness.schedule()).enabled).toBe(false);
  });

  /**
   * The half of the reset that nothing above can see, and it is the half that has to be written.
   *
   * Both tests above reach `setTaskScheduleEnabled` twice: the dispatcher's own pause calls it with
   * `enabled=FALSE` and zeroes the counter there, so by the time the resume runs the streak is
   * already 0 and the resume-side reset changes nothing. Measured: narrow the statement to
   * `consecutive_failures=CASE WHEN $3 THEN consecutive_failures ELSE 0 END` - reset on disable
   * only, never on enable - and all five cases in this file stay green.
   *
   * This one never lets the schedule pause. Two failures, then the owner turns a schedule that is
   * still enabled back on, which is a real door: `apps/worker/src/tools/scheduling.ts` enables a
   * schedule from the agent's own tool and `POST /v1/schedules/:id/resume` does not ask whether the
   * schedule was off. So the enable side is the only writer here, and with that narrowing the third
   * failure pauses a schedule the owner has just restarted. `lastErrorCode` is asserted with it
   * because a run that quietly stopped failing would make `enabled` true for the wrong reason.
   */
  test('gives patience back to a schedule enabled without a pause first', async () => {
    const harness = await buildHarness();
    await harness.withdraw(true);

    await harness.dispatch(50);
    await harness.dispatch(40);
    const midStreak = await harness.schedule();
    const resumeStatus = await harness.resume();
    await harness.dispatch(30);
    await harness.dispatch(20);
    const settled = await harness.schedule();

    // Never paused, so the dispatcher's own `setTaskScheduleEnabled(..., false, ...)` never ran and
    // the streak this resume clears is one only the enable side can clear.
    expect(midStreak.enabled).toBe(true);
    expect(resumeStatus).toBe(200);
    expect(settled.enabled).toBe(true);
    expect(settled.lastErrorCode).toBe('model_unavailable');
  });

  /** And a schedule whose model never went away is never touched by any of this. */
  test('leaves a schedule alone while its model is available', async () => {
    const harness = await buildHarness();

    await harness.dispatch(40);
    await harness.dispatch(30);
    await harness.dispatch(20);
    await harness.dispatch(10);

    const settled = await harness.schedule();
    expect(settled.enabled).toBe(true);
    expect(settled.lastErrorCode).toBeNull();
  });
});
