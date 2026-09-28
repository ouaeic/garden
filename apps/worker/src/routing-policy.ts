import { OwnerPreferences, type ModelRelease } from '@garden/contracts';
import {
  DEFAULT_ROUTING_POLICY,
  providerPreferences,
  shouldMeasureCeiling,
  type ProviderPreferences,
  type RoutingPolicy
} from '@garden/core';
import type { DataStore } from '@garden/data';

/**
 * The owner's rule for choosing between the companies serving one model.
 *
 * Unreadable preferences are the default preferences, never a reason to stop routing: a turn that
 * failed because a settings row would not parse would be this feature costing the owner the thing
 * it exists to improve.
 */
export const routingPolicyFor = async (
  store: DataStore,
  userId: string
): Promise<RoutingPolicy> => {
  try {
    const routing = OwnerPreferences.parse(
      (await store.getUserById(userId))?.preferences ?? {}
    ).providerRouting;
    if (!routing) return DEFAULT_ROUTING_POLICY;
    return {
      objective: routing.objective,
      throughputFloorPercent: routing.throughputFloorPercent,
      ignoredProviders: routing.ignoredProviders
    };
  } catch {
    return DEFAULT_ROUTING_POLICY;
  }
};

export interface TurnRouting {
  /** What goes on the wire, or nothing on a route with no companies to choose between. */
  readonly preferences: ProviderPreferences | undefined;
  /**
   * True when this turn is routed to the fastest company in order to learn what fastest means for
   * this model. The turn is not slowed by it - it is on the quickest route there is - and its
   * generation is what the ceiling gets read from afterwards.
   */
  readonly measuring: boolean;
}

/**
 * What this turn asks the aggregator for, and whether it is the turn that takes the measurement.
 *
 * The ceiling is read per model rather than per turn because it is a property of the aggregator's
 * fleet, and it is deliberately allowed to be absent: an absent ceiling routes by throughput, which
 * is a good route and the one that produces the next ceiling.
 */
export const routingForTurn = async (input: {
  store: DataStore;
  model: ModelRelease;
  userId: string;
}): Promise<TurnRouting> => {
  const policy = await routingPolicyFor(input.store, input.userId);
  // The aggregator names a model `vendor/model`; anything else is not one of its routes and has no
  // second company serving it to choose between.
  if (!input.model.providerModelId.includes('/'))
    return { preferences: undefined, measuring: false };
  const ceiling = await input.store.modelThroughputCeiling(input.model.id).catch(() => null);
  const tokensPerSecond = ceiling?.tokensPerSecond ?? null;
  return {
    preferences: providerPreferences(policy, tokensPerSecond),
    measuring: shouldMeasureCeiling(policy, tokensPerSecond)
  };
};
