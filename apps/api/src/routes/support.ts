/**
 * The helpers more than one route group needs, built once on top of `ApiContext`.
 *
 * Everything here was a local inside `buildServer` that two or more of the groups Wave 6 split
 * out reached for: what a model costs and whether the owner will allow it, which provider this
 * box actually calls, what the media section of Settings says, and how a computer is made. They
 * stay in one closure because they call each other - `providerSettings` is three of the others -
 * and splitting a caller from a callee is how a price ceiling comes loose from the call it is
 * meant to bound.
 *
 * The type is derived from the factory, not declared beside it, so a helper that changes shape
 * changes `RouteContext` with it.
 */

import { randomUUID } from 'node:crypto';
import {
  MEDIA_APPROVAL_USD,
  ModelRelease,
  OwnerPreferences,
  resolveWebToolPlan
} from '@garden/contracts';
import type {
  MediaModalityState,
  MediaSettings,
  PrivacyRoute,
  Workspace,
  CreateWorkspaceRequest,
  MediaModelSelection
} from '@garden/contracts';
import {
  GardenError,
  assertSpendAllowed,
  generateDataKey,
  readInferenceConnections,
  environmentInferenceSecret,
  modelConnectionId,
  priceCeilingFields,
  readRoutingMetadata,
  selectModel,
  spendWindowBounds,
  wrapDataKey
} from '@garden/core';
import type { ModelTaskKind, RoutableModel } from '@garden/core';
import type { MediaModelOption } from '@garden/contracts';
import type { UserRecord, WorkspaceRecord } from '@garden/data';
import {
  createModelAdapter,
  vendorForEndpoint,
  vendorPresets,
  MediaRouteResolver,
  applyOpenRouterPrivacyPolicy,
  refreshOpenRouterCatalog,
  planUsageFor,
  type PlanUsage,
  vendorPreset,
  resolveVisionInputRoutes,
  seedModels
} from '@garden/model-gateway';
import type { z } from 'zod';
import { ownerPriceCeiling, workspaceResponse } from '../context.js';
import type { InferenceSecret } from '../context.js';
import type { ServerBase } from '../http/server-context.js';
import { errorFields } from '../log.js';
import { serverLimits } from '../plans.js';
import { createTitleCompletion } from '../title-completion.js';

/**
 * The model dial as the owner left it, read from the row rather than from whichever browser wrote
 * it last.
 *
 * Two traps are why this is a named function and not an inline property read. The stored object is
 * open at the top level by contract - an older build has to be able to read a row a newer one wrote
 * - so only the `model` key is validated here and a malformed `place` or `inspector` beside it can
 * never cost the owner their preference. And `modelId` is NOT a pin on its own:
 * `apps/web/src/app/use-model-choice.ts` writes the currently recommended id into that field on
 * every ranking it receives, so a run that read it whenever it was set would be frozen on whatever
 * the picker happened to be showing the last time the owner had the app open. Only
 * `automatic: false` makes it a choice.
 */
const ownerModelChoice = (
  preferences: UserRecord['preferences'] | undefined
): { preference: 'fast' | 'balanced' | 'best'; pinnedModelId: string | null } | undefined => {
  const parsed = OwnerPreferences.shape.model.safeParse(
    (preferences as { model?: unknown } | undefined)?.model
  );
  if (!parsed.success || !parsed.data) return undefined;
  return {
    preference: parsed.data.preference,
    pinnedModelId: parsed.data.automatic ? null : parsed.data.modelId || null
  };
};

export const createServerSupport = (context: ServerBase) => {
  const { log, database, store, keyRelease, masterKey, runner, config, overrides } = context;
  const PROVIDER_SPEND_WINDOWS = ['daily', 'weekly', 'monthly'] as const;

  /**
   * What the owner's provider has charged over their own day, week and month.
   *
   * The boundaries come from the same place the spending caps take theirs, and so does the figure:
   * `spendTotal` is the statement the caps themselves are measured with. The usage pane draws a
   * window's spend beside a cap when one is set and without it when none is, and it used to reach a
   * second, separately worded query to do it - two definitions of "what this cost" that agreed only
   * as long as nobody edited one of them. There is no allowance to report against either: the owner
   * holds the provider account and pays it directly.
   */
  const providerSpend = async (userId: string) => {
    const { timeZone } = await store.effectiveSpendLimits(userId);
    const periods = spendWindowBounds(timeZone);
    const spent = await Promise.all(
      PROVIDER_SPEND_WINDOWS.map((name) =>
        store.spendTotal(userId, periods[name].start, periods[name].end)
      )
    );
    return {
      windows: Object.fromEntries(
        PROVIDER_SPEND_WINDOWS.map((name, index) => [
          name,
          { used: spent[index] ?? 0, resetsAt: periods[name].end.toISOString() }
        ])
      ) as Record<(typeof PROVIDER_SPEND_WINDOWS)[number], { used: number; resetsAt: string }>
    };
  };
  /**
   * What the connected provider's own plan endpoint says, read live so the strip beside CPU and
   * RAM is the plan's current state rather than this box's own bookkeeping. A provider that will
   * not answer arrives as null - the strip renders nothing for it - because an outage should
   * cost the owner a missing number, not their first paint.
   */
  /**
   * One connection's balance, held for a minute: the strip is drawn on every bootstrap and the
   * settings list on every visit, and neither is worth a request to each provider every time.
   */
  const balances = new Map<string, { at: number; key: string; usage: PlanUsage | null }>();
  const connectionUsage = async (connectionId: string, secret: InferenceSecret) => {
    const key = `${secret.baseUrl}\n${secret.apiKey ?? ''}`;
    const held = balances.get(connectionId);
    if (held && held.key === key && Date.now() - held.at < 60_000) return held.usage;
    const usage = await planUsageFor(
      secret.provider,
      secret.apiKey,
      overrides.modelCatalogFetch ?? globalThis.fetch,
      secret.baseUrl
    );
    balances.set(connectionId, { at: Date.now(), key, usage });
    return usage;
  };
  /** The name a connection goes by on the strip, the same one the settings list shows. */
  const connectionProvider = (secret: InferenceSecret) =>
    vendorPreset(secret.vendor)?.label ??
    vendorForEndpoint(secret.baseUrl)?.label ??
    (secret.provider === 'openrouter'
      ? 'OpenRouter'
      : secret.provider === 'ollama-cloud'
        ? 'Ollama Cloud'
        : new URL(secret.baseUrl).hostname);
  const connectionName = (secret: InferenceSecret) => secret.label ?? connectionProvider(secret);
  /**
   * What every connected provider's own account endpoint says, read live so the strip beside CPU
   * and RAM is each plan's current state rather than this box's own bookkeeping. With several
   * connections, each window carries the name of the one it came from. A provider that will not
   * answer, or publishes no balance, contributes nothing - an outage should cost the owner a
   * missing number, not their first paint.
   */
  const planUsage = async (userId: string): Promise<PlanUsage | null> => {
    const connections = [...(await inferenceConnections(userId))];
    if (!connections.length) return null;
    const read = await Promise.all(
      connections.map(async ([id, entry]) => ({
        name: connectionName(entry.secret),
        usage: await connectionUsage(id, entry.secret)
      }))
    );
    const windows = read.flatMap(({ name, usage }) =>
      (usage?.windows ?? []).map((window) =>
        connections.length > 1 ? { ...window, connection: name } : window
      )
    );
    if (!windows.length) return null;
    return {
      provider: read.find((entry) => entry.usage)?.usage?.provider ?? 'several',
      windows,
      queriedAt: new Date().toISOString()
    };
  };

  /**
   * The dollar ceiling a task actually runs under. A request that names none inherits the account
   * default rather than becoming unlimited, which is what lets one setting cover follow-ups and
   * scheduled runs as well as tasks started by hand.
   */
  /**
   * The compute allowance a turn starts with, sized so it outlasts the step budget rather than
   * expiring a third of the way into it.
   *
   * A credit is (input + 2x output) per million tokens, times a class multiplier that runs from 0.5
   * to 5. So the same fixed number is eighty steps on a light model and nine on a heavy one, and the
   * five everything asked for was reached around step twenty-two to thirty-nine on a frontier model
   * against a step budget of a hundred and twenty. The ceiling that actually fired was therefore
   * never the one anything was designed around.
   *
   * This is a runaway backstop, not the owner's spending limit - that is `maxSpendUsd`, denominated
   * in real money, which is the number they set and understand. So it is sized to sit just past the
   * step budget for the model actually chosen, and the owner is never asked about it.
   */
  const computeAllowanceFor = (model: { usageClass: string }, maxSteps: number): number => {
    const multiplier = { light: 0.5, medium: 1, high: 2.5, extra_high: 5 }[model.usageClass] ?? 1;
    // A generous step: a large window in, a full reply out. Rounded up so the arithmetic never
    // lands exactly on the boundary it is meant to sit past.
    const creditsPerStep = ((200_000 + 2 * 16_384) / 1_000_000) * multiplier;
    return Math.ceil(creditsPerStep * maxSteps * 1.1);
  };

  const resolveSpendCeiling = async (
    userId: string,
    requested: number | undefined
  ): Promise<number | null> =>
    requested ?? (await store.effectiveSpendLimits(userId)).defaultTaskCapUsd;

  /**
   * Refuses work that would take the day or the month past its cap before any of it is started.
   * The whole ceiling is offered as the estimate because that is what starting the work commits to,
   * and open commitments count - otherwise two tasks started in the same second each fit under the
   * cap and together sail past it. A ceiling of zero still asks the question, which is how a cap
   * that is already breached stops work that named no ceiling of its own.
   */
  const assertSpendCeilingAllowed = async (input: {
    userId: string;
    ceilingUsd: number | null;
    /**
     * Set on a follow-up. The task is then excluded from the commitments it is measured against -
     * it would otherwise block on its own reservation - and its own window is left to the worker,
     * which knows what the task has already spent.
     */
    taskId?: string;
  }): Promise<void> => {
    assertSpendAllowed(
      await store.spendGuard({
        userId: input.userId,
        ...(input.taskId ? { taskId: input.taskId, taskCapUsd: null } : {}),
        estimateUsd: input.ceilingUsd ?? 0,
        ...(input.taskId ? {} : { taskCapUsd: input.ceilingUsd }),
        includeOpenCommitments: true
      })
    );
  };

  /**
   * The route this box picks for itself, held to the owner's price ceiling.
   *
   * The ceiling is the pre-flight half of the spending brake. The caps stop a task that is already
   * spending, which is the half that works while somebody is watching; this one decides what may be
   * chosen at all, which is the half that works at three in the morning. Every piece of it -
   * `hasPriceCeiling`, `priceCeilingBreach`, the `isModelEligible` filter inside `rankModels` - has
   * been correct and complete for two releases and had **no producer**: every `ModelRequest` this
   * repository built carried no ceiling, so the whole apparatus was unreachable and a $75 per
   * million route was one automatic pick away on a box whose owner had set $1.
   *
   * `selectModel` rather than `rankModels(...)[0]?.model`, because the ceiling can legitimately
   * empty the catalogue and an empty ranking is indistinguishable from a catalogue that has not
   * loaded. Falling through to `model_unavailable` there would send the owner to the privacy route
   * they did not set to fix a refusal their price ceiling caused. A blocked selection is answered
   * with the cheapest route that could have done the work and what it costs, in the same 402 family
   * as the running cap, because both are "this would cost more than you allowed".
   *
   * Named selections use the purpose resolver. This path ranks automatic choices and validates
   * standing defaults, falling back to the ranking when a default exceeds the rate ceiling.
   *
   * What it now also reads is the dial the owner already set. `OwnerPreferences.model` was
   * validated, persisted and read back by exactly one consumer - the browser - so every pick this
   * server made for itself used the literal 'balanced'. That is precisely the half of the product
   * nobody is watching: every scheduled run, and every task an API token creates without naming a
   * model. An owner who chose Higher quality got balanced at three in the morning.
   */
  const pickModelUnderPriceCeiling = async (
    userId: string,
    catalog: RoutableModel[],
    request: { privacyRoute: PrivacyRoute; taskKind: ModelTaskKind }
  ): Promise<{ model: RoutableModel | undefined; message: string | null }> => {
    // Two independent reads of the same owner, so the preference costs no round-trip of its own.
    const [limits, owner] = await Promise.all([
      store.effectiveSpendLimits(userId),
      store.getUserById(userId)
    ]);
    const choice = ownerModelChoice(owner?.preferences);
    const ceiling = priceCeilingFields(ownerPriceCeiling(limits));
    const select = (requestedId?: string) =>
      selectModel(catalog, {
        privacyRoute: request.privacyRoute,
        requiredCapabilities: ['chat', 'tools'],
        requiredModalities: ['text'],
        minContextTokens: 16_000,
        preference: choice?.preference ?? 'balanced',
        taskKind: request.taskKind,
        ...ceiling,
        ...(requestedId ? { requestedId } : {})
      });
    /**
     * A standing pin is asked for by name first, and falls back to the ranking when it cannot be
     * served or when serving it would breach the ceiling.
     *
     * `requestedId` is the same door the composer sends an explicit pick through, which is what
     * makes an unattended run agree with the owner's own screen rather than quietly choosing
     * something else. That door is deliberately exempt from the price ceiling - `rankModels` drops
     * the ceiling for an explicit id, and `selectModel`'s `requestedId` arm can never answer
     * `blocked` - because the ceiling governs what garden chooses for the owner, never what the
     * owner chooses for themselves. A pin is not that. It is a setting made once on a screen, and
     * it then governs runs the owner is not present for, so on this path the ceiling wins:
     * measured before this line existed, a pin at 30x the input ceiling and 45x the output ceiling
     * was honoured for a schedule while the ranked pick on the same box was correctly held.
     *
     * `ceilingOutcome === 'requested_over_ceiling'` is the whole test, and it is the price rather
     * than the sentence about the price. The first version of this guard read `message !== null`,
     * which is a defect the code it replaced did not have: `selectModel`'s `requestedId` arm says
     * one sentence for a rate over the ceiling AND for a rate the catalogue does not publish, so an
     * owner who set a ceiling lost their standing pin on every unpriced route - free routes
     * included, and every row of the reviewed open-weight seed allowlist, which is the catalogue on
     * any box whose live price refresh has not run. Measured through POST /v1/schedules: 201 on the
     * pinned model before that guard, 402 after it. Prose is not an API; `selectModel` now carries
     * the distinction in the outcome and this reads that.
     *
     * So the two halves are ruled separately. A published rate above the ceiling: the ceiling wins,
     * for the reason in the paragraph above. No published rate: the pin stands, because an absent
     * price is not a breach and refusing on it would revoke a setting the owner made over a fact
     * about the catalogue. A row can carry one rate and not the other, and that is ruled by the
     * rate it does carry: `priceCeilingBreachReason` compares every published rate before it
     * reports a missing one, so `requested_unpriced` here means the ceiling had nothing to compare
     * on either side - not that the side nobody looked at was fine. Before that ordering, a pin on
     * a route publishing $900 per million out ran unattended under a $15 output ceiling because its
     * input rate was null. That deliberately does not agree with the ranked path, and should not:
     * `isModelEligible` keeps an unpriced route out of an automatic pick under a ceiling, where
     * nobody named anything and the box is choosing how to spend the owner's money on its own.
     *
     * The fallback is the part that matters. A pin the catalogue can no longer serve - a withdrawn
     * route, or one that does not answer on the privacy route this run asked for - would otherwise
     * turn a working schedule into `model_unavailable` for a setting the owner made months ago in a
     * different context. A boundary that refuses legitimate work is an outage, so the ranking
     * answers instead. An over-ceiling pin takes the same road, and the ranking is then held to the
     * ceiling in the ordinary way, up to and including a 402 when nothing fits under it - which on
     * a wholly unpriced catalogue is every ranked pick, so the honoured unpriced pin above is also
     * the only thing standing between such a box and a 402 on every unattended run.
     *
     * What this does NOT do is tell the owner a pin the ceiling overruled was set aside.
     * `routes/tasks.ts` posts `message` into the transcript, but the dropped pin's sentence is not
     * that message - the selection returned here is the ranking's - and `routes/schedules.ts` reads
     * no message at all, because `TaskSchedule` has no field to carry one. An unpriced pin is the
     * one case that does reach the owner, since it is honoured and its own advisory travels with
     * it.
     */
    const pinned = choice?.pinnedModelId ? select(choice.pinnedModelId) : null;
    const selection =
      pinned?.choice && pinned.ceilingOutcome !== 'requested_over_ceiling' ? pinned : select();
    if (selection.ceilingOutcome === 'blocked')
      throw new GardenError(
        'price_ceiling_blocked',
        selection.message ?? 'No model can do this work under your price ceiling',
        402
      );
    return { model: selection.choice?.model, message: selection.message };
  };

  const requiresZeroDataRetention = async (userId: string): Promise<boolean> => {
    return connectionRequiresZdr(await readConnections(userId));
  };

  /**
   * Put the catalogue back if something flattened it.
   *
   * The registry service used to write the static seed over the enriched catalogue once an hour,
   * which left every model at availability 'review' with no prices - out of the picker, and
   * `model_unavailable` for anything pinned to one. That is fixed at the source, but a box that
   * already hit it stays flattened until its owner happens to re-save their provider key, and
   * nothing tells them that is the cure. So it repairs itself: if every model in the catalogue is
   * still in the seeded state and the owner has a working credential, ask the provider again.
   *
   * Runs without being awaited. It is a repair, not a precondition - the server should answer
   * requests while it happens, and a provider that is down must not delay startup.
   */
  const repairFlattenedCatalog = async (): Promise<void> => {
    const catalog = await store.listModels();
    if (!catalog.length || catalog.some((model) => String(model.availability) !== 'review')) return;
    const owner = await store.soleUser();
    if (!owner) return;
    const secret = (await inferenceConnections(owner.id)).get('openrouter')?.secret;
    if (!secret?.apiKey) return;
    const live = await refreshOpenRouterCatalog(seedModels(), {
      baseUrl: secret.baseUrl ?? config.OPENROUTER_BASE_URL,
      apiKey: secret.apiKey,
      scope: config.MODEL_CATALOG_SCOPE,
      ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
    });
    await store.upsertModels(live);
    log.info('models.catalog_repaired', { count: live.length });
  };
  void repairFlattenedCatalog().catch((error: unknown) => {
    log.warn('models.catalog_repair_failed', errorFields(error));
  });

  let ollamaReasoningRepair: Promise<void> | undefined;
  const modelsForUser = async (user: UserRecord) => {
    const [saved, initialCatalog] = await Promise.all([
      readConnections(user.id),
      store.listModels()
    ]);
    const requireZdr = connectionRequiresZdr(saved);
    const { connections } = saved;
    let catalog = initialCatalog;
    /*
     * Which provider the key on this box actually belongs to.
     *
     * A catalogue row outlives the credential that wrote it: the only pruning this software does
     * is the registry's replace, which runs on the OpenRouter path alone. So an owner who moved
     * from OpenRouter to their own account kept a picker full of models their key cannot reach,
     * every one of them offered as available, and the first thing that noticed was the worker
     * refusing the turn with `provider_model_mismatch` - after the conversation had started.
     *
     * A connected catalogue is the picker: other providers' rows are excluded. A box with no
     * provider connected keeps the seeded rows so the first connection can still be configured.
     */
    const reachable = new Set(
      [...connections.values()].map((connection) => connection.secret.provider)
    );
    if (reachable.has('ollama-cloud')) {
      // Persist discovery so both the picker and worker validate the same effort choices.
      ollamaReasoningRepair ??= (async () => {
        const missing = catalog.filter((record) => {
          const model = ModelRelease.parse(record);
          return (
            model.provider === 'custom' &&
            model.recommendationTags.includes('Ollama Cloud') &&
            // Any of the three native-metadata halves can be missing: an older build wrote rows
            // that knew thinking and nothing else, and one knew modalities but not the vision
            // capability the gates actually read. All three are repaired by the same loop.
            (model.reasoning?.supportedEfforts === undefined ||
              !model.modalities.includes('image') ||
              !model.capabilities.includes('vision'))
          );
        });
        if (!missing.length) return;
        const secret = connections.get('ollama-cloud')?.secret;
        if (!secret) return;
        const adapter = createModelAdapter({
          provider: 'custom',
          privacyRoute: 'external',
          baseUrl: secret.baseUrl,
          ...(secret.apiKey ? { apiKey: secret.apiKey } : {})
        });
        const described = await adapter.describe(AbortSignal.timeout(20_000));
        const repaired = missing.flatMap((record) => {
          const model = described.find((entry) => entry.id === record.providerModelId);
          if (!model) return [];
          const knowsEffort = model.supportsReasoningEffort !== null;
          const knowsModalities = Array.isArray(model.inputModalities);
          if (!knowsEffort && !knowsModalities) return [];
          // The capability row is written with the modalities it follows: an image-input model
          // is vision-capable, and usableCapabilities refuses to grant vision without both.
          // `knowsModalities` is the Array.isArray guard above, which already narrows this.
          const modalities = knowsModalities ? model.inputModalities : [];
          const capabilities = knowsModalities
            ? [
                ...new Set(
                  ModelRelease.parse(record).capabilities.concat(
                    modalities.includes('image') &&
                      !ModelRelease.parse(record).capabilities.includes('vision')
                      ? (['vision'] as const)
                      : []
                  )
                )
              ]
            : undefined;
          return [
            {
              ...record,
              ...(knowsEffort
                ? {
                    supportsReasoningEffort: model.supportsReasoningEffort,
                    ...(model.reasoning ? { reasoning: model.reasoning } : {})
                  }
                : {}),
              ...(knowsModalities ? { modalities } : {}),
              ...(capabilities ? { capabilities } : {})
            }
          ];
        });
        if (repaired.length) await store.upsertModels(repaired);
      })().catch((error: unknown) => {
        ollamaReasoningRepair = undefined;
        log.warn('models.ollama_capabilities_failed', errorFields(error));
      });
      await ollamaReasoningRepair;
      catalog = await store.listModels();
    }
    return catalog.flatMap((record) => {
      const parsed = ModelRelease.parse(record);
      const connectionId = modelConnectionId(parsed, connections.keys());
      if (reachable.size && !connectionId) return [];
      const connection = connectionId ? connections.get(connectionId) : undefined;
      const model = applyOpenRouterPrivacyPolicy(
        parsed,
        connection?.secret.enforceZeroDataRetention ?? requireZdr
      );
      return [
        {
          ...model,
          ...(connectionId ? { connectionId } : {}),
          ...(connection
            ? {
                connectionLabel: connectionName(connection.secret),
                connectionProvider: connectionProvider(connection.secret)
              }
            : {}),
          ...readRoutingMetadata(record)
        }
      ];
    });
  };

  const provisionWorkspace = async (
    user: UserRecord,
    input: z.infer<typeof CreateWorkspaceRequest>
  ): Promise<Workspace> => {
    const existing = await store.listWorkspaces(user.id);
    if (existing.length >= serverLimits.maxWorkspaces)
      throw new GardenError(
        'computer_already_exists',
        'This garden installation already has its persistent computer',
        409
      );
    const remainingStorage =
      serverLimits.storageBytes - existing.reduce((sum, item) => sum + item.storageLimitBytes, 0);
    if (input.storageLimitBytes > remainingStorage)
      throw new GardenError(
        'storage_limit',
        'The requested cloud storage exceeds your selected allowance'
      );
    const dataKey = generateDataKey();
    const workspaceId = randomUUID();
    const wrappedKey = wrapDataKey(dataKey, masterKey, workspaceId);
    const created = await store.createWorkspace({
      id: workspaceId,
      userId: user.id,
      name: input.name,
      storageLimitBytes: input.storageLimitBytes,
      imageRevision: config.WORKSPACE_IMAGE_REVISION,
      region: input.region,
      wrappedKey,
      keyProtection: keyRelease.mode,
      securityMode: input.securityMode
    });
    try {
      await runner.request({
        workspaceId: created.id,
        userId: user.id,
        role: 'control',
        scopes: ['workspace.manage'],
        path: `/v1/workspaces/${created.id}`,
        method: 'PUT',
        contentType: 'application/json',
        body: JSON.stringify({
          storageLimitBytes: created.storageLimitBytes,
          imageRevision: created.imageRevision
        })
      });
      await store.updateWorkspaceStatus(created.id, 'running', config.WORKSPACE_RUNNER_URL);
      return workspaceResponse((await store.getWorkspace(user.id, created.id))!);
    } catch (error) {
      await store.updateWorkspaceStatus(created.id, 'failed');
      throw error;
    }
  };

  /**
   * One computer per owner, made once.
   *
   * Deliberately counts a `failed` row as existing. A failed computer is the owner's computer with
   * their files in it that did not come up; provisioning a second one beside it would leave the
   * first orphaned and take its data out of reach, which is a worse answer than a computer that
   * needs starting. Repairing it is a different act, and the clients do it: the workbench asks the
   * box to resume a `failed` or `hibernated` computer on load and every five minutes, and Settings
   * offers the same call as a button.
   */
  const ensurePrimaryWorkspace = async (user: UserRecord): Promise<WorkspaceRecord[]> => {
    const existing = await store.listWorkspaces(user.id);
    if (existing.length) return existing;
    await provisionWorkspace(user, {
      name: 'My computer',
      storageLimitBytes: serverLimits.storageBytes,
      region: 'self-hosted',
      securityMode: 'balanced'
    });
    return store.listWorkspaces(user.id);
  };

  /**
   * The provider this box will actually call for one account, and where that answer came from.
   *
   * The owner's own connection is held encrypted in the database and is what a running install
   * uses. The environment is the fallback a development checkout and a first start rely on, and
   * `configured` is false when neither carries enough to make a call - which is a state every
   * caller has to handle, because it is what a box looks like before Settings has been opened.
   *
   * There was a second copy of this inside the transcription route, resolving the same credential
   * with its own idea of the environment fallback. Two of them is one too many for the object that
   * decides which company sees the owner's words.
   */
  const inferenceCredential = async (
    userId: string
  ): Promise<{
    secret: InferenceSecret;
    source: 'encrypted_database' | 'server_environment';
    configured: boolean;
  }> => {
    const primary = (await inferenceConnections(userId)).values().next().value;
    if (primary) return { ...primary, configured: true };
    const { apiKey: _unavailableKey, ...secret } = environmentInferenceSecret(config);
    return { secret, source: 'server_environment', configured: false };
  };

  const readConnections = async (userId: string) => {
    const rows = await store.listManagedProviderCredentials(userId);
    const connections = readInferenceConnections<InferenceSecret>({
      rows,
      userId,
      masterKey,
      environment: config
    });
    return { rows, connections };
  };
  const connectionRequiresZdr = (saved: Awaited<ReturnType<typeof readConnections>>): boolean => {
    const primary = saved.connections.values().next().value;
    return primary
      ? primary.secret.enforceZeroDataRetention !== false
      : saved.rows.some((row) => row.status === 'active') || config.AI_REQUIRE_ZDR;
  };
  const inferenceConnections = async (userId: string) =>
    (await readConnections(userId)).connections;

  /**
   * Where this box's web searches are answered.
   *
   * One verdict, not two. This used to publish an answer per privacy route, on the reasoning that
   * an owner should be told what choosing a route would mean before they chose it - but no box ever
   * offered that choice. A model's privacy route is set from the credential's retention flag and a
   * task may only run on a model whose route matches its own, so every conversation on a given box
   * is on the same route, and the second heading described a conversation that could not be started
   * here. Where a query goes is a fact about the box, so it is reported as one.
   *
   * The verdict itself is not computed here: `resolveWebToolPlan` in @garden/contracts is the only
   * place in this repository that decides it, so the sentence on the settings page and the tools
   * that go on the wire cannot come from two different opinions.
   *
   * Only the verdict is published. The plan also carries the tool names that route would send and
   * withdraw, which are the worker's business and not an owner's: what an owner is owed here is
   * where their queries go and what decided it.
   *
   * The answer carries no `startedMode`, and that is the difference between this question and the
   * one a running task asks. The settings page asks what a conversation started now would do; a
   * task already in flight is additionally held to the mode it started on, so a credential edited
   * mid-run cannot move that task onto the provider's search behind the owner's back.
   */
  const webSearchRoute = (secret: { provider: string }) => {
    const { mode, reason, disclosure } = resolveWebToolPlan({
      provider: secret.provider,
      forceInHouse: config.AI_FORCE_INHOUSE_WEB
    });
    return { mode, reason, disclosure };
  };

  /**
   * The same verdict, for a client that has not asked for the provider settings.
   *
   * Every screen that can start a conversation needs this, so it travels in the first response the
   * client gets rather than costing a second request that most sessions would make and few would
   * use.
   *
   * A credential that cannot be read answers with the deployment's own configured provider, which
   * is the only thing left that is true about this box. The retention flag used to be read here as
   * well, and an unreadable one was assumed to be on; it is no longer part of this question, so
   * there is no longer a privacy fact to be cautious about on the way past.
   */
  const webSearchRouteFor = async (userId: string) => {
    try {
      return webSearchRoute((await inferenceCredential(userId)).secret);
    } catch {
      return webSearchRoute({ provider: config.AI_PROVIDER });
    }
  };

  /**
   * What the owner told this screen about a directly configured endpoint, read back.
   *
   * `PUT /v1/providers` takes `contextTokens`, `capabilities` and `modalities` - the facts an
   * endpoint that publishes no metadata cannot state for itself - writes them into the catalogue
   * row, and this route never answered with them. So the settings form had nothing to re-populate
   * from, filled in the schema's defaults, and the next save of anything at all wrote 128K, chat/
   * tools/reasoning and text over whatever the owner had entered. Write-only fields that silently
   * reset are worse than fields that were never offered.
   *
   * Null when there is no configured row to read: an OpenRouter box has a catalogue nobody typed.
   */
  const configuredModelFacts = async (
    modelId: string | undefined,
    connectionId?: string
  ): Promise<{
    contextTokens: number | null;
    capabilities: string[] | null;
    modalities: string[] | null;
  }> => {
    const absent = { contextTokens: null, capabilities: null, modalities: null };
    if (!modelId) return absent;
    const record = (await store.listModels()).find(
      (row) =>
        (row.id === `custom/${modelId}` || row.providerModelId === modelId) &&
        (!connectionId || modelConnectionId(ModelRelease.parse(row), [connectionId]) !== null)
    );
    if (!record) return absent;
    const parsed = ModelRelease.safeParse(record);
    if (!parsed.success) return absent;
    return {
      contextTokens: parsed.data.contextTokens,
      capabilities: parsed.data.capabilities,
      modalities: parsed.data.modalities
    };
  };

  const providerSettings = async (userId: string) => {
    const connections = await inferenceConnections(userId);
    const describe = async (connectionId: string, secret: InferenceSecret, source: string) => ({
      connectionId,
      label: secret.label ?? null,
      source,
      provider: secret.provider,
      vendor: secret.vendor ?? vendorForEndpoint(secret.baseUrl)?.id ?? null,
      baseUrl: secret.baseUrl,
      modelId: secret.modelId ?? null,
      hasApiKey: Boolean(secret.apiKey),
      localEndpoint: secret.localEndpoint === true,
      enforceZeroDataRetention: secret.enforceZeroDataRetention,
      mediaModels: secret.mediaModels ?? null,
      webSearch: webSearchRoute(secret),
      name: connectionName(secret),
      usage:
        source === 'server_environment' && !secret.apiKey
          ? null
          : await connectionUsage(connectionId, secret),
      ...(secret.catalogDefaults ?? (await configuredModelFacts(secret.modelId, connectionId)))
    });
    const listed = await Promise.all(
      [...connections].map(([id, entry]) => describe(id, entry.secret, entry.source))
    );
    const primary = listed[0];
    const { apiKey: _unavailableKey, ...unconfigured } = environmentInferenceSecret(config);
    return {
      ...(primary ?? (await describe(config.AI_PROVIDER, unconfigured, 'server_environment'))),
      configured: Boolean(primary),
      connections: listed,
      vendors: vendorPresets.map(({ id, label, maker, baseUrl, keyUrl, contextTokens }) => ({
        id,
        label,
        maker,
        baseUrl,
        keyUrl,
        contextTokens
      }))
    };
  };

  const mediaRouting = new MediaRouteResolver({
    ...(overrides.modelCatalogFetch ? { fetch: overrides.modelCatalogFetch } : {})
  });

  const mediaCatalogFor = (secret: InferenceSecret) => mediaRouting.catalog(secret);

  const mediaSettings = async (
    userId: string,
    overrideSelection?: MediaModelSelection
  ): Promise<MediaSettings> => {
    const { secret } = await inferenceCredential(userId);
    const selection = overrideSelection ?? secret.mediaModels ?? {};
    const { options, routes } = await mediaRouting.resolve(secret, selection);
    // A provider whose chat models take images but publishes no media feed still has image-input
    // routes: its own catalogue rows marked vision-capable, priced as unknown because the image
    // rides the chat request. Empty for every provider whose feed already answers.
    const visionOptions =
      secret.provider === 'ollama-cloud'
        ? resolveVisionInputRoutes(
            (await store.listModels())
              .map((record) => ModelRelease.parse(record))
              .filter((model) => model.provider === 'custom')
          )
        : [];
    const imageOptions = [
      ...options.filter((option) => option.modality === 'image'),
      ...visionOptions
    ];
    const resolveImageRoute = (): MediaModelOption | null => {
      const choice = selection.image ?? { automatic: true, preference: 'balanced', modelId: '' };
      if (!choice.automatic && choice.modelId) {
        const pinned =
          imageOptions.find((option) => option.id === choice.modelId) ??
          imageOptions.find((option) => option.providerModelId === choice.modelId);
        return pinned ?? routes.image ?? null;
      }
      return routes.image ?? null;
    };
    const modality = (kind: 'image' | 'audio' | 'transcription' | 'video'): MediaModalityState => {
      const forKind =
        kind === 'image' ? imageOptions : options.filter((option) => option.modality === kind);
      const choice = selection[kind] ?? { automatic: true, preference: 'balanced', modelId: '' };
      const effective = kind === 'image' ? resolveImageRoute() : (routes[kind] ?? null);
      return {
        modality: kind,
        available: forKind.some((option) => !option.unavailableReason),
        reason: forKind.some((option) => !option.unavailableReason)
          ? null
          : 'No currently verified route is available from this provider account.',
        options: forKind,
        choice,
        effective
      };
    };
    return {
      modalities: [
        modality('image'),
        modality('audio'),
        modality('transcription'),
        modality('video')
      ],
      approvalThresholdUsd: MEDIA_APPROVAL_USD
    };
  };

  const mediaRoutesFor = async (
    secret: InferenceSecret,
    selection: MediaModelSelection | undefined
  ): Promise<InferenceSecret['mediaRoutes']> => {
    const { routes } = await mediaRouting.resolve(secret, selection);
    for (const kind of ['image', 'audio', 'transcription', 'video'] as const) {
      const choice = selection?.[kind];
      if (
        choice &&
        !choice.automatic &&
        choice.modelId &&
        (!routes[kind] || routes[kind]?.unavailableReason)
      )
        throw new GardenError(
          'media_route_unavailable',
          'The selected media route is unavailable. Choose an available model.',
          409
        );
    }
    return routes;
  };

  const titleCompletion = createTitleCompletion(context, inferenceConnections);

  /**
   * Refuses while the computer is in use, for two different meanings of "in use".
   *
   * Changing the set of recovery points asks the wider question: anything not settled might still
   * write, and the owner is doing maintenance rather than working, so waiting is cheap.
   *
   * Rewinding the files asks the narrower one. It is reached from a conversation, and that
   * conversation is almost always `awaiting_user` — it is waiting for the person now clicking the
   * button. Refusing on that would have made "put the computer back" unreachable from the only
   * screen that offers it. What must not happen is the tree being replaced under a step that is
   * running or about to be picked up by a worker.
   */
  const EXECUTING_STATUSES = ['queued', 'planning', 'running'] as const;

  /** Nothing in these is going to write again without the owner asking it to. */
  const SETTLED_STATUSES = ['paused', 'completed', 'failed', 'cancelled'];

  /*
   * Asked of the database rather than of a list.
   *
   * This is a boolean, and it was answered by `store.listTasks`, which is `SELECT t.*` with two
   * correlated subqueries per row and no limit - so a computer with five thousand conversations on
   * it decoded five thousand task records, trajectories and all, to discover that none of them was
   * queued. It runs on every recovery point taken, every restore and every filesystem rewind.
   *
   * The join is the same one `listTasks` carries and is what scopes the answer to this owner.
   * Wave 6 folds the query into the store; it is local here because the step that needed it did not
   * own that file.
   */
  const assertWorkspaceHasNoActiveWork = async (
    userId: string,
    workspaceId: string,
    options?: { refusal?: string; busyStatuses?: readonly string[] }
  ): Promise<void> => {
    const busy = options?.busyStatuses;
    const result = await database.query(
      `SELECT 1 FROM tasks t JOIN workspaces w ON w.id=t.workspace_id
       WHERE t.workspace_id=$1 AND w.user_id=$2
         AND ${busy ? 't.status = ANY($3::text[])' : 'NOT (t.status = ANY($3::text[]))'}
       LIMIT 1`,
      [workspaceId, userId, busy ? [...busy] : SETTLED_STATUSES]
    );
    if (result.rows.length > 0)
      throw new GardenError(
        'workspace_busy',
        options?.refusal ?? 'Pause or finish every agent task before changing recovery points',
        409
      );
  };

  return {
    PROVIDER_SPEND_WINDOWS,
    providerSpend,
    computeAllowanceFor,
    resolveSpendCeiling,
    planUsage,
    assertSpendCeilingAllowed,
    pickModelUnderPriceCeiling,
    requiresZeroDataRetention,
    modelsForUser,
    provisionWorkspace,
    ensurePrimaryWorkspace,
    inferenceCredential,
    inferenceConnections,
    webSearchRoute,
    webSearchRouteFor,
    configuredModelFacts,
    providerSettings,
    mediaCatalogFor,
    mediaSettings,
    mediaRoutesFor,
    titleCompletion,
    EXECUTING_STATUSES,
    SETTLED_STATUSES,
    assertWorkspaceHasNoActiveWork
  };
};

/** What createServerSupport hands back, named so RouteContext can be built from it. */
export type ServerSupport = ReturnType<typeof createServerSupport>;
