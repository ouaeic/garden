import { seedMediaModels, type MediaRouteResolver } from '@garden/model-gateway';
import type { InferenceCredential } from './agent-state.js';

/** Explicit provider metadata for offline loop tests; discovery has its own HTTP contract tests. */
export const fixtureMediaRouting: Pick<MediaRouteResolver, 'resolve'> = {
  resolve: async (secret) => {
    const saved = (secret as InferenceCredential).mediaRoutes;
    const options = seedMediaModels(new Date('2026-07-01T00:00:00.000Z'));
    return {
      options,
      routes: saved ?? Object.fromEntries(options.map((option) => [option.modality, option]))
    };
  }
};
