/**
 * The instrument the tool catalogue's largest saving is gated on.
 *
 * `apps/worker/src/tool-catalogue.test.ts` holds the resident wire under 55,700 bytes and records,
 * in the block above that assertion, the one lever that would take it to 20,505: defer the cold and
 * fat two thirds behind a resident index line and open them on demand. That lever is not refused,
 * it is GATED - on whether production really touches a deferred tool in fewer than 9.2% of turns.
 * The number it is gated against today comes from 83 hand-written eval turns in which the model is
 * a script, and `docs/design/organs/PREAMBLE.md` §10.4 prices the fix at one aggregate over the
 * `tool_started` events the loop already emits. `GET /v1/usage/tool-opens` is that aggregate.
 *
 * Everything here goes through `app.inject` against a real `buildServer`, over a real database, and
 * the events are sealed with the real workspace key by the same `encryptJson` call the worker's
 * `tool-recording.ts` makes. A test that called `summariseToolOpens` on hand-built sets would pass
 * with the route reading the wrong rows, decrypting nothing, or dividing by the wrong denominator -
 * and a wrong denominator here is not a failing test, it is a byte budget cut on a number nobody
 * can reproduce.
 *
 * The two assertions that matter most are the two that are easy to get wrong in the direction that
 * flatters the scheme: a tool called five times in ONE turn is one turn, and a turn that called
 * nothing at all still divides.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptJson, unwrapDataKey } from '@athanor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../config.js';
import { buildServer } from '../server.js';
import { MIN_TURNS_TO_ANSWER, summariseToolOpens, upperBound95 } from './usage.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

/** The base64 master key this server is built with, and the one the events are sealed under. */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>['app'];
  store: Awaited<ReturnType<typeof buildServer>>['store'];
  /** For the one test that has to age a conversation past the window it is asking about. */
  database: Awaited<ReturnType<typeof buildServer>>['database'];
  cookie: string;
  userId: string;
  workspaceId: string;
  /**
   * One conversation, written the way a real turn writes one: a `tool_started` row per dispatched
   * call, sealed exactly as `apps/worker/src/tool-recording.ts` seals it, and a `user_message` row
   * wherever a follow-up opened the next turn. `null` in the list is that boundary.
   */
  conversation: (calls: Array<string | null>) => Promise<string>;
  /** What the route answers, through the owner's session. */
  read: (days?: number) => Promise<Record<string, unknown>>;
}

const buildHarness = async (): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'athanor-tool-opens-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  // Everything this server would reach for over the network is the workspace runner and the model
  // feed, and this suite reads neither. Nothing here calls a provider or spends anything.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
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
    REGISTRATION_BOOTSTRAP_TOKEN: 'tool-opens-pairing-token-with-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 4137,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 4437,
    RESERVED_PREVIEW_PORTS: '4137,4437',
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: MASTER_KEY,
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'athanor Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'tool-opens-test-worker',
    EMBEDDED_WORKER: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_MS: 60_000,
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

  const { app, previewApp, database, store } = await buildServer(config);
  disposers.push(async () => {
    await app.close().catch(() => undefined);
    await previewApp.close().catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  const userId = me.json<{ user: { id: string } }>().user.id;

  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'tool-opens-workspace-0001' },
    payload: { name: 'Opens' }
  });
  if (created.statusCode !== 200) throw new Error(`workspace: ${created.body}`);
  const workspaceId = created.json<{ id: string }>().id;
  const workspace = (await store.listWorkspaces(userId)).find((row) => row.id === workspaceId);
  if (!workspace?.wrappedKey) throw new Error('the new workspace has no wrapped key');
  const key = unwrapDataKey(workspace.wrappedKey, Buffer.from(MASTER_KEY, 'base64'), workspaceId);

  let conversations = 0;
  return {
    app,
    store,
    database,
    cookie,
    userId,
    workspaceId,
    conversation: async (calls) => {
      conversations += 1;
      const task = await store.createTask({
        userId,
        workspaceId,
        titleCiphertext: encryptJson({ title: 'Opens' }, key, `task-title:${workspaceId}`),
        nameIndex: { nameTokens: '', openingTokens: '' },
        modelId: 'qwen',
        privacyRoute: 'provider_zdr',
        maxComputeCredits: 1,
        promptCiphertext: encryptJson(
          { prompt: `conversation ${conversations}` },
          key,
          `task-prompt:${workspaceId}`
        )
      });
      for (const call of calls) {
        if (call === null) {
          await store.appendTaskEvent({
            taskId: task.id,
            kind: 'user_message',
            summary: 'Encrypted user message event',
            payloadCiphertext: encryptJson(
              { __athanorEventVersion: 1, summary: 'and now this', payload: {} },
              key,
              `task-event:${task.id}`
            )
          });
          continue;
        }
        // Byte for byte the shape `tool-recording.ts`'s `event()` writes, including the plaintext
        // summary that carries no name: if this test sealed a different shape it would prove the
        // route can read a payload nothing produces.
        await store.appendTaskEvent({
          taskId: task.id,
          kind: 'tool_started',
          summary: 'Encrypted tool started event',
          payloadCiphertext: encryptJson(
            {
              __athanorEventVersion: 1,
              summary: `Running ${call}`,
              payload: { toolCallId: `call-${call}`, tool: call, arguments: {} }
            },
            key,
            `task-event:${task.id}`
          )
        });
      }
      return task.id;
    },
    read: async (days) => {
      const response = await app.inject({
        method: 'GET',
        url: days === undefined ? '/v1/usage/tool-opens' : `/v1/usage/tool-opens?days=${days}`,
        headers: { cookie }
      });
      if (response.statusCode !== 200) throw new Error(`tool-opens: ${response.body}`);
      return response.json<Record<string, unknown>>();
    }
  };
};

/** The rows the report carries, keyed by tool, for assertions that name one. */
const byTool = (
  report: Record<string, unknown>
): Record<string, { turns: number; shareOfTurns: number; upper95: number }> =>
  Object.fromEntries(
    (
      report.tools as Array<{ tool: string; turns: number; shareOfTurns: number; upper95: number }>
    ).map((row) => [row.tool, row])
  );

describe('the share of turns each tool is reached in', () => {
  it('counts a tool once per turn however many times the turn called it', async () => {
    const harness = await buildHarness();
    // One turn that reaches for `shell` five times, one that reaches for it once, and one that
    // reaches for something else. Deferral opens a schema once per turn - PREAMBLE §6.2 prices the
    // round trip per open, not per call - so counting calls would say 6 of 7 for `shell` where the
    // truth is 2 of 3, and would overstate the cost of deferring exactly the tools that arrive in
    // bursts. Enough conversations to clear the floor, so the rates are actually printed.
    await harness.conversation(['shell', 'shell', 'shell', 'shell', 'shell']);
    await harness.conversation(['shell']);
    await harness.conversation(['file_read']);
    for (let filler = 0; filler < MIN_TURNS_TO_ANSWER - 3; filler += 1)
      await harness.conversation([]);

    const report = await harness.read();
    expect(report.turns).toBe(MIN_TURNS_TO_ANSWER);
    expect(report.decidable).toBe(true);
    expect(byTool(report).shell).toMatchObject({ turns: 2 });
    expect(byTool(report).file_read).toMatchObject({ turns: 1 });
    expect(report.unreadableCalls).toBe(0);
  });

  it('divides by turns that called nothing, because they are turns', async () => {
    const harness = await buildHarness();
    await harness.conversation(['shell']);
    for (let quiet = 0; quiet < MIN_TURNS_TO_ANSWER - 1; quiet += 1) await harness.conversation([]);

    // A conversation the model answered without reaching for anything writes no `tool_started` row
    // at all, and an aggregate built from those rows alone would never see it. Then `shell` would
    // read as 100% of turns instead of 3%, and every tool in the catalogue would look far too hot
    // to defer - which is the one arithmetic error here that cannot be caught by looking at the
    // answer, because a plausible number comes out either way.
    const report = await harness.read();
    expect(report.turns).toBe(MIN_TURNS_TO_ANSWER);
    expect(byTool(report).shell?.turns).toBe(1);
    expect(byTool(report).shell?.shareOfTurns).toBeCloseTo(1 / MIN_TURNS_TO_ANSWER, 10);
  });

  it('counts each follow-up in one conversation as its own turn', async () => {
    const harness = await buildHarness();
    // One conversation, three turns: the opening request and two follow-ups. `createTask` writes no
    // `user_message` for the first, so a reader that counted only those rows would report two.
    await harness.conversation(['shell', null, 'file_read', 'file_read', null, 'shell']);
    for (let filler = 0; filler < MIN_TURNS_TO_ANSWER - 3; filler += 1)
      await harness.conversation([]);

    const report = await harness.read();
    expect(report.tasksScanned).toBe(MIN_TURNS_TO_ANSWER - 2);
    expect(report.turns).toBe(MIN_TURNS_TO_ANSWER);
    expect(byTool(report).shell?.turns).toBe(2);
    expect(byTool(report).file_read?.turns).toBe(1);
  });

  it('refuses to report a rate off a sample that cannot settle anything', async () => {
    const harness = await buildHarness();
    for (let turn = 0; turn < MIN_TURNS_TO_ANSWER - 1; turn += 1)
      await harness.conversation(['shell']);

    // One turn short of the floor. `shell` is in every one of them, so a rate is trivially
    // computable and would be perfectly true - and reporting it is still refused, because the
    // decision this feeds cannot be made from here in either direction and a table of numbers reads
    // as an answer whatever the caveat beside it says.
    const thin = await harness.read();
    expect(thin.turns).toBe(MIN_TURNS_TO_ANSWER - 1);
    expect(thin.decidable).toBe(false);
    expect(thin.tools).toEqual([]);
    expect(thin.minimumTurns).toBe(MIN_TURNS_TO_ANSWER);

    await harness.conversation(['shell']);
    const enough = await harness.read();
    expect(enough.decidable).toBe(true);
    expect(byTool(enough).shell?.turns).toBe(MIN_TURNS_TO_ANSWER);
  });

  it('leaves out of the window a turn that opened before it', async () => {
    const harness = await buildHarness();
    const old = await harness.conversation(['browser_action']);
    await harness.database.query(
      `UPDATE tasks SET created_at = NOW() - INTERVAL '40 days' WHERE id=$1`,
      [old]
    );
    await harness.database.query(
      `UPDATE task_events SET created_at = NOW() - INTERVAL '40 days' WHERE task_id=$1`,
      [old]
    );
    for (let recent = 0; recent < MIN_TURNS_TO_ANSWER; recent += 1)
      await harness.conversation(['shell']);

    // Seven days is what a weekly read asks for, and the conversation from forty days ago is not in
    // it: neither its turn in the denominator nor its `browser_action` in the numerator.
    const week = await harness.read(7);
    expect(week.turns).toBe(MIN_TURNS_TO_ANSWER);
    expect(byTool(week).browser_action).toBeUndefined();

    // And the same instrument over a window that does reach it finds both halves of it.
    const quarter = await harness.read(90);
    expect(quarter.turns).toBe(MIN_TURNS_TO_ANSWER + 1);
    expect(byTool(quarter).browser_action?.turns).toBe(1);
  });

  it('splits a conversation that straddles the window at the turn, not at the conversation', async () => {
    const harness = await buildHarness();
    // One conversation, two turns: an old one that used `browser_action`, and a follow-up today
    // that used `shell`. The conversation is inside the window because its second turn is, so the
    // read opens it - and then the first turn has to be dropped on its own account.
    //
    // This is the case the previous test cannot reach. There the whole conversation was old, so
    // selecting conversations by window was enough and the per-turn filter could have been deleted
    // without a single assertion noticing. Here deleting it counts a turn from forty days ago in
    // this week's denominator and puts a `browser_action` nobody called this week in the numerator.
    const straddler = await harness.conversation(['browser_action', null, 'shell']);
    await harness.database.query(
      `UPDATE tasks SET created_at = NOW() - INTERVAL '40 days' WHERE id=$1`,
      [straddler]
    );
    await harness.database.query(
      `UPDATE task_events SET created_at = NOW() - INTERVAL '40 days' WHERE task_id=$1 AND sequence <= 1`,
      [straddler]
    );
    for (let recent = 0; recent < MIN_TURNS_TO_ANSWER - 1; recent += 1)
      await harness.conversation([]);

    const week = await harness.read(7);
    expect(week.tasksScanned).toBe(MIN_TURNS_TO_ANSWER);
    // The follow-up turn and nothing else out of that conversation.
    expect(week.turns).toBe(MIN_TURNS_TO_ANSWER);
    expect(byTool(week).shell?.turns).toBe(1);
    expect(byTool(week).browser_action).toBeUndefined();

    // Over ninety days both turns of it are there, which is what proves the week's answer dropped a
    // turn that exists rather than a turn this test failed to write.
    const quarter = await harness.read(90);
    expect(quarter.turns).toBe(MIN_TURNS_TO_ANSWER + 1);
    expect(byTool(quarter).browser_action?.turns).toBe(1);
    expect(byTool(quarter).shell?.turns).toBe(1);
  });
});

describe('the floor this instrument refuses below', () => {
  it('is the smallest sample at which a never-called tool can clear the deferral threshold', () => {
    /*
     * The number that chose 33, checked against the number that would change it.
     *
     * PREAMBLE §10.5 defers a tool only if production touches it in fewer than 9.2% of turns under
     * the serial scheme. The strongest evidence this instrument can hold about a candidate is that
     * nobody called it at all, and that carries a 95% upper bound of about 3/n. At 32 turns that
     * bound is still above the threshold, so a tool nobody touched once cannot be cleared and no
     * row printed off 32 turns could move the decision. At 33 it can.
     *
     * If the deferral ships batched, the threshold is 59.8% and the same rule gives n >= 6, so this
     * floor is the conservative of the two. Lowering it is a decision about which scheme is being
     * measured for, not a decision about sample size.
     */
    const SERIAL_THRESHOLD = 0.092;
    expect(3 / (MIN_TURNS_TO_ANSWER - 1)).toBeGreaterThan(SERIAL_THRESHOLD);
    expect(3 / MIN_TURNS_TO_ANSWER).toBeLessThan(SERIAL_THRESHOLD);
    // And the exact bound this instrument actually reports is inside it too, as it must be: it is
    // the tighter of the two, clearing the threshold at 32 where the shorthand needs 33.
    expect(upperBound95(0, MIN_TURNS_TO_ANSWER)).toBeLessThan(SERIAL_THRESHOLD);
    expect(upperBound95(0, MIN_TURNS_TO_ANSWER - 1)).toBeLessThan(SERIAL_THRESHOLD);

    /*
     * The three figures `MIN_TURNS_TO_ANSWER`'s block quotes, pinned here so the block cannot go
     * stale silently. It is the constant whose whole authority is that it was computed rather than
     * chosen, and it once carried a derivation that was false of the bound this instrument prints -
     * so the rewritten block says exactly where the shorthand and the exact bound part company, and
     * every number in that sentence is asserted below.
     *
     * 31 is here and 32 is not the only case, because "the difference is one turn" is a claim about
     * a boundary and a boundary needs the row on each side of it.
     */
    expect(upperBound95(0, 31)).toBeCloseTo(0.0921, 4);
    expect(upperBound95(0, 32)).toBeCloseTo(0.0894, 4);
    expect(upperBound95(0, 31)).toBeGreaterThan(SERIAL_THRESHOLD);
    // The batched threshold the block names as what would change this, on the same shorthand: 3/6
    // is under 59.8% and 3/5 is not, so n >= 6 there against n >= 33 here.
    const BATCHED_THRESHOLD = 0.598;
    expect(3 / 6).toBeLessThan(BATCHED_THRESHOLD);
    expect(3 / 5).toBeGreaterThan(BATCHED_THRESHOLD);
  });

  it('reports the exact zero-count bound, just inside the rule of three', () => {
    // §3.2 quotes 3/83 = 3.61% for its own zero counts. The exact binomial answer is 3.54%, so the
    // shorthand is the looser of the two by 2% of itself - which is the direction that costs
    // nothing, and is why the floor above is derived from the shorthand and the column from this.
    expect(upperBound95(0, 83)).toBeCloseTo(0.0354, 4);
    expect(upperBound95(0, 83)).toBeLessThan(3 / 83);
    // And it is the number carried for every catalogued tool the window never saw, which is the
    // population the deferral set is drawn from.
    expect(
      summariseToolOpens(Array.from({ length: 83 }, () => new Set<string>())).unseenToolUpper95
    ).toBeCloseTo(0.0354, 4);
  });

  it('widens the bound rather than the estimate when a tool is seen a few times', () => {
    // Three turns in 83 is 3.6% measured, and the honest statement about it is 8.7% - two and a
    // half times the point estimate, and close enough to the serial scheme's 9.2% that the two
    // numbers say different things about the same tool. This is the column that decides a marginal
    // row; a point estimate alone would put `memory` and `ask` clear of the threshold in silence.
    const seen = summariseToolOpens(
      Array.from({ length: 83 }, (_, turn) => new Set(turn < 3 ? ['memory'] : []))
    );
    const memory = seen.tools.find((row) => row.tool === 'memory');
    expect(memory?.shareOfTurns).toBeCloseTo(3 / 83, 10);
    expect(memory?.upper95).toBeCloseTo(0.087, 3);
    expect(memory?.upper95).toBeGreaterThan(2 * (3 / 83));
  });
});
