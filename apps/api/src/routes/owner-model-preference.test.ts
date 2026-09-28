/**
 * The owner's model dial, on the runs nobody is watching.
 *
 * `OwnerPreferences.model` was validated, persisted and read back by exactly one consumer - the
 * browser - so every pick the server made for itself used the literal 'balanced'. This drives the
 * production path a schedule takes, `POST /v1/schedules` with no `modelId`, because that is the
 * unattended half: whatever it answers is what runs at three in the morning, months later.
 *
 * Everything here goes through `app.inject` against a real `buildServer`. A test that called
 * `pickModelUnderPriceCeiling` directly would pass with the route still hardcoding the literal,
 * which is the defect shape this tree has shipped four times.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedModels } from '@garden/model-gateway';
import { ProjectModelPreferences } from '@garden/contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiConfig } from '../config.js';
import { buildServer } from '../server.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  vi.unstubAllGlobals();
});

/** One live-feed entry, in the shape OpenRouter answers `/models` with. */
const feedModel = (id: string) => ({
  id,
  context_length: 200_000,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0.000001', completion: '0.000003' },
  supported_parameters: ['tools', 'reasoning']
});

/**
 * Three routes that disagree about which is best, so a preference has somewhere to move to.
 *
 * `providerAvailable` is deliberately absent: `applyOpenRouterPrivacyPolicy` returns a row it has
 * not been told about unchanged, which keeps availability and privacy route exactly as written here
 * rather than as a function of a ZDR feed this suite is not about.
 */
const routableModel = (input: {
  id: string;
  quality: number;
  latencyMs: number;
  inputUsd: number;
  outputUsd: number;
  usageClass: string;
}) => ({
  id: input.id,
  providerModelId: input.id.replace(/^openrouter\//, ''),
  displayName: input.id,
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
  usageClass: input.usageClass,
  recommendationTags: [],
  measuredQuality: input.quality,
  measuredLatencyMs: input.latencyMs,
  inputUsdPerMillionTokens: input.inputUsd,
  outputUsdPerMillionTokens: input.outputUsd,
  metadataSource: 'measured',
  updatedAt: new Date().toISOString()
});

const SWIFT = 'openrouter/test/swift';
const MIDDLE = 'openrouter/test/middle';
const DEEP = 'openrouter/test/deep';
const UNPRICED = 'openrouter/test/unpriced';
const HALF_DEAR = 'openrouter/test/half-dear';
const HALF_CHEAP = 'openrouter/test/half-cheap';

/**
 * A route the catalogue carries and publishes no rate for.
 *
 * Not an exotic case: every row of the reviewed open-weight seed allowlist in
 * `packages/model-gateway/src/catalog.ts` has both rates null, so this is what the whole catalogue
 * looks like on a box whose live price refresh has not run yet or is failing. Priced at zero and
 * then nulled rather than built from a second literal, so it differs from its neighbours in exactly
 * the two fields under test.
 */
const unpricedModel = {
  ...routableModel({
    id: UNPRICED,
    quality: 0.55,
    latencyMs: 1_000,
    inputUsd: 0,
    outputUsd: 0,
    usageClass: 'medium'
  }),
  inputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: null
};

/**
 * Priced on one side and not the other, which is not a contrivance: `perMillion` in
 * `packages/model-gateway/src/openrouter-catalog.ts` reads `pricing.prompt` and `pricing.completion`
 * independently, so a feed that omits one side produces this row - and a stated rate above the
 * credible ceiling produces it too, because on a `reviewed_open_weight` box such a route is kept
 * with the price removed rather than dropped.
 *
 * `HALF_DEAR` publishes $900 per million out against the $15 ceiling these tests set, so the
 * catalogue has answered the ceiling's question on the side it can. `HALF_CHEAP` publishes $9,
 * under the same ceiling, so there the question is genuinely unanswered.
 */
const halfPricedModel = (id: string, outputUsd: number) => ({
  ...routableModel({
    id,
    quality: 0.7,
    latencyMs: 1_000,
    inputUsd: 0,
    outputUsd,
    usageClass: 'medium'
  }),
  inputUsdPerMillionTokens: null
});

const catalogue = [
  routableModel({
    id: SWIFT,
    quality: 0.3,
    latencyMs: 250,
    inputUsd: 0.15,
    outputUsd: 0.4,
    usageClass: 'light'
  }),
  routableModel({
    id: MIDDLE,
    quality: 0.62,
    latencyMs: 1_200,
    inputUsd: 3,
    outputUsd: 9,
    usageClass: 'medium'
  }),
  routableModel({
    id: DEEP,
    quality: 0.8,
    latencyMs: 20_000,
    inputUsd: 30,
    outputUsd: 90,
    usageClass: 'extra_high'
  })
];

interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>['app'];
  store: Awaited<ReturnType<typeof buildServer>>['store'];
  cookie: string;
  workspaceId: string;
  /** The signed-in owner, for the store calls that take a user id rather than a cookie. */
  userId: string;
  /** Sets the stored preference the way the browser does, through the route that writes it. */
  savePreference: (model: Record<string, unknown>) => Promise<void>;
  /** Creates a schedule with no `modelId` and answers with the model the server picked for it. */
  scheduledModel: (options?: { modelId?: string; headers?: Record<string, string> }) => Promise<{
    statusCode: number;
    modelId: string | undefined;
  }>;
  /** Mints an API token with exactly these scopes. */
  token: (scopes: string[]) => Promise<string>;
}

const buildHarness = async (options: {
  catalogScope: ApiConfig['MODEL_CATALOG_SCOPE'];
  /** What the provider answers `/models` with. Empty by default: this suite writes its own rows. */
  feed?: Array<ReturnType<typeof feedModel>>;
  /** Skip writing the three routable models, for the catalogue-scope test. */
  seedCatalogue?: boolean;
}): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), 'garden-preference-'));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const feed = options.feed ?? [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      if (url.split('?')[0]!.endsWith('/models')) return json({ data: feed });
      if (url.endsWith('/endpoints/zdr'))
        return json({ data: feed.map((model) => ({ model_id: model.id, status: 0 })) });
      // Everything else on this box is the workspace runner, which answers nothing this suite reads.
      return json({});
    })
  );

  const config: ApiConfig = {
    DEPLOYMENT_MODE: 'development',
    MODEL_CATALOG_SCOPE: options.catalogScope,
    CONNECTION_MANIFEST_PATH: join(directory, 'connection.json'),
    GARDEN_STATE_PATH: directory,
    RELAY_STATE_DIR: join(directory, 'relay'),
    RELAY_LOCAL_HOST: '127.0.0.1',
    RELAY_LOCAL_PORT: 443,
    RELAY_LOCAL_HTTP_PORT: 80,
    RELAY_LOCAL_PREVIEW_PORT: 8443,
    REGISTRATION_BOOTSTRAP_TOKEN: 'preference-pairing-token-with-20-characters',
    REGISTRATION_BOOTSTRAP_EXPIRES_AT: Math.floor(Date.now() / 1000) + 86_400,
    PUBLIC_APP_URL: 'http://localhost:5173',
    PREVIEW_BASE_URL: 'http://preview.localhost:4400',
    API_HOST: '127.0.0.1',
    API_PORT: 4131,
    PREVIEW_GATEWAY_HOST: '127.0.0.1',
    PREVIEW_GATEWAY_PORT: 4431,
    RESERVED_PREVIEW_PORTS: '4131,4431',
    DATABASE_DRIVER: 'pglite',
    DATABASE_URL: 'postgres://unused',
    PGLITE_PATH: join(directory, 'database'),
    DATA_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
    SESSION_SIGNING_KEY: 'session-secret-with-at-least-32-characters',
    RUNNER_SHARED_SECRET: 'runner-secret-with-at-least-32-characters',
    WORKSPACE_RUNNER_URL: 'http://workspace-manager.test',
    PUBLIC_RUNNER_URL: 'ws://127.0.0.1:4300',
    WORKSPACE_IMAGE_REVISION: 'dev',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'garden Test',
    WEBAUTHN_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_DEV_AUTH: true,
    WORKER_ID: 'preference-test-worker',
    EMBEDDED_WORKER: false,
    WORKER_CONCURRENCY: 1,
    WORKER_POLL_MS: 60_000,
    // Long enough that the scheduler never fires behind these assertions.
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
  if (options.seedCatalogue !== false) await store.upsertModels(catalogue);

  const login = await app.inject({ method: 'POST', url: '/v1/auth/dev', payload: {} });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
  if (!cookie) throw new Error('dev sign-in returned no session cookie');
  const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie } });
  const userId = me.json<{ user: { id: string } }>().user.id;

  const created = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    headers: { cookie, 'idempotency-key': 'preference-workspace-0001' },
    payload: { name: 'Preference' }
  });
  if (created.statusCode !== 200) throw new Error(`workspace: ${created.body}`);
  const workspaceId = created.json<{ id: string }>().id;

  let scheduleKey = 0;
  return {
    app,
    store,
    cookie,
    workspaceId,
    userId,
    savePreference: async (model) => {
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/account/preferences',
        headers: { cookie },
        payload: { model }
      });
      if (saved.statusCode !== 200) throw new Error(`preferences: ${saved.body}`);
    },
    scheduledModel: async (input = {}) => {
      scheduleKey += 1;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/schedules',
        headers: {
          ...(input.headers ?? { cookie }),
          'idempotency-key': `preference-schedule-${scheduleKey}`
        },
        payload: {
          workspaceId,
          prompt: 'Summarise what changed overnight',
          spec: { kind: 'interval', everyMinutes: 60 },
          ...(input.modelId ? { modelId: input.modelId } : {})
        }
      });
      return {
        statusCode: response.statusCode,
        modelId:
          response.statusCode === 201 ? response.json<{ modelId: string }>().modelId : undefined
      };
    },
    token: async (scopes) => {
      const issued = await app.inject({
        method: 'POST',
        url: '/v1/api-tokens',
        headers: { cookie },
        payload: { label: `scoped ${scopes.join('+')}`, scopes, expiresInDays: 7 }
      });
      if (issued.statusCode !== 200) throw new Error(`token: ${issued.body}`);
      return issued.json<{ token: string }>().token;
    }
  };
};

describe('model choices across settings, drafts and the first prompt', () => {
  test('applies one eligibility and price verdict to named prompt, project, follow-up and schedule choices', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.store.setSpendLimits({
      userId: harness.userId,
      maxInputUsdPerMillionTokens: 5,
      maxOutputUsdPerMillionTokens: 15,
      defaultTaskCapUsd: 2,
      dailyCapUsd: 100,
      monthlyCapUsd: 200
    });
    const beforeLimits = await harness.store.effectiveSpendLimits(harness.userId);
    const base = catalogue[0]!;
    const cases = [
      { model: base, allowed: true },
      { model: catalogue[2]!, allowed: false },
      { model: unpricedModel, allowed: true },
      {
        model: { ...base, id: 'openrouter/test/no-tools', capabilities: ['chat'] },
        allowed: false
      },
      {
        model: { ...base, id: 'openrouter/test/short-context', contextTokens: 8_000 },
        allowed: false
      },
      {
        model: { ...base, id: 'openrouter/test/retired', availability: 'unavailable' },
        allowed: false
      },
      {
        model: { ...base, id: 'openrouter/test/external', privacyRoute: 'external' },
        allowed: false
      }
    ];
    expect(cases.length).toBeGreaterThan(0);
    await harness.store.upsertModels(cases.map((item) => item.model));
    const headers = { cookie: harness.cookie };
    const preview = await harness.app.inject({
      method: 'GET',
      url: '/v1/models?purpose=main&privacyRoute=provider_zdr',
      headers
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const options = preview.json<Array<{ id: string; unavailableReason: string | null }>>();
    expect(options.length).toBeGreaterThan(0);
    for (const item of cases) {
      const option = options.find((model) => model.id === item.model.id);
      if (item.model.privacyRoute === 'external') expect(option).toBeUndefined();
      else {
        expect(option, item.model.id).toBeDefined();
        expect(Boolean(option!.unavailableReason), item.model.id).toBe(!item.allowed);
      }
    }
    const create = (selection: Record<string, unknown>) =>
      harness.app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: {
          workspaceId: harness.workspaceId,
          prompt: 'Check a model selection',
          ...selection
        }
      });
    const parent = await create({ modelId: SWIFT });
    expect(parent.statusCode, parent.body).toBe(200);
    const parentId = parent.json<{ id: string }>().id;
    expect((await harness.store.getTask(harness.userId, parentId))?.modelOverride).toBe(true);
    for (const item of [...cases, { model: { id: 'openrouter/test/missing' }, allowed: false }]) {
      const direct = await create({ modelId: item.model.id });
      const project = await create({
        modelChoices: {
          main: { automatic: false, preference: 'balanced', modelId: item.model.id }
        }
      });
      expect(direct.statusCode, `${item.model.id}: ${direct.body}`).toBe(item.allowed ? 200 : 400);
      expect(project.statusCode, `${item.model.id}: ${project.body}`).toBe(direct.statusCode);
      if (item.allowed) {
        expect(direct.json<{ modelId: string }>().modelId).toBe(item.model.id);
        expect(project.json<{ modelId: string }>().modelId).toBe(item.model.id);
      } else {
        expect(direct.json()).toMatchObject({ error: { code: 'model_unavailable' } });
        expect(project.json()).toMatchObject({
          error: {
            code: 'model_unavailable',
            message: direct.json<{ error: { message: string } }>().error.message
          }
        });
        const followup = await harness.app.inject({
          method: 'POST',
          url: `/v1/tasks/${parentId}/messages`,
          headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
          payload: { prompt: 'Use this model', modelId: item.model.id }
        });
        expect(followup.statusCode, followup.body).toBe(400);
        expect(followup.json()).toMatchObject({
          error: {
            code: 'model_unavailable',
            message: direct.json<{ error: { message: string } }>().error.message
          }
        });
      }
      const schedule = await harness.scheduledModel({ modelId: item.model.id });
      expect(schedule.statusCode, `${item.model.id}: ${JSON.stringify(schedule)}`).toBe(
        item.allowed ? 201 : 400
      );
    }
    expect(await harness.store.effectiveSpendLimits(harness.userId)).toEqual(beforeLimits);
    expect(await harness.store.getNextQueuedTaskMessage(parentId)).toBeNull();
  });

  test('persists the decision opt-out while preserving saved model choices', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    const headers = { cookie: harness.cookie };
    const pin = { automatic: false, preference: 'fast', modelId: 'openrouter/decision-saved' };
    const update = await harness.app.inject({
      method: 'PUT',
      url: '/v1/account/preferences',
      headers,
      payload: { decisionModelsEnabled: false, modelPurposes: { decisions: pin } }
    });
    expect(update.statusCode).toBe(200);
    const read = await harness.app.inject({
      method: 'GET',
      url: '/v1/account/preferences',
      headers
    });
    expect(read.json()).toMatchObject({
      preferences: { decisionModelsEnabled: false, modelPurposes: { decisions: pin } }
    });
    const surface = await harness.app.inject({
      method: 'GET',
      url: '/v1/workspace-model-preferences',
      headers
    });
    expect(surface.statusCode).toBe(200);
    const preferences = ProjectModelPreferences.parse(surface.json());
    expect(preferences.decisionModelsEnabled).toBe(false);
    expect(preferences.purposes.find((item) => item.purpose === 'decisions')).toMatchObject({
      disabled: true,
      effective: null,
      available: false
    });
    await harness.app.inject({
      method: 'PUT',
      url: '/v1/account/preferences',
      headers,
      payload: { decisionModelsEnabled: true }
    });
    const restored = await harness.app.inject({
      method: 'GET',
      url: '/v1/account/preferences',
      headers
    });
    expect(restored.json()).toMatchObject({
      preferences: { decisionModelsEnabled: true, modelPurposes: { decisions: pin } }
    });
    const inactive = await harness.app.inject({
      method: 'GET',
      url: '/v1/workspace-model-preferences',
      headers
    });
    expect(inactive.statusCode).toBe(200);
    expect(
      ProjectModelPreferences.parse(inactive.json()).purposes.find(
        (item) => item.purpose === 'decisions'
      )
    ).toMatchObject({
      disabled: true,
      effective: null,
      available: false,
      options: [],
      reason: 'Decision models are not in use. All features work without one.'
    });
  });

  test('round-trips auxiliary defaults and controls without prompt text, then creates the project with its choices', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    const headers = { cookie: harness.cookie };
    const choice = { automatic: false, preference: 'balanced', modelId: SWIFT };
    const defaults = await harness.app.inject({
      method: 'PUT',
      url: '/v1/account/preferences',
      headers,
      payload: {
        model: choice,
        modelPurposes: {
          summarise: choice,
          title: choice,
          decisions: { automatic: true, preference: 'balanced', modelId: '' }
        }
      }
    });
    expect(defaults.statusCode, defaults.body).toBe(200);
    const global = await harness.app.inject({
      method: 'GET',
      url: '/v1/workspace-model-preferences',
      headers
    });
    expect(global.statusCode, global.body).toBe(200);
    const surface = ProjectModelPreferences.parse(global.json());
    expect(surface.choices).toMatchObject({
      main: choice,
      summarise: choice,
      title: choice,
      decisions: { automatic: true, preference: 'balanced', modelId: '' }
    });
    expect(surface.purposes).not.toHaveLength(0);
    expect(surface.purposes.find((item) => item.purpose === 'summarise')?.effective?.id).toBe(
      SWIFT
    );

    const modelChoices = {
      main: { ...choice, modelId: MIDDLE },
      coding: choice,
      decisions: { automatic: true, preference: 'balanced', modelId: '' },
      image: { automatic: true, preference: 'best', modelId: '' }
    };
    const controls = {
      modelId: MIDDLE,
      modelChoices,
      reasoningEffort: 'auto',
      privacyRoute: 'provider_zdr',
      spendCap: ''
    };
    const draft = await harness.app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      payload: { workspaceId: harness.workspaceId, body: '', controls }
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const bootstrap = await harness.app.inject({ method: 'GET', url: '/v1/bootstrap', headers });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json<{ drafts: unknown[] }>().drafts).toEqual([
      expect.objectContaining({ body: '', controls })
    ]);

    const payload = {
      workspaceId: harness.workspaceId,
      prompt: 'Create a project using these choices',
      modelChoices
    };
    const createHeaders = { ...headers, 'idempotency-key': 'model-choices-create-0001' };
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: createHeaders,
      payload
    });
    expect(created.statusCode, created.body).toBe(200);
    const task = created.json<{ id: string; modelId: string }>();
    expect(task.modelId).toBe(MIDDLE);
    const read = await harness.app.inject({
      method: 'GET',
      url: `/v1/projects/${task.id}/model-preferences`,
      headers
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(ProjectModelPreferences.parse(read.json())).toMatchObject({
      revision: 1,
      choices: modelChoices
    });
    const localRead = await harness.app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.id}/model-preferences`,
      headers
    });
    expect(ProjectModelPreferences.parse(localRead.json())).toMatchObject({
      revision: 0,
      choices: {}
    });
    const localSaved = await harness.app.inject({
      method: 'PUT',
      url: `/v1/tasks/${task.id}/model-preferences`,
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      payload: {
        expectedRevision: 0,
        choices: { main: { automatic: true, preference: 'fast', modelId: '' } }
      }
    });
    expect(localSaved.statusCode, localSaved.body).toBe(200);
    expect(ProjectModelPreferences.parse(localSaved.json())).toMatchObject({
      revision: 1,
      choices: { main: { automatic: true, preference: 'fast', modelId: '' } }
    });
    const localReload = await harness.app.inject({
      method: 'GET',
      url: `/v1/tasks/${task.id}/model-preferences`,
      headers
    });
    expect(localReload.json()).toMatchObject({
      projectTaskId: task.id,
      revision: localSaved.json<{ revision: number }>().revision,
      choices: localSaved.json<{ choices: unknown }>().choices
    });
    const projectReload = await harness.app.inject({
      method: 'GET',
      url: `/v1/projects/${task.id}/model-preferences`,
      headers
    });
    expect(ProjectModelPreferences.parse(projectReload.json()).choices).toEqual(modelChoices);
    const retried = await harness.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: createHeaders,
      payload
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json<{ id: string }>().id).toBe(task.id);

    const conflict = await harness.app.inject({
      method: 'PUT',
      url: `/v1/projects/${task.id}/model-preferences`,
      headers: { ...headers, 'idempotency-key': 'model-choice-conflict-0001' },
      payload: { expectedRevision: 0, choices: {} }
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    const retained = await harness.app.inject({
      method: 'GET',
      url: `/v1/projects/${task.id}/model-preferences`,
      headers
    });
    expect(ProjectModelPreferences.parse(retained.json()).choices).toEqual(modelChoices);

    const cleared = await harness.app.inject({
      method: 'PUT',
      url: '/v1/drafts',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      payload: { workspaceId: harness.workspaceId, body: '', attachments: [], expectedRevision: 1 }
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const empty = await harness.app.inject({ method: 'GET', url: '/v1/bootstrap', headers });
    expect(empty.json<{ drafts: unknown[] }>().drafts).toEqual([
      expect.objectContaining({ body: '', revision: 2 })
    ]);
  });

  test('rolls back creation if project preferences cannot be saved', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    const before = await harness.store.listTasks(harness.userId, harness.workspaceId);
    const write = vi
      .spyOn(harness.store, 'putProjectModelPreferences')
      .mockRejectedValueOnce(new Error('Storage unavailable'));
    const result = await harness.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { cookie: harness.cookie, 'idempotency-key': 'model-choices-rollback-0001' },
      payload: {
        workspaceId: harness.workspaceId,
        prompt: 'Do not queue without my choices',
        modelId: SWIFT,
        modelChoices: { coding: { automatic: false, preference: 'fast', modelId: MIDDLE } }
      }
    });
    expect(result.statusCode, result.body).toBe(500);
    expect(write).toHaveBeenCalledOnce();
    write.mockRestore();
    expect(await harness.store.listTasks(harness.userId, harness.workspaceId)).toHaveLength(
      before.length
    );
  });
});

describe('the owner preference on an unattended pick', () => {
  /**
   * The bound. Revert `preference: choice?.preference ?? 'balanced'` in `pickModelUnderPriceCeiling`
   * to the literal `'balanced'` and all three answers collapse onto the same model, which is what
   * this owner has been getting on every scheduled run.
   */
  test('picks a different model for each preference the owner can set', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });

    await harness.savePreference({ automatic: true, preference: 'fast', modelId: '' });
    const fast = await harness.scheduledModel();
    await harness.savePreference({ automatic: true, preference: 'balanced', modelId: '' });
    const balanced = await harness.scheduledModel();
    await harness.savePreference({ automatic: true, preference: 'best', modelId: '' });
    const best = await harness.scheduledModel();

    expect([fast.statusCode, balanced.statusCode, best.statusCode]).toEqual([201, 201, 201]);
    expect(fast.modelId).toBe(SWIFT);
    expect(balanced.modelId).toBe(MIDDLE);
    expect(best.modelId).toBe(DEEP);
  });

  /**
   * The same pick through the other unattended door. A bearer token creating a schedule is the
   * headless client the whole preference argument is about, and it must not get a second answer.
   */
  test('honours the same preference for a schedule created by an API token', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    const token = await harness.token(['tasks:write', 'tasks:read']);

    await harness.savePreference({ automatic: true, preference: 'best', modelId: '' });
    const viaToken = await harness.scheduledModel({
      headers: { authorization: `Bearer ${token}` }
    });

    expect(viaToken.statusCode).toBe(201);
    expect(viaToken.modelId).toBe(DEEP);
  });

  /**
   * The counter-direction that matters most: the request still wins. An owner who names a model on
   * the call has said something more specific than a setting made weeks ago, and `routes/tasks.ts`
   * and `routes/schedules.ts` both branch before the picker is reached. Delete that branch and this
   * goes red while the test above stays green.
   */
  test('lets an explicit modelId on the request beat the stored preference', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.savePreference({ automatic: true, preference: 'best', modelId: '' });

    const named = await harness.scheduledModel({ modelId: SWIFT });

    expect(named.statusCode).toBe(201);
    expect(named.modelId).toBe(SWIFT);
  });

  /** An owner who has never touched the control is still routed the way they always were. */
  test('resolves to balanced when nothing has ever been stored', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });

    const untouched = await harness.scheduledModel();

    expect(untouched.statusCode).toBe(201);
    expect(untouched.modelId).toBe(MIDDLE);
  });

  /**
   * The trap. `use-model-choice.ts` writes the currently recommended id into `modelId` on every
   * ranking it receives, so the field is populated on an owner who has never pinned anything. Read
   * as a pin it would freeze every unattended run on whatever the picker last showed - here, the
   * fast route, against a preference that says best.
   */
  test('ignores the modelId that automatic mode leaves behind', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });

    await harness.savePreference({ automatic: true, preference: 'best', modelId: SWIFT });
    const automatic = await harness.scheduledModel();

    expect(automatic.statusCode).toBe(201);
    expect(automatic.modelId).toBe(DEEP);
  });

  /** `automatic: false` is the owner naming a route outright, and it is honoured by name. */
  test('runs a standing pin on the model the owner named', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });

    await harness.savePreference({ automatic: false, preference: 'best', modelId: SWIFT });
    const pinned = await harness.scheduledModel();

    expect(pinned.statusCode).toBe(201);
    expect(pinned.modelId).toBe(SWIFT);
  });

  /**
   * And the pin falls back rather than refusing. A boundary that stops everything is an outage: a
   * route the catalogue can no longer serve must not turn a working watcher into a permanent
   * `model_unavailable` over a setting made months ago.
   */
  test('falls back to the ranking when the pinned model is no longer in the catalogue', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });

    await harness.savePreference({
      automatic: false,
      preference: 'best',
      modelId: 'openrouter/test/withdrawn'
    });
    const recovered = await harness.scheduledModel();

    expect(recovered.statusCode).toBe(201);
    expect(recovered.modelId).toBe(DEEP);
  });

  /**
   * The bound the other pin tests cannot see, because their harness has no ceiling set and every
   * assertion above therefore passes with the ceiling ignored entirely.
   *
   * Measured before the fix: with $1/$2 stored, a pin on DEEP - $30 in, $90 out, thirty and
   * forty-five times over - was honoured for a schedule while the ranked pick on the same box was
   * correctly held. `selectModel`'s `requestedId` arm lifts the ceiling by contract, and a pin went
   * through that arm. So the pin is now honoured only when that arm comes back with no message.
   *
   * The ceiling here admits SWIFT and MIDDLE and refuses DEEP, so both directions are legible in
   * the same run: the fallback lands on MIDDLE (the ranking under 'best'), which is neither the pin
   * nor the model an unbounded pin would have bought. Restore `pinned?.choice ? pinned : select()`
   * in `pickModelUnderPriceCeiling` and this goes red on DEEP.
   */
  test('drops a standing pin that is over the owner price ceiling', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.store.setSpendLimits({
      userId: harness.userId,
      maxInputUsdPerMillionTokens: 5,
      maxOutputUsdPerMillionTokens: 15
    });

    await harness.savePreference({ automatic: false, preference: 'best', modelId: DEEP });
    const dropped = await harness.scheduledModel();

    expect(dropped.statusCode, JSON.stringify(dropped)).toBe(201);
    expect(dropped.modelId).toBe(MIDDLE);
  });

  /**
   * The counter-direction, and the one a ceiling that refused everything would break. A pin the
   * owner set that is inside their own ceiling is still honoured, and it is honoured over the
   * ranking: under 'best' with this ceiling the ranking answers MIDDLE, so SWIFT here can only have
   * come from the pin. Widen the new test to `pinned?.choice ? select() : select()` - a ceiling that
   * drops every pin - and this goes red while the test above stays green.
   */
  test('keeps a standing pin that is inside the owner price ceiling', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.store.setSpendLimits({
      userId: harness.userId,
      maxInputUsdPerMillionTokens: 5,
      maxOutputUsdPerMillionTokens: 15
    });

    await harness.savePreference({ automatic: false, preference: 'best', modelId: SWIFT });
    const kept = await harness.scheduledModel();

    expect(kept.statusCode, JSON.stringify(kept)).toBe(201);
    expect(kept.modelId).toBe(SWIFT);
  });

  /**
   * The half the first version of the ceiling guard got wrong, and the reason `selectModel` now
   * reports which exclusion it is instead of one sentence for both.
   *
   * That guard dropped the pin whenever the `requestedId` arm came back with a message, and
   * `priceCeilingBreach` emits its one sentence for a route with no published rate as well as for
   * one over the ceiling. So an owner who set a ceiling lost their standing pin on every unpriced
   * route, free ones included. The ruling: a published rate over the ceiling loses the pin (the
   * test above), an absent rate does not, because the ceiling has no verdict to enforce.
   *
   * Under 'best' with this ceiling the ranking answers MIDDLE, so UNPRICED here can only have come
   * from the pin. Restore `pinned.message === null` as the guard in `pickModelUnderPriceCeiling`
   * and this goes red on MIDDLE while every other pin test in this file stays green.
   */
  test('keeps a standing pin on a route the catalogue publishes no price for', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.store.upsertModels([unpricedModel]);
    await harness.store.setSpendLimits({
      userId: harness.userId,
      maxInputUsdPerMillionTokens: 5,
      maxOutputUsdPerMillionTokens: 15
    });

    await harness.savePreference({ automatic: false, preference: 'best', modelId: UNPRICED });
    const honoured = await harness.scheduledModel();

    expect(honoured.statusCode, JSON.stringify(honoured)).toBe(201);
    expect(honoured.modelId).toBe(UNPRICED);
  });

  /**
   * The hole the first version of this ruling left, measured at the same door.
   *
   * `priceCeilingBreachReason` tested `input === null` before it compared any published rate, so a
   * route priced on the output side and not the input side came back `no_published_price` - and
   * this guard honours that kind. A pin on a $900-per-million-output route therefore ran unattended
   * under a $15 output ceiling: measured through POST /v1/schedules, the pin was returned rather
   * than MIDDLE. The catalogue had published a rate; nothing looked at it.
   *
   * Both halves are asserted in one run, because a fix that simply dropped every partly-priced pin
   * would pass the first assertion and break the ruling: a rate the ceiling admits on the side that
   * is published leaves the ceiling with nothing to enforce, so that pin still stands. Under 'best'
   * with this ceiling the ranking answers MIDDLE, so HALF_CHEAP can only have come from the pin.
   *
   * Put the `input === null` test back in front of the comparisons and the first assertion goes red
   * at HALF_DEAR while every other pin test in this file stays green.
   */
  test('drops a pin whose published rate breaches the ceiling on the side the catalogue priced', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.store.upsertModels([
      halfPricedModel(HALF_DEAR, 900),
      halfPricedModel(HALF_CHEAP, 9)
    ]);
    await harness.store.setSpendLimits({
      userId: harness.userId,
      maxInputUsdPerMillionTokens: 5,
      maxOutputUsdPerMillionTokens: 15
    });

    await harness.savePreference({ automatic: false, preference: 'best', modelId: HALF_DEAR });
    const dear = await harness.scheduledModel();
    await harness.savePreference({ automatic: false, preference: 'best', modelId: HALF_CHEAP });
    const cheap = await harness.scheduledModel();

    expect(dear.statusCode, JSON.stringify(dear)).toBe(201);
    expect(dear.modelId).toBe(MIDDLE);
    expect(cheap.statusCode, JSON.stringify(cheap)).toBe(201);
    expect(cheap.modelId).toBe(HALF_CHEAP);
  });

  /**
   * The same ruling where it stops being a preference and starts being an outage.
   *
   * With no priced row in the catalogue there is no ranked pick under a ceiling at all -
   * `isModelEligible` excludes every unpriced route from an automatic pick, which is a separate and
   * deliberate rule - so the ranking answers 402 and the pin is the only thing that can answer at
   * all. Measured with the guard reading `message === null`: 402 on this exact catalogue, which is
   * schedule creation stopping outright on a box whose price refresh has not run.
   *
   * `seedCatalogue: false` so the store holds the boot seeds - the reviewed allowlist, every row
   * unpriced - plus the one row this test names.
   */
  test('still creates a schedule on a wholly unpriced catalogue when the owner pinned a route', async () => {
    const harness = await buildHarness({
      catalogScope: 'reviewed_open_weight',
      seedCatalogue: false
    });
    await harness.store.upsertModels([unpricedModel]);
    await harness.store.setSpendLimits({
      userId: harness.userId,
      maxInputUsdPerMillionTokens: 5,
      maxOutputUsdPerMillionTokens: 15
    });

    await harness.savePreference({ automatic: false, preference: 'best', modelId: UNPRICED });
    const pinned = await harness.scheduledModel();

    // The counter-direction on the same box: without a pin the ceiling still refuses, so this is a
    // pin being honoured and not the ceiling quietly ceasing to apply. Delete the ceiling spread in
    // `pickModelUnderPriceCeiling` and this second assertion goes red at 201.
    await harness.savePreference({ automatic: true, preference: 'best', modelId: '' });
    const unpinned = await harness.scheduledModel();

    expect(pinned.statusCode, JSON.stringify(pinned)).toBe(201);
    expect(pinned.modelId).toBe(UNPRICED);
    expect(unpinned.statusCode, JSON.stringify(unpinned)).toBe(402);
  });
});

describe('reading the preference without a browser', () => {
  /** The setting the server now acts on, legible to the client it acts on behalf of. */
  test('answers a token carrying models:read with the model preference', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.savePreference({ automatic: true, preference: 'best', modelId: '' });
    const token = await harness.token(['models:read']);

    const read = await harness.app.inject({
      method: 'GET',
      url: '/v1/account/preferences',
      headers: { authorization: `Bearer ${token}` }
    });

    expect(read.statusCode, read.body).toBe(200);
    expect(
      read.json<{ preferences: { model: { preference: string } } }>().preferences.model
    ).toMatchObject({ automatic: true, preference: 'best' });
  });

  /**
   * The fix widens exactly one route and exactly one method. A token without the scope is still
   * refused, the write is refused to every token, and `DELETE /v1/account` on the same prefix is
   * untouched.
   */
  test('still refuses a token without the scope, and refuses every token the write', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    const unscoped = await harness.token(['tasks:read']);
    const scoped = await harness.token(['models:read']);

    const refused = await harness.app.inject({
      method: 'GET',
      url: '/v1/account/preferences',
      headers: { authorization: `Bearer ${unscoped}` }
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('api_token_scope_required');

    const written = await harness.app.inject({
      method: 'PUT',
      url: '/v1/account/preferences',
      headers: { authorization: `Bearer ${scoped}` },
      payload: { model: { automatic: true, preference: 'fast', modelId: '' } }
    });
    expect(written.statusCode).toBe(403);

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/v1/account',
      headers: { authorization: `Bearer ${scoped}` },
      payload: { confirmUsername: 'anyone' }
    });
    expect(deleted.statusCode).toBe(403);
  });

  /**
   * `models:read` is not `tasks:read`. `place` names the conversation and the computer the owner
   * last had open, so a token scoped to the model dial does not get it; the owner at their own
   * keyboard does.
   */
  test('keeps the open conversation out of the answer a token gets', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.savePreference({ automatic: true, preference: 'fast', modelId: '' });
    const stored = await harness.app.inject({
      method: 'PUT',
      url: '/v1/account/preferences',
      headers: { cookie: harness.cookie },
      payload: { inspector: { open: true, tab: 'files' } }
    });
    expect(stored.statusCode).toBe(200);
    const token = await harness.token(['models:read']);

    const viaToken = await harness.app.inject({
      method: 'GET',
      url: '/v1/account/preferences',
      headers: { authorization: `Bearer ${token}` }
    });
    const viaSession = await harness.app.inject({
      method: 'GET',
      url: '/v1/account/preferences',
      headers: { cookie: harness.cookie }
    });

    expect(Object.keys(viaToken.json<{ preferences: object }>().preferences)).toEqual(['model']);
    expect(
      viaSession.json<{ preferences: { inspector?: unknown } }>().preferences.inspector
    ).toBeDefined();
  });
});

describe('who the browser is told it is signed in as', () => {
  /**
   * `GET /v1/auth/me` answered with the whole `UserRecord`, and `UserRecord` carries
   * `recoveryHash`: the scrypt hash of the recovery code that reassigns the account when every
   * passkey is gone. Nothing in this repository reads it from that route - the two recovery routes
   * in auth-routes.ts read it from the store - so it was published to the page for nobody.
   *
   * Put `requireUser(request.user)` back as the answer and this goes red on `recoveryHash`, while
   * the rest of the assertion holds: the fields the page actually uses are all still there, which
   * is the direction that would matter if the narrowing were too narrow.
   */
  test('does not hand the recovery hash to the page', async () => {
    const harness = await buildHarness({ catalogScope: 'reviewed_open_weight' });
    await harness.store.setRecoveryHash(harness.userId, 'scrypt$of$the$recovery$code');

    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie: harness.cookie }
    });

    expect(me.statusCode).toBe(200);
    const user = me.json<{ user: Record<string, unknown> }>().user;
    expect(Object.keys(user).sort()).toEqual([
      'createdAt',
      'displayName',
      'id',
      'preferences',
      'username'
    ]);
    expect(user.id).toBe(harness.userId);
  });
});

describe('the catalogue scope the boot seed writes with', () => {
  /**
   * `seedModelCatalog` was the one caller of four that did not pass `scope`, so on a
   * `reviewed_open_weight` box every restart wrote the whole provider catalogue over the reviewed
   * allowlist. Delete the `scope: config.MODEL_CATALOG_SCOPE` line in `routes/models.ts` and the
   * ten fabricated routes below appear in the store, which is this assertion going red.
   */
  test('keeps a ten-model provider feed out of a reviewed_open_weight catalogue', async () => {
    const feed = Array.from({ length: 10 }, (_, index) => feedModel(`stub/model-${index + 1}`));
    const harness = await buildHarness({
      catalogScope: 'reviewed_open_weight',
      feed,
      seedCatalogue: false
    });

    const ids = (await harness.store.listModels()).map((model) => String(model.id));
    expect(ids.filter((id) => id.startsWith('openrouter/stub/'))).toEqual([]);
    // Not merely "empty": the reviewed allowlist is still there, so this is a scope and not an
    // outage.
    expect(ids).toEqual(expect.arrayContaining(seedModels().map((model) => model.id)));
  });

  /** The other direction: the same feed on a provider_catalog box is offered, as it should be. */
  test('offers the same feed when the box is configured for the provider catalogue', async () => {
    const feed = Array.from({ length: 10 }, (_, index) => feedModel(`stub/model-${index + 1}`));
    const harness = await buildHarness({
      catalogScope: 'provider_catalog',
      feed,
      seedCatalogue: false
    });

    const ids = (await harness.store.listModels()).map((model) => String(model.id));
    expect(ids.filter((id) => id.startsWith('openrouter/stub/'))).toHaveLength(10);
  });
});
