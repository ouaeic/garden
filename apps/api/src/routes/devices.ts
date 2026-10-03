/**
 * Adding a second device without handing it the recovery code.
 *
 * An enrollment grant is single use, ten minutes long, minted by a device that is already signed
 * in and stepped up, and worth nothing without a WebAuthn ceremony completed on top of it. That is
 * what lets the two redemption routes be unauthenticated.
 */

import { randomBytes } from 'node:crypto';
import { sha256 } from '@garden/core';
import { z } from 'zod';
import { CONNECTION_TICKET_VERSION, MDNS_PORT, MDNS_SERVICE } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { withRelayEndpoint } from '../relay.js';
import { recordSecurityEvent } from '../security-events.js';
import { sessionCookieName } from '../session.js';

export const registerDeviceRoutes = (context: RouteContext): void => {
  const { app, store, relay, connectionManifest, config, requireRecentStepUp, idempotent } =
    context;
  /**
   * Device enrollment.
   *
   * The ticket is a connection ticket in the one shape a client can read - the shape the installer
   * prints for the first device, down to the version number and the field the one-time code
   * travels in. The endpoint set and the pinned identity go with the grant, which is what lets the
   * new device verify it is talking to this server rather than to whoever answered that address.
   *
   * The client rejects unknown fields, so a ticket in any other spelling drawn as a QR code by the
   * settings screen could not be imported by anything. The expiry is the grant's, in whole
   * seconds since the epoch, so a client can say "this link has expired" instead of failing at the
   * server.
   */
  app.post('/v1/devices/enrollments', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({ label: z.string().trim().min(1).max(60).default('New device') })
        .parse(request.body ?? {});
      const token = randomBytes(32).toString('base64url');
      const enrollment = await store.createDeviceEnrollment({
        userId: user.id,
        tokenHash: sha256(token),
        label: input.label,
        ...(request.cookies[sessionCookieName(config.PUBLIC_APP_URL.startsWith('https://'))]
          ? {
              issuedBySession: sha256(
                request.cookies[
                  sessionCookieName(config.PUBLIC_APP_URL.startsWith('https://'))
                ] as string
              )
            }
          : {}),
        // Short enough that a photographed screen stops being useful quickly; long enough to walk
        // to another room and finish a passkey ceremony.
        expiresAt: new Date(Date.now() + 10 * 60_000)
      });
      const connection = await connectionManifest();
      const ticket = Buffer.from(
        JSON.stringify({
          version: CONNECTION_TICKET_VERSION,
          endpoints: withRelayEndpoint(connection.endpoints, relay.publicHostname()),
          identity: connection.identity,
          // A manifest written before the watcher recorded discovery carries none; the service and
          // port are fixed for the whole product, so the ticket states them rather than omitting a
          // field the client requires.
          discovery: {
            mdnsService: connection.discovery?.mdnsService ?? MDNS_SERVICE,
            mdnsPort: connection.discovery?.mdnsPort ?? MDNS_PORT
          },
          pairingCode: token,
          expiresAt: Math.floor(new Date(enrollment.expiresAt).getTime() / 1000)
        })
      ).toString('base64url');
      await recordSecurityEvent(store, {
        userId: user.id,
        kind: 'device_enrollment_created',
        outcome: 'completed',
        metadata: { enrollmentId: enrollment.id }
      });
      return {
        id: enrollment.id,
        expiresAt: enrollment.expiresAt,
        uri: `garden://pair/${ticket}`,
        /** Browser-readable enrollment keeps the ticket in a fragment, outside request logs. */
        webUri: `${config.PUBLIC_APP_URL.replace(/\/+$/, '')}/#pair=${ticket}`
      };
    });
  });

  app.get('/v1/devices/enrollments', async (request) =>
    store.listDeviceEnrollments(requireUser(request.user).id)
  );

  app.delete<{ Params: { enrollmentId: string } }>(
    '/v1/devices/enrollments/:enrollmentId',
    async (request) => {
      const user = requireUser(request.user);
      return {
        revoked: await store.revokeDeviceEnrollment(
          user.id,
          z.string().uuid().parse(request.params.enrollmentId)
        )
      };
    }
  );
};
