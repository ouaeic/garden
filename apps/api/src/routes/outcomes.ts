import { MAX_OUTCOME_IDS, TaskOutcomes } from '@garden/contracts';
import { GardenError } from '@garden/core';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { readTaskOutcomes } from '../task-outcomes.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Finished goals as their results and cover notes, for a page of them in one read. */
export const registerOutcomeRoutes = (context: RouteContext): void => {
  context.app.get<{ Querystring: { ids?: string | string[] } }>(
    '/v1/outcomes',
    async (request, reply) => {
      const user = requireUser(request.user);
      const given = request.query.ids;
      const requested = [
        ...new Set(
          (Array.isArray(given) ? given.join(',') : (given ?? ''))
            .split(',')
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean)
        )
      ];
      if (requested.length > MAX_OUTCOME_IDS)
        throw new GardenError(
          'outcome_ids_limit',
          `Ask for at most ${MAX_OUTCOME_IDS} outcomes at a time`,
          400
        );
      // An id that is not one names nothing - the same answer as an id naming someone else's task.
      const outcomes = await readTaskOutcomes(
        context,
        user.id,
        requested.filter((id) => uuid.test(id))
      );
      reply.header('cache-control', 'private, no-store');
      return TaskOutcomes.parse({ outcomes });
    }
  );
};
