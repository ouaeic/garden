/**
 * Liveness, readiness, and the licence notice an AGPL box owes whoever it is serving.
 *
 * `/healthz` answers before the database is asked anything; `/readyz` is the one that fails while
 * the store is unreachable, because a process that is up and cannot read is not ready.
 */

import { isAddressLiteral } from '../context.js';
import type { RouteContext } from '../http/server-context.js';
import { errorFields } from '../log.js';

export const registerHealthRoutes = (context: RouteContext): void => {
  const { log, app, database, store, config } = context;
  app.get('/healthz', async () => ({ ok: true, service: 'api' }));
  /**
   * A WebAuthn Relying Party ID has to be a registrable domain: the spec rules out IP literals,
   * and Chrome refuses outright. A server reached only by address therefore cannot run a passkey
   * ceremony at all, however healthy everything else is. That is reported here so the sign-in
   * screen can say what to do instead of presenting a button that always fails.
   */
  const passkeysUsable = !isAddressLiteral(config.WEBAUTHN_RP_ID);
  /**
   * What this program is and where its source is, which is all a licence notice on an AGPL box
   * amounts to.
   *
   * There is no document version or "acceptance required" flag: a machine the owner installed does
   * not present its owner with terms.
   */
  app.get('/v1/legal', async () => {
    // Counted once. This route is public, is not rate limited, and the sign-in screen calls it on
    // every load, so a second identical query would be two per hit on the one path a box that
    // cannot answer them has no other way to explain itself.
    const users = await store.countUsers();
    return {
      applicationLicense: 'AGPL-3.0-only' as const,
      sourceUrl: config.PUBLIC_SOURCE_URL ?? null,
      privacyUrl: config.PUBLIC_PRIVACY_URL ?? null,
      passkeysUsable,
      registrationAvailable: users === 0,
      /**
       * Whether recovery needs to be told which account it is for.
       *
       * On a box with one owner it does not, and asking made the last-resort path depend on
       * remembering a display name typed once during setup. Nothing is disclosed by saying so that
       * `registrationAvailable` does not already say: a box that refuses registration is a box that
       * has been claimed.
       */
      singleOwner: users === 1
    };
  });
  app.get('/readyz', async (_request, reply) => {
    try {
      await database.query('SELECT 1 AS ready');
      return { ok: true, service: 'api' };
    } catch (error) {
      // The one route that reports a dead database, and the gate an update should be checking.
      log.error('api.not_ready', { driver: config.DATABASE_DRIVER, ...errorFields(error) });
      return reply.status(503).send({ ok: false, service: 'api' });
    }
  });
};
