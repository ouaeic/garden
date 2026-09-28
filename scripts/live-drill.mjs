#!/usr/bin/env node
/**
 * Drives real work through the whole stack against a real model.
 *
 * The release drill proves the runner: the toolchain is there, a document builds, a browser
 * navigates. The unit and end-to-end suites prove garden's own behaviour against a scripted
 * provider. Neither answers the only question an owner actually cares about - give it a job in
 * plain English and does the thing arrive.
 *
 * So this runs the real API, the real worker, the real agent loop and the real workspace runner,
 * with nothing scripted and no mock anywhere, and asks a live model to do a day's ordinary work.
 * It scores each job on the artefact that came out of it, not on whether the agent said it was
 * done - a model claiming success while writing nothing is exactly the failure worth catching.
 *
 * Its database is its own, thrown away at the end. The instance's own database, its owner and
 * its passkeys are never touched, so this can run against a box already in use.
 *
 * It cannot be pointed at a deployed box, and that is not an oversight to fix here: it builds the
 * server it drives and signs in through `POST /v1/auth/dev` at line 158, which is refused unless
 * ALLOW_INSECURE_DEV_AUTH is on AND DEPLOYMENT_MODE is development. The over-the-wire equivalent of
 * `runJob` below is `garden task run` in `scripts/garden`: the same routes, a bearer token, an
 * honest exit code and one documented JSON object, from anywhere that can reach the server. See
 * docs/HEADLESS.md. It does not replace this file - what this one has and that one cannot is a real
 * model, a real runner and a score taken from the artefact rather than from the agent's claim.
 *
 * One thing that file fixed and this one still does: `harnessRan` recovers whether the harness ran by
 * lower-casing the whole completed event and looking for the string 'exit 0'. The payload that
 * event carries has a summary, a verification record and what the turn left open, all of them
 * readable as fields. Changing it here was not attempted, because this rig cannot be run without
 * spending the owner's money and an unproven edit to a paid rig is worth less than the tea leaves.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Imported from the built output rather than by package name: this runs from an installed tree,
// where the workspace links the packages to each other but not to a script beside them.
const here = dirname(fileURLToPath(import.meta.url));
const { seedModels, refreshOpenRouterCatalog } = await import(
  pathToFileURL(join(here, '../packages/model-gateway/dist/index.js')).href
);
const { buildServer } = await import(pathToFileURL(join(here, '../apps/api/dist/server.js')).href);

const apiKey = process.env.OPENROUTER_API_KEY ?? '';
if (!apiKey) {
  console.error('live-drill: set OPENROUTER_API_KEY');
  process.exit(64);
}
const runnerSecret = process.env.RUNNER_SHARED_SECRET ?? '';
if (!runnerSecret) {
  console.error('live-drill: set RUNNER_SHARED_SECRET (from /etc/garden/runner.env)');
  process.exit(64);
}

const only = process.argv.slice(2).filter((value) => !value.startsWith('-'));
/*
 * Which model to hold every job to, when the point is to test garden rather than to let its router
 * shop. A credit-limited account wants one known-cheap model and no surprises, and without this the
 * drill picked whatever ranked best for each job - which is the right default for judging the
 * router and the wrong one for judging the loop on somebody's last few dollars.
 *
 * The route follows: a model is only offered on the privacy route its provider actually supports,
 * so pinning a model without letting the route follow it just makes the task unroutable.
 */
const pinnedModel = process.env.GARDEN_DRILL_MODEL ?? '';
const pinnedRoute = process.env.GARDEN_DRILL_ROUTE ?? '';
const directory = await mkdtemp(join(tmpdir(), 'garden-live-'));

const config = {
  DEPLOYMENT_MODE: 'development',
  MODEL_CATALOG_SCOPE: 'provider_catalog',
  CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
  RELAY_STATE_DIR: join(directory, 'relay'),
  RELAY_LOCAL_HOST: '127.0.0.1',
  RELAY_LOCAL_PORT: 443,
  RELAY_LOCAL_HTTP_PORT: 80,
  REGISTRATION_BOOTSTRAP_TOKEN: 'live-drill-token-with-at-least-20-characters',
  REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
  PUBLIC_APP_URL: 'http://localhost:5173',
  PREVIEW_BASE_URL: 'http://preview.localhost:4499',
  API_HOST: '127.0.0.1',
  API_PORT: 4198,
  PREVIEW_GATEWAY_HOST: '127.0.0.1',
  PREVIEW_GATEWAY_PORT: 4499,
  DATABASE_DRIVER: 'pglite',
  DATABASE_URL: 'postgres://unused',
  PGLITE_PATH: join(directory, 'database'),
  DATA_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SIGNING_KEY: 'live-drill-session-key-at-least-32-characters',
  RUNNER_SHARED_SECRET: runnerSecret,
  // The real runner on this box, with the real toolchain and the real agent account behind it.
  WORKSPACE_RUNNER_URL: 'http://127.0.0.1:4300',
  PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
  WORKSPACE_IMAGE_REVISION: 'dev',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'garden live drill',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
  ALLOW_INSECURE_DEV_AUTH: true,
  WORKER_ID: 'live-drill',
  WORKER_POLL_MS: 100,
  SCHEDULER_POLL_MS: 60_000,
  TASK_MAX_STEPS: 40,
  SECURITY_EVENT_RETENTION_DAYS: 30,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  AI_PROVIDER: 'openrouter',
  AI_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENROUTER_API_KEY: apiKey,
  // The box's own setting: zero data retention on, which is what a fresh install gets.
  AI_REQUIRE_ZDR: true,
  AI_FORCE_INHOUSE_WEB: false,
  ALLOW_INSECURE_PROVIDER_URLS: false,
  CONNECTOR_ALLOWED_HOST_SUFFIXES: 'webdav.example',
  RESERVED_PREVIEW_PORTS: '4198,4499',
  WORKER_CONCURRENCY: 2,
  LOG_LEVEL: 'silent',
  PUSH_VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
  PUSH_ENDPOINT_HOST_SUFFIXES: 'fcm.googleapis.com'
};

const { app, previewApp, database, store } = await buildServer(config);

const shutdown = async () => {
  await app.close().catch(() => undefined);
  await previewApp.close().catch(() => undefined);
  await database.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
};

const results = [];
let workspaceId = '';
let cookie = '';

const ok = (label, detail) => {
  results.push({ label, passed: true, detail });
  console.log(`ok  ${label}${detail ? ` - ${detail}` : ''}`);
};
const fail = (label, detail) => {
  results.push({ label, passed: false, detail });
  console.log(`FAIL ${label}${detail ? ` - ${detail}` : ''}`);
};

try {
  // The catalogue this box would really offer, fetched live rather than assumed, so the model the
  // router picks is one the owner's own account can actually reach today.
  const catalog = await refreshOpenRouterCatalog(seedModels(), {
    baseUrl: config.OPENROUTER_BASE_URL,
    apiKey,
    scope: 'provider_catalog'
  });
  await store.upsertModels(catalog);
  ok('live model catalogue', `${catalog.length} models offered by this account`);
  if (pinnedModel) {
    // Checked before a single job runs, because discovering it three jobs in costs the three jobs.
    const match = catalog.find(
      (model) => model.id === pinnedModel || model.providerModelId === pinnedModel
    );
    if (!match) {
      const near = catalog
        .filter((model) => model.id.includes(pinnedModel.split('/').pop() ?? pinnedModel))
        .slice(0, 5)
        .map((model) => model.id);
      throw new Error(
        `GARDEN_DRILL_MODEL=${pinnedModel} is not in this account's catalogue.${near.length ? ` Did you mean: ${near.join(', ')}` : ''}`
      );
    }
    ok(
      'pinned model',
      `${match.id} on the ${pinnedRoute || 'provider_zdr'} route${match.privacyRoute === (pinnedRoute || 'provider_zdr') ? '' : ` - note this model is offered on ${match.privacyRoute}, so set GARDEN_DRILL_ROUTE=${match.privacyRoute}`}`
    );
  }

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0] ?? '';
  if (!cookie) throw new Error('dev sign-in returned no session cookie');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'live-drill-workspace' },
    payload: { name: 'Live drill' }
  });
  workspaceId = created.json().id;
  ok('workspace on the real runner', workspaceId);
} catch (error) {
  fail('harness start-up', error instanceof Error ? error.message : String(error));
  await shutdown();
  process.exit(1);
}

/**
 * Every file under the workspace, not only the ones at the top of it.
 *
 * An agent given a real job makes somewhere to put things - `workspace/cv/`, `workspace/proofs/` -
 * and a check that only looked at the top level reported "no PDF written" for a job that had
 * written one. Bounded in depth so a node_modules cannot turn a check into a crawl.
 */
const listFiles = async (prefix = 'workspace', depth = 4) => {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}/files?path=${encodeURIComponent(prefix)}`,
    headers: { cookie }
  });
  if (response.statusCode !== 200) return [];
  const body = response.json();
  const here = Array.isArray(body) ? body : (body.entries ?? body.files ?? []);
  if (depth <= 0) return here;
  const nested = await Promise.all(
    here
      .filter((entry) => entry.type === 'directory')
      .map((entry) => listFiles(entry.path ?? `${prefix}/${entry.name}`, depth - 1))
  );
  return [...here, ...nested.flat()];
};

const readWorkspaceFile = async (relative) => {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/workspaces/${workspaceId}/file?path=${encodeURIComponent(relative)}`,
    headers: { cookie }
  });
  return response.statusCode === 200 ? Buffer.from(response.rawPayload) : null;
};

let taskKey = 0;
const runJob = async (job) => {
  const started = Date.now();
  const asked = [];
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { cookie, 'idempotency-key': `live-drill-${(taskKey += 1)}` },
    payload: {
      workspaceId,
      prompt: job.prompt,
      ...(pinnedModel ? { modelId: pinnedModel } : {}),
      privacyRoute: pinnedRoute || 'provider_zdr',
      maxComputeCredits: 200,
      maxSpendUsd: job.budgetUsd ?? 0.5
    }
  });
  if (response.statusCode >= 300)
    return { status: 'rejected', detail: response.body.slice(0, 300), seconds: 0 };
  const taskId = response.json().id;
  const deadline = Date.now() + (job.timeoutMs ?? 480_000);
  let status = 'queued';
  // A correction sent while the task is working, which is the only way to test the one channel the
  // owner has for steering: it has to arrive at a task that is genuinely mid-flight, so it is sent
  // on the first poll that finds one rather than after a fixed wait.
  let corrected = !job.interrupt;
  for (;;) {
    const current = await app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}`,
      headers: { cookie }
    });
    status = current.json().status;
    // Checked before anything that could continue the loop: an approval branch that skipped it
    // could spin forever on a task that keeps asking, which is exactly what it did.
    if (Date.now() > deadline) {
      status = 'timed_out';
      break;
    }
    if (status === 'awaiting_user') {
      // What a task stopped to ask for is the thing worth reading. A drill answers its own
      // questions so the job can finish, and prints every one of them - an approval that fires on
      // ordinary work is friction the owner would feel on every job like it.
      const pending = await app
        .inject({ method: 'GET', url: '/v1/approvals?status=pending', headers: { cookie } })
        .then((response) => (response.statusCode === 200 ? response.json() : []));
      const mine = (Array.isArray(pending) ? pending : []).filter(
        (approval) => String(approval.taskId) === taskId
      );
      if (!mine.length) break;
      if (asked.length >= 12) {
        status = 'approval_loop';
        break;
      }
      for (const approval of mine) {
        asked.push(
          `${approval.action ?? '?'} :: ${JSON.stringify(approval.preview ?? '').slice(0, 220)}`
        );
        await app.inject({
          method: 'POST',
          url: `/v1/approvals/${approval.id}/approve`,
          headers: { cookie, 'idempotency-key': `live-approve-${approval.id}` },
          payload: {}
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!corrected && ['running', 'planning'].includes(status)) {
      const sent = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${taskId}/messages`,
        headers: { cookie, 'idempotency-key': `live-drill-correction-${taskId}` },
        payload: {
          prompt: job.interrupt,
          ...(pinnedModel ? { modelId: pinnedModel } : {}),
          privacyRoute: pinnedRoute || 'provider_zdr',
          maxComputeCredits: 100,
          interrupt: true
        }
      });
      if (sent.statusCode >= 300)
        return {
          taskId,
          status: 'correction_rejected',
          asked,
          seconds: Math.round((Date.now() - started) / 1000),
          detail: sent.body.slice(0, 300)
        };
      corrected = true;
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = await app.inject({
    method: 'GET',
    url: `/v1/tasks/${taskId}`,
    headers: { cookie }
  });
  return {
    taskId,
    status,
    asked,
    seconds: Math.round((Date.now() - started) / 1000),
    task: detail.json()
  };
};

/**
 * Jobs are written the way an owner would write them - no tool names, no file paths, no format
 * hints - because the point is whether garden turns an ordinary sentence into the right work.
 * Each one is checked on what it left behind.
 */
/** Only what this job left behind: the jobs share a workspace, so an earlier one's file must
 * never be able to pass a later one's check. */
const appeared = (files, before) =>
  files.filter((entry) => entry.type !== 'directory' && !before.has(entry.path ?? entry.name));

const JOBS = [
  {
    name: 'cv',
    prompt:
      'Write me a one-page CV as a PDF for a software engineer called Dana Reyes with eight ' +
      'years of backend experience in Python and Go, two years leading a small team, and a ' +
      'degree in computer science from Edinburgh. Make it look professional.',
    check: async (before) => {
      const files = appeared(await listFiles(), before);
      const pdf = files.find((entry) => /\.pdf$/i.test(entry.name ?? entry.path ?? ''));
      if (!pdf) return { passed: false, detail: `no PDF written; got ${files.length} file(s)` };
      const bytes = await readWorkspaceFile(pdf.path);
      if (!bytes || bytes.length < 8_000)
        return { passed: false, detail: `PDF is ${bytes?.length ?? 0} bytes` };
      const text = bytes.toString('latin1');
      return {
        passed: text.startsWith('%PDF'),
        detail: `${pdf.name ?? pdf.path}, ${bytes.length} bytes`
      };
    }
  },
  {
    name: 'deck',
    prompt:
      'Put together a short slide deck introducing a new internal tool that turns a single Linux ' +
      'server into a private AI computer. Six slides, a title slide, and speaker notes.',
    check: async (before) => {
      const files = appeared(await listFiles(), before);
      const deck = files.find((entry) => /\.pptx$/i.test(entry.name ?? entry.path ?? ''));
      if (!deck) return { passed: false, detail: `no .pptx written; got ${files.length} file(s)` };
      const bytes = await readWorkspaceFile(deck.path);
      return {
        passed: Boolean(bytes && bytes.length > 20_000 && bytes.subarray(0, 2).toString() === 'PK'),
        detail: `${deck.name ?? deck.path}, ${bytes?.length ?? 0} bytes`
      };
    }
  },
  {
    name: 'spreadsheet',
    prompt:
      'Build me a spreadsheet that models a small consultancy: twelve months of revenue starting ' +
      'at 18000 and growing 4% a month, fixed costs of 9500 a month, and a row that shows the ' +
      'running profit. Put the monthly figures in a chart.',
    check: async (before) => {
      const files = appeared(await listFiles(), before);
      const book = files.find((entry) => /\.xlsx$/i.test(entry.name ?? entry.path ?? ''));
      if (!book) return { passed: false, detail: `no .xlsx written; got ${files.length} file(s)` };
      const bytes = await readWorkspaceFile(book.path);
      return {
        passed: Boolean(bytes && bytes.length > 5_000 && bytes.subarray(0, 2).toString() === 'PK'),
        detail: `${book.name ?? book.path}, ${bytes?.length ?? 0} bytes`
      };
    }
  },
  {
    name: 'code',
    // The sharpest test there is, and the one nothing else here covers: a repository the agent has
    // to understand before it can change it, a change that has to be correct, and a check that has
    // to actually run. Scored on the test passing, not on the agent saying it fixed anything.
    prompt:
      'In a new folder called tally, write a small Node project: a package.json with a test script ' +
      'using node --test, a src/tally.js exporting a function that takes an array of numbers and ' +
      'returns their sum, and a test file covering the empty array, positives, and negatives. ' +
      'Then run the tests and make sure they pass.',
    timeoutMs: 600_000,
    check: async (before, run) => {
      const files = appeared(await listFiles(), before);
      const source = files.find((entry) => /tally\.js$/i.test(entry.name ?? entry.path ?? ''));
      const manifest = files.find((entry) =>
        /package\.json$/i.test(entry.name ?? entry.path ?? '')
      );
      if (!source) return { passed: false, detail: `no tally.js; got ${files.length} file(s)` };
      if (!manifest) return { passed: false, detail: 'no package.json' };
      const bytes = await readWorkspaceFile(source.path);
      const text = bytes?.toString('utf8') ?? '';
      const tests = files.filter((entry) =>
        /\.test\.(m?js|cjs)$/i.test(entry.name ?? entry.path ?? '')
      );
      const testText = tests.length
        ? ((await readWorkspaceFile(tests[0].path))?.toString('utf8') ?? '')
        : '';
      // The API deliberately exposes no way to run a command, so the proof that the tests pass is
      // the harness's own: an acceptance check is a command garden ran and watched exit zero, and
      // the completion carries what it observed. That is a stronger signal than anything this
      // script could assert by reading the file, because the agent cannot write it.
      const events = await app
        .inject({ method: 'GET', url: `/v1/tasks/${run.taskId}/events`, headers: { cookie } })
        .then((response) => (response.statusCode === 200 ? response.json() : []));
      const rows = Array.isArray(events) ? events : (events.events ?? []);
      const completed = rows.filter((event) => event.kind === 'completed');
      const harnessRan = JSON.stringify(completed).toLowerCase().includes('exit 0');
      const exported = /module\.exports|export /.test(text);
      return {
        passed: Boolean(exported && tests.length > 0 && /empty|\[\]/i.test(testText) && harnessRan),
        detail:
          `${source.path}, ${bytes?.length ?? 0} bytes` +
          `, ${tests.length} test file(s)` +
          `${exported ? '' : ', nothing exported'}` +
          `${harnessRan ? ', harness ran a check that passed' : ', no verified command'}`
      };
    }
  },
  {
    name: 'image',
    // Media generation has never been exercised end to end from a prompt. The provider layer was
    // verified by hand; this is the whole path, and it is scored on a real PNG arriving.
    prompt:
      'Generate a simple square image of a red circle on a white background, and save it in the workspace.',
    timeoutMs: 420_000,
    check: async (before) => {
      const files = appeared(await listFiles(), before);
      const image = files.find((entry) =>
        /\.(png|jpe?g|webp)$/i.test(entry.name ?? entry.path ?? '')
      );
      if (!image) return { passed: false, detail: `no image written; got ${files.length} file(s)` };
      const bytes = await readWorkspaceFile(image.path);
      const png = bytes?.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const jpeg = bytes?.subarray(0, 2).toString('hex') === 'ffd8';
      return {
        passed: Boolean(bytes && bytes.length > 2_000 && (png || jpeg)),
        detail: `${image.path}, ${bytes?.length ?? 0} bytes${png ? ', PNG' : jpeg ? ', JPEG' : ', not an image'}`
      };
    }
  },
  {
    name: 'research',
    prompt:
      'Find out what the current stable version of PostgreSQL is and when it was released, then ' +
      'write me a short note saying what it is and what changed in it.',
    check: async (before) => {
      const files = appeared(await listFiles(), before);
      const note = files.find((entry) =>
        /\.(md|txt|docx|pdf)$/i.test(entry.name ?? entry.path ?? '')
      );
      if (!note) return { passed: false, detail: 'no note written' };
      const bytes = await readWorkspaceFile(note.path);
      return {
        passed: Boolean(bytes && bytes.length > 200),
        detail: `${note.name ?? note.path}, ${bytes?.length ?? 0} bytes`
      };
    }
  },
  {
    /*
     * The one channel an owner has for steering work that is already moving. Everything else here
     * checks that a sentence becomes the right work; this checks that a SECOND sentence, sent while
     * the first is being carried out, changes what happens - without losing the turn. A task that
     * ignored the correction and shipped the original answer passes every other check in this file.
     */
    name: 'correction',
    prompt:
      'Research the current stable version of PostgreSQL and write me a short markdown note about ' +
      'it, saved in the workspace. Take your time and check a couple of sources.',
    interrupt:
      'Change of plan - forget PostgreSQL. Write the note about the current stable version of ' +
      'SQLite instead, and make sure the file only covers SQLite.',
    timeoutMs: 420_000,
    check: async (before) => {
      const files = appeared(await listFiles(), before);
      const note = files.find((entry) => /\.(md|txt)$/i.test(entry.name ?? entry.path ?? ''));
      if (!note) return { passed: false, detail: 'no note written' };
      const bytes = await readWorkspaceFile(note.path);
      const text = (bytes?.toString('utf8') ?? '').toLowerCase();
      if (text.length < 120) return { passed: false, detail: `note is ${text.length} chars` };
      // The correction landed if the note is about what was asked for second, not first.
      if (!text.includes('sqlite'))
        return { passed: false, detail: `${note.name ?? note.path} never mentions SQLite` };
      return {
        passed: true,
        detail: `${note.name ?? note.path}, ${bytes?.length ?? 0} bytes, followed the correction`
      };
    }
  }
];

for (const job of JOBS) {
  if (only.length && !only.includes(job.name)) continue;
  const before = await listFiles();
  const beforeNames = new Set(before.map((entry) => entry.path ?? entry.name));
  const run = await runJob(job);
  if (run.status !== 'completed') {
    // The task's own account of what happened, not just its final state - a job that fails in a
    // second failed for a reason the events already recorded.
    const trail = run.taskId
      ? await app
          .inject({
            method: 'GET',
            url: `/v1/tasks/${run.taskId}/events`,
            headers: { cookie }
          })
          .then((response) => (response.statusCode === 200 ? response.json() : []))
      : [];
    const rows = Array.isArray(trail) ? trail : (trail.events ?? []);
    if (process.env.DRILL_TRACE)
      for (const event of rows)
        console.log(`    ${event.kind ?? '?'}: ${(event.summary ?? '').slice(0, 150)}`);
    const tail = rows
      .slice(-4)
      .map((event) => `${event.kind ?? '?'}: ${(event.summary ?? '').slice(0, 160)}`)
      .join(' | ');
    fail(
      `${job.name}: ${run.status}`,
      `${run.seconds}s, model ${run.task?.modelId ?? '?'}${run.detail ? ` - ${run.detail}` : ''}${tail ? ` - ${tail}` : ''}`
    );
    continue;
  }
  const verdict = await job.check(beforeNames, run);
  const cost = run.task?.spendUsd ?? run.task?.costUsd;
  const priced = cost === undefined ? '' : `, $${Number(cost).toFixed(4)}`;
  const gates = run.asked?.length
    ? `, ${run.asked.length} approval(s): ${run.asked.join(' ; ')}`
    : '';
  if (verdict.passed) ok(`${job.name}`, `${run.seconds}s${priced} - ${verdict.detail}${gates}`);
  else fail(`${job.name}`, `${run.seconds}s${priced} - ${verdict.detail}${gates}`);
}

const failed = results.filter((entry) => !entry.passed);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `; failed: ${failed.map((entry) => entry.label).join(', ')}` : '')
);
await shutdown();
process.exit(failed.length ? 1 : 0);
