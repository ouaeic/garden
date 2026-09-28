import { describe, expect, it } from 'vitest';
import type { ModelRelease } from '@garden/contracts';
import {
  UNMEASURED_QUALITY_PRIOR,
  blendWeights,
  blendedPricePerMillionTokens,
  classifyModelTask,
  coarsenTaskKind,
  CONVERSATION_PROMPT_CHARS,
  contextHeadroomScore,
  effectivePricePerMillionTokens,
  inferModelTask,
  isModelEligible,
  isPrivacyRouteEligible,
  modelFit,
  modelTaskKinds,
  priceCeilingBreach,
  priceCeilingBreachReason,
  preferIncumbent,
  priceCeilingFields,
  qualityScore,
  rankModels,
  readRoutingMetadata,
  requestForWork,
  selectModel,
  taskProfile,
  type ModelRequest,
  type ModelTaskKind,
  type RoutableModel,
  type RoutingMetadata
} from './model-policy.js';

const base: ModelRelease = {
  id: 'fast',
  providerModelId: 'fast',
  displayName: 'Fast',
  provider: 'openrouter',
  revision: '1',
  availability: 'available',
  openness: 'permissive_open_weight',
  license: 'Apache-2.0',
  commercialUse: true,
  privacyRoute: 'provider_zdr',
  contextTokens: 128_000,
  modalities: ['text'],
  capabilities: ['chat', 'tools'],
  usageClass: 'light',
  recommendationTags: [],
  measuredQuality: 0.7,
  measuredLatencyMs: 300,
  updatedAt: new Date().toISOString()
};

const request: ModelRequest = {
  privacyRoute: 'provider_zdr',
  requiredCapabilities: ['tools'],
  requiredModalities: ['text'],
  minContextTokens: 32_000,
  preference: 'balanced'
};

describe('model policy', () => {
  it('filters privacy and commercial constraints before ranking', () => {
    const blocked = { ...base, id: 'blocked', commercialUse: false, measuredQuality: 1 };
    const external = { ...base, id: 'external', privacyRoute: 'external' as const };
    const ranked = rankModels([blocked, external, base], {
      privacyRoute: 'provider_zdr',
      requiredCapabilities: ['tools'],
      requiredModalities: ['text'],
      minContextTokens: 32_000,
      preference: 'balanced'
    });
    expect(ranked.map((item) => item.model.id)).toEqual(['fast']);
  });

  it('ranks against the benchmark dimension that matches the task', () => {
    const coding = {
      ...base,
      id: 'coding',
      measuredQuality: 0.8,
      codingQuality: 0.98,
      agenticQuality: 0.55,
      intelligenceQuality: 0.7
    };
    const agentic = {
      ...base,
      id: 'agentic',
      measuredQuality: 0.8,
      codingQuality: 0.6,
      agenticQuality: 0.97,
      intelligenceQuality: 0.75
    };
    const best = { ...request, preference: 'best' as const };
    expect(rankModels([agentic, coding], { ...best, taskKind: 'coding' })[0]?.model.id).toBe(
      'coding'
    );
    expect(rankModels([agentic, coding], { ...best, taskKind: 'agentic' })[0]?.model.id).toBe(
      'agentic'
    );
    expect(inferModelTask('Refactor this TypeScript repository and run tests')).toBe('coding');
    expect(inferModelTask('Research the latest evidence and compare sources')).toBe('agentic');
    expect(inferModelTask('Explain partial pooling')).toBe('general');
  });

  it('refuses a zero-retention route when the live endpoints lost their contract', () => {
    const lapsed = { ...base, id: 'lapsed', zeroDataRetentionAvailable: false, measuredQuality: 1 };
    expect(isPrivacyRouteEligible(lapsed, 'provider_zdr')).toBe(false);
    expect(rankModels([lapsed, base], request).map((item) => item.model.id)).toEqual(['fast']);
  });

  it('drops a reviewed model that no live provider endpoint currently serves', () => {
    const offline = { ...base, id: 'offline', providerAvailable: false, measuredQuality: 1 };
    expect(isModelEligible(offline, request)).toBe(false);
    expect(rankModels([offline, base], request).map((item) => item.model.id)).toEqual(['fast']);
  });

  it('prefers the cheap model for bulk summarisation and the strong one for deep reasoning', () => {
    const cheap = {
      ...base,
      id: 'cheap',
      usageClass: 'light' as const,
      intelligenceQuality: 0.62,
      inputUsdPerMillionTokens: 0.05,
      outputUsdPerMillionTokens: 0.2,
      capabilities: ['chat', 'tools', 'reasoning'] as ModelRelease['capabilities']
    };
    const strong = {
      ...base,
      id: 'strong',
      usageClass: 'extra_high' as const,
      intelligenceQuality: 0.94,
      inputUsdPerMillionTokens: 12,
      outputUsdPerMillionTokens: 60,
      capabilities: ['chat', 'tools', 'reasoning'] as ModelRelease['capabilities']
    };
    expect(
      rankModels([strong, cheap], { ...request, taskKind: 'bulk_summarisation' })[0]?.model.id
    ).toBe('cheap');
    expect(rankModels([cheap, strong], { ...request, taskKind: 'reasoning' })[0]?.model.id).toBe(
      'strong'
    );
  });

  it('prefers real context headroom for long-context work and low latency for conversation', () => {
    const wide = { ...base, id: 'wide', contextTokens: 1_000_000, measuredLatencyMs: 4_000 };
    const snappy = { ...base, id: 'snappy', contextTokens: 128_000, measuredLatencyMs: 200 };
    expect(rankModels([snappy, wide], { ...request, taskKind: 'long_context' })[0]?.model.id).toBe(
      'wide'
    );
    expect(rankModels([wide, snappy], { ...request, taskKind: 'conversation' })[0]?.model.id).toBe(
      'snappy'
    );
  });

  it('never lets a million-token window outweigh quality through context alone', () => {
    // Headroom is capped, so a weak model with an enormous window still loses a reasoning task.
    const wideWeak = {
      ...base,
      id: 'wide-weak',
      contextTokens: 2_000_000,
      intelligenceQuality: 0.4
    };
    const narrowStrong = {
      ...base,
      id: 'narrow-strong',
      contextTokens: 200_000,
      intelligenceQuality: 0.95
    };
    expect(contextHeadroomScore(2_000_000, 64_000)).toBeLessThanOrEqual(1);
    expect(
      rankModels([wideWeak, narrowStrong], { ...request, taskKind: 'reasoning' })[0]?.model.id
    ).toBe('narrow-strong');
  });

  it('treats a missing price as unknown rather than free', () => {
    expect(blendedPricePerMillionTokens(base)).toBeNull();
    expect(
      blendedPricePerMillionTokens({
        ...base,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 5
      })
    ).toBeCloseTo(2, 10);
    const free = { ...base, id: 'free', inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
    const unknown = { ...base, id: 'unknown', usageClass: 'extra_high' as const };
    // The priced-at-zero model must beat the unpriced heavyweight when price dominates.
    expect(
      rankModels([unknown, free], { ...request, taskKind: 'bulk_summarisation' })[0]?.model.id
    ).toBe('free');
    // ...and an unpriced model is never excluded by a price ceiling it cannot be checked against.
    expect(isModelEligible(unknown, { ...request, maxUsdPerMillionTokens: 0.01 })).toBe(true);
    expect(
      isModelEligible(
        { ...base, inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 4 },
        { ...request, maxUsdPerMillionTokens: 1 }
      )
    ).toBe(false);
  });

  it('scores an unmeasured model from its usage class instead of zeroing it', () => {
    const unmeasured = {
      ...base,
      id: 'unmeasured',
      measuredQuality: null,
      measuredLatencyMs: null
    };
    const scored = qualityScore(unmeasured, 'coding');
    expect(scored.source).toBe('usage_class');
    expect(scored.value).toBeGreaterThan(0);
    const ranked = rankModels([unmeasured], { ...request, taskKind: 'coding' });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.score).toBeGreaterThan(0);
    expect(ranked[0]?.reasons.join(' ')).toContain(
      'Not benchmarked; ranked at the 40th percentile'
    );
  });

  it('never lets an unmeasured model outrank a measured one on the sub-score that rewards capability', () => {
    // The benchmark columns are percentiles of the live catalogue, so the best model in the world
    // scores 1.0. It used to score its raw index over 100 - about 0.55 on agentic - and lose to
    // every unmeasured model's 0.72 or 0.80 prior, which inverted the whole ranking.
    const bestInTheWorld = {
      ...base,
      id: 'best',
      usageClass: 'extra_high' as const,
      agenticQuality: 1,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25
    };
    const unmeasured = {
      ...base,
      id: 'unmeasured',
      usageClass: 'extra_high' as const,
      measuredQuality: null,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25
    };
    expect(qualityScore(bestInTheWorld, 'agentic').value).toBe(1);
    expect(qualityScore(unmeasured, 'agentic')).toEqual({
      value: UNMEASURED_QUALITY_PRIOR,
      source: 'usage_class'
    });
    expect(
      rankModels([unmeasured, bestInTheWorld], { ...request, taskKind: 'agentic' })[0]?.model.id
    ).toBe('best');
    // Reachable, though: a model nobody has measured still sits above the weakest measured ones.
    const weak = { ...base, id: 'weak', agenticQuality: 0.2, measuredQuality: 0.2 };
    expect(
      rankModels([weak, unmeasured], { ...request, taskKind: 'agentic', preference: 'best' })[0]
        ?.model.id
    ).toBe('unmeasured');
  });

  it('refuses to score a route nobody has measured or described, and still lets it be picked by name', () => {
    const configured: RoutableModel = {
      ...base,
      id: 'custom/local',
      metadataSource: 'unknown',
      measuredQuality: null,
      measuredLatencyMs: null
    };
    expect(rankModels([configured, base], request).map((item) => item.model.id)).toEqual(['fast']);
    const picked = rankModels([configured, base], { ...request, requestedId: 'custom/local' });
    expect(picked.map((item) => item.model.id)).toEqual(['custom/local']);
    expect(qualityScore(configured, 'coding')).toEqual({ value: 0, source: 'unknown' });
    expect(picked[0]?.reasons.join(' ')).toContain('unrated');
  });

  it('falls back from the task benchmark to the overall score when the column is missing', () => {
    const overallOnly = { ...base, measuredQuality: 0.83 };
    expect(qualityScore(overallOnly, 'agentic')).toEqual({ value: 0.83, source: 'overall' });
    expect(qualityScore({ ...overallOnly, agenticQuality: 0.91 }, 'agentic')).toEqual({
      value: 0.91,
      source: 'benchmark'
    });
  });

  it('bends but does not replace the task profile when a preference is set', () => {
    const coding = taskProfile('coding');
    const fast = blendWeights(coding, 'fast');
    const best = blendWeights(coding, 'best');
    expect(fast.latency).toBeGreaterThan(best.latency);
    expect(best.quality).toBeGreaterThan(fast.quality);
    for (const weights of [fast, best, blendWeights(coding, 'balanced')])
      expect(weights.quality + weights.latency + weights.price + weights.context).toBeCloseTo(
        1,
        10
      );
    // Even at "fast", the ranking still reads the coding column rather than the intelligence one.
    const codingSpecialist = {
      ...base,
      id: 'coder',
      codingQuality: 0.99,
      intelligenceQuality: 0.4
    };
    const generalist = { ...base, id: 'generalist', codingQuality: 0.4, intelligenceQuality: 0.99 };
    expect(
      rankModels([generalist, codingSpecialist], {
        ...request,
        preference: 'fast',
        taskKind: 'coding'
      })[0]?.model.id
    ).toBe('coder');
  });

  it('honours an explicit pick only while it stays eligible', () => {
    const other = { ...base, id: 'other', measuredQuality: 1 };
    const picked = rankModels([base, other], { ...request, requestedId: 'fast' });
    expect(picked.map((item) => item.model.id)).toEqual(['fast']);
    expect(picked[0]?.reasons[0]).toBe('Explicitly selected by the user');
    const external = { ...base, privacyRoute: 'external' as const };
    expect(rankModels([external], { ...request, requestedId: 'fast' })).toEqual([]);
  });

  it('explains every ranked model in terms a person can read', () => {
    const ranked = rankModels(
      [
        {
          ...base,
          codingQuality: 0.88,
          inputUsdPerMillionTokens: 0.3,
          outputUsdPerMillionTokens: 1
        }
      ],
      { ...request, taskKind: 'coding' }
    );
    const first = ranked[0];
    expect(first).toBeDefined();
    expect(first?.explanation).toContain('coding');
    expect(first?.reasons).toContain('Served by a zero-retention endpoint');
    expect(first?.reasons.join(' ')).toContain('coding benchmark 88th percentile');
    expect(first?.reasons.join(' ')).toContain('$0.475 per million tokens blended');
    expect(first?.breakdown.weights.quality).toBeGreaterThan(0);
  });

  it('shows the published index and where it sits, not a synthetic decimal', () => {
    const ranked = rankModels(
      [{ ...base, agenticQuality: 1, agenticIndex: 55.3, benchmarkPopulation: 117 }],
      { ...request, taskKind: 'agentic' }
    );
    expect(ranked[0]?.reasons.join(' ')).toContain(
      'agentic benchmark 55.3, 100th percentile of 117 measured'
    );
  });

  it('counts the column the percentile was computed on, not the biggest column', () => {
    // A live catalogue carries 117 coding scores, 108 agentic and 107 intelligence. Reporting an
    // agentic percentile "of 117 measured" states a number that never measured this column.
    const model: RoutableModel = {
      ...base,
      agenticQuality: 0.99,
      agenticIndex: 55.3,
      codingQuality: 0.5,
      benchmarkPopulation: 117,
      benchmarkPopulations: { coding: 117, agentic: 108, intelligence: 107 }
    };
    expect(
      rankModels([model], { ...request, taskKind: 'agentic' })[0]?.reasons.join(' ')
    ).toContain('agentic benchmark 55.3, 99th percentile of 108 measured');
    expect(rankModels([model], { ...request, taskKind: 'coding' })[0]?.reasons.join(' ')).toContain(
      'coding benchmark 50th percentile of 117 measured'
    );
    // A model scored only on the overall mean has no single column, so it keeps the overall count.
    const overall: RoutableModel = { ...base, measuredQuality: 0.8, benchmarkPopulation: 114 };
    expect(
      rankModels([overall], { ...request, taskKind: 'agentic' })[0]?.reasons.join(' ')
    ).toContain('overall benchmark 80th percentile of 114 measured');
  });

  it('classifies the shape of the work from prompt and turn signals', () => {
    expect(classifyModelTask({ prompt: 'What does this screenshot show?' }).kind).toBe('vision');
    expect(classifyModelTask({ prompt: 'What is on the slide?', hasImages: true }).kind).toBe(
      'vision'
    );
    expect(
      classifyModelTask({ prompt: 'Summarise the meeting', attachedContextTokens: 400_000 }).kind
    ).toBe('long_context');
    expect(classifyModelTask({ prompt: 'Read the entire repository and map it' }).kind).toBe(
      'long_context'
    );
    expect(classifyModelTask({ prompt: 'Classify all these support tickets' }).kind).toBe(
      'bulk_summarisation'
    );
    expect(classifyModelTask({ prompt: 'Fix the failing unit test' }).kind).toBe('coding');
    expect(classifyModelTask({ prompt: 'Prove that this schedule is optimal' }).kind).toBe(
      'reasoning'
    );
    expect(classifyModelTask({ prompt: 'Browse for the cheapest flight' }).kind).toBe('agentic');
    expect(classifyModelTask({ prompt: 'Morning!', interactive: true }).kind).toBe('conversation');
    expect(classifyModelTask({ prompt: 'Morning!' }).kind).toBe('general');
    expect(classifyModelTask({ prompt: 'anything', internalPurpose: 'summarisation' }).kind).toBe(
      'bulk_summarisation'
    );
  });

  it('reports the signal that drove the classification', () => {
    const classified = classifyModelTask({ prompt: 'x', attachedContextTokens: 500_000 });
    expect(classified.signals[0]).toContain('500000 tokens');
  });

  it('collapses the full vocabulary onto the three kinds older callers pass', () => {
    expect(coarsenTaskKind('vision')).toBe('general');
    expect(coarsenTaskKind('long_context')).toBe('general');
    expect(coarsenTaskKind('bulk_summarisation')).toBe('general');
    expect(coarsenTaskKind('reasoning')).toBe('general');
    expect(coarsenTaskKind('conversation')).toBe('general');
    expect(coarsenTaskKind('coding')).toBe('coding');
    expect(coarsenTaskKind('agentic')).toBe('agentic');
  });

  it('gives every task kind a profile with normalised weights', () => {
    expect(modelTaskKinds).toHaveLength(8);
    for (const kind of modelTaskKinds) {
      const profile = taskProfile(kind);
      expect(profile.kind).toBe(kind);
      expect(profile.requiredCapabilities).toContain('chat');
      const { quality, latency, price, context } = profile.weights;
      expect(quality + latency + price + context).toBeCloseTo(1, 10);
    }
    expect(taskProfile('vision').requiredModalities).toContain('image');
    expect(taskProfile('vision').requiredCapabilities).toContain('vision');
  });
});

const opus: RoutableModel = {
  ...base,
  id: 'opus',
  displayName: 'Claude Opus 5',
  usageClass: 'high',
  intelligenceQuality: 1,
  agenticQuality: 1,
  inputUsdPerMillionTokens: 5,
  outputUsdPerMillionTokens: 25
};

const sonnet: RoutableModel = {
  ...base,
  id: 'sonnet',
  displayName: 'Claude Sonnet 5',
  usageClass: 'medium',
  intelligenceQuality: 0.9,
  agenticQuality: 0.9,
  inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 10
};

const unpriced: RoutableModel = { ...base, id: 'unpriced', displayName: 'Unpriced' };

/**
 * Priced on one side and not the other, which is a shape the live catalogue really produces:
 * `perMillion` reads `pricing.prompt` and `pricing.completion` independently, and a
 * `reviewed_open_weight` box keeps a row whose stated rate was refused as implausible rather than
 * dropping it. $900 out is sixty times the $10 ceiling below, so nothing here rests on the input
 * side being missing.
 */
const halfPriced: RoutableModel = {
  ...base,
  id: 'half-priced',
  displayName: 'Half Priced',
  inputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: 900
};

/** "The best benchmarked model for the task under $2 per million in and $10 per million out." */
const ceiling: ModelRequest = {
  ...request,
  taskKind: 'agentic',
  maxInputUsdPerMillionTokens: 2,
  maxOutputUsdPerMillionTokens: 10
};

describe('the owner price ceiling', () => {
  it('is inclusive at the boundary and judges the two rates separately', () => {
    expect(isModelEligible(sonnet, ceiling)).toBe(true);
    expect(isModelEligible(opus, ceiling)).toBe(false);
    expect(priceCeilingBreach(opus, ceiling)).toBe(
      '$5.00 per million input is above the $2.00 ceiling'
    );
    // A single blended number cannot express this: $3 in and $6 out blends to $3.75, under a
    // blended $4.00 ceiling, while breaking the $2.00 input rate the owner actually set.
    const blendedPass = {
      ...base,
      id: 'blended',
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 6
    };
    expect(blendedPricePerMillionTokens(blendedPass)).toBeCloseTo(3.75, 10);
    expect(isModelEligible(blendedPass, { ...request, maxUsdPerMillionTokens: 4 })).toBe(true);
    expect(isModelEligible(blendedPass, ceiling)).toBe(false);
  });

  it('refuses a model that publishes no price, and says so', () => {
    expect(priceCeilingBreach(unpriced, ceiling)).toBe('no published price');
    expect(isModelEligible(unpriced, ceiling)).toBe(false);
    // With no ceiling set, an unpublished price still must not shrink the pool.
    expect(isModelEligible(unpriced, request)).toBe(true);
  });

  /**
   * The two exclusions are one sentence and two facts, and a caller that has to tell them apart
   * gets the kind rather than the prose. `apps/api/src/routes/support.ts` told them apart by the
   * prose and revoked standing pins for every route the catalogue does not price.
   *
   * Collapse `kind` to the single literal 'over_ceiling' in `priceCeilingBreachReason` and this
   * goes red on the unpriced row while every string assertion in this file stays green - which is
   * the whole point of the type existing.
   */
  it('names which of the two exclusions it is, not only the sentence', () => {
    expect(priceCeilingBreachReason(opus, ceiling)).toEqual({
      kind: 'over_ceiling',
      reason: '$5.00 per million input is above the $2.00 ceiling'
    });
    expect(priceCeilingBreachReason(unpriced, ceiling)).toEqual({
      kind: 'no_published_price',
      reason: 'no published price'
    });
    expect(priceCeilingBreachReason(sonnet, ceiling)).toBeNull();
    // The blended shape admits an unpriced route outright, so it has no second kind to report.
    expect(
      priceCeilingBreachReason(unpriced, { ...request, maxUsdPerMillionTokens: 4 })
    ).toBeNull();
    expect(priceCeilingBreachReason(opus, { ...request, maxUsdPerMillionTokens: 4 })?.kind).toBe(
      'over_ceiling'
    );
  });

  /**
   * A rate the catalogue does publish is compared before a rate it does not, and the order is
   * load-bearing rather than cosmetic: the standing pin in `apps/api/src/routes/support.ts` honours
   * `no_published_price` and drops `over_ceiling`, so calling this row unpriced put an unattended
   * run on a $900-per-million-output route under a $10 output ceiling.
   *
   * Put the `input === null` test back in front of the comparisons in `priceCeilingBreachReason`
   * and this goes red at `no_published_price`, while every other assertion in this file - including
   * the eligibility one below, which only ever asks null or not - stays green.
   */
  it('reports a published rate over the ceiling even when the other rate is missing', () => {
    expect(priceCeilingBreachReason(halfPriced, ceiling)).toEqual({
      kind: 'over_ceiling',
      reason: '$900.00 per million output is above the $10.00 ceiling'
    });
    // Eligibility is unchanged by the ordering, which is why nothing caught this.
    expect(isModelEligible(halfPriced, ceiling)).toBe(false);
    // The counter-direction: a missing rate beside a rate the ceiling admits is still unknown, not
    // a breach to be blamed on the side that is present.
    expect(
      priceCeilingBreachReason({ ...halfPriced, outputUsdPerMillionTokens: 4 }, ceiling)
    ).toEqual({ kind: 'no_published_price', reason: 'no published price' });
    // And a ceiling on the missing side only leaves the present side to answer for itself.
    expect(
      priceCeilingBreachReason(halfPriced, {
        ...request,
        taskKind: 'agentic',
        maxOutputUsdPerMillionTokens: 10
      })?.kind
    ).toBe('over_ceiling');
  });

  it('judges the tier the task will actually reach', () => {
    const tiered: RoutableModel = {
      ...base,
      id: 'tiered',
      contextTokens: 1_000_000,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 6,
      priceTiers: [
        { minPromptTokens: 200_000, inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 24 }
      ]
    };
    expect(isModelEligible(tiered, { ...ceiling, minContextTokens: 32_000 })).toBe(true);
    expect(isModelEligible(tiered, { ...ceiling, minContextTokens: 250_000 })).toBe(false);
  });

  it('never constrains a model the owner picked by name', () => {
    const picked = rankModels([opus, sonnet], { ...ceiling, requestedId: 'opus' });
    expect(picked.map((item) => item.model.id)).toEqual(['opus']);
  });
});

describe('latency and reliability', () => {
  it('drops the latency term entirely when nothing on this server has measured one', () => {
    const untimed = [
      { ...opus, measuredLatencyMs: null },
      { ...sonnet, measuredLatencyMs: null }
    ];
    const ranked = rankModels(untimed, {
      ...request,
      preference: 'fast',
      taskKind: 'conversation'
    });
    const weights = ranked[0]?.breakdown.weights;
    expect(ranked[0]?.breakdown.latency).toBeNull();
    expect(weights?.latency).toBe(0);
    expect((weights?.quality ?? 0) + (weights?.price ?? 0) + (weights?.context ?? 0)).toBeCloseTo(
      1,
      10
    );
    expect(ranked[0]?.reasons.join(' ')).toContain('Latency not measured on this server');
  });

  it('keeps ranking on latency once something has actually been timed', () => {
    const ranked = rankModels([opus, sonnet], { ...request, preference: 'fast' });
    expect(ranked[0]?.breakdown.weights.latency).toBeGreaterThan(0);
    expect(ranked[0]?.breakdown.latency).toEqual({ value: 0.99, source: 'measured' });
  });

  it('does not rank an untimed model as the slowest thing on the box because one route published a latency', () => {
    // The switch used to be pool-wide: the moment any candidate carried a `measuredLatencyMs`,
    // every candidate that did not was scored `0` on the latency term while still carrying its
    // full weight - "slower than the 30-second ceiling" rather than "not measured". Measured
    // against the shipped build: adding a single `measuredLatencyMs: 800` to the weaker of two
    // models moved it from last to first. `openrouter-catalog.ts` fills `measuredLatencyMs` only
    // for the routes that appear in the `/endpoints/zdr` feed, so a mixed pool is the ordinary
    // case on a box that never asked for zero retention, not an edge one.
    const untimedStrong: RoutableModel = {
      ...opus,
      id: 'strong',
      displayName: 'Strong',
      measuredLatencyMs: null,
      inputUsdPerMillionTokens: 0.5,
      outputUsdPerMillionTokens: 1.5
    };
    const timedWeak: RoutableModel = {
      ...base,
      id: 'weak',
      displayName: 'Weak',
      measuredQuality: 0.3,
      intelligenceQuality: 0.3,
      agenticQuality: 0.3,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
      measuredLatencyMs: 800
    };
    const fast: ModelRequest = { ...request, preference: 'fast', taskKind: 'conversation' };

    const mixed = rankModels([untimedStrong, timedWeak], fast);
    expect(mixed.map((item) => item.model.id)).toEqual(['strong', 'weak']);
    expect(mixed.every((item) => item.breakdown.weights.latency === 0)).toBe(true);

    // The order the pool has when nothing is timed at all is the order it must keep when one
    // member starts publishing: a latency is evidence about that route, never about the others.
    const untimed = rankModels([untimedStrong, { ...timedWeak, measuredLatencyMs: null }], fast);
    expect(untimed.map((item) => item.model.id)).toEqual(mixed.map((item) => item.model.id));
  });

  it('admits the latency term only once most of the pool carries one', () => {
    // Four fifths is the floor. `scoreModel` on its own assumes the pool is comparable, which is
    // what makes a single-model score readable outside a ranking.
    const timed = (id: string): RoutableModel => ({ ...sonnet, id, measuredLatencyMs: 300 });
    const untimed: RoutableModel = { ...sonnet, id: 'untimed', measuredLatencyMs: null };

    const belowFloor = rankModels([timed('a'), timed('b'), timed('c'), untimed], {
      ...request,
      preference: 'fast'
    });
    expect(belowFloor.every((item) => item.breakdown.weights.latency === 0)).toBe(true);

    const atFloor = rankModels([timed('a'), timed('b'), timed('c'), timed('d'), untimed], {
      ...request,
      preference: 'fast'
    });
    const straggler = atFloor.find((item) => item.model.id === 'untimed');
    // The one row nobody timed is dropped from the term rather than scored zero on it, and the
    // sentence `buildReasons` has always printed for a null sub-score is finally true of the maths.
    expect(straggler?.breakdown.latency).toBeNull();
    expect(straggler?.breakdown.weights.latency).toBe(0);
    const { quality, price, context } =
      straggler?.breakdown.weights ?? taskProfile('general').weights;
    expect(quality + price + context).toBeCloseTo(1, 10);
    expect(straggler?.reasons.join(' ')).toContain('Latency not measured on this server');
    expect(
      atFloor.find((item) => item.model.id === 'a')?.breakdown.weights.latency
    ).toBeGreaterThan(0);
  });

  it('routes around a model whose endpoints were failing yesterday, unless it is all there is', () => {
    const flaky = { ...sonnet, id: 'flaky', uptimeLast1dPercent: 42, intelligenceQuality: 1 };
    const steady = { ...sonnet, id: 'steady', uptimeLast1dPercent: 99.99 };
    expect(rankModels([flaky, steady], request).map((item) => item.model.id)).toEqual(['steady']);
    const only = rankModels([flaky], request);
    expect(only.map((item) => item.model.id)).toEqual(['flaky']);
    expect(only[0]?.reasons.join(' ')).toContain('42.00% uptime over the last day');
  });

  it('keeps a route the provider is about to withdraw out of automatic selection', () => {
    const asOf = '2026-08-03T00:00:00.000Z';
    const retiring = { ...sonnet, id: 'retiring', expiresAt: '2026-08-10', intelligenceQuality: 1 };
    const successor = { ...sonnet, id: 'successor' };
    expect(
      rankModels([retiring, successor], { ...request, asOf }).map((item) => item.model.id)
    ).toEqual(['successor']);
    // A date far enough out is not a reason to stop using a model.
    const distant = { ...retiring, id: 'distant', expiresAt: '2098-12-31' };
    expect(
      rankModels([distant, successor], { ...request, asOf, preference: 'best' })[0]?.model.id
    ).toBe('distant');
    // ...and the owner can still choose the retiring route by name, with the date in front of them.
    const picked = rankModels([retiring, successor], {
      ...request,
      asOf,
      requestedId: 'retiring'
    });
    expect(picked[0]?.reasons.join(' ')).toContain('Provider withdraws this route on 2026-08-10');
  });
});

describe('effective price', () => {
  it('prices a resent transcript at the cache-read rate the route actually charges', () => {
    const caching: RoutableModel = { ...opus, cacheReadUsdPerMillionTokens: 0.5 };
    expect(blendedPricePerMillionTokens(caching)).toBeCloseTo(10, 10);
    // Three quarters of the input arrives as a cache read: (5*0.25 + 0.5*0.75)*0.75 + 25*0.25.
    expect(effectivePricePerMillionTokens(caching, taskProfile('agentic'))).toBeCloseTo(7.46875, 8);
    // Work that does not resend a transcript pays the prompt rate, so nothing is assumed for it.
    expect(effectivePricePerMillionTokens(caching, taskProfile('conversation'))).toBeCloseTo(
      10,
      10
    );
    // ...and a route that publishes no cache-read rate is priced at what it charges.
    expect(effectivePricePerMillionTokens(opus, taskProfile('agentic'))).toBeCloseTo(10, 10);
    const ranked = rankModels([caching], { ...request, taskKind: 'agentic' });
    expect(ranked[0]?.reasons.join(' ')).toContain(
      '$10.00 per million tokens blended, $7.47 once the prefix is cached'
    );
  });
});

/**
 * Typed as `Required`, so a field added to `RoutingMetadata` without being covered here fails to
 * compile. The round trip is the only thing standing between the catalogue refresh and a router
 * that reads none of what it collected.
 */
const everyRoutingField: Required<RoutingMetadata> = {
  reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', mandatory: true },
  metadataSource: 'measured',
  agenticIndex: 55.3,
  codingIndex: 78,
  intelligenceIndex: 60.7,
  benchmarkPopulation: 117,
  benchmarkPopulations: { coding: 117, agentic: 108, intelligence: 107 },
  cacheReadUsdPerMillionTokens: 0.5,
  cacheWriteUsdPerMillionTokens: 6.25,
  promptCacheStyle: 'explicit',
  supportsReasoningEffort: true,
  priceTiers: [
    { minPromptTokens: 200_000, inputUsdPerMillionTokens: 4, outputUsdPerMillionTokens: 24 }
  ],
  uptimeLast1dPercent: 99.98,
  expiresAt: '2026-12-31',
  maxOutputTokens: 64_000,
  knowledgeCutoff: '2026-01-31'
};

describe('routing metadata round trip', () => {
  it('carries every field the router reads through the journey the store puts it on', () => {
    const stored = JSON.parse(JSON.stringify({ ...base, ...everyRoutingField })) as unknown;
    expect(readRoutingMetadata(stored)).toEqual(everyRoutingField);
    // ...and off a live model exactly as off the blob it was stored in: one contract, both ways.
    expect(readRoutingMetadata({ ...base, ...everyRoutingField })).toEqual(everyRoutingField);
  });

  it('drops a malformed field on its own rather than taking the entry with it', () => {
    const damaged = {
      ...everyRoutingField,
      expiresAt: 12,
      promptCacheStyle: 'sometimes',
      priceTiers: [{ inputUsdPerMillionTokens: 4 }, 'nonsense'],
      benchmarkPopulations: ['117'],
      somethingElseEntirely: 'ignored'
    };
    const read = readRoutingMetadata(damaged);
    expect(read.expiresAt).toBeUndefined();
    expect(read.promptCacheStyle).toBeUndefined();
    expect(read.benchmarkPopulations).toBeUndefined();
    // A tier with no threshold cannot be evaluated, so it is not carried as one.
    expect(read.priceTiers).toEqual([]);
    expect(read).not.toHaveProperty('somethingElseEntirely');
    expect(read.metadataSource).toBe('measured');
    expect(read.maxOutputTokens).toBe(64_000);
  });

  it('keeps "never reported" apart from "publishes nothing"', () => {
    expect(readRoutingMetadata({ expiresAt: null })).toEqual({ expiresAt: null });
    expect('expiresAt' in readRoutingMetadata({})).toBe(false);
    expect(readRoutingMetadata(null)).toEqual({});
    expect(readRoutingMetadata('not a model')).toEqual({});
  });

  it('keeps the guards working after the round trip, which is the whole point of carrying it', () => {
    const asOf = '2026-08-03T00:00:00.000Z';
    const retiring = { ...sonnet, id: 'retiring', expiresAt: '2026-08-10', intelligenceQuality: 1 };
    const successor = { ...sonnet, id: 'successor' };
    const restore = (model: RoutableModel): RoutableModel => ({
      ...model,
      ...readRoutingMetadata(JSON.parse(JSON.stringify(model)) as unknown)
    });
    expect(
      rankModels([restore(retiring), restore(successor)], { ...request, asOf }).map(
        (item) => item.model.id
      )
    ).toEqual(['successor']);
    // The provenance guard survives too: an unmeasured route stays out of automatic ranking.
    const configured: RoutableModel = { ...base, id: 'custom/local', metadataSource: 'unknown' };
    expect(restore(configured).metadataSource).toBe('unknown');
    expect(rankModels([restore(configured), base], request).map((item) => item.model.id)).toEqual([
      'fast'
    ]);
  });
});

describe('task classification', () => {
  it('lets the caller name the kind of work instead of guessing at the words', () => {
    expect(classifyModelTask({ prompt: 'anything at all', declaredKind: 'reasoning' })).toEqual({
      kind: 'reasoning',
      signals: ['The caller named the kind of work']
    });
    // A declared kind outranks even an image attachment, because the caller has seen the turn.
    expect(
      classifyModelTask({ prompt: 'x', hasImages: true, declaredKind: 'bulk_summarisation' }).kind
    ).toBe('bulk_summarisation');
  });

  /*
   * The safe fallback, which the declared kind is the only signal to need one.
   *
   * Every other signal in `TaskSignals` is produced inside this repository and typed by it.
   * `declaredKind` is the one that comes from wherever the caller got it - a stored schedule row, a
   * request body, a tier some other process chose - and `ModelTaskKind` on the field is a claim
   * about that value, not a check of it. Returned verbatim it becomes a key into `profiles`, and
   * `taskProfile` has no entry for it: the next line in `modelFit` reads `requiredCapabilities` off
   * `undefined` and the turn dies inside the router, on the one path whose whole job is to be the
   * safe one. So an unrecognised label loses its precedence and the ordinary rules run.
   */
  it('drops a declared kind it has no profile for rather than routing on it', () => {
    const classified = classifyModelTask({
      prompt: 'Fix the failing unit test',
      declaredKind: 'sql_wizard' as ModelTaskKind
    });
    expect(classified.kind).toBe('coding');
    expect(taskProfile(classified.kind)).toBeDefined();
    // Said rather than swallowed: a caller that declared something the router does not know has a
    // bug, and a silent downgrade to the prose regexes is how it stays unfound.
    expect(classified.signals[0]).toContain('sql_wizard');
    // And every kind the router does know still outranks the prose, which is the point of it.
    for (const kind of modelTaskKinds)
      expect(
        classifyModelTask({ prompt: 'Fix the failing unit test', declaredKind: kind }).kind
      ).toBe(kind);
  });

  it('bounds an unknown declared kind before it reaches a line someone reads', () => {
    // The signals list is explanation, and this one carries a value from outside. A label is a
    // short word; anything longer or stranger than that is quoted at a length nobody scrolls.
    const classified = classifyModelTask({
      prompt: 'Morning!',
      declaredKind: `${'k'.repeat(400)}\n<script>alert(1)</script>` as ModelTaskKind
    });
    expect(classified.kind).toBe('general');
    const said = classified.signals.join(' ');
    expect(said.length).toBeLessThan(120);
    expect(said).not.toContain('<script>');
  });

  it('no longer treats an artefact as a plan', () => {
    // "document" used to sit in the agentic pattern, so a short prose edit was routed to the
    // agentic benchmark with a 128K reference window.
    expect(classifyModelTask({ prompt: 'Summarise this document for me' }).kind).toBe('general');
    expect(
      classifyModelTask({ prompt: 'Tidy up this document and tighten the wording' }).kind
    ).toBe('general');
    // Work that genuinely leaves this process still classifies as agentic.
    expect(classifyModelTask({ prompt: 'Browse for the cheapest flight' }).kind).toBe('agentic');
    expect(classifyModelTask({ prompt: 'Deploy the staging build' }).kind).toBe('agentic');
  });

  it('does not read a short request to a machine that can act as a chat', () => {
    // Measured on the owner's box. Ninety-eight characters, and every one of them about pictures:
    // on prompt length alone this is the latency-first profile with a 16K reference window. What it
    // asked for was a script, several runs of it and a montage, on a 37,000-token window.
    const prompt =
      'Generate a cartoon logo, cut the background out cleanly, produce several sizes and a contact sheet';
    expect(prompt.length).toBeLessThan(CONVERSATION_PROMPT_CHARS);
    expect(classifyModelTask({ prompt, interactive: true, usesTools: true }).kind).toBe('general');
    // The profile is still reachable for a turn that genuinely has nothing to act with.
    expect(classifyModelTask({ prompt, interactive: true, usesTools: false }).kind).toBe(
      'conversation'
    );
  });

  it('reaches every profile from the only entry point callers use', () => {
    // inferModelTask used to coarsen its answer to three kinds, which left five carefully written
    // profiles unreachable from the API.
    expect(inferModelTask('What does this screenshot show?')).toBe('vision');
    expect(inferModelTask('Read the entire repository and map it')).toBe('long_context');
    expect(inferModelTask('Classify all these support tickets')).toBe('bulk_summarisation');
    expect(inferModelTask('Prove that this schedule is optimal')).toBe('reasoning');
    expect(inferModelTask('Refactor this TypeScript repository and run tests')).toBe('coding');
    expect(inferModelTask('Explain partial pooling')).toBe('general');
  });
});

/*
 * One spelling of what a kind of work requires.
 *
 * Every ranking site outside `model-policy.ts` used to write the profile's requirements out by hand
 * beside its own call, which is two spellings of one rule: the profile decides how a candidate is
 * scored for the work while the call site decides who is eligible for it, and nothing made them
 * agree.
 */
describe('the request a declared piece of work asks for', () => {
  it('takes its requirements from the profile rather than from the caller', () => {
    const built = requestForWork({
      signals: { prompt: 'anything at all', declaredKind: 'vision' },
      privacyRoute: 'provider_zdr',
      minContextTokens: 8_000
    });
    expect(built.taskKind).toBe('vision');
    expect(built.requiredCapabilities).toEqual([...taskProfile('vision').requiredCapabilities]);
    expect(built.requiredModalities).toEqual([...taskProfile('vision').requiredModalities]);
    // An unattended site is asking for `balanced` unless it says otherwise; nothing about a
    // background call justifies the quality-first or the latency-first dial by default.
    expect(built.preference).toBe('balanced');
    expect(built.minContextTokens).toBe(8_000);
  });

  it('adds what a site needs of its own without dropping what the profile needs', () => {
    const built = requestForWork({
      signals: { prompt: 'anything at all', declaredKind: 'bulk_summarisation' },
      privacyRoute: 'external',
      minContextTokens: 32_000,
      alsoRequires: ['tools']
    });
    expect(new Set(built.requiredCapabilities)).toEqual(new Set(['chat', 'tools']));
  });

  it('carries the owner price ceiling, which is the field a background site forgets', () => {
    const built = requestForWork({
      signals: { prompt: 'anything at all', declaredKind: 'vision' },
      privacyRoute: 'provider_zdr',
      minContextTokens: 8_000,
      ceiling: { maxInputUsdPerMillionTokens: 1, maxOutputUsdPerMillionTokens: null }
    });
    expect(built.maxInputUsdPerMillionTokens).toBe(1);
    // `null` is "no ceiling" and `0` is a ceiling of zero, which is the distinction
    // `priceCeilingFields` exists to keep; an absent field is not an explicit `undefined`.
    expect('maxOutputUsdPerMillionTokens' in built).toBe(false);
  });

  it('falls back to the prose when the declared kind is not one the router has', () => {
    const built = requestForWork({
      signals: { prompt: 'Fix the failing unit test', declaredKind: 'tier_3' as ModelTaskKind },
      privacyRoute: 'provider_zdr',
      minContextTokens: 8_000
    });
    expect(built.taskKind).toBe('coding');
    expect(built.requiredCapabilities).toEqual([...taskProfile('coding').requiredCapabilities]);
  });
});

/*
 * Sticky selection over a sequence of calls: the catalogue moves under a run that lasts hours, and
 * a ranking recomputed from scratch each time can hand the second half of a turn to a different
 * model than the first - a downgrade nobody chose, and a prompt prefix the provider has never seen.
 */
describe('the model that answered a moment ago', () => {
  const pool = [{ id: 'best' }, { id: 'second' }, { id: 'third' }];

  it('moves the incumbent to the head of a ranking it is still in', () => {
    expect(preferIncumbent(pool, 'third').map((entry) => entry.id)).toEqual([
      'third',
      'best',
      'second'
    ]);
  });

  /*
   * The half that makes it safe. It reorders, it never re-admits: every eligibility rule - the
   * privacy route, the owner's ceiling, a withdrawn row - has already excluded a candidate before
   * this is asked, so a memory of who answered last must not be a way back in.
   */
  it('leaves a ranking that no longer contains the incumbent exactly as it found it', () => {
    const withdrawn = preferIncumbent(pool, 'retired');
    expect(withdrawn).toBe(pool);
    expect(withdrawn.map((entry) => entry.id)).toEqual(['best', 'second', 'third']);
  });

  it('is the identity when nothing is remembered or the incumbent already leads', () => {
    expect(preferIncumbent(pool, undefined)).toBe(pool);
    expect(preferIncumbent(pool, 'best')).toBe(pool);
  });
});

describe('model fit', () => {
  /**
   * A catalogue with a clear best answer and a clear worst one, so what the fit reports is the
   * ranking rather than an accident of the fixture. Latency is measured on both, which keeps the
   * `fast` dial the fit judges on honest instead of collapsing into price.
   */
  const strong: RoutableModel = {
    ...base,
    id: 'strong',
    displayName: 'Strong',
    contextTokens: 400_000,
    codingQuality: 0.98,
    agenticQuality: 0.98,
    intelligenceQuality: 0.98,
    measuredQuality: 0.98,
    measuredLatencyMs: 900,
    inputUsdPerMillionTokens: 3,
    outputUsdPerMillionTokens: 15
  };
  const middling: RoutableModel = {
    ...base,
    id: 'middling',
    displayName: 'Middling',
    codingQuality: 0.6,
    agenticQuality: 0.6,
    intelligenceQuality: 0.6,
    measuredQuality: 0.6,
    inputUsdPerMillionTokens: 0.5,
    outputUsdPerMillionTokens: 1.5
  };
  const cheap: RoutableModel = {
    ...base,
    id: 'cheap',
    displayName: 'Cheap',
    contextTokens: 32_000,
    codingQuality: 0.05,
    agenticQuality: 0.05,
    intelligenceQuality: 0.05,
    measuredQuality: 0.05,
    measuredLatencyMs: 120,
    inputUsdPerMillionTokens: 0.05,
    outputUsdPerMillionTokens: 0.2
  };
  const second: RoutableModel = {
    ...strong,
    id: 'second',
    displayName: 'Second',
    codingQuality: 0.93,
    agenticQuality: 0.93,
    intelligenceQuality: 0.93
  };
  const third: RoutableModel = {
    ...strong,
    id: 'third',
    displayName: 'Third',
    codingQuality: 0.88,
    agenticQuality: 0.88,
    intelligenceQuality: 0.88
  };
  const open: ModelRequest = {
    privacyRoute: 'provider_zdr',
    requiredCapabilities: ['chat', 'tools'],
    requiredModalities: ['text'],
    minContextTokens: 16_000,
    preference: 'balanced'
  };

  it('says nothing when the model in use is the one that leads', () => {
    const fit = modelFit({
      models: [strong, cheap],
      chosen: strong,
      request: open,
      signals: { prompt: 'Refactor this TypeScript repository and run the tests' }
    });
    expect(fit.headline).toBeNull();
    expect(fit.rank).toBe(1);
  });

  it('says nothing about a near miss, because a ranking disagreeing with itself is not news', () => {
    const fit = modelFit({
      models: [strong, second, middling],
      chosen: second,
      request: open,
      signals: { prompt: 'Refactor this TypeScript repository and run the tests' }
    });
    expect(fit.headline).toBeNull();
    expect(fit.rank).toBe(2);
  });

  it('names the leader when the model in use is far down the ranking', () => {
    const fit = modelFit({
      models: [strong, second, third, cheap],
      chosen: cheap,
      request: open,
      signals: { prompt: 'Refactor this TypeScript repository and run the tests' }
    });
    expect(fit.rank).toBe(4);
    expect(fit.leader?.id).toBe('strong');
    expect(fit.headline).toContain('Cheap ranks 4 of 4 for coding');
    expect(fit.headline).toContain('Strong leads');
    // The benchmark is the evidence; the sentence above it is only the index into it.
    expect(fit.detail).toContain('Cheap:');
    expect(fit.detail).toContain('Strong:');
  });

  it('reports work the model cannot do at all rather than a placement', () => {
    const blind: RoutableModel = {
      ...cheap,
      modalities: ['text'],
      capabilities: ['chat', 'tools']
    };
    const seeing: RoutableModel = {
      ...strong,
      modalities: ['text', 'image'],
      capabilities: ['chat', 'tools', 'vision']
    };
    const fit = modelFit({
      models: [seeing, blind],
      chosen: blind,
      request: open,
      signals: { prompt: 'What is wrong with this?', hasImages: true }
    });
    expect(fit.classification.kind).toBe('vision');
    expect(fit.rank).toBeNull();
    expect(fit.missing).toEqual(['no vision', 'it cannot read image']);
    expect(fit.headline).toBe(
      'Cheap cannot do vision work here: no vision, it cannot read image. Strong can.'
    );
  });

  it('judges the pick on the dial most forgiving to it, whatever the owner asked for', () => {
    // `best` would condemn a cheap route on quality alone. The fit ranks on `fast` - latency and
    // price weighted hardest, quality least - so a model that still places last has lost on terms
    // nobody chose for it.
    const forgiving = modelFit({
      models: [strong, second, third, cheap],
      chosen: cheap,
      request: { ...open, preference: 'best' },
      signals: { prompt: 'Refactor this TypeScript repository and run the tests' }
    });
    const asked = modelFit({
      models: [strong, second, third, cheap],
      chosen: cheap,
      request: { ...open, preference: 'fast' },
      signals: { prompt: 'Refactor this TypeScript repository and run the tests' }
    });
    expect(forgiving.headline).toEqual(asked.headline);
  });

  it('is silent when nothing else could have answered either', () => {
    expect(
      modelFit({
        models: [cheap],
        chosen: cheap,
        request: open,
        signals: { prompt: 'Refactor this TypeScript repository' }
      }).headline
    ).toBeNull();
  });

  /*
   * The same fallback seen from the caller that would have died of it. `modelFit` is the only
   * production reader of a classification's `kind`, and it uses it as a key into `profiles` twice
   * before anything validates it.
   */
  it('survives a declared kind that is not in the vocabulary', () => {
    expect(() =>
      modelFit({
        models: [strong, cheap],
        chosen: cheap,
        request: open,
        signals: {
          prompt: 'Refactor this TypeScript repository',
          declaredKind: 'tier_3' as ModelTaskKind
        }
      })
    ).not.toThrow();
  });
});

/**
 * A model priced above the ceiling, which is also the *better* model.
 *
 * The gate probe that specified this step said the discriminating property out loud: `balanced`
 * already prefers the cheaper of two models on its own, so a test that only checks which model came
 * first passes identically whether the ceiling is wired or not. Every test below asserts
 * membership - who is in the pool at all - and where it asserts an order it does so under
 * `preference: 'best'`, where the expensive model wins unless something excludes it.
 */
const unbenchmarkedCheap: RoutableModel = {
  ...base,
  id: 'unbenchmarked-cheap',
  displayName: 'Unbenchmarked Cheap',
  measuredQuality: null,
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 4
};

describe('selecting a model under the owner price ceiling', () => {
  it('excludes an over-priced model from the pool even when it is the better model', () => {
    // Without the ceiling and asked for the best, the expensive model wins - so its absence below
    // is the ceiling and cannot be the scoring.
    const open = { ...request, taskKind: 'agentic' as const, preference: 'best' as const };
    expect(rankModels([opus, sonnet], open)[0]?.model.id).toBe('opus');

    const selection = selectModel([opus, sonnet], { ...ceiling, preference: 'best' });
    expect(selection.ranked.map((entry) => entry.model.id)).toEqual(['sonnet']);
    expect(selection.choice?.model.id).toBe('sonnet');
    expect(selection.ceilingOutcome).toBe('within');
    expect(selection.message).toBeNull();
  });

  it('picks nothing at all when the whole catalogue is above the ceiling, and says which and why', () => {
    const selection = selectModel([opus], ceiling);
    expect(selection.choice).toBeNull();
    expect(selection.ranked).toEqual([]);
    expect(selection.ceilingOutcome).toBe('blocked');
    expect(selection.cheapestAboveCeiling?.id).toBe('opus');
    expect(selection.message).toContain('$5.00 per million input is above the $2.00 ceiling');
    expect(selection.message).toContain('Claude Opus 5');
  });

  it('names the cheapest of the excluded models, not whichever came first in the catalogue', () => {
    const dearer: RoutableModel = {
      ...opus,
      id: 'dearer',
      displayName: 'Dearer',
      inputUsdPerMillionTokens: 40,
      outputUsdPerMillionTokens: 200
    };
    expect(selectModel([dearer, opus], ceiling).cheapestAboveCeiling?.id).toBe('opus');
    expect(selectModel([opus, dearer], ceiling).cheapestAboveCeiling?.id).toBe('opus');
  });

  it('judges cheapness at the price tier the task will actually reach', () => {
    // Cheap at the head of the catalogue and dear past 200K, against a rival that is flat. Blaming
    // the flat one for being expensive would send the owner to raise a ceiling for the wrong route.
    const tiered: RoutableModel = {
      ...opus,
      id: 'tiered',
      displayName: 'Tiered',
      contextTokens: 1_000_000,
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 12,
      priceTiers: [
        { minPromptTokens: 200_000, inputUsdPerMillionTokens: 60, outputUsdPerMillionTokens: 240 }
      ]
    };
    const wide = { ...ceiling, minContextTokens: 250_000 };
    expect(
      selectModel([tiered, { ...opus, contextTokens: 1_000_000 }], wide).cheapestAboveCeiling?.id
    ).toBe('opus');
  });

  it('does not blame the ceiling for an empty pool the ceiling had no part in', () => {
    // A catalogue with nothing that can do the work is not a ceiling problem. Reporting `blocked`
    // here would send the owner to raise the one setting that excluded nothing.
    const wrongRoute: RoutableModel = { ...sonnet, privacyRoute: 'external' };
    const selection = selectModel([wrongRoute], ceiling);
    expect(selection.choice).toBeNull();
    expect(selection.ceilingOutcome).toBe('no_ceiling');
    expect(selection.cheapestAboveCeiling).toBeNull();
    expect(selection.message).toBeNull();
  });

  it('never blocks a model the owner named, and says it is over the ceiling rather than hiding it', () => {
    const selection = selectModel([opus, sonnet], { ...ceiling, requestedId: 'opus' });
    expect(selection.choice?.model.id).toBe('opus');
    expect(selection.ceilingOutcome).toBe('requested_over_ceiling');
    expect(selection.message).toContain('$5.00 per million input is above the $2.00 ceiling');
  });

  /**
   * The negative control the pin guard rests on, and it lives here because the guard cannot hold it
   * from `apps/api`: a named model with no published price is a different answer from a named model
   * over the ceiling, and the outcome has to say so. It did not, and one advisory sentence covering
   * both is what cost an owner their pin on every unpriced route.
   *
   * Return `'requested_over_ceiling'` from both arms in `selectModel` and this goes red while the
   * test above stays green. Note the choice is the named model either way - an explicit pick is
   * never refused here - so `choice` alone can never tell the two apart.
   */
  it('separates a named model with no published price from a named model over the ceiling', () => {
    const selection = selectModel([unpriced, sonnet], { ...ceiling, requestedId: 'unpriced' });
    expect(selection.choice?.model.id).toBe('unpriced');
    expect(selection.ceilingOutcome).toBe('requested_unpriced');
    // The sentence follows the fact: an unknown price is not "above your price ceiling".
    expect(selection.message).toContain('price is not published');
    expect(selection.message).not.toContain('above your price ceiling');
    // And a named model the ceiling has no objection to still reports no ceiling involvement.
    expect(selectModel([sonnet], { ...ceiling, requestedId: 'sonnet' }).ceilingOutcome).toBe(
      'no_ceiling'
    );
  });

  it('says so when the only model under the ceiling is one nobody has benchmarked', () => {
    const selection = selectModel([opus, unbenchmarkedCheap], ceiling);
    expect(selection.choice?.model.id).toBe('unbenchmarked-cheap');
    expect(selection.ceilingOutcome).toBe('relaxed_unbenchmarked');
    expect(selection.message).toContain('Unbenchmarked Cheap');
    // ...and it is only said when a benchmarked model was in fact excluded. An unbenchmarked pick
    // on a catalogue where nothing is benchmarked has nothing to do with the ceiling.
    const alone = selectModel([unbenchmarkedCheap], ceiling);
    expect(alone.ceilingOutcome).toBe('within');
    expect(alone.message).toBeNull();
  });

  it('reports no ceiling at all when the request carries none', () => {
    const selection = selectModel([opus, sonnet], { ...request, taskKind: 'agentic' });
    expect(selection.ceilingOutcome).toBe('no_ceiling');
    expect(selection.message).toBeNull();
    expect(selection.cheapestAboveCeiling).toBeNull();
    expect(selection.choice).not.toBeNull();
  });
});

describe('the stored ceiling as request fields', () => {
  it('carries a ceiling of zero through, and drops one that was never set', () => {
    // `null` is "no ceiling" and `0` is "only a route that publishes a price of zero". Spreading
    // the record with `??` collapses the second into the first, which is why this conversion has
    // one home rather than one per call site.
    expect(priceCeilingFields(null)).toEqual({});
    expect(priceCeilingFields({ maxInputUsdPerMillionTokens: null })).toEqual({});
    expect(priceCeilingFields({ maxInputUsdPerMillionTokens: 0 })).toEqual({
      maxInputUsdPerMillionTokens: 0
    });
    expect(
      priceCeilingFields({ maxInputUsdPerMillionTokens: 2, maxOutputUsdPerMillionTokens: 10 })
    ).toEqual({ maxInputUsdPerMillionTokens: 2, maxOutputUsdPerMillionTokens: 10 });
  });

  it('produces exactly the request a ceiling-bearing caller has to build', () => {
    const built: ModelRequest = {
      ...request,
      taskKind: 'agentic',
      ...priceCeilingFields({ maxInputUsdPerMillionTokens: 2, maxOutputUsdPerMillionTokens: 10 })
    };
    expect(selectModel([opus, sonnet], built).ranked.map((entry) => entry.model.id)).toEqual([
      'sonnet'
    ]);
  });
});
