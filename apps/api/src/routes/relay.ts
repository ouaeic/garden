/**
 * Reaching this box from outside the house, and what it will admit about itself.
 *
 * Off by default and for most owners that is the right answer, so the settings say plainly what
 * turning it on means rather than presenting it as a feature to enable.
 */

import { GardenError, redactText } from '@garden/core';
import { buildIdentity } from '@garden/worker';
import { z } from 'zod';
import { isAddressLiteral, readBackupStatus, readStateFailure, timerState } from '../context.js';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { recordSecurityEvent } from '../security-events.js';

export const registerRelayRoutes = (context: RouteContext): void => {
  const { app, store, relay, config, requireRecentStepUp, idempotent } = context;
  /**
   * The relay: off, and for most owners that is the right answer.
   *
   * A box on a public address, or one with a dynamic-DNS name, is reached directly and needs none
   * of this. The relay exists for a box behind carrier-grade NAT, and turning it on is two
   * deliberate acts - a hostname and an enrollment token - because it puts a third party in the
   * path of every connection. There is no default relay and nothing here contacts anyone until an
   * owner names one.
   */
  /**
   * What the box knows is wrong with itself, said where the owner is already looking.
   *
   * The certificate helper and the dynamic DNS helper each write a timestamped reason when they
   * fail, and nothing read either file. Renewal starts about thirty days before expiry, so a
   * failing certificate had a month in which the app was reachable, could have said what happened
   * and offered the command, and instead said nothing at all - until it expired, at which point
   * every device refused at once and the only way to find out why was a shell.
   *
   * Read-only, and deliberately thin: it reports what the box already wrote down rather than
   * running probes of its own. `garden doctor` remains the fuller account for somebody who is
   * already at a terminal.
   */
  app.get('/v1/instance/diagnostics', async (request) => {
    requireUser(request.user);
    const [certificate, dynamicDns, backup, autoUpdate, backupTimer] = await Promise.all([
      readStateFailure(config.GARDEN_STATE_PATH, 'certificate.error'),
      readStateFailure(config.GARDEN_STATE_PATH, 'ddns.error'),
      readBackupStatus(config.GARDEN_STATE_PATH),
      timerState('garden-auto-update.timer'),
      timerState('garden-backup.timer')
    ]);
    // Which build is answering. It belongs on this route rather than on one of its own because it
    // is the same kind of fact as the three above - something the box knows about itself that an
    // owner otherwise needs a terminal to ask - and because a bug report that does not start with
    // it starts with a guess.
    return { certificate, dynamicDns, backup, autoUpdate, backupTimer, build: buildIdentity() };
  });

  app.get('/v1/relay', async (request) => {
    requireUser(request.user);
    return relay.report();
  });

  app.post('/v1/relay/enrollment', async (request, reply) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    return idempotent(request, reply, user, async () => {
      const input = z
        .object({
          // A relay is named, never addressed: the label lives under this domain and the
          // certificate the box will hold is for a name.
          host: z
            .string()
            .trim()
            .toLowerCase()
            .min(3)
            .max(253)
            .regex(
              /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
              'Use the relay’s hostname, such as relay.example.com'
            )
            // A dotted quad passes the shape above; the label the relay derives lives under this
            // domain and the certificate the box will hold is for a name, so an address never works.
            .refine(
              (value) => !isAddressLiteral(value),
              'Use the relay’s hostname, not an address'
            ),
          token: z.string().trim().min(8).max(500),
          // For a relay whose DNS the owner would rather not depend on. The relay still routes on
          // the name, so this only decides where the connection is opened.
          address: z.string().trim().min(1).max(255).nullish(),
          port: z.number().int().min(1).max(65_535).optional()
        })
        .parse(request.body ?? {});
      try {
        const report = await relay.enroll({
          host: input.host,
          token: input.token,
          address: input.address ?? null,
          ...(input.port === undefined ? {} : { port: input.port })
        });
        await recordSecurityEvent(store, {
          userId: user.id,
          kind: 'relay_enrolled',
          outcome: 'completed'
        });
        return report;
      } catch (error) {
        // The relay wrote this text, so it is bounded before it is shown; it is the only place an
        // owner learns that a token was already used or has expired.
        throw new GardenError(
          'relay_enrollment_failed',
          error instanceof Error
            ? redactText(error.message).slice(0, 200)
            : 'The relay refused this enrollment',
          422
        );
      }
    });
  });

  app.patch('/v1/relay', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const input = z.object({ enabled: z.boolean() }).parse(request.body ?? {});
    if (input.enabled && !relay.settings.label) {
      throw new GardenError('relay_not_enrolled', 'Enroll with a relay before turning it on', 422);
    }
    const report = input.enabled ? await relay.enable() : await relay.disable();
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: input.enabled ? 'relay_enabled' : 'relay_disabled',
      outcome: 'completed'
    });
    return report;
  });

  /** Forgets the enrollment. The identity key stays, so re-enrolling keeps the same address. */
  app.delete('/v1/relay', async (request) => {
    const user = requireUser(request.user);
    await requireRecentStepUp(request, user);
    const report = await relay.forget();
    await recordSecurityEvent(store, {
      userId: user.id,
      kind: 'relay_disabled',
      outcome: 'completed'
    });
    return report;
  });
};
