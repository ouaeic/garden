/**
 * The one argument every route group and every maintenance pass takes.
 *
 * A route group reaches into what its server has built, and that reach is named in three layers:
 * `ApiContext` is what one server decides once, `ServerSupport` is the helpers built on top of it
 * that more than one group needs, and `RouteContext` adds the three things only a request handler
 * wants - the step-up guard, the idempotency wrapper, and the sweep the provider save route
 * runs to clear a wall.
 *
 * Derived from the factories rather than declared beside them, deliberately: a helper that changes
 * shape changes this type with it, so a route group cannot fall out of step with what it is handed.
 */
import type { ApiConfig } from '../config.js';
import type { ApiContext, ApiOverrides } from '../context.js';
import type { ServerSupport } from '../routes/support.js';
import type { StepUpGuard } from './auth-hook.js';
import type { IdempotentOperation } from './idempotency.js';

/** What one server decided once, plus the two inputs it decided it from. */
export type ServerBase = ApiContext & { config: ApiConfig; overrides: ApiOverrides };

/** Everything a background pass needs: the base, and the shared helpers built on it. */
export type SupportedContext = ServerBase & ServerSupport;

/** The above, plus what only a request handler asks for. */
export type RouteContext = SupportedContext & {
  requireRecentStepUp: StepUpGuard;
  idempotent: IdempotentOperation;
  /** Owned by `maintenance/provider-walls.ts`; called from the route that saves a provider key. */
  resumeTasksWaitingOnAProvider: (userId: string) => Promise<number>;
};
