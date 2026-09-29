/**
 * The one place a throw becomes a status code, a body and a log line.
 *
 * Kept whole and kept alone: the requestId the client is told to quote is minted here and it is
 * the same string that reaches the log, so the two cannot drift apart. Everything that leaves
 * goes through `redactText` on the way out, because some GardenError messages are built from an
 * upstream response.
 */

import { randomUUID } from 'node:crypto';
import { GardenError, redactText } from '@garden/core';
import { z } from 'zod';
import { errorFields } from '../log.js';
import type { ServerBase } from './server-context.js';

export const registerErrorHandler = (context: ServerBase): void => {
  const { log, app, requestStarted } = context;
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id ?? randomUUID());
    const known = error instanceof GardenError;
    const invalid = error instanceof z.ZodError;
    const status = invalid
      ? 400
      : known && error.code === 'authentication_required'
        ? 401
        : known && ['not_found', 'workspace_not_found', 'task_not_found'].includes(error.code)
          ? 404
          : known && ['storage_limit', 'spend_cap_reached'].includes(error.code)
            ? 402
            : known && ['idempotency_conflict', 'operation_in_progress'].includes(error.code)
              ? 409
              : known
                ? error.statusCode
                : 500;
    const code = invalid ? 'invalid_request' : known ? error.code : 'request_failed';
    /**
     * The client is handed a requestId and told to quote it; this is the line it has to match.
     * A 401 is the ordinary sound of an expired cookie, so it stays at debug; an unrecognised
     * throw is the one case worth the stack frames, since its own message is never safe to print.
     */
    const fields = {
      requestId,
      code,
      statusCode: status,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      durationMs: Math.round(performance.now() - (requestStarted.get(request) ?? performance.now()))
    };
    if (status >= 500) log.error('http.request_failed', { ...fields, ...errorFields(error) });
    else if (status === 401) log.debug('http.request_rejected', fields);
    else log.warn('http.request_rejected', fields);
    // Schema errors expose field paths without echoing input values. GardenError carries
    // owner-facing guidance for expected failures such as an unsuitable password length.
    const invalidFields = invalid
      ? [...new Set(error.issues.map((issue) => issue.path.join('.')).filter(Boolean))]
          .slice(0, 8)
          .join(', ')
      : '';
    void reply.status(status).send({
      error: {
        code,
        message: invalid
          ? `One or more request fields are missing or invalid${invalidFields ? `: ${invalidFields}` : ''}`
          : known
            ? // An GardenError message is written to be read by the owner, but some are built from
              // an upstream response, so the last thing before it leaves the process scrubs it.
              redactText(error.message)
            : 'The request could not be completed',
        requestId
      }
    });
  });
};
