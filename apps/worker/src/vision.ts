import { runtimeNow } from '@garden/core';
/**
 * Who looks at a picture the lead model cannot see, and what the registry rows that decision is
 * taken against cost to read.
 *
 * A second model call - its own ranking, its own price ceiling, its own billing and its own refusal
 * sentences - kept out of the bookkeeping that records tool results. Its failure path is a system
 * notice rather than an error, so a defect here is invisible unless something tests it directly.
 */
import { preferIncumbent, rankModels, requestForWork, selectModel, sha256 } from '@garden/core';
import type { ModelRelease, PrivacyRoute } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import { isProviderWall, type ModelGateway, type ModelToolCall } from '@garden/model-gateway';
import type { AgentState } from './agent-state.js';
import { estimatedInferenceCostUsd, usageCredit } from './billing.js';
import { routeTo, usableCapabilities } from './routing.js';
import { sanitiseUntrustedText, untrustedEnvelope } from './sanitise.js';
import { event, type ImageObservation } from './tool-recording.js';
import { VISION_SPECIALIST_ATTEMPTS, VISION_SPECIALIST_MIN_CONTEXT_TOKENS } from './turn-bounds.js';
import { withRequestDeadline } from './turn-lifecycle.js';
import { textValue } from './values.js';

/**
 * How long a read of `model_releases` stands in for the next one.
 *
 * The rows were re-read from the database on every image-bearing tool result - a whole-table scan
 * per screenshot, which on a browsing turn is one per step - to track a registry the model-registry
 * service refreshes hourly. A minute is two orders of magnitude fresher than the thing it is
 * following and still collapses a browsing turn's worth of reads into one, which is the whole of
 * what the measurement asked for.
 *
 * Deliberately not longer. The reason this reads the live rows at all is that a run can last hours
 * and availability moves underneath it, so the cache has to be shorter than the shortest outage
 * anyone would want a mid-run reroute for.
 */
export const MODEL_CATALOG_CACHE_MS = 60_000;

/**
 * One worker's memory of the registry. Held by the worker rather than by this module, because a
 * module-level cache is shared by every worker in the process and by every test in a file - and a
 * catalogue is per-installation state that a second worker must be able to disagree about.
 */
export interface CatalogCache {
  rows: ModelRelease[];
  readAt: number;
}

/**
 * What the worker remembers between two images, which is the registry read and who read the last
 * one.
 *
 * The two sit in one slot because they have the same owner and opposite lifetimes, and putting the
 * second inside the first would have been the bug: the catalogue memo expires after a minute
 * precisely so a mid-run outage is routed around, and the specialist has to outlive that or the
 * refresh it exists to allow is the thing that changes who is reading the pictures.
 *
 * `specialist` is optional so the worker's existing slot - `{ current: null }` - is still a
 * `RoutingMemo`, and it carries the task it was decided for: one worker leases one task at a time
 * but not the same task forever, and a decision taken for a finished run must not be inherited by
 * the next one.
 */
export interface RoutingMemo {
  current: CatalogCache | null;
  specialist?: { taskId: string; modelId: string };
}

/**
 * Registry rows as they are now. A run can last hours, and the model-registry service keeps
 * refreshing availability and route metadata underneath it, so routing decisions taken mid-run
 * read the current rows instead of the snapshot taken when the task was leased.
 *
 * Answered from the last read while it is still inside `MODEL_CATALOG_CACHE_MS`. A failed read is
 * not cached: an unavailable store must not pin the fallback for a minute.
 */
export const currentCatalog = async (
  deps: Pick<VisionDeps, 'store' | 'catalogCache' | 'now'>,
  fallback: ModelRelease[]
): Promise<ModelRelease[]> => {
  const now = deps.now?.() ?? runtimeNow();
  const cached = deps.catalogCache.current;
  if (cached && now - cached.readAt < MODEL_CATALOG_CACHE_MS) return cached.rows;
  const rows = (await deps.store.listModels().catch(() => [])) as unknown as ModelRelease[];
  if (!rows.length) return fallback;
  deps.catalogCache.current = { rows, readAt: now };
  return rows;
};

/** What routing an image needs from the worker that owns the turn. */
export interface VisionDeps {
  readonly store: DataStore;
  /** The worker's own slot for the registry read, so the memo lives and dies with the worker. */
  readonly catalogCache: RoutingMemo;
  /** Overridable only so a test can age the memo without sleeping through a minute. */
  now?: () => number;
  assertProviderConfigured(task: TaskRecord): Promise<void>;
  gateway(
    task: TaskRecord,
    model: ModelRelease
  ): Promise<{ gateway: ModelGateway; provider: string }>;
  withLeaseRenewal<T>(task: TaskRecord, operation: () => Promise<T>): Promise<T>;
}

/**
 * Route one picture: to the lead model if it can see, and otherwise to the best specialist on the
 * same provider that can.
 *
 * Entered by the caller rather than by `recordToolResult` itself, which is what keeps `vision.ts`
 * free to import `event` from `tool-recording.ts` without closing a cycle.
 */
export const routeImageObservation = async (
  deps: VisionDeps,
  task: TaskRecord,
  key: Uint8Array,
  state: AgentState,
  call: ModelToolCall,
  image: ImageObservation,
  leadModel: ModelRelease,
  catalog: ModelRelease[]
): Promise<void> => {
  const sourceLabel =
    call.name === 'image_read'
      ? `Workspace image from ${textValue(call.arguments.path)}`
      : call.name === 'desktop_observe'
        ? 'Current private Linux desktop screenshot'
        : call.name === 'desktop_action'
          ? 'Cropped private Linux desktop screenshot'
          : 'Current private browser screenshot';
  const imageLabel = image.screen
    ? `${sourceLabel}. Screenshot geometry (region is in display pixels): ${JSON.stringify(image.screen)}`
    : sourceLabel;
  const current = await currentCatalog(deps, catalog);
  const currentLead = current.find((entry) => entry.id === leadModel.id) ?? leadModel;
  if (usableCapabilities(currentLead, task.privacyRoute).has('vision')) {
    state.messages.push({
      role: 'user',
      content: `${imageLabel}. Inspect this image as part of the preceding tool result.`,
      images: [`data:${image.mimeType};base64,${image.base64}`]
    });
    return;
  }

  /*
   * Who reads the picture when the lead cannot.
   *
   * This was an ad-hoc filter and sort with four things wrong with it, and every one of them was
   * invisible because the failure path is a system notice rather than an error.
   *
   * It never asked whether the candidate was on the provider this run holds a credential for.
   * `#gateway` throws `provider_model_mismatch` for any other, the compaction summariser beside
   * it has always had the check, and the sort is deterministic - so on a box migrated from one
   * provider to another the same doomed candidate was chosen for every image, for the life of the
   * box, and every image failed with a notice telling the model to work from the text.
   *
   * It scored unmeasured models at 0.5 where the rest of the router scores them at
   * `UNMEASURED_QUALITY_PRIOR`, so a route nobody has benchmarked outranked measured ones here and
   * nowhere else. `rankModels` carries the right prior, applies the eligibility rules this filter
   * only half had, and returns a ranking rather than a single `[0]` - so a candidate that fails
   * can be followed by the next one instead of by nothing.
   *
   * The `vision` profile at `model-policy.ts` exists for exactly this question and had no caller
   * that used it to choose anything.
   */
  const candidates = current.filter(
    (candidate) => candidate.id !== leadModel.id && candidate.provider === leadModel.provider
  );
  /*
   * The owner's price ceiling, on the fifth and last ranking site - the only one that chooses a
   * model while the owner is asleep.
   *
   * Without it, a box with a $1/M ceiling would route an image to a $75/M model without asking
   * anybody: the lead cannot see, this picks a replacement mid-turn, and nothing between the two
   * reads the ceiling.
   *
   * Not caught, deliberately, where the two `effectiveSpendLimits` reads above it are. Those two
   * want a time zone and 'UTC' is a fair answer when the store will not say; a ceiling has no fair
   * default, and `?? no ceiling` on a failed read is the ceiling silently not applying on exactly
   * the runs nobody is watching. This method already writes the tool-result event through an
   * uncaught `event()` call, so a store that will not answer ends the turn either way.
   *
   * The `?? null` pair is the same reconciliation the API's `ownerPriceCeiling` makes, written out
   * rather than shared because the worker does not import the API. `SpendLimits` still declares both rates optional while `effectiveSpendLimits` has
   * answered with both since the migration that added the columns, and under
   * `exactOptionalPropertyTypes` an explicit `undefined` is not an absent field. When the
   * `.optional()` comes off the contract, both copies of this collapse to a spread.
   */
  const ownerLimits = await deps.store.effectiveSpendLimits(task.userId);
  /*
   * The caller naming the kind of work, on the one site in this worker that ranks a model.
   *
   * `declaredKind` has been documented as outranking every prose hint since it was written and had
   * no producer anywhere: routing was decided by six regexes reading a prompt, and this site does
   * not have a prompt at all - it has an image, a lead that cannot see it, and certainty about
   * what it is asking for. It says so, and the profile answers with what vision work requires
   * rather than this file keeping its own copy of that list beside the ranking it feeds.
   *
   * The prose is still passed, and `hasImages` with it, so the fallback is a real one: if a kind
   * ever stops being a kind the router knows, this asks for the work it can see instead of dying
   * on a profile lookup.
   */
  const visionRequest = requestForWork({
    signals: { prompt: imageLabel, hasImages: true, declaredKind: 'vision' },
    privacyRoute: task.privacyRoute as PrivacyRoute,
    minContextTokens: VISION_SPECIALIST_MIN_CONTEXT_TOKENS,
    ceiling: {
      maxInputUsdPerMillionTokens: ownerLimits.maxInputUsdPerMillionTokens ?? null,
      maxOutputUsdPerMillionTokens: ownerLimits.maxOutputUsdPerMillionTokens ?? null
    }
  });
  const ranked = preferIncumbent(
    rankModels(candidates, visionRequest)
      .map((entry) => entry.model as ModelRelease)
      // The live modality check the ranker cannot make: a catalogue row can advertise vision while
      // the route serving it has lost the endpoint that accepts an image, and on a zero-retention
      // task that is a refusal rather than a downgrade.
      .filter((candidate) => usableCapabilities(candidate, task.privacyRoute).has('vision')),
    /*
     * Who read the last picture on this task, moved to the head of the pool it is still in.
     *
     * A browsing turn reads an image on nearly every step and the registry refreshes underneath
     * it, so without this the second half of a turn is described by a different model than the
     * first - re-ranked, never re-decided, and on a `sessionId` shared by every one of these calls
     * so that the provider recognises the prefix. Applied after the filters rather than instead of
     * them: the incumbent has to still be eligible to be preferred.
     */
    deps.catalogCache.specialist?.taskId === task.id
      ? deps.catalogCache.specialist.modelId
      : undefined
  );
  if (!ranked.length) {
    /*
     * Which of the two refusals this is, because they have different remedies and only one of
     * them is the owner's to apply.
     *
     * Spreading the ceiling in without this is the trap the API's own 402 was built to avoid: a
     * ceiling that empties the pool would fall through to the sentence below, which says no
     * specialist is available - true about the wrong setting, with no route back to the number
     * that caused it. An owner reading it changes their privacy route, or buys nothing, and the
     * images keep failing.
     *
     * Asked over the models that could actually have served the image rather than over every
     * candidate, so the live-modality filter above is never reported as the ceiling's doing and a
     * route the ceiling really did exclude is never reported as an absent specialist. `rankModels`
     * above keeps its own pool untouched, so the order of what is offered is unchanged.
     */
    const refused = selectModel(
      candidates.filter((candidate) =>
        usableCapabilities(candidate, task.privacyRoute).has('vision')
      ),
      visionRequest
    );
    if (refused.ceilingOutcome === 'blocked') {
      // `blocked` always carries its sentence; the fallback is the same one the API's 402 uses,
      // and it is here so the type rather than a convention is what guarantees a sentence.
      const refusal = refused.message ?? 'No model can do this work under your price ceiling.';
      // Said to the owner as well as to the model. The model cannot raise a price ceiling and the
      // owner cannot read a system message, so a notice that only reaches the transcript is a
      // turn that quietly stopped looking at pictures for a reason nobody is shown.
      await event(
        deps.store,
        task,
        key,
        'warning',
        'An image could not be read under your price ceiling',
        {
          owner: true,
          capability: 'vision',
          leadModel: leadModel.id,
          code: 'price_ceiling_blocked',
          ...(refused.cheapestAboveCeiling
            ? { cheapestAboveCeiling: refused.cheapestAboveCeiling.id }
            : {}),
          message: refusal
        }
      );
      state.messages.push({
        role: 'system',
        content: `VISION ROUTING NOTICE: ${leadModel.displayName} cannot inspect images, and every vision specialist on ${leadModel.provider} that could is priced above the price ceiling this computer's owner set. ${refusal} Only the owner can change that, so do not retry the image and do not look for another route. Rely on the semantic text in the tool result, and tell the user their price ceiling is why, in those words, if visual detail matters.`
      });
      return;
    }
    state.messages.push({
      role: 'system',
      // Said as what it is. "No hosted ZDR specialist" on a task whose route is `external` names
      // a restriction that is not in force and sends the model looking for the wrong remedy.
      content: `VISION ROUTING NOTICE: ${leadModel.displayName} cannot inspect images and no eligible ${
        task.privacyRoute === 'provider_zdr' ? 'hosted zero-retention ' : ''
      }vision specialist on ${leadModel.provider} is currently available. Rely only on the semantic text in the tool result and state this limitation if visual detail matters.`
    });
    return;
  }
  /*
   * Tried in ranked order rather than once. Any failure here used to become a system notice
   * telling the model to work from the text, so a candidate that could never answer was chosen
   * again on the next image and on every image after it.
   *
   * Two attempts, and a wall ends them: a quota, an outage or a missing credential is not this
   * candidate's fault and the next candidate is behind the same wall, so asking it is a second
   * billed call for the same refusal.
   */
  let observed = false;
  let lastFailure = 'unknown failure';
  let attempted = ranked[0]!;
  for (const specialist of ranked.slice(0, VISION_SPECIALIST_ATTEMPTS)) {
    attempted = specialist;
    try {
      await deps.assertProviderConfigured(task);
      const specialistGateway = await deps.gateway(task, specialist);
      // Runs after the tool call's own renewal has been torn down, so it needs its own.
      const response = await deps.withLeaseRenewal(task, () =>
        withRequestDeadline((signal) =>
          specialistGateway.gateway.chat(specialistGateway.provider, {
            ...routeTo(specialist),
            messages: [
              {
                role: 'system',
                content:
                  'You are a private vision specialist inside an agent workflow. Describe only task-relevant visual facts, UI state, readable text, spatial relationships, uncertainty, and suggested next observable controls. Do not make external decisions or claim actions were taken.'
              },
              {
                role: 'user',
                content: `${imageLabel}. Return a concise, precise observation for the lead agent ${leadModel.displayName}.`,
                images: [`data:${image.mimeType};base64,${image.base64}`]
              }
            ],
            tools: [],
            temperature: 0.1,
            reasoningEffort: 'medium',
            sessionId: sha256(`garden-task:${task.id}:vision`).slice(0, 64),
            signal
          })
        )
      );
      const credit = usageCredit(
        specialist,
        response.usage.inputTokens,
        response.usage.outputTokens
      );
      const costUsd =
        response.usage.costUsd ??
        estimatedInferenceCostUsd(
          specialist,
          response.usage.inputTokens,
          response.usage.outputTokens,
          response.usage
        );
      state.credits += credit;
      // Added to, not replaced: a vision handoff is one of several calls a step can make, and it is
      // the cheapest of them. Overwriting the step's figure with a light specialist's price is what
      // let a full-window lead call be priced at a thumbnail description on every image-heavy turn.
      state.lastStepUsd = (state.lastStepUsd ?? 0) + costUsd;
      await deps.store.recordUsage({
        userId: task.userId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        kind: 'model_inference',
        resourceClass: specialist.usageClass,
        quantity: response.usage.totalTokens,
        unit: 'tokens',
        credits: credit,
        costUsd,
        state: 'settled',
        idempotencyKey: `vision:${task.id}:${call.id}`,
        providerRef: `${response.metadata.provider}:${response.metadata.model}`
      });
      await event(
        deps.store,
        task,
        key,
        'status',
        `Vision handled by ${specialist.displayName}; returned to ${leadModel.displayName}`,
        {
          capability: 'vision',
          leadModel: leadModel.id,
          specialistModel: specialist.id,
          credits: credit
        }
      );
      state.messages.push({
        role: 'system',
        content: `VISION SPECIALIST HANDOFF\nLead model: ${leadModel.displayName}\nVision model: ${specialist.displayName}\nSource: ${imageLabel}\n${untrustedEnvelope(
          'vision specialist observation',
          sanitiseUntrustedText(response.text)
        )}`
      });
      // Recorded only where it answered. A candidate that failed is not an incumbent, and the
      // ranking is the right thing to consult for the next image rather than the memory of who
      // could not read the last one.
      deps.catalogCache.specialist = { taskId: task.id, modelId: specialist.id };
      observed = true;
      break;
    } catch (cause) {
      lastFailure = cause instanceof Error ? cause.message : 'unknown failure';
      if (isProviderWall(cause)) break;
    }
  }
  if (!observed)
    state.messages.push({
      role: 'system',
      content: `VISION ROUTING NOTICE: ${attempted.displayName} was selected because ${leadModel.displayName} has no vision capability, but the specialist call failed: ${lastFailure}. Use only semantic tool output.`
    });
};
